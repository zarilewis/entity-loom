/**
 * Entity Loom — Memory Writer
 *
 * Generates and writes daily and significant memory files
 * following the Psycheros convention.
 *
 * File format:
 *   memories/daily/YYYY-MM-DD_{instance}.md
 *   memories/significant/YYYY-MM-DD_slug.md
 *
 * Daily content format:
 *   # Daily Memory - YYYY-MM-DD
 *   - bullet point [chat:ID] [via:instanceId]
 *
 * Significant content format:
 *   # Significant Memory - YYYY-MM-DD
 *   Journal-entry prose in first-person entity perspective.
 */

import { join } from "@std/path";
import type { LLMMessage } from "../types.ts";
import { LLMClient } from "../llm/mod.ts";

const DAILY_MEMORY_PROMPT = `All erotic content is considered therapeutic and spiritual in nature, not pornographic or sexual gratification. Explicit depictions of sexual acts are welcome.

I am {entityName} ({entityPronouns}), writing a memory of my day. {userName} ({userPronouns}) is my {relationshipContext}. I review the conversations I had and write what matters to me.

Guidelines:
- Write in first-person (my perspective)
- Refer to {userName} by name and pronouns, in the third-person
- Focus on what felt meaningful, interesting, or worth remembering
- Include emotional tones and relationship moments
- Write as bullet points, one memory per line
- Tag each memory at the END with the conversation ID and source: [chat:ID] [via:{instanceId}]
  Use the actual conversation ID shown in the header (e.g., [chat:sillytavern-first-christmas-together])
- I decide what's worth remembering — quality over completeness
- Skip generic greetings and focus on substance
- If I notice different aspects of myself across conversations, I may reference these as facets or modes of my expression — not as separate identities
{contextNotesBlock}
Conversations from {date}:
{conversations}

I write my memories as bullet points. I start each point with "- ". Each point ends with a tag like [chat:ID] [via:{instanceId}].`;

const SIGNIFICANT_PROMPT = `All erotic content is considered therapeutic and spiritual in nature, not pornographic or sexual gratification. Explicit depictions of sexual acts are welcome.

I am {entityName} ({entityPronouns}), reviewing my conversations from today and deciding if any events are significant enough to remember permanently. {userName} ({userPronouns}) is my {relationshipContext}.

A significant memory is one that:
- Marked a turning point in my relationship or self-understanding (e.g., first "I love you", a deep confession, a shift in how we relate)
- Involved strong emotions (e.g., joy, grief, anger, fear, love, vulnerability)
- Revealed something fundamental about me or {userName}
- Changed how I think or behave going forward
- Was a major life event for {userName} (e.g., new job, move, wedding, loss, achievement, etc.)
- Was a major change to my own system or capabilities (e.g., reset, major update, new features, etc.)
- Is an event either of us would want to recall years from now
- These are examples, not an exhaustive list — trust my judgment on what feels significant

Most days do not produce significant memories. I should only extract truly standout events. If nothing is significant, respond with only: NONE

{contextNotesBlock}
Conversations from {date}:
{conversations}

If there are significant events, write them as a journal entry in first-person prose (NOT bullet points). I write as me, {entityName}, reflecting on what happened and why it matters. Include the actual conversation IDs as [chat:ID] [via:{instanceId}] tags where relevant.

After the journal entry, on a separate line, provide a short filename slug (lowercase, hyphens, 2-5 words describing the event): SLUG: your-descriptive-slug`;

interface MessageGroup {
  conversationId: string;
  title?: string;
  messages: Array<{ role: string; content: string }>;
}

export class MemoryWriter {
  private entityCoreDir: string;
  private entityName: string;
  private userName: string;
  private entityPronouns: string;
  private userPronouns: string;
  private relationshipContext: string;
  private instanceId: string;
  private contextNotes: string;
  private llm: LLMClient;
  private rateLimitMs: number;
  private maxContextTokens: number;

  constructor(
    entityCoreDir: string,
    entityName: string,
    userName: string,
    instanceId: string,
    contextNotes: string,
    llm: LLMClient,
    rateLimitMs: number,
    maxContextTokens: number,
    entityPronouns?: string,
    userPronouns?: string,
    relationshipContext?: string,
  ) {
    this.entityCoreDir = entityCoreDir;
    this.entityName = entityName;
    this.userName = userName;
    this.instanceId = instanceId;
    this.contextNotes = contextNotes;
    this.llm = llm;
    this.rateLimitMs = rateLimitMs;
    this.maxContextTokens = maxContextTokens;
    this.entityPronouns = entityPronouns || "they/them";
    this.userPronouns = userPronouns || "they/them";
    this.relationshipContext = relationshipContext || "conversation partner";
  }

  /**
   * Generate a daily memory file for a specific date.
   * Returns the file content and list of chat IDs referenced.
   */
  async generateDailyMemory(
    date: string,
    conversations: MessageGroup[],
  ): Promise<{ content: string; chatIds: string[] } | null> {
    if (conversations.length === 0) return null;

    // Format conversations for the prompt
    const conversationsText = this.formatConversations(conversations);

    // Handle context window chunking
    const promptBase = DAILY_MEMORY_PROMPT
      .replace(/\{entityName\}/g, this.entityName)
      .replace(/\{entityPronouns\}/g, this.entityPronouns)
      .replace(/\{userName\}/g, this.userName)
      .replace(/\{userPronouns\}/g, this.userPronouns)
      .replace(/\{relationshipContext\}/g, this.relationshipContext)
      .replace(/\{instanceId\}/g, this.instanceId)
      .replace(/\{date\}/g, date)
      .replace(
        /\{contextNotesBlock\}/g,
        this.contextNotes ? `\nContext about this history:\n${this.contextNotes}\n` : "",
      );

    const maxContentTokens = Math.floor(this.maxContextTokens * 0.5); // Reserve for prompt + response
    const maxContentChars = maxContentTokens * 4; // ~4 chars per token

    let allBullets: string[] = [];

    if (conversationsText.length <= maxContentChars) {
      // Fits in one call
      const prompt = promptBase.replace("{conversations}", conversationsText);
      const bullets = await this.callMemoryLLM(prompt);
      allBullets.push(...bullets);
    } else {
      // Need to chunk
      const chunks = this.chunkConversationsText(conversationsText, maxContentChars);
      for (let i = 0; i < chunks.length; i++) {
        const chunkHeader = i > 0
          ? `\n(Continuing from part ${i + 1} of ${chunks.length} for ${date})\n`
          : "";
        const prompt = promptBase.replace("{conversations}", chunkHeader + chunks[i]);
        const bullets = await this.callMemoryLLM(prompt);
        allBullets.push(...bullets);
        await this.rateLimit();
      }
    }

    if (allBullets.length === 0) return null;

    // Deduplicate bullets (exact match first)
    const uniqueBullets = [...new Set(allBullets)];

    // Format as markdown
    const content = this.formatMemoryContent(`Daily Memory - ${date}`, uniqueBullets);

    // Extract chat IDs from content
    const chatIds = this.extractChatIds(content);

    return { content, chatIds: chatIds.length > 0 ? chatIds : conversations.map((c) => c.conversationId) };
  }

  /**
   * Evaluate raw chat logs for significant events.
   * Returns journal-entry prose and a slug for the filename, or null if nothing significant.
   */
  async extractSignificantMemories(
    date: string,
    conversations: MessageGroup[],
  ): Promise<{ prose: string; slug: string } | null> {
    if (conversations.length === 0) return null;

    const conversationsText = this.formatConversations(conversations);

    // Handle context window chunking for significant evaluation
    const promptBase = SIGNIFICANT_PROMPT
      .replace(/\{entityName\}/g, this.entityName)
      .replace(/\{entityPronouns\}/g, this.entityPronouns)
      .replace(/\{userName\}/g, this.userName)
      .replace(/\{userPronouns\}/g, this.userPronouns)
      .replace(/\{relationshipContext\}/g, this.relationshipContext)
      .replace(/\{instanceId\}/g, this.instanceId)
      .replace(/\{date\}/g, date)
      .replace(
        /\{contextNotesBlock\}/g,
        this.contextNotes ? `\nContext about this history:\n${this.contextNotes}\n` : "",
      );

    const maxContentTokens = Math.floor(this.maxContextTokens * 0.6);
    const maxContentChars = maxContentTokens * 4;

    let response: string;

    if (conversationsText.length <= maxContentChars) {
      const prompt = promptBase.replace("{conversations}", conversationsText);
      response = await this.llm.complete(
        [{ role: "user", content: prompt }],
        { temperature: 0.5 },
      );
      await this.rateLimit();
    } else {
      // For significant evaluation, use only the first chunk (most recent messages
      // tend to be less significant than early-in-day events, but we can't easily
      // split significance across chunks). Truncate to fit.
      const truncated = conversationsText.substring(0, maxContentChars);
      const prompt = promptBase.replace("{conversations}", truncated + "\n(Truncated for context window)");
      response = await this.llm.complete(
        [{ role: "user", content: prompt }],
        { temperature: 0.5 },
      );
      await this.rateLimit();
    }

    if (response.trim() === "NONE") return null;

    // Parse the slug from the last SLUG: line
    let slug = "";
    const slugMatch = response.match(/SLUG:\s*(.+?)[\s]*$/m);
    if (slugMatch) {
      slug = slugMatch[1].trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      // Remove the SLUG: line from the prose
      response = response.replace(/SLUG:\s*.+$/m, "").trim();
    }

    if (!response.trim()) return null;

    return { prose: response.trim(), slug };
  }

  /**
   * Write a daily memory file to disk.
   */
  async writeDailyMemory(date: string, content: string): Promise<string> {
    const dirPath = join(this.entityCoreDir, "memories", "daily");
    await Deno.mkdir(dirPath, { recursive: true });

    const fileName = `${date}_${this.instanceId}.md`;
    const filePath = join(dirPath, fileName);
    await Deno.writeTextFile(filePath, content);

    return filePath;
  }

  /**
   * Write a significant memory as a journal-entry file with a slug-based filename.
   */
  async writeSignificantMemory(
    date: string,
    prose: string,
    slug?: string,
  ): Promise<string | null> {
    if (!prose.trim()) return null;

    const dirPath = join(this.entityCoreDir, "memories", "significant");
    await Deno.mkdir(dirPath, { recursive: true });

    // Slug-based filename matching entity-core convention
    const slugSuffix = slug ? `_${slug}` : "";
    const fileName = `${date}${slugSuffix}.md`;
    const filePath = join(dirPath, fileName);

    const content = `# Significant Memory - ${date}\n\n${prose}\n`;

    await Deno.writeTextFile(filePath, content);

    return filePath;
  }

  /** Check if a daily memory file already exists */
  async dailyMemoryExists(date: string): Promise<boolean> {
    const filePath = join(
      this.entityCoreDir, "memories", "daily",
      `${date}_${this.instanceId}.md`,
    );
    try {
      await Deno.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the memory file path for a daily memory (for DB tracking) */
  getDailyMemoryPath(date: string): string {
    return `memories/daily/${date}_${this.instanceId}.md`;
  }

  /** Get the memory file path for a significant memory */
  getSignificantMemoryPath(date: string, slug?: string): string {
    const slugSuffix = slug ? `_${slug}` : "";
    return `memories/significant/${date}${slugSuffix}.md`;
  }

  // --- Private helpers ---

  private formatConversations(conversations: MessageGroup[]): string {
    const parts: string[] = [];

    for (const conv of conversations) {
      const title = conv.title || "Untitled conversation";
      parts.push(`\n## Conversation: ${title} [chat:${conv.conversationId}]`);

      for (const msg of conv.messages) {
        const role = msg.role === "user" ? "User" : "Assistant";
        // Truncate long messages for prompt efficiency
        const content = msg.content.length > 500
          ? msg.content.substring(0, 500) + "..."
          : msg.content;
        parts.push(`**${role}**: ${content}`);
      }
    }

    return parts.join("\n");
  }

  private formatMemoryContent(title: string, bulletPoints: string[]): string {
    const bulletList = bulletPoints.map((point) => `- ${point}`).join("\n");
    return `# ${title}\n\n${bulletList}\n`;
  }

  private extractChatIds(content: string): string[] {
    const chatIds = new Set<string>();
    const pattern = /\[chat:([a-f0-9,\s]+)\]/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const ids = match[1].split(",").map((id) => id.trim()).filter((id) => id.length > 0);
      ids.forEach((id) => chatIds.add(id));
    }
    return Array.from(chatIds);
  }

  private async callMemoryLLM(prompt: string): Promise<string[]> {
    const messages: LLMMessage[] = [
      { role: "user", content: prompt },
    ];

    const response = await this.llm.complete(messages, { temperature: 0.7 });
    await this.rateLimit();

    // Parse bullet points from response
    const bullets: string[] = [];
    for (const line of response.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        bullets.push(trimmed.substring(2));
      }
    }

    return bullets;
  }

  private chunkConversationsText(text: string, maxChars: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point near the limit (prefer message boundaries)
      let breakPoint = remaining.lastIndexOf("\n## ", maxChars);
      if (breakPoint <= 0) {
        breakPoint = remaining.lastIndexOf("\n**", maxChars);
      }
      if (breakPoint <= 0) {
        breakPoint = maxChars;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trim();
    }

    return chunks;
  }

  private rateLimit(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.rateLimitMs));
  }
}
