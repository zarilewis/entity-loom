/**
 * Entity Loom — Context Window Chunker
 *
 * Splits conversation messages into chunks that fit within
 * the worker model's context window.
 */

import type { ImportedConversation } from "../types.ts";

/** ~4 characters per token for English text */
const CHARS_PER_TOKEN = 4;

export interface MessageChunk {
  messages: Array<{ role: string; content: string; conversationId: string }>;
  tokenEstimate: number;
  chunkIndex: number;
  totalChunks: number;
}

/**
 * Split messages into chunks that fit within the context window.
 * Leaves headroom for the system prompt and LLM response.
 */
export function chunkMessages(
  messages: Array<{ role: string; content: string; conversationId: string }>,
  maxContextTokens: number,
): MessageChunk[] {
  // Reserve 40% for system prompt + response
  const maxContentTokens = Math.floor(maxContextTokens * 0.6);
  const maxContentChars = maxContentTokens * CHARS_PER_TOKEN;

  // Calculate total content size
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  if (totalChars <= maxContentChars) {
    return [{
      messages,
      tokenEstimate: Math.ceil(totalChars / CHARS_PER_TOKEN),
      chunkIndex: 0,
      totalChunks: 1,
    }];
  }

  // Need to chunk — split by message boundaries
  const chunks: MessageChunk[] = [];
  let currentChunk: typeof messages = [];
  let currentChars = 0;

  for (const msg of messages) {
    if (currentChars + msg.content.length > maxContentChars && currentChunk.length > 0) {
      chunks.push({
        messages: currentChunk,
        tokenEstimate: Math.ceil(currentChars / CHARS_PER_TOKEN),
        chunkIndex: chunks.length,
        totalChunks: 0, // Will be updated at the end
      });
      currentChunk = [msg];
      currentChars = msg.content.length;
    } else {
      currentChunk.push(msg);
      currentChars += msg.content.length;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      messages: currentChunk,
      tokenEstimate: Math.ceil(currentChars / CHARS_PER_TOKEN),
      chunkIndex: chunks.length,
      totalChunks: 0,
    });
  }

  // Set totalChunks on each chunk
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.totalChunks = total;
  }

  return chunks;
}
