/**
 * Entity Loom — Command Handlers
 *
 * Implements the import, resume, and analyze CLI commands.
 */

import { join } from "@std/path";
import type { PipelineConfig, PlatformType, CheckpointState } from "../types.ts";
import { buildConfig, validateConfig, getLLMConfig } from "../config.ts";
import { ProgressReporter } from "./progress.ts";
import { askString, askChoice, askConfirm, askMultiline } from "./prompts.ts";
import { detectPlatform, getRegisteredPlatforms } from "../parsers/mod.ts";
import { CheckpointManager } from "../dedup/checkpoint.ts";
import { runPipeline } from "../pipeline/orchestrator.ts";
import { CorePromptAnalyzer } from "../writers/core-prompt.ts";
import { LLMClient } from "../llm/mod.ts";

/**
 * Interactive import command — guides user through the full pipeline.
 */
export async function import(flags: Record<string, string | boolean>): Promise<void> {
  const progress = new ProgressReporter("[entity-loom]");
  const partial = buildConfig(flags);

  // Step 1: Platform
  let platform = partial.platform;
  if (!platform) {
    const options = getRegisteredPlatforms().map((p) => ({
      label: p.charAt(0).toUpperCase() + p.slice(1),
      value: p,
    }));
    platform = await askChoice("Which platform are you importing from?", options) as PlatformType;
  }

  // Step 2: Input path
  let inputPath = partial.inputPath;
  if (!inputPath) {
    inputPath = await askString("Path to export file or directory");
  }

  // Validate input exists
  try {
    await Deno.stat(inputPath);
  } catch {
    progress.error(`File not found: ${inputPath}`);
    Deno.exit(1);
  }

  // Auto-detect platform if not specified
  if (!platform) {
    const detected = await detectPlatform(inputPath);
    if (detected) {
      platform = detected;
      progress.log(`Detected platform: ${platform}`);
    } else {
      platform = await askChoice(
        "Could not detect platform. Which platform?",
        getRegisteredPlatforms().map((p) => ({
          label: p.charAt(0).toUpperCase() + p.slice(1),
          value: p,
        })),
      ) as PlatformType;
    }
  }

  // Step 3: Entity name
  let entityName = partial.entityName;
  if (!entityName) {
    entityName = await askString("What name should the entity be called in memories?");
  }

  // Step 4: User name
  let userName = partial.userName;
  if (!userName) {
    userName = await askString("What is your name (for memory writing)?");
  }

  // Step 5: Context notes
  let contextNotes = partial.contextNotes || "";
  if (!contextNotes && !partial.contextNotes) {
    contextNotes = await askMultiline(
      "Any context about the conversation history? (persona names, life events, etc.)\n" +
      "This helps the memory writer understand things it can't infer from messages alone.",
    );
  }

  // Step 6: Paths
  const psycherosDir = partial.psycherosDir || join(Deno.cwd(), "..", "Psycheros");
  const entityCoreDir = partial.entityCoreDir || join(Deno.cwd(), "..", "entity-core", "data");

  // Build config
  const config: PipelineConfig = {
    platform,
    inputPath,
    psycherosDir,
    entityCoreDir,
    entityName,
    userName,
    contextNotes,
    instanceId: (partial.instanceId as string) || platform,
    workerModel: partial.workerModel || "",
    maxContextTokens: partial.maxContextTokens || 90000,
    rateLimitMs: partial.rateLimitMs || 2000,
    dryRun: partial.dryRun || false,
    skipGraph: partial.skipGraph || false,
    skipMemories: partial.skipMemories || false,
    significanceThreshold: partial.significanceThreshold || 0.7,
  };

  // Validate
  const errors = validateConfig(config);
  if (errors.length > 0) {
    progress.error("Configuration errors:");
    for (const err of errors) {
      progress.error(`  - ${err}`);
    }
    Deno.exit(1);
  }

  // Validate LLM config
  const llmConfig = getLLMConfig();
  if (!llmConfig.apiKey && !config.dryRun) {
    progress.error("LLM_API_KEY not set in environment. Memory generation requires an LLM API key.");
    progress.error("Set it in .env or as an environment variable.");
    Deno.exit(1);
  }

  // Summary
  console.log("\n--- Import Summary ---");
  console.log(`  Platform:      ${config.platform}`);
  console.log(`  Input:         ${config.inputPath}`);
  console.log(`  Entity name:   ${config.entityName}`);
  console.log(`  User name:     ${config.userName}`);
  console.log(`  Instance:      ${config.instanceId}`);
  console.log(`  Psycheros dir: ${config.psycherosDir}`);
  console.log(`  Entity-core:   ${config.entityCoreDir}`);
  if (config.dryRun) console.log(`  Mode:          DRY RUN (no writes)`);
  if (config.skipMemories) console.log(`  Memories:      SKIPPED`);
  if (config.skipGraph) console.log(`  Graph:         SKIPPED`);
  console.log("");

  const proceed = await askConfirm("Proceed with import?", true);
  if (!proceed) {
    progress.log("Import cancelled.");
    Deno.exit(0);
  }

  // Run pipeline
  try {
    const result = await runPipeline(config, (msg) => progress.log(msg));

    console.log("\n--- Results ---");
    progress.summary({
      "Conversations parsed": result.pass1.conversationsParsed,
      "Conversations skipped": result.pass1.conversationsSkipped,
      "Conversations stored": result.pass2.conversationsStored,
      "Messages stored": result.pass2.messagesStored,
      "Daily memories": result.pass3.dailyMemoriesCreated,
      "Significant memories": result.pass3.significantMemoriesCreated,
      "Graph nodes": result.pass4.nodesCreated,
      "Graph edges": result.pass4.edgesCreated,
    });

    console.log("\nImport complete!");
    Deno.exit(0);
  } catch (error) {
    progress.error(`Pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
    progress.log("Use 'entity-loom resume' to continue from the last checkpoint.");
    Deno.exit(2);
  }
}

/**
 * Resume a partially-completed import.
 */
export async function resume(flags: Record<string, string | boolean>): Promise<void> {
  const progress = new ProgressReporter("[entity-loom]");
  const partial = buildConfig(flags);

  const psycherosDir = partial.psycherosDir || join(Deno.cwd(), "..", "Psycheros");
  const instanceId = (partial.instanceId as string) || "unknown";

  const checkpointMgr = new CheckpointManager(psycherosDir, instanceId);
  const checkpoint = await checkpointMgr.load();

  if (!checkpoint) {
    progress.error("No checkpoint found. Run 'entity-loom import' to start a new import.");
    Deno.exit(1);
  }

  progress.log(`Resuming import from checkpoint (started ${checkpoint.startedAt})`);
  console.log(`  Platform: ${checkpoint.platform}`);
  console.log(`  Entity: ${checkpoint.entityName}`);
  console.log(`  User: ${checkpoint.userName}`);
  console.log(`  Pass 1: ${checkpoint.pass1.completed ? "complete" : "incomplete"}`);
  console.log(`  Pass 2: ${checkpoint.pass2.completed ? "complete" : "incomplete"}`);
  console.log(`  Pass 3: ${checkpoint.pass3.completed ? "complete" : `incomplete (${checkpoint.pass3.failedDates.length} failed dates)`}`);
  console.log(`  Pass 4: ${checkpoint.pass4.completed ? "complete" : "incomplete"}`);
  console.log("");

  const config: PipelineConfig = {
    platform: checkpoint.platform,
    inputPath: checkpoint.inputPath,
    psycherosDir,
    entityCoreDir: partial.entityCoreDir || join(Deno.cwd(), "..", "entity-core", "data"),
    entityName: checkpoint.entityName,
    userName: checkpoint.userName,
    contextNotes: checkpoint.contextNotes,
    instanceId: checkpoint.instanceId,
    workerModel: partial.workerModel || "",
    maxContextTokens: partial.maxContextTokens || 90000,
    rateLimitMs: partial.rateLimitMs || 2000,
    dryRun: false,
    skipGraph: partial.skipGraph || false,
    skipMemories: partial.skipMemories || false,
    significanceThreshold: partial.significanceThreshold || 0.7,
  };

  try {
    const result = await runPipeline(config, (msg) => progress.log(msg));

    console.log("\n--- Results ---");
    progress.summary({
      "Conversations parsed": result.pass1.conversationsParsed,
      "Conversations stored": result.pass2.conversationsStored,
      "Messages stored": result.pass2.messagesStored,
      "Daily memories": result.pass3.dailyMemoriesCreated,
      "Significant memories": result.pass3.significantMemoriesCreated,
      "Graph nodes": result.pass4.nodesCreated,
      "Graph edges": result.pass4.edgesCreated,
    });

    Deno.exit(0);
  } catch (error) {
    progress.error(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(2);
  }
}

/**
 * Analyze system prompts and generate identity files.
 */
export async function analyze(flags: Record<string, string | boolean>): Promise<void> {
  const progress = new ProgressReporter("[entity-loom]");
  const partial = buildConfig(flags);

  const psycherosDir = partial.psycherosDir || join(Deno.cwd(), "..", "Psycheros");
  const entityCoreDir = partial.entityCoreDir || join(Deno.cwd(), "..", "entity-core", "data");

  // Find checkpoint to get system prompts from
  const instanceId = (partial.instanceId as string) || "unknown";
  const checkpointMgr = new CheckpointManager(psycherosDir, instanceId);
  const checkpoint = await checkpointMgr.load();

  if (!checkpoint) {
    progress.error("No checkpoint found. Run 'entity-loom import' first to collect system prompts.");
    Deno.exit(1);
  }

  // We need to re-parse to get system prompts (they're not stored in checkpoint)
  // For now, this requires re-parsing the export file
  let platform = partial.platform || checkpoint.platform;
  let inputPath = partial.inputPath || checkpoint.inputPath;
  let entityName = partial.entityName || checkpoint.entityName;
  let userName = partial.userName || checkpoint.userName;
  let contextNotes = partial.contextNotes || checkpoint.contextNotes;

  if (!entityName) entityName = await askString("Entity name?");
  if (!userName) userName = await askString("Your name?");

  const llmConfig = getLLMConfig();
  if (!llmConfig.apiKey) {
    progress.error("LLM_API_KEY not set. Analysis requires an LLM API key.");
    Deno.exit(1);
  }

  const llm = new LLMClient({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: partial.workerModel || llmConfig.model,
  });

  const analyzer = new CorePromptAnalyzer(entityCoreDir, entityName, userName, contextNotes, llm);

  // Parse the export to collect system prompts
  const { createParser } = await import("../parsers/mod.ts");
  const parser = createParser(platform);
  const conversations = await parser.parse(inputPath);

  // Collect all system prompts
  const allSystemPrompts: string[] = [];
  for (const conv of conversations) {
    allSystemPrompts.push(...conv.systemPrompts);
  }

  progress.log(`Found ${allSystemPrompts.length} system prompts across ${conversations.length} conversations`);

  const result = await analyzer.analyze(platform, allSystemPrompts);
  if (result) {
    progress.log(`Identity analysis written to: ${result}`);
  } else {
    progress.log("No system prompts to analyze.");
  }

  Deno.exit(0);
}
