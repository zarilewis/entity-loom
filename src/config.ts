/**
 * Entity Loom — Configuration
 *
 * Loads configuration from environment variables, CLI flags, and interactive prompts.
 */

import type { PipelineConfig, PlatformType } from "./types.ts";

// Load .env file if present
try {
  const { loadSync } = await import("@std/dotenv");
  loadSync({ export: true });
} catch {
  // .env not present, that's fine
}

/**
 * Parse command-line flags from Deno.args.
 * Supports --flag value and --flag=value formats.
 * Boolean flags (--dry-run) default to true when present.
 */
export function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    const eqIndex = arg.indexOf("=");
    const key = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);

    if (eqIndex >= 0) {
      flags[key] = arg.slice(eqIndex + 1);
    } else if (args[i + 1] && !args[i + 1].startsWith("--")) {
      flags[key] = args[++i];
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** Build PipelineConfig from flags, env vars, and defaults */
export function buildConfig(flags: Record<string, string | boolean>): Partial<PipelineConfig> {
  return {
    platform: typeof flags.platform === "string"
      ? flags.platform as PlatformType
      : undefined,
    inputPath: typeof flags.input === "string" ? flags.input : undefined,
    psycherosDir: typeof flags["psycheros-dir"] === "string"
      ? flags["psycheros-dir"]
      : undefined,
    entityCoreDir: typeof flags["entity-core-dir"] === "string"
      ? flags["entity-core-dir"]
      : undefined,
    entityName: typeof flags["entity-name"] === "string"
      ? flags["entity-name"]
      : undefined,
    userName: typeof flags["user-name"] === "string"
      ? flags["user-name"]
      : undefined,
    contextNotes: typeof flags["context-notes"] === "string"
      ? flags["context-notes"]
      : undefined,
    instanceId: typeof flags["instance-id"] === "string"
      ? flags["instance-id"]
      : undefined,
    workerModel: typeof flags["worker-model"] === "string"
      ? flags["worker-model"]
      : Deno.env.get("WORKER_MODEL") || Deno.env.get("LLM_MODEL") || "google/gemini-2.5-flash",
    maxContextTokens: typeof flags["max-context-tokens"] === "string"
      ? parseInt(flags["max-context-tokens"])
      : 90000,
    rateLimitMs: typeof flags["rate-limit-ms"] === "string"
      ? parseInt(flags["rate-limit-ms"])
      : 2000,
    dryRun: flags["dry-run"] === true,
    skipGraph: flags["skip-graph"] === true,
    skipMemories: flags["skip-memories"] === true,
    significanceThreshold: typeof flags["significance-threshold"] === "string"
      ? parseFloat(flags["significance-threshold"])
      : 0.7,
    dateFrom: typeof flags["date-from"] === "string" ? flags["date-from"] : undefined,
    dateTo: typeof flags["date-to"] === "string" ? flags["date-to"] : undefined,
    costEstimate: flags["cost-estimate"] === true,
    idPrefix: typeof flags["id-prefix"] === "string" ? flags["id-prefix"] : undefined,
  };
}

/** Validate that all required config values are present */
export function validateConfig(config: PipelineConfig): string[] {
  const errors: string[] = [];

  if (!config.platform) errors.push("Platform is required");
  if (!config.inputPath) errors.push("Input path is required");
  if (!config.entityName) errors.push("Entity name is required");
  if (!config.userName) errors.push("User name is required");

  return errors;
}

/** Get LLM configuration from env vars */
export function getLLMConfig(): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: Deno.env.get("LLM_API_KEY") || "",
    baseUrl: Deno.env.get("LLM_BASE_URL") || "https://openrouter.ai/api/v1",
    model: Deno.env.get("LLM_MODEL") || "google/gemini-2.5-flash",
  };
}
