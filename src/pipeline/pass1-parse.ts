/**
 * Entity Loom — Pass 1: Parse
 *
 * Parses the export file and normalizes into ImportedConversation[].
 * Applies ID prefix to conversation and message IDs to prevent
 * conflicts with existing Psycheros chatIDs.
 *
 * Message IDs are shortened to a hash to keep memory file [chat:ID] tags
 * compact (important for RAG token efficiency over hundreds of memory files).
 */

import type {
  ImportedConversation,
  PlatformType,
  CheckpointState,
  ProgressCallback,
} from "../types.ts";
import { createParser } from "../parsers/mod.ts";
import { hashConversation, sha256Hex } from "../dedup/content-hash.ts";

/**
 * Apply prefix to a conversation ID.
 * Uses custom prefix if provided, otherwise uses the platform name.
 */
function prefixConvId(id: string, platform: PlatformType, customPrefix?: string): string {
  const prefix = customPrefix || platform;
  return `${prefix}-${id}`;
}

/**
 * Generate a short, unique message ID from the original ID.
 * Uses first 12 chars of SHA-256 to keep IDs compact for memory file tags.
 *
 * Without this, ChatGPT message IDs produce tags like:
 *   [chat:chatgpt-550e8400-e29b-41d4-a716-446655440000] (51 chars)
 *
 * With shortening:
 *   [chat:chatgpt-a3f2b1c8d4e0] (27 chars) — nearly half the size
 *
 * Over 365 daily memories referencing 5-10 chats each, this saves
 * significant tokens in RAG indexes.
 */
async function shortMessageId(originalId: string): Promise<string> {
  const hash = await sha256Hex(originalId);
  return hash.slice(0, 12);
}

/**
 * Apply prefix to all IDs in a conversation.
 */
async function prefixConversationIds(
  conv: ImportedConversation,
  platform: PlatformType,
  customPrefix?: string,
): Promise<ImportedConversation> {
  const prefixedConvId = prefixConvId(conv.id, platform, customPrefix);

  const messages = await Promise.all(
    conv.messages.map(async (msg) => ({
      ...msg,
      id: `${prefixedConvId}-msg-${await shortMessageId(msg.id)}`,
    })),
  );

  return {
    ...conv,
    id: prefixedConvId,
    messages,
  };
}

/**
 * Parse the export file and return conversations, skipping already-parsed ones.
 * All conversation and message IDs are prefixed.
 */
export async function parseExport(
  inputPath: string,
  platform: PlatformType,
  checkpoint: CheckpointState,
  onProgress?: ProgressCallback,
  idPrefix?: string,
): Promise<{ conversations: ImportedConversation[]; skipped: number }> {
  const parser = createParser(platform);
  const allConversations = await parser.parse(inputPath);

  onProgress?.(`Parsed ${allConversations.length} conversations from ${inputPath}`);

  const conversations: ImportedConversation[] = [];
  let skipped = 0;

  for (const conv of allConversations) {
    // Apply prefix to all IDs
    const prefixed = await prefixConversationIds(conv, platform, idPrefix);

    // Check dedup hash (computed on raw content, keyed by prefixed ID)
    const hash = await hashConversation(conv);

    if (checkpoint.pass1.conversationHashes[prefixed.id] === hash) {
      skipped++;
      continue;
    }

    conversations.push(prefixed);
    checkpoint.pass1.conversationHashes[prefixed.id] = hash;
  }

  if (skipped > 0) {
    onProgress?.(`Skipped ${skipped} already-parsed conversations (dedup)`);
  }

  return { conversations, skipped };
}
