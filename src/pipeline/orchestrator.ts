/**
 * Entity Loom — Pipeline Orchestrator
 *
 * Controls the 4-pass import pipeline with checkpoint support.
 */

import type { PipelineConfig, PipelineResult, CheckpointState, ImportedConversation, ProgressCallback } from "../types.ts";
import { CheckpointManager, createCheckpoint } from "../dedup/checkpoint.ts";
import { parseExport } from "./pass1-parse.ts";
import { storeConversations } from "./pass2-store.ts";
import { generateMemories } from "./pass3-memorize.ts";
import { populateGraph } from "./pass4-graph.ts";
import { LLMClient } from "../llm/mod.ts";
import { getLLMConfig } from "../config.ts";

/**
 * Run the full 4-pass import pipeline.
 */
export async function runPipeline(
  config: PipelineConfig,
  onProgress?: ProgressCallback,
): Promise<PipelineResult> {
  const checkpointMgr = new CheckpointManager(config.psycherosDir, config.instanceId);

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

  const result: PipelineResult = {
    pass1: { conversationsParsed: 0, conversationsSkipped: 0 },
    pass2: { conversationsStored: 0, messagesStored: 0 },
    pass3: { dailyMemoriesCreated: 0, significantMemoriesCreated: 0 },
    pass4: { nodesCreated: 0, edgesCreated: 0 },
  };

  // Conversations collected during Pass 1, passed to Pass 2
  let parsedConversations: ImportedConversation[] = [];

  // Pass 1: Parse
  if (!checkpointMgr.isPassComplete(checkpoint, "pass1") && !config.dryRun) {
    onProgress?.("Pass 1/4: Parsing export file...");
    const pass1Result = await parseExport(config.inputPath, config.platform, checkpoint, onProgress, config.idPrefix);
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
    const pass1Result = await parseExport(config.inputPath, config.platform, checkpoint, onProgress, config.idPrefix);
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
    onProgress?.("Pass 2/4: Storing conversations to Psycheros DB...");
    const toStore = parsedConversations.filter(
      (c) => !checkpointMgr.wasConversationStored(checkpoint, c.id),
    );
    const pass2Result = await storeConversations(toStore, config.psycherosDir, checkpoint, onProgress);
    result.pass2 = pass2Result;
    checkpoint.pass2.completed = true;
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 2 complete: ${result.pass2.conversationsStored} conversations stored`);
  } else {
    onProgress?.("Pass 2: Skipping (already completed)");
    result.pass2.conversationsStored = checkpoint.pass2.storedIds.length;
  }

  // Pass 3: Memorize
  if (!config.skipMemories && !checkpointMgr.isPassComplete(checkpoint, "pass3")) {
    onProgress?.("Pass 3/4: Generating memories...");
    const llmConfig = getLLMConfig();
    const llm = new LLMClient({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: config.workerModel || llmConfig.model,
    });
    const pass3Result = await generateMemories(config, checkpoint, llm, onProgress);
    result.pass3 = pass3Result;
    if (checkpoint.pass3.failedDates.length === 0) {
      checkpoint.pass3.completed = true;
    }
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 3 complete: ${result.pass3.dailyMemoriesCreated} daily, ${result.pass3.significantMemoriesCreated} significant`);
  } else if (config.skipMemories) {
    onProgress?.("Pass 3: Skipping (--skip-memories)");
  } else {
    onProgress?.("Pass 3: Skipping (already completed)");
  }

  // Pass 4: Graph
  if (!config.skipGraph && !checkpointMgr.isPassComplete(checkpoint, "pass4")) {
    onProgress?.("Pass 4/4: Populating knowledge graph...");
    const llmConfig = getLLMConfig();
    const llm = new LLMClient({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: config.workerModel || llmConfig.model,
    });
    const pass4Result = await populateGraph(config, checkpoint, llm, onProgress);
    result.pass4 = pass4Result;
    checkpoint.pass4.completed = true;
    await checkpointMgr.save(checkpoint);
    onProgress?.(`Pass 4 complete: ${result.pass4.nodesCreated} nodes, ${result.pass4.edgesCreated} edges`);
  } else if (config.skipGraph) {
    onProgress?.("Pass 4: Skipping (--skip-graph)");
  } else {
    onProgress?.("Pass 4: Skipping (already completed)");
  }

  onProgress?.("Import pipeline complete!");
  return result;
}

/**
 * Run a single pass of the pipeline (used by resume).
 */
export async function runPass(
  pass: number,
  config: PipelineConfig,
  checkpoint: CheckpointState,
  onProgress?: ProgressCallback,
): Promise<Partial<PipelineResult>> {
  switch (pass) {
    case 1: {
      const result = await parseExport(config.inputPath, config.platform, checkpoint, onProgress, config.idPrefix);
      return { pass1: { conversationsParsed: result.conversations.length, conversationsSkipped: result.skipped } };
    }
    case 2: {
      const parserResult = await parseExport(config.inputPath, config.platform, checkpoint, onProgress, config.idPrefix);
      const toStore = parserResult.conversations.filter((c) => !checkpoint.pass2.storedIds.includes(c.id));
      return { pass2: await storeConversations(toStore, config.psycherosDir, checkpoint, onProgress) };
    }
    case 3: {
      const llmConfig = getLLMConfig();
      const llm = new LLMClient({ apiKey: llmConfig.apiKey, baseUrl: llmConfig.baseUrl, model: config.workerModel || llmConfig.model });
      return { pass3: await generateMemories(config, checkpoint, llm, onProgress) };
    }
    case 4: {
      const llmConfig = getLLMConfig();
      const llm = new LLMClient({ apiKey: llmConfig.apiKey, baseUrl: llmConfig.baseUrl, model: config.workerModel || llmConfig.model });
      return { pass4: await populateGraph(config, checkpoint, llm, onProgress) };
    }
    default:
      throw new Error(`Invalid pass number: ${pass}`);
  }
}
