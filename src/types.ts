/**
 * Entity Loom — Shared Types
 *
 * Core type definitions for the migration pipeline.
 */

/** Supported source platforms */
export type PlatformType = "chatgpt" | "claude" | "sillytavern" | "kindroid" | "letta";

/** A single message from an external platform, normalized for import */
export interface ImportedMessage {
  /** Original message/node ID from the platform */
  id: string;
  /** Normalized role */
  role: "user" | "assistant" | "system" | "tool";
  /** Text content (images replaced with [image was here]) */
  content: string;
  /** Original timestamp when the message was sent */
  createdAt: Date;
  /** Model slug if available from export metadata */
  model?: string;
  /** Whether this is a system prompt (extracted, not stored as message) */
  isSystemPrompt?: boolean;
  /** The actual system prompt text */
  systemPromptText?: string;
}

/** A conversation from an external platform, normalized for import */
export interface ImportedConversation {
  /** Original platform conversation ID — becomes the Psycheros chatID */
  id: string;
  /** Conversation title from the platform */
  title?: string;
  /** Original creation timestamp */
  createdAt: Date;
  /** Original last-updated timestamp */
  updatedAt: Date;
  /** Ordered messages (oldest first) */
  messages: ImportedMessage[];
  /** Source platform */
  platform: PlatformType;
  /** System prompts / custom instructions extracted (not stored as messages) */
  systemPrompts: string[];
  /** Platform-specific metadata (character name, user name, etc.) */
  metadata?: Record<string, string>;
}

/** Pipeline configuration — assembled from flags, env, and interactive input */
export interface PipelineConfig {
  platform: PlatformType;
  inputPath: string;
  psycherosDir: string;
  entityCoreDir: string;
  entityName: string;
  userName: string;
  contextNotes: string;
  instanceId: string;
  workerModel: string;
  maxContextTokens: number;
  rateLimitMs: number;
  dryRun: boolean;
  skipGraph: boolean;
  skipMemories: boolean;
  significanceThreshold: number;
  dateFrom?: string;
  dateTo?: string;
  costEstimate: boolean;
  /** Custom ID prefix (overrides auto-generated platform prefix) */
  idPrefix?: string;
}

/** Pipeline result — counts for each pass */
export interface PipelineResult {
  pass1: { conversationsParsed: number; conversationsSkipped: number };
  pass2: { conversationsStored: number; messagesStored: number };
  pass3: { dailyMemoriesCreated: number; significantMemoriesCreated: number };
  pass4: { nodesCreated: number; edgesCreated: number };
}

/** Checkpoint state — persisted between runs for resume support */
export interface CheckpointState {
  version: number;
  platform: PlatformType;
  instanceId: string;
  entityName: string;
  userName: string;
  contextNotes: string;
  inputPath: string;
  startedAt: string;
  pass1: {
    completed: boolean;
    conversationHashes: Record<string, string>;
    parseErrors: string[];
  };
  pass2: {
    completed: boolean;
    storedIds: string[];
  };
  pass3: {
    completed: boolean;
    processedDates: string[];
    failedDates: string[];
  };
  pass4: {
    completed: boolean;
    processedMemories: string[];
  };
}

/** LLM message for the client */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Progress callback for pipeline passes */
export type ProgressCallback = (message: string, current?: number, total?: number) => void;
