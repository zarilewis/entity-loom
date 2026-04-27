/**
 * Entity Loom — Pipeline Orchestrator
 *
 * Controls the 5-pass import pipeline with checkpoint support.
 * Produces a self-contained import package in .loom-exports/.
 */

import { join } from "@std/path";
import type { PipelineConfig, PipelineResult, ImportedConversation, ProgressCallback } from "../types.ts";
import { CheckpointManager, createCheckpoint } from "../dedup/checkpoint.ts";
import { parseExport } from "./pass1-parse.ts";
import { storeConversations } from "./pass2-store.ts";
import { generateDailyMemories } from "./pass3-memorize.ts";
import { generateSignificantMemories } from "./pass3b-significant.ts";
import { populateGraph } from "./pass4-graph.ts";
import { finalizePackage } from "./packager.ts";
import { LLMClient } from "../llm/mod.ts";
import { getLLMConfig } from "../config.ts";

/**
 * Compute the package directory path from config.
 */
export function getPackageDir(config: PipelineConfig): string {
  return join(config.outputDir, `${config.entityName}-${config.platform}`);
}

/**
 * Ensure the package directory structure exists.
 */
async function ensurePackageStructure(packageDir: string): Promise<void> {
  await Deno.mkdir(join(packageDir, "memories", "daily"), { recursive: true });
  await Deno.mkdir(join(packageDir, "memories", "significant"), { recursive: true });
  await Deno.mkdir(join(packageDir, "raw"), { recursive: true });
}

/**
 * Run the full 5-pass import pipeline.
 */
export async function runPipeline(
  config: PipelineConfig,
  onProgress?: ProgressCallback,
): Promise<PipelineResult> {
  const packageDir = getPackageDir(config);

  // Ensure package directory structure
  await ensurePackageStructure(packageDir);

  const checkpointMgr = new CheckpointManager(packageDir);

  // Load or create checkpoint
  let checkpoint = await checkpointMgr.load();
  if (!checkpoint) {
    checkpoint = createCheckpoint(
      config.platform,
      config.instanceId,
      config.entityName,
      config.userName,
      config.contextNotes,
      config.inputPath,
    );
  }

  onProgress?.("Starting entity-loom import pipeline");
  onProgress?.(`Package directory: ${packageDir}`);

  const result: PipelineResult = {
    pass1: { conversationsParsed: 0, conversationsSkipped: 0 },
    pass2: { conversationsStored: 0, messagesStored: 0 },
    pass3a: { dailyMemoriesCreated: 0 },
    pass3b: { significantMemoriesCreated: 0, conversationsProcessed: 0 },
    pass4: { nodesCreated: 0, edgesCreated: 0 },
    pass5: { manifestWritten: false },
  };

  // Conversations collected during Pass 1, passed to Pass 2
  let parsedConversations: ImportedConversation[] = [];

  // Pass 1: Parse
  if (!checkpointMgr.isPassComplete(checkpoint, "pass1") && !config.dryRun) {
    onProgress?.("Pass 1/5: Parsing export file...");
    const pass1Result = await parseExport(config.inputPath, config.platform, checkpoint, packageDir, onProgress, config.idPrefix);
    parsedConversations = pass1Result.conversations;
    result.pass1 = {
      conversationsParsed: pass1Result.conversations.length,
      conversationsSkipped: pass1Result.skipped,
    };
    checkpoint.pass1.completed = true;
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 1 complete: ${result.pass1.conversationsParsed} conversations parsed`);
  } else if (config.dryRun) {
    onProgress?.("Pass 1: Dry run — parsing only");
    const pass1Result = await parseExport(config.inputPath, config.platform, checkpoint, packageDir, onProgress, config.idPrefix);
    parsedConversations = pass1Result.conversations;
    result.pass1 = {
      conversationsParsed: pass1Result.conversations.length,
      conversationsSkipped: pass1Result.skipped,
    };
    return result;
  } else {
    onProgress?.("Pass 1: Skipping (already completed)");
    result.pass1.conversationsParsed = Object.keys(checkpoint.pass1.conversationHashes).length;
  }

  // Pass 2: Store
  if (!checkpointMgr.isPassComplete(checkpoint, "pass2")) {
    onProgress?.("Pass 2/5: Storing conversations to package DB...");
    const dbPath = join(packageDir, "chats.db");
    const toStore = parsedConversations.filter(
      (c) => !checkpointMgr.wasConversationStored(checkpoint, c.id),
    );
    const pass2Result = await storeConversations(toStore, dbPath, checkpoint, onProgress);
    result.pass2 = pass2Result;
    checkpoint.pass2.completed = true;
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 2 complete: ${result.pass2.conversationsStored} conversations stored`);
  } else {
    onProgress?.("Pass 2: Skipping (already completed)");
    result.pass2.conversationsStored = checkpoint.pass2.storedIds.length;
  }

  // Pass 3a: Daily Memories
  if (!config.skipMemories && !checkpointMgr.isPassComplete(checkpoint, "pass3a")) {
    onProgress?.("Pass 3/5: Generating daily memories...");
    const llmConfig = getLLMConfig();
    const llm = new LLMClient({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: config.workerModel || llmConfig.model,
    });
    const dbPath = join(packageDir, "chats.db");
    const pass3aResult = await generateDailyMemories(dbPath, packageDir, config, checkpoint, llm, onProgress);
    result.pass3a = pass3aResult;
    if (checkpoint.pass3a.failedDates.length === 0) {
      checkpoint.pass3a.completed = true;
    }
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 3a complete: ${result.pass3a.dailyMemoriesCreated} daily memories`);
  } else if (config.skipMemories) {
    onProgress?.("Pass 3: Skipping (--skip-memories)");
  } else {
    onProgress?.("Pass 3a: Skipping (already completed)");
  }

  // Pass 3b: Significant Memories
  if (!config.skipMemories && !checkpointMgr.isPassComplete(checkpoint, "pass3b")) {
    onProgress?.("Pass 3b: Extracting significant memories from raw conversations...");
    const llmConfig = getLLMConfig();
    const llm = new LLMClient({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: config.workerModel || llmConfig.model,
    });
    const pass3bResult = await generateSignificantMemories(packageDir, config, checkpoint, llm, onProgress);
    result.pass3b = pass3bResult;
    if (checkpoint.pass3b.failedConversationIds.length === 0) {
      checkpoint.pass3b.completed = true;
    }
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 3b complete: ${result.pass3b.significantMemoriesCreated} significant memories`);
  } else if (config.skipMemories) {
    onProgress?.("Pass 3b: Skipping (--skip-memories)");
  } else {
    onProgress?.("Pass 3b: Skipping (already completed)");
  }

  // Pass 4: Graph
  if (!config.skipGraph && !checkpointMgr.isPassComplete(checkpoint, "pass4")) {
    onProgress?.("Pass 4/5: Populating knowledge graph...");
    const llmConfig = getLLMConfig();
    const llm = new LLMClient({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: config.workerModel || llmConfig.model,
    });
    const pass4Result = await populateGraph(packageDir, config, checkpoint, llm, onProgress);
    result.pass4 = pass4Result;
    checkpoint.pass4.completed = true;
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 4 complete: ${result.pass4.nodesCreated} nodes, ${result.pass4.edgesCreated} edges`);
  } else if (config.skipGraph) {
    onProgress?.("Pass 4: Skipping (--skip-graph)");
  } else {
    onProgress?.("Pass 4: Skipping (already completed)");
  }

  // Pass 5: Package (finalize manifest)
  if (!checkpointMgr.isPassComplete(checkpoint, "pass5") && !config.dryRun) {
    onProgress?.("Pass 5/5: Writing manifest...");
    await finalizePackage(packageDir, config, result);
    result.pass5 = { manifestWritten: true };
    checkpoint.pass5.completed = true;
    await checkpointMgr.save(checkpoint);
    onProgress?.("Pass 5 complete: manifest written");
  } else if (config.dryRun) {
    onProgress?.("Pass 5: Skipping (dry run)");
  } else {
    onProgress?.("Pass 5: Skipping (already completed)");
  }

  onProgress?.("Import pipeline complete!");
  return result;
}
