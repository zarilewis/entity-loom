/**
 * Entity Loom — Pass 4: Graph
 *
 * Populates the entity-core knowledge graph from generated memory files.
 */

import { join } from "@std/path";
import type { PipelineConfig, CheckpointState, ProgressCallback } from "../types.ts";
import { GraphWriter } from "../writers/graph-writer.ts";
import { LLMClient } from "../llm/mod.ts";

/**
 * Populate the knowledge graph from memory files.
 */
export async function populateGraph(
  config: PipelineConfig,
  checkpoint: CheckpointState,
  llm: LLMClient,
  onProgress?: ProgressCallback,
): Promise<{ nodesCreated: number; edgesCreated: number }> {
  const graphWriter = new GraphWriter(
    config.entityCoreDir,
    llm,
    config.rateLimitMs,
    config.entityName,
    config.userName,
  );
  graphWriter.init();

  const memoriesDir = join(config.entityCoreDir, "memories");
  let totalNodes = 0;
  let totalEdges = 0;

  // Process daily memory files
  const dailyDir = join(memoriesDir, "daily");
  const dailyResults = await processMemoryDirectory(dailyDir, config.instanceId, graphWriter, checkpoint, onProgress);
  totalNodes += dailyResults.nodes;
  totalEdges += dailyResults.edges;

  // Process significant memory files
  const significantDir = join(memoriesDir, "significant");
  const sigResults = await processMemoryDirectory(significantDir, config.instanceId, graphWriter, checkpoint, onProgress);
  totalNodes += sigResults.nodes;
  totalEdges += sigResults.edges;

  graphWriter.close();
  onProgress?.(`Graph populated: ${totalNodes} nodes, ${totalEdges} edges`);

  return { nodesCreated: totalNodes, edgesCreated: totalEdges };
}

async function processMemoryDirectory(
  dirPath: string,
  sourceInstance: string,
  graphWriter: GraphWriter,
  checkpoint: CheckpointState,
  onProgress?: ProgressCallback,
): Promise<{ nodes: number; edges: number }> {
  let totalNodes = 0;
  let totalEdges = 0;

  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;
      if (entry.name === ".gitkeep") continue;

      const memoryPath = join(dirPath, entry.name);

      // Skip if already processed
      if (checkpoint.pass4.processedMemories.includes(memoryPath)) continue;

      try {
        const content = await Deno.readTextFile(memoryPath);
        const result = await graphWriter.processMemory(memoryPath, content, sourceInstance);

        totalNodes += result.nodesCreated;
        totalEdges += result.edgesCreated;

        if (result.nodesCreated > 0 || result.edgesCreated > 0) {
          checkpoint.pass4.processedMemories.push(memoryPath);
        }
      } catch (error) {
        onProgress?.(`Graph: Error processing ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      onProgress?.(`Graph: Could not read directory ${dirPath}`);
    }
  }

  return { nodes: totalNodes, edges: totalEdges };
}
