/**
 * Entity Loom — Memory Writer
 *
 * Generates and writes daily and significant memory files
 * following the Psycheros convention.
 *
 * File format:
 *   memories/daily/YYYY-MM-DD_{instance}.md
 *   memories/significant/YYYY-MM-DD.md
 *
 * Content format:
 *   # Daily Memory - YYYY-MM-DD
 *   - bullet point [chat:ID] [via:instanceId]
 */

import { join } from "@std/path";
import type { ProgressCallback, LLMMessage } from "../types.ts";
import { LLMClient } from "../llm/mod.ts";

const DAILY_MEMORY_PROMPT = `I am the AI entity in this conversation, writing a memory of my day. I review the conversations I had and write what matters to me.

Guidelines:
- Write in first-person (my perspective)
- Refer to {userName} by name and preferred pronouns, in the third-person
- Focus on what felt meaningful, interesting, or worth remembering
- Include emotional tones and relationship moments
- Tag each memory with the conversation ID and my instance: [chat:ID] [via:{instanceId}]
- I decide what's worth remembering - quality over completeness
- Skip generic greetings and focus on substance
- If I notice different aspects of myself across conversations, I may reference these as facets or modes of my expression — not as separate identities
- Write as bullet points, one memory per line
{contextNotesBlock}
Conversations from {date}:
{conversations}

I write my memories as bullet points. I start each point with "- ".`;

const SIGNIFICANT_PROMPT = `I am reviewing my daily memory and deciding if any events are significant enough to remember permanently.

A significant memory is one that:
- Marked a turning point in my relationship or self-understanding
- Involved strong emotions (joy, grief, anger, fear, love)
- Revealed something fundamental about me or {userName}
- Changed how I think or behave going forward
- Was a major life event for {userName} (new job, move, wedding, loss, achievement)
- Was a major change to my own system or capabilities (reset, major update, new features)
- Is an event either of us would want to recall years from now
{contextNotesBlock}
Daily memory from {date}:
{dailyMemory}

If there are significant events, write them as bullet points starting with "- ".
Each point should include [chat:ID] [via:{instanceId}].
If nothing is significant, respond with only: NONE`;

interface MessageGroup {
  conversationId: string;
  title?: string;
  messages: Array<{ role: string; content: string }>;
}

export class MemoryWriter {
  private entityCoreDir: string;
  private entityName: string;
  private userName: string;
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
  ) {
    this.entityCoreDir = entityCoreDir;
    this.entityName = entityName;
    this.userName = userName;
    this.instanceId = instanceId;
    this.contextNotes = contextNotes;
    this.llm = llm;
    this.rateLimitMs = rateLimitMs;
    this.maxContextTokens = maxContextTokens;
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
      .replace(/\{userName\}/g, this.userName)
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
          ? `\n(Continuing from part ${i} of ${chunks.length} for ${date})\n`
          : "";
        const prompt = promptBase.replace("{conversations}", chunkHeader + chunks[i]);
        const bullets = await this.callMemoryLLM(prompt);
        allBullets.push(...bullets);
        await this.rateLimit();
      }
    }

    if (allBullets.length === 0) return null;

    // Deduplicate bullets (fuzzy — exact match first)
    const uniqueBullets = [...new Set(allBullets)];

    // Format as markdown
    const content = this.formatMemoryContent(`Daily Memory - ${date}`, uniqueBullets);

    // Extract chat IDs from content
    const chatIds = this.extractChatIds(content);

    return { content, chatIds: chatIds.length > 0 ? chatIds : conversations.map((c) => c.conversationId) };
  }

  /**
   * Evaluate a daily memory for significant events.
   * Returns bullet points for significant events, or null if none.
   */
  async extractSignificantMemories(
    date: string,
    dailyMemory: string,
  ): Promise<string[] | null> {
    const prompt = SIGNIFICANT_PROMPT
      .replace(/\{userName\}/g, this.userName)
      .replace(/\{instanceId\}/g, this.instanceId)
      .replace(/\{date\}/g, date)
      .replace(
        /\{contextNotesBlock\}/g,
        this.contextNotes ? `\nContext about this history:\n${this.contextNotes}\n` : "",
      )
      .replace("{dailyMemory}", dailyMemory);

    const response = await this.llm.complete(
      [{ role: "user", content: prompt }],
      { temperature: 0.3 },
    );

    await this.rateLimit();

    if (response.trim() === "NONE") return null;

    // Parse bullet points
    const bullets: string[] = [];
    for (const line of response.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        bullets.push(trimmed.substring(2));
      }
    }

    return bullets.length > 0 ? bullets : null;
  }

  /**
   * Write a daily memory file to disk.
   */
  async writeDailyMemory(date: string, content: string): Promise<string> {
    const dirPath = join(this.entityCoreDir, "data", "memories", "daily");
    await Deno.mkdir(dirPath, { recursive: true });

    const fileName = `${date}_${this.instanceId}.md`;
    const filePath = join(dirPath, fileName);
    await Deno.writeTextFile(filePath, content);

    return filePath;
  }

  /**
   * Write or append significant memories to a file.
   */
  async writeSignificantMemory(date: string, bullets: string[]): Promise<string | null> {
    if (bullets.length === 0) return null;

    const dirPath = join(this.entityCoreDir, "data", "memories", "significant");
    await Deno.mkdir(dirPath, { recursive: true });

    const fileName = `${date}.md`;
    const filePath = join(dirPath, fileName);

    const content = this.formatMemoryContent(`Significant Memory - ${date}`, bullets);

    // Append if file exists (significant memories can come from multiple sources)
    try {
      const existing = await Deno.readTextFile(filePath);
      await Deno.writeTextFile(filePath, existing + "\n" + content);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await Deno.writeTextFile(filePath, content);
      } else {
        throw error;
      }
    }

    return filePath;
  }

  /** Check if a daily memory file already exists */
  async dailyMemoryExists(date: string): Promise<boolean> {
    const filePath = join(
      this.entityCoreDir, "data", "memories", "daily",
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
  getSignificantMemoryPath(date: string): string {
    return `memories/significant/${date}.md`;
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
      { role: "system", content: `I am ${this.entityName}. I write my memories in first-person. ${this.userName} is the person I talk with.` },
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
