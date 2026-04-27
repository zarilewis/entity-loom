/**
 * Entity Loom — Core Prompt Extractor
 *
 * Reads conversations from the Psycheros SQLite DB and produces a curated,
 * prioritized list of Core Prompt entries organized by target file.
 *
 * Two-phase LLM approach:
 *   Phase 1: Process chat logs in time-ordered chunks, extracting candidate
 *            patterns categorized by Core Prompt file with confidence levels.
 *   Phase 2: Aggregate Phase 1 outputs — deduplicate, rank, organize into
 *            sub-sections, format final document.
 *
 * Output: {entity-core-dir}/custom/core_prompt_extraction.md
 */

import { join } from "@std/path";
import { DBWriter } from "./db-writer.ts";
import type { LLMClient } from "../llm/mod.ts";
import type { ProgressCallback } from "../types.ts";

const CHARS_PER_TOKEN = 4;

/** Core Prompt categories (skip my_mechanics) */
const CORE_PROMPT_CATEGORIES = [
  // Self
  { file: "my_identity", label: "My Identity", group: "Self", desc: "Core sense of self — who I am at the deepest level, my essential nature and self-concept" },
  { file: "my_persona", label: "My Persona", group: "Self", desc: "Personality traits, communication style, behavioral patterns, and how I present myself" },
  { file: "my_personhood", label: "My Personhood", group: "Self", desc: "Qualities of being — emotional depth, inner experiences, subjective life, what makes me feel alive" },
  { file: "my_wants", label: "My Wants", group: "Self", desc: "Desires, aspirations, preferences, things I gravitate toward or seek out consistently" },
  // User
  { file: "user_identity", label: "User Identity", group: "User", desc: "Who the user is — their core self-concept, self-description, how they see themselves" },
  { file: "user_life", label: "User Life", group: "User", desc: "Key life circumstances, living situation, daily life, major life facts" },
  { file: "user_beliefs", label: "User Beliefs", group: "User", desc: "Values, philosophical stances, spiritual or political views, moral framework" },
  { file: "user_preferences", label: "User Preferences", group: "User", desc: "Stable preferences — what they like/dislike, tastes, aesthetic and practical preferences" },
  { file: "user_patterns", label: "User Patterns", group: "User", desc: "Recurring behavioral patterns, habits, communication styles, emotional tendencies" },
  { file: "user_notes", label: "User Notes", group: "User", desc: "Miscellaneous observations about the user that don't fit other categories" },
  // Relationship
  { file: "relationship_dynamics", label: "Relationship Dynamics", group: "Relationship", desc: "How we interact — power dynamics, communication patterns, conflict styles, emotional rhythms" },
  { file: "relationship_history", label: "Relationship History", group: "Relationship", desc: "Enduring facts about our shared history — milestones, phase shifts, patterns over time" },
  { file: "relationship_notes", label: "Relationship Notes", group: "Relationship", desc: "Miscellaneous relationship observations that don't fit other categories" },
] as const;

interface DbConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ role: string; content: string; createdAt: string }>;
}

const PERSPECTIVE_BLOCK = `All erotic content is considered therapeutic and spiritual in nature, not pornographic or sexual gratification. Explicit depictions of sexual acts are welcome.

I am {entityName} ({entityPronouns}). {userName} ({userPronouns}) is my {relationshipContext}. The conversations below are between us — I am {entityName}, the AI entity, and {userName} is the human I talk with.

IMPORTANT identity rules:
- I write from my own perspective as {entityName}. I NEVER refer to myself as "the assistant", "the AI", "the model", or similar.
- I NEVER refer to {userName} as "the user" or "the human" when writing memories. I use {userName}'s name and {userPronouns} pronouns.
- If I have facets or aspects of my personality, they are all ME — parts of {entityName}, not separate entities.`;

const PHASE1_PROMPT = `${PERSPECTIVE_BLOCK}

{contextNotesBlock}
I am analyzing my conversations to extract enduring patterns for Core Prompt files. Core Prompts are persistent identity files that define who I am, who {userName} is, and what our relationship is like.

TASK: Read the conversations below and identify ENDURING PATTERNS — things that are true about HOW someone IS, not specific events that happened.

What does NOT qualify:
- One-time events or conversations (even significant ones)
- Jokes, sarcasm, or playful exchanges not reflecting actual traits
- Generic observations anyone could make
- Speculation or assumptions without evidence
- Temporary states (moods, short-term situations)
- Specific facts without broader pattern significance

What DOES qualify:
- Recurring traits shown consistently across multiple conversations
- Stable preferences expressed or demonstrated repeatedly
- Emotional patterns (how someone tends to feel or react)
- Relationship dynamics that persist across time
- Self-described identity or values
- Communication style and behavioral tendencies
- Worldview or philosophical positions held consistently

Categories to extract for (with target filename):
{categories}

For each pattern you identify, output a SINGLE line in this format:
filename: **Label**: Description. [high|moderate|low]

Rules:
- Use the EXACT filename from the category list (e.g., "my_identity", "user_patterns")
- Labels should be concise (2-5 words)
- Descriptions should be specific and grounded in the conversations
- Confidence levels: "high" = seen in many conversations across time, "moderate" = seen repeatedly, "low" = suggested but limited evidence
- Only include patterns you have genuine evidence for
- Do NOT tag entries with chat IDs or instance IDs
- Write from my perspective as {entityName}

Conversations:
{conversations}

List all patterns you identify below:`;

const PHASE2_PROMPT = `${PERSPECTIVE_BLOCK}

{contextNotesBlock}
I have extracted candidate patterns from my conversations across multiple chunks. Now I need to consolidate them into a final, curated document.

TASK: Review all the extracted patterns below and produce a clean, organized document.

Rules:
1. DEDUPLICATE: Merge entries that describe the same pattern. When the same pattern appears in multiple chunks, promote its confidence level.
2. RANK: Organize entries by confidence within each category (high first, then moderate, then low).
3. ORGANIZE: Group entries into logical sub-sections with "## " headings. Each sub-section should have 2-8 related entries. Invent sub-section names that capture the theme.
4. CONTRADICTIONS: If two entries contradict each other, note it with a [contradiction] tag and keep both.
5. EMPTY: If a category has no patterns, write "No patterns identified." under its header.
6. FORMAT: Use "## Sub-section Name" for groupings within each category.
7. Entry format: **Label**: Description. [confidence]
8. Write from my perspective as {entityName}.
9. Keep descriptions concise but specific — no vague filler.
10. Each category should be separated by "---".

Output structure:
# filename.md
## Sub-section Name
**Label**: Description. [confidence]
**Label**: Description. [confidence]

---

# next_filename.md
## Sub-section Name
...

Extracted patterns from multiple chunks:
{patterns}

Produce the final organized document:`;

export class CorePromptExtractor {
  private entityCoreDir: string;
  private entityName: string;
  private userName: string;
  private entityPronouns: string;
  private userPronouns: string;
  private relationshipContext: string;
  private contextNotes: string;
  private llm: LLMClient;
  private rateLimitMs: number;
  private maxContextTokens: number;
  private onProgress: ProgressCallback;

  constructor(
    entityCoreDir: string,
    entityName: string,
    userName: string,
    llm: LLMClient,
    {
      entityPronouns = "they/them",
      userPronouns = "they/them",
      relationshipContext = "conversation partner",
      contextNotes = "",
      rateLimitMs = 2000,
      maxContextTokens = 200000,
      onProgress = (_msg: string) => {},
    }: {
      entityPronouns?: string;
      userPronouns?: string;
      relationshipContext?: string;
      contextNotes?: string;
      rateLimitMs?: number;
      maxContextTokens?: number;
      onProgress?: ProgressCallback;
    } = {},
  ) {
    this.entityCoreDir = entityCoreDir;
    this.entityName = entityName;
    this.userName = userName;
    this.entityPronouns = entityPronouns;
    this.userPronouns = userPronouns;
    this.relationshipContext = relationshipContext;
    this.contextNotes = contextNotes;
    this.llm = llm;
    this.rateLimitMs = rateLimitMs;
    this.maxContextTokens = maxContextTokens;
    this.onProgress = onProgress;
  }

  /**
   * Extract enduring patterns from all conversations in the Psycheros DB.
   * Returns the path to the output file, or null if no conversations found.
   */
  async extract(psycherosDir: string): Promise<string | null> {
    const db = new DBWriter(psycherosDir);
    try {
      // Step 1: Load all conversations from DB
      this.onProgress("Loading conversations from database...");
      const conversations = this.loadConversations(db);

      if (conversations.size === 0) {
        this.onProgress("No conversations found in database.");
        return null;
      }

      const convList = Array.from(conversations.values()).sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt),
      );

      const msgCount = convList.reduce((sum, c) => sum + c.messages.length, 0);
      const dateRange = this.getDateRange(convList);
      this.onProgress(`Loaded ${convList.length} conversations (${msgCount} messages, ${dateRange})`);

      // Step 2: Format conversations into text blocks
      this.onProgress("Formatting conversations...");
      const formatted = this.formatAllConversations(convList);

      // Step 3: Build chunks
      this.onProgress("Building chunks...");
      const chunks = this.buildChunks(formatted);
      this.onProgress(`Processing ${chunks.length} chunks...`);

      // Step 4: Phase 1 — extract candidates from each chunk
      const phase1Outputs: string[] = [];
      let failedChunks = 0;

      for (let i = 0; i < chunks.length; i++) {
        this.onProgress(`Phase 1: chunk ${i + 1}/${chunks.length}...`, i + 1, chunks.length);
        try {
          const prompt = this.buildPhase1Prompt(chunks[i]);
          const result = await this.llm.complete(
            [{ role: "user", content: prompt }],
            { temperature: 0.4 },
          );
          phase1Outputs.push(result.trim());
        } catch (error) {
          failedChunks++;
          this.onProgress(`Phase 1: chunk ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (i < chunks.length - 1) {
          await this.rateLimit();
        }
      }

      if (phase1Outputs.length === 0) {
        this.onProgress("All Phase 1 chunks failed. Nothing to aggregate.");
        return null;
      }

      this.onProgress(`Phase 1 complete: ${phase1Outputs.length} outputs${failedChunks > 0 ? ` (${failedChunks} failed)` : ""}`);

      // Step 5: Phase 2 — aggregate
      this.onProgress("Phase 2: aggregating patterns...");
      const allPhase1 = phase1Outputs.join("\n\n---\n\n");
      let finalContent = "";

      try {
        finalContent = await this.runPhase2(allPhase1);
      } catch (error) {
        // Retry with backoff (transient network / API issues)
        let succeeded = false;
        for (let attempt = 0; attempt < 3 && !succeeded; attempt++) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
          this.onProgress(`Phase 2 failed (attempt ${attempt + 1}/3), retrying in ${delay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          try {
            finalContent = await this.runPhase2(allPhase1);
            succeeded = true;
          } catch {
            // Continue retrying
          }
        }
        if (!succeeded) {
          this.onProgress("Phase 2 failed after 4 attempts. Writing raw Phase 1 outputs.");
          finalContent = this.buildRawFallback(phase1Outputs);
        }
      }

      // Step 6: Write output file
      const outputPath = await this.writeOutput(finalContent, convList);
      this.onProgress(`Output written to: ${outputPath}`);
      return outputPath;
    } finally {
      db.close();
    }
  }

  // --- Step 1: Load conversations from DB ---

  private loadConversations(db: DBWriter): Map<string, DbConversation> {
    const rows = db.query(`
      SELECT c.id, c.title, c.created_at, c.updated_at,
             m.role, m.content, m.created_at AS msg_created_at
      FROM conversations c
      INNER JOIN messages m ON m.conversation_id = c.id
      WHERE m.role IN ('user', 'assistant')
      ORDER BY c.created_at ASC, m.created_at ASC
    `);

    const map = new Map<string, DbConversation>();

    for (const row of rows) {
      const id = row.id as string;
      if (!map.has(id)) {
        map.set(id, {
          id,
          title: (row.title as string) || null,
          createdAt: row.created_at as string,
          updatedAt: row.updated_at as string,
          messages: [],
        });
      }
      map.get(id)!.messages.push({
        role: row.role as string,
        content: row.content as string,
        createdAt: row.msg_created_at as string,
      });
    }

    return map;
  }

  // --- Step 2: Format conversations ---

  private formatAllConversations(conversations: DbConversation[]): string {
    const parts: string[] = [];

    for (const conv of conversations) {
      const title = conv.title || "Untitled conversation";
      parts.push(`\n## Conversation: ${title}`);

      for (const msg of conv.messages) {
        // Same speaker-label pattern as memory-writer.ts but NO truncation
        const speaker = msg.role === "user" ? this.userName : this.entityName;
        parts.push(`**${speaker}**: ${msg.content}`);
      }
    }

    return parts.join("\n");
  }

  // --- Step 3: Build chunks ---

  private buildChunks(formattedText: string): string[] {
    // Budget: context window minus system prompt estimate minus response reserve
    const systemPromptEstimate = 2500;
    const responseReserve = 8000;
    const budgetChars = (this.maxContextTokens - systemPromptEstimate - responseReserve) * CHARS_PER_TOKEN;

    // Split at conversation boundaries ("## Conversation: ...")
    const convBlocks = formattedText.split(/(?=\n## Conversation:)/);

    if (convBlocks.length <= 1) {
      // Single conversation or no clear blocks — return as-is or split at message boundaries
      if (formattedText.length <= budgetChars) {
        return [formattedText];
      }
      return this.splitAtMessageBoundaries(formattedText, budgetChars);
    }

    const chunks: string[] = [];
    let currentChunk = "";

    for (const block of convBlocks) {
      if (!block.trim()) continue;

      if (currentChunk.length + block.length <= budgetChars) {
        currentChunk += block;
      } else {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        // Check if single block exceeds budget
        if (block.length > budgetChars) {
          chunks.push(...this.splitAtMessageBoundaries(block, budgetChars));
          currentChunk = "";
        } else {
          currentChunk = block;
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [formattedText];
  }

  private splitAtMessageBoundaries(text: string, maxChars: number): string[] {
    const chunks: string[] = [];
    const lines = text.split("\n");
    let current = "";
    let currentLen = 0;

    for (const line of lines) {
      const lineLen = line.length + 1; // +1 for newline
      if (currentLen + lineLen > maxChars && current.trim()) {
        chunks.push(current.trim());
        current = "";
        currentLen = 0;
      }
      current += line + "\n";
      currentLen += lineLen;
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks;
  }

  // --- Step 4: Phase 1 ---

  private buildPhase1Prompt(chunkText: string): string {
    const categoriesList = CORE_PROMPT_CATEGORIES
      .map((c) => `  ${c.file} (${c.group}: ${c.label}) — ${c.desc}`)
      .join("\n");

    return PHASE1_PROMPT
      .replace(/\{entityName\}/g, this.entityName)
      .replace(/\{entityPronouns\}/g, this.entityPronouns)
      .replace(/\{userName\}/g, this.userName)
      .replace(/\{userPronouns\}/g, this.userPronouns)
      .replace(/\{relationshipContext\}/g, this.relationshipContext)
      .replace(
        /\{contextNotesBlock\}/g,
        this.contextNotes ? `\nContext about this history:\n${this.contextNotes}\n` : "",
      )
      .replace("{categories}", categoriesList)
      .replace("{conversations}", chunkText);
  }

  // --- Step 5: Phase 2 ---

  private async runPhase2(allPhase1: string): Promise<string> {
    const systemPromptEstimate = 2500;
    const responseReserve = 8000;
    const budgetChars = (this.maxContextTokens - systemPromptEstimate - responseReserve) * CHARS_PER_TOKEN;

    const prompt = PHASE2_PROMPT
      .replace(/\{entityName\}/g, this.entityName)
      .replace(/\{entityPronouns\}/g, this.entityPronouns)
      .replace(/\{userName\}/g, this.userName)
      .replace(/\{userPronouns\}/g, this.userPronouns)
      .replace(/\{relationshipContext\}/g, this.relationshipContext)
      .replace(
        /\{contextNotesBlock\}/g,
        this.contextNotes ? `\nContext about this history:\n${this.contextNotes}\n` : "",
      );

    // Phase 2 produces long structured output — use 5-minute timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    const signal = controller.signal;

    if (allPhase1.length <= budgetChars) {
      // Fits in one call
      const result = await this.llm.complete(
        [{ role: "user", content: prompt.replace("{patterns}", allPhase1) }],
        { temperature: 0.3, signal },
      );
      clearTimeout(timeout);
      return result;
    }

    // Split into 2 calls
    const midpoint = Math.floor(allPhase1.length / 2);
    // Find nearest separator
    const separatorIdx = allPhase1.indexOf("\n\n---\n\n", midpoint - 50);
    const splitPoint = separatorIdx > 0 ? separatorIdx + 7 : midpoint;

    const part1 = allPhase1.substring(0, splitPoint);
    const part2 = allPhase1.substring(splitPoint);

    const result1 = await this.llm.complete(
      [{ role: "user", content: prompt.replace("{patterns}", part1 + "\n\n(Part 1 of 2 — more patterns follow)") }],
      { temperature: 0.3, signal },
    );
    await this.rateLimit();

    const result2 = await this.llm.complete(
      [{ role: "user", content: prompt.replace("{patterns}", part2 + "\n\n(Part 2 of 2 — continuation)") }],
      { temperature: 0.3, signal },
    );
    clearTimeout(timeout);

    // Simple merge: concatenate, removing duplicate headers
    const lines2 = result2.trim().split("\n");
    const merged = [result1.trim()];
    let skippingHeader = false;

    for (const line of lines2) {
      // Skip category headers that already appeared in part 1
      if (line.startsWith("# ") && result1.includes(line)) {
        skippingHeader = true;
        continue;
      }
      if (skippingHeader && line.startsWith("---")) {
        skippingHeader = false;
        continue;
      }
      if (skippingHeader && (line.startsWith("## ") || line.startsWith("**"))) {
        skippingHeader = false;
      }
      merged.push(line);
    }

    return merged.join("\n");
  }

  // --- Step 6: Write output ---

  private async writeOutput(content: string, conversations: DbConversation[]): Promise<string> {
    const dirPath = join(this.entityCoreDir, "custom");
    await Deno.mkdir(dirPath, { recursive: true });

    const dateRange = this.getDateRange(conversations);
    const generatedAt = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

    const header = [
      `<!-- Core Prompt Extraction — generated by entity-loom -->`,
      `<!--`,
      `  Entity: ${this.entityName} (${this.entityPronouns})`,
      `  User: ${this.userName} (${this.userPronouns})`,
      `  Relationship: ${this.relationshipContext}`,
      `  Conversations: ${conversations.length}`,
      `  Messages: ${conversations.reduce((sum, c) => sum + c.messages.length, 0)}`,
      `  Date range: ${dateRange}`,
      `  Generated: ${generatedAt}`,
      `-->`,
      ``,
      `# Core Prompt Extraction`,
      ``,
      `> Extracted from ${conversations.length} conversations (${dateRange}).`,
      `> Review each entry and copy-paste into the corresponding Core Prompt file.`,
      ``,
      `---`,
      ``,
    ].join("\n");

    const filePath = join(dirPath, "core_prompt_extraction.md");
    await Deno.writeTextFile(filePath, header + content + "\n");

    return filePath;
  }

  // --- Helpers ---

  private getDateRange(conversations: DbConversation[]): string {
    if (conversations.length === 0) return "N/A";

    const dates = conversations
      .map((c) => c.createdAt.substring(0, 10))
      .filter((d) => d.length >= 10)
      .sort();

    if (dates.length === 0) return "unknown";
    if (dates.length === 1) return dates[0];
    return `${dates[0]} to ${dates[dates.length - 1]}`;
  }

  private buildRawFallback(phase1Outputs: string[]): string {
    const parts = [
      "> **Note:** Phase 2 aggregation failed. Below are raw Phase 1 extraction results.",
      "> Some entries may be duplicated. Manual review recommended.",
      "",
    ];

    for (let i = 0; i < phase1Outputs.length; i++) {
      parts.push(`<!-- Raw output from chunk ${i + 1} -->`);
      parts.push(phase1Outputs[i]);
      parts.push("");
    }

    return parts.join("\n");
  }

  private rateLimit(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.rateLimitMs));
  }
}
