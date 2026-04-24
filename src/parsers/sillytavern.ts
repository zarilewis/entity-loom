/**
 * Entity Loom — SillyTavern Parser
 *
 * Parses SillyTavern chat files (JSONL format, one file per chat).
 *
 * Each JSONL file represents a single chat. The first line is a header with
 * chat_metadata, user_name, and character_name. Subsequent lines are messages.
 */

import type { PlatformParser } from "./interface.ts";
import type { ImportedConversation, ImportedMessage, PlatformType } from "../types.ts";
import { sha256Hex } from "../dedup/content-hash.ts";

interface STHeader {
  chat_metadata: Record<string, unknown>;
  user_name: string;
  character_name: string;
  create_date?: string;
}

interface STMessage {
  name: string;
  is_user: boolean;
  send_date: string;
  mes: string;
  extra?: Record<string, unknown>;
  swipes?: string[];
  swipe_id?: number;
  force_avatar?: string;
  gen_started?: string;
  gen_finished?: string;
}

export class SillyTavernParser implements PlatformParser {
  readonly platform: PlatformType = "sillytavern";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;
      if (!filePath.endsWith(".jsonl")) return false;

      // Read first line and check for SillyTavern header structure
      const file = await Deno.open(filePath);
      const buf = new Uint8Array(1024);
      const n = await file.read(buf);
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      const firstLine = head.split("\n")[0];
      if (!firstLine) return false;

      const parsed = JSON.parse(firstLine);
      // SillyTavern headers have chat_metadata, user_name, character_name
      return "chat_metadata" in parsed &&
        "user_name" in parsed &&
        "character_name" in parsed;
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const stat = await Deno.stat(filePath);

    // Single file = single chat
    if (stat.isFile) {
      const conv = await this.parseChatFile(filePath);
      return conv.messages.length > 0 ? [conv] : [];
    }

    // Directory = multiple chat files
    if (stat.isDirectory) {
      const conversations: ImportedConversation[] = [];
      for await (const entry of Deno.readDir(filePath)) {
        if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
        const conv = await this.parseChatFile(`${filePath}/${entry.name}`);
        if (conv.messages.length > 0) {
          conversations.push(conv);
        }
      }
      return conversations;
    }

    throw new Error(`Not a file or directory: ${filePath}`);
  }

  private async parseChatFile(filePath: string): Promise<ImportedConversation> {
    const text = await Deno.readTextFile(filePath);
    const lines = text.split("\n").filter((line) => line.trim());

    if (lines.length === 0) {
      throw new Error(`Empty chat file: ${filePath}`);
    }

    // Parse header (first line)
    const header = JSON.parse(lines[0]) as STHeader;
    const messages: ImportedMessage[] = [];

    // Use filename as conversation ID (strip .jsonl)
    const fileName = filePath.split("/").pop()?.replace(".jsonl", "") || "unknown";

    for (let i = 1; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]) as STMessage;
        if (!msg.mes?.trim()) continue;

        // Generate stable message ID from timestamp + content hash
        const id = await this.generateMessageId(msg, i);

        const role = msg.is_user ? "user" : "assistant";

        // Replace image references with [image was here]
        const content = this.cleanContent(msg.mes);

        // Skip messages with no timestamp
        if (!msg.send_date) continue;

        messages.push({
          id,
          role,
          content,
          createdAt: new Date(msg.send_date),
        });
      } catch {
        // Skip malformed message lines
        continue;
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const title = header.character_name || fileName;

    return {
      id: `st-${fileName}`,
      title: `[sillytavern] ${title}`,
      createdAt: messages.length > 0 ? messages[0].createdAt : new Date(),
      updatedAt: messages.length > 0 ? messages[messages.length - 1].createdAt : new Date(),
      messages,
      platform: "sillytavern",
      systemPrompts: [], // SillyTavern doesn't export system prompts in chat files
      metadata: {
        characterName: header.character_name,
        userName: header.user_name,
      },
    };
  }

  /**
   * Generate a stable message ID from the message content and position.
   */
  private async generateMessageId(msg: STMessage, index: number): Promise<string> {
    const content = msg.mes || "";
    const timestamp = msg.send_date || "";
    const hash = await sha256Hex(`${timestamp}:${index}:${content}`);
    return `st-msg-${hash.slice(0, 16)}`;
  }

  /**
   * Clean message content, replacing image references with placeholder.
   */
  private cleanContent(content: string): string {
    // Replace markdown image syntax
    let cleaned = content.replace(/!\[[^\]]*\]\([^)]+\)/g, "[image was here]");
    // Replace HTML img tags
    cleaned = cleaned.replace(/<img[^>]*>/gi, "[image was here]");
    // Replace ST-specific image embedding format
    cleaned = cleaned.replace(/\[img\b[^\]]*\][^\[]*?\[\/img\]/gi, "[image was here]");
    return cleaned;
  }
}
