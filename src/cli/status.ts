/**
 * Entity Loom — Status Command
 *
 * Shows the current checkpoint state and import progress.
 */

import { join } from "@std/path";
import { CheckpointManager } from "../dedup/checkpoint.ts";

/**
 * Display the current checkpoint state.
 */
export async function status(flags: Record<string, string | boolean>): Promise<void> {
  const outputDir = (typeof flags["output-dir"] === "string")
    ? flags["output-dir"]
    : join(Deno.cwd(), ".loom-exports");

  let found = false;

  try {
    for await (const entry of Deno.readDir(outputDir)) {
      if (!entry.isDirectory) continue;
      const checkpointPath = join(outputDir, entry.name, "checkpoint.json");
      try {
        await Deno.stat(checkpointPath);
        const mgr = new CheckpointManager(join(outputDir, entry.name));
        const checkpoint = await mgr.load();
        if (checkpoint) {
          showCheckpointStatus(entry.name, checkpoint);
          console.log("");
          found = true;
        }
      } catch {
        // no checkpoint in this directory
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log("No checkpoints found. Run 'entity-loom import' to start an import.");
    } else {
      console.error(`Error reading checkpoints: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (!found) {
    console.log("No checkpoints found. Run 'entity-loom import' to start an import.");
  }
}

function showCheckpointStatus(packageName: string, checkpoint: Awaited<ReturnType<CheckpointManager["load"]>>): void {
  if (!checkpoint) return;

  const statusIcon = (complete: boolean, failed = 0) =>
    complete ? "[done]" : failed > 0 ? `[failed: ${failed}]` : "[pending]";

  console.log(`=== ${packageName} ===`);
  console.log(`  Started:     ${checkpoint.startedAt}`);
  console.log(`  Platform:    ${checkpoint.platform}`);
  console.log(`  Entity:      ${checkpoint.entityName}`);
  console.log(`  User:        ${checkpoint.userName}`);
  console.log(`  Input:       ${checkpoint.inputPath}`);
  console.log("");
  console.log("  Pipeline progress:");
  console.log(`    Pass 1 (Parse):      ${statusIcon(checkpoint.pass1.completed)} ${Object.keys(checkpoint.pass1.conversationHashes).length} conversations`);
  console.log(`    Pass 2 (Store):      ${statusIcon(checkpoint.pass2.completed)} ${checkpoint.pass2.storedIds.length} stored`);
  console.log(`    Pass 3a (Daily):     ${statusIcon(checkpoint.pass3a.completed, checkpoint.pass3a.failedDates.length)} ${checkpoint.pass3a.processedDates.length} dates processed`);
  if (checkpoint.pass3a.failedDates.length > 0) {
    console.log(`                         Failed dates: ${checkpoint.pass3a.failedDates.join(", ")}`);
  }
  console.log(`    Pass 3b (Signif.):   ${statusIcon(checkpoint.pass3b.completed, checkpoint.pass3b.failedConversationIds.length)} ${checkpoint.pass3b.processedConversationIds.length} conversations processed`);
  if (checkpoint.pass3b.failedConversationIds.length > 0) {
    console.log(`                         Failed: ${checkpoint.pass3b.failedConversationIds.length} conversations`);
  }
  console.log(`    Pass 4 (Graph):      ${statusIcon(checkpoint.pass4.completed)} ${checkpoint.pass4.processedMemories.length} memories processed`);
  console.log(`    Pass 5 (Package):    ${statusIcon(checkpoint.pass5.completed)}`);
}
