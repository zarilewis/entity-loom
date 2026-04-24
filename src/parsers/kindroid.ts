/**
 * Entity Loom — Kindroid Parser
 *
 * Placeholder parser for Kindroid AI exports.
 * Kindroid uses an API-based format similar to OpenAI chat completions.
 * This parser will be implemented once the export format is confirmed.
 */

import type { PlatformParser } from "./interface.ts";
import type { ImportedConversation, PlatformType } from "../types.ts";

export class KindroidParser implements PlatformParser {
  readonly platform: PlatformType = "kindroid";

  async detect(_filePath: string): Promise<boolean> {
    // TODO: Implement Kindroid export detection
    return false;
  }

  async parse(_filePath: string): Promise<ImportedConversation[]> {
    throw new Error(
      "Kindroid parser is not yet implemented. " +
      "Please provide a sample Kindroid export file to help build this parser.",
    );
  }
}
