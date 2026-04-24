/**
 * Entity Loom — Letta Parser
 *
 * Placeholder parser for Letta (formerly MemGPT) exports.
 * Letta uses session-based conversations stored in SQLite or exportable via API.
 * This parser will be implemented once the export format is confirmed.
 */

import type { PlatformParser } from "./interface.ts";
import type { ImportedConversation, PlatformType } from "../types.ts";

export class LettaParser implements PlatformParser {
  readonly platform: PlatformType = "letta";

  async detect(_filePath: string): Promise<boolean> {
    // TODO: Implement Letta export detection
    return false;
  }

  async parse(_filePath: string): Promise<ImportedConversation[]> {
    throw new Error(
      "Letta parser is not yet implemented. " +
      "Please provide a sample Letta export file to help build this parser.",
    );
  }
}
