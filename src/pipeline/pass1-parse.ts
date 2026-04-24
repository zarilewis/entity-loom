/**
 * Entity Loom — Pass 1: Parse
 *
 * Parses the export file and normalizes into ImportedConversation[].
 * Applies ID prefix to conversation IDs to prevent conflicts with
 * existing Psycheros chatIDs.
 */

import type {
  ImportedConversation,
  PlatformType,
  CheckpointState,
  ProgressCallback,
} from "../types.ts";
import { createParser } from "../parsers/mod.ts";
import { hashConversation } from "../dedup/content-hash.ts";

/**
 * Apply prefix to a conversation ID.
 * Uses custom prefix if provided, otherwise uses the platform name.
 */
function prefixConvId(id: string, platform: PlatformType, customPrefix?: string): string {
  const prefix = customPrefix || platform;
  return `${prefix}-${id}`;
}

/**
 * Apply prefix to conversation ID. Message IDs are kept as-is.
 */
function prefixConversationIds(
  conv: ImportedConversation,
  platform: PlatformType,
  customPrefix?: string,
): ImportedConversation {
  const prefixedConvId = prefixConvId(conv.id, platform, customPrefix);

  return {
    ...conv,
    id: prefixedConvId,
  };
}

/**
 * Parse the export file and return conversations, skipping already-parsed ones.
 * Conversation IDs are prefixed; message IDs are preserved as-is.
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
    // Apply prefix to conversation ID
    const prefixed = prefixConversationIds(conv, platform, idPrefix);

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
