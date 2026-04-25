/**
 * Entity Loom — ChatGPT Parser
 *
 * Parses ChatGPT data exports (conversations.json).
 *
 * ChatGPT exports are a single JSON file where each key is a conversation UUID.
 * The `mapping` field contains a tree structure supporting branching (regeneration).
 * We follow `current_node` to get the canonical conversation thread.
 */

import type { PlatformParser } from "./interface.ts";
import type { ImportedConversation, ImportedMessage, PlatformType } from "../types.ts";

interface ChatGPTContentPart {
  content_type: string;
  text?: string;
  asset_pointer?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
}

interface ChatGPTMessage {
  id: string;
  author: { role: string; name?: string };
  content: {
    content_type: string;
    parts: Array<string | ChatGPTContentPart>;
  };
  create_time: number;
  update_time: number;
  metadata?: {
    model_slug?: string;
    is_user_system_message?: boolean;
    conversation_id?: string;
    user_id?: string;
    parent_message_id?: string;
  };
  status?: string;
  end_turn?: boolean;
  weight?: number;
}

interface ChatGPTNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTConversation {
  title?: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, ChatGPTNode>;
  current_node: string;
  conversation_template?: string | null;
  conversation_mode?: Record<string, unknown> | null;
  gizmo_id?: string | null;
  is_archived?: boolean;
  id: string;
}

export class ChatGPTParser implements PlatformParser {
  readonly platform: PlatformType = "chatgpt";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;
      if (!filePath.endsWith(".json")) return false;

      // Read first 1KB and check for ChatGPT export structure
      const file = await Deno.open(filePath);
      const buf = new Uint8Array(1024);
      const n = await file.read(buf) ?? 0;
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      // ChatGPT exports have mapping/current_node/title/create_time fields
      return head.includes('"mapping"') && head.includes('"current_node"');
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const raw = await Deno.readTextFile(filePath);
    const data = JSON.parse(raw) as Record<string, ChatGPTConversation>;

    const conversations: ImportedConversation[] = [];
    const errors: string[] = [];

    for (const [convId, conv] of Object.entries(data)) {
      try {
        const imported = this.parseConversation(convId, conv);
        if (imported.messages.length > 0) {
          conversations.push(imported);
        }
      } catch (error) {
        errors.push(`Conversation ${convId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      console.warn(`[ChatGPT] ${errors.length} conversations had parse errors (skipped)`);
    }

    return conversations;
  }

  private parseConversation(convId: string, conv: ChatGPTConversation): ImportedConversation {
    // Walk the tree from current_node to get the canonical thread
    const nodes = this.walkTree(conv.mapping, conv.current_node);

    const messages: ImportedMessage[] = [];
    const systemPrompts: string[] = [];

    for (const node of nodes) {
      if (!node.message) continue;

      const msg = node.message;

      // Extract system prompts / custom instructions
      if (
        msg.author.role === "system" &&
        msg.metadata?.is_user_system_message === true
      ) {
        const text = this.extractText(msg);
        if (text) systemPrompts.push(text);
        continue;
      }

      // Skip null-content system messages (structural nodes)
      if (msg.author.role === "system") continue;

      // Skip tool messages
      if (msg.author.role === "tool") continue;

      // Map roles
      const role = msg.author.role === "user" ? "user" : "assistant";
      const content = this.extractText(msg);

      // Skip empty messages
      if (!content.trim()) continue;

      messages.push({
        id: msg.id,
        role,
        content,
        createdAt: new Date(msg.create_time * 1000),
        model: msg.metadata?.model_slug,
      });
    }

    return {
      id: conv.id || convId,
      title: conv.title ? `[chatgpt] ${conv.title}` : "[chatgpt]Untitled",
      createdAt: new Date(conv.create_time * 1000),
      updatedAt: new Date(conv.update_time * 1000),
      messages,
      platform: "chatgpt",
      systemPrompts,
    };
  }

  /**
   * Walk the conversation tree from current_node to root,
   * collecting nodes in chronological order (oldest first).
   */
  private walkTree(
    mapping: Record<string, ChatGPTNode>,
    current_node: string,
  ): ChatGPTNode[] {
    const nodes: ChatGPTNode[] = [];
    let nodeId: string | null = current_node;

    while (nodeId) {
      const node: ChatGPTNode | undefined = mapping[nodeId];
      if (!node) break;
      if (node.message !== null) {
        nodes.unshift(node); // Build oldest-first
      }
      nodeId = node.parent;
    }

    return nodes;
  }

  /**
   * Extract text content from a ChatGPT message.
   * Handles multimodal content by replacing images with [image was here].
   */
  private extractText(msg: ChatGPTMessage): string {
    if (!msg.content?.parts) return "";

    const textParts: string[] = [];

    for (const part of msg.content.parts) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (part.content_type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.asset_pointer) {
        // Image or other media asset
        textParts.push("[image was here]");
      }
    }

    return textParts.join("\n");
  }
}
