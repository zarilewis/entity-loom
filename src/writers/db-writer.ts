/**
 * Entity Loom — DB Writer
 *
 * Writes conversations and messages to the Psycheros SQLite database.
 * Matches the exact schema from Psycheros src/db/schema.ts.
 */

import { join } from "@std/path";
import type { ImportedConversation, ProgressCallback } from "../types.ts";

/** Schema SQL for the tables entity-loom writes to */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    reasoning_content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id);

  CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON messages(conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
    ON conversations(updated_at);

  CREATE TABLE IF NOT EXISTS memory_summaries (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    granularity TEXT NOT NULL CHECK (granularity IN ('daily', 'weekly', 'monthly', 'yearly')),
    file_path TEXT NOT NULL,
    chat_ids TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_summaries_date
    ON memory_summaries(date);

  CREATE TABLE IF NOT EXISTS summarized_chats (
    chat_id TEXT NOT NULL,
    message_date TEXT NOT NULL,
    summary_id TEXT NOT NULL,
    summarized_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_date),
    FOREIGN KEY (summary_id) REFERENCES memory_summaries(id) ON DELETE CASCADE
  );
`;

export class DBWriter {
  private db: Deno.Sqlite;
  private dbPath: string;

  constructor(psycherosDir: string) {
    this.dbPath = join(psycherosDir, "psycheros.db");
    this.db = new Deno.Sqlite(this.dbPath);
  }

  /** Initialize the database schema (idempotent) */
  init(): void {
    this.db.exec(SCHEMA_SQL);
  }

  /** Get a list of conversation IDs already in the database */
  getExistingConversationIds(): Set<string> {
    const result = this.db.query<[string]>("SELECT id FROM conversations");
    return new Set(result.map((row) => row[0]));
  }

  /**
   * Write a conversation and its messages to the database.
   * Returns the number of messages written.
   */
  writeConversation(conv: ImportedConversation): number {
    const createdAt = conv.createdAt.toISOString();
    const updatedAt = conv.updatedAt.toISOString();

    // Upsert conversation
    this.db.exec(
      `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [conv.id, conv.title || null, createdAt, updatedAt],
    );

    let messageCount = 0;

    // Insert messages (skip system and tool messages)
    const insertMsg = this.db.prepare(
      `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const msg of conv.messages) {
      if (msg.role === "system" || msg.role === "tool") continue;

      insertMsg.run([
        msg.id,
        conv.id,
        msg.role,
        msg.content,
        msg.createdAt.toISOString(),
      ]);
      messageCount++;
    }

    return messageCount;
  }

  /**
   * Record a memory summary in the database for tracking.
   * Matches Psycheros' pattern so the consolidation system recognizes it.
   */
  recordMemorySummary(
    date: string,
    granularity: string,
    filePath: string,
    chatIds: string[],
  ): void {
    const summaryId = `loom-${granularity}-${date}`;
    const chatIdsStr = chatIds.join(",");

    this.db.exec(
      `INSERT OR IGNORE INTO memory_summaries (id, date, granularity, file_path, chat_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [summaryId, date, granularity, filePath, chatIdsStr, new Date().toISOString()],
    );

    const markSummarized = this.db.prepare(
      `INSERT OR IGNORE INTO summarized_chats (chat_id, message_date, summary_id, summarized_at)
       VALUES (?, ?, ?, ?)`,
    );

    for (const chatId of chatIds) {
      markSummarized.run([chatId, date, summaryId, new Date().toISOString()]);
    }
  }

  /** Get all messages for a specific date */
  getMessagesByDate(date: string): Array<{
    id: string;
    conversationId: string;
    role: string;
    content: string;
    createdAt: string;
  }> {
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    const result = this.db.query<[string, string, string, string, string]>(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages
       WHERE created_at >= ? AND created_at <= ? AND role IN ('user', 'assistant')
       ORDER BY created_at`,
      [startOfDay, endOfDay],
    );

    return result.map((row) => ({
      id: row[0],
      conversationId: row[1],
      role: row[2],
      content: row[3],
      createdAt: row[4],
    }));
  }

  /** Get conversation title by ID */
  getConversationTitle(convId: string): string | null {
    const result = this.db.query<[string]>(
      "SELECT title FROM conversations WHERE id = ?",
      [convId],
    );
    return result[0]?.[0] || null;
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  /**
   * Execute a parameterized query and return typed rows.
   * Exposes the underlying Deno.Sqlite query for pipeline passes.
   */
  query<T extends unknown[]>(sql: string, params?: unknown[]): Array<{ [K in keyof T]: T[number] }> {
    return params ? this.db.query<T>(sql, params as T) : this.db.query<T>(sql);
  }
}
