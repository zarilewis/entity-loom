/**
 * Entity Loom — Claude Parser
 *
 * Parses Claude/Anthropic data exports (JSONL format).
 *
 * Claude exports are JSONL files where each line is a conversation object.
 * Messages have role "human" or "assistant" with "text" content.
 */

import type { PlatformParser } from "./interface.ts";
import type { ImportedConversation, ImportedMessage, PlatformType } from "../types.ts";

interface ClaudeMessage {
  uuid: string;
  role: "human" | "assistant";
  text: string;
  created_at: string;
  model?: string;
  thinking?: string;
  attachments?: Array<{
    file_name?: string;
    file_type?: string;
    size_bytes?: number;
  }>;
}

interface ClaudeConversation {
  uuid: string;
  title?: string;
  chat_name?: string;
  created_at: string;
  updated_at: string;
  summary?: string | null;
  conversation: ClaudeMessage[];
}

export class ClaudeParser implements PlatformParser {
  readonly platform: PlatformType = "claude";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;

      const ext = filePath.toLowerCase();
      if (!ext.endsWith(".jsonl")) return false;

      // Read first line and check for Claude export structure
      const file = await Deno.open(filePath);
      const buf = new Uint8Array(2048);
      const n = await file.read(buf) ?? 0;
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      const firstLine = head.split("\n")[0];
      if (!firstLine) return false;

      const parsed = JSON.parse(firstLine);
      // Claude exports have "conversation" array with "human"/"assistant" roles
      return Array.isArray(parsed.conversation) &&
        parsed.conversation.length > 0 &&
        (parsed.conversation[0].role === "human" || parsed.conversation[0].role === "assistant");
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const text = await Deno.readTextFile(filePath);
    const lines = text.split("\n").filter((line) => line.trim());

    const conversations: ImportedConversation[] = [];
    const errors: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const conv = JSON.parse(lines[i]) as ClaudeConversation;
        const imported = this.parseConversation(conv);
        if (imported.messages.length > 0) {
          conversations.push(imported);
        }
      } catch (error) {
        errors.push(`Line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      console.warn(`[Claude] ${errors.length} lines had parse errors (skipped)`);
    }

    return conversations;
  }

  private parseConversation(conv: ClaudeConversation): ImportedConversation {
    const messages: ImportedMessage[] = [];

    for (const msg of conv.conversation) {
      // Map Claude roles to standard roles
      const role = msg.role === "human" ? "user" : "assistant";

      // Check for images in attachments
      let content = msg.text || "";
      if (msg.attachments && msg.attachments.length > 0) {
        content = "[image was here]\n" + content;
      }

      if (!content.trim()) continue;

      messages.push({
        id: msg.uuid,
        role,
        content,
        createdAt: new Date(msg.created_at),
        model: msg.model,
        reasoning: msg.role === "assistant" ? (msg.thinking || undefined) : undefined,
      });
    }

    const title = conv.title || conv.chat_name;

    return {
      id: conv.uuid,
      title: title ? `[claude] ${title}` : "[claude]Untitled",
      createdAt: new Date(conv.created_at),
      updatedAt: new Date(conv.updated_at),
      messages,
      platform: "claude",
      systemPrompts: [], // Claude exports don't include system prompts
    };
  }
}
