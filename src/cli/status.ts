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
  const psycherosDir = (typeof flags["psycheros-dir"] === "string")
    ? flags["psycheros-dir"]
    : join(Deno.cwd(), "..", "Psycheros");

  const instanceId = (typeof flags["instance-id"] === "string")
    ? flags["instance-id"]
    : undefined;

  if (!instanceId) {
    console.log("No instance specified. Checking all checkpoints...\n");

    // List all checkpoint files
    const loomDir = join(psycherosDir, ".entity-loom");
    try {
      for await (const entry of Deno.readDir(loomDir)) {
        if (entry.isFile && entry.name.startsWith("checkpoint_") && entry.name.endsWith(".json")) {
          const id = entry.name.replace("checkpoint_", "").replace(".json", "");
          await showCheckpointStatus(psycherosDir, id);
          console.log("");
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.log("No checkpoints found. Run 'entity-loom import' to start an import.");
      } else {
        console.error(`Error reading checkpoints: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return;
  }

  await showCheckpointStatus(psycherosDir, instanceId);
}

async function showCheckpointStatus(psycherosDir: string, instanceId: string): Promise<void> {
  const mgr = new CheckpointManager(psycherosDir, instanceId);
  const checkpoint = await mgr.load();

  if (!checkpoint) {
    console.log(`No checkpoint found for instance: ${instanceId}`);
    return;
  }

  const statusIcon = (complete: boolean, failed = 0) =>
    complete ? "[done]" : failed > 0 ? `[failed: ${failed}]` : "[pending]";

  console.log(`=== ${checkpoint.instanceId} (${checkpoint.platform}) ===`);
  console.log(`  Started:     ${checkpoint.startedAt}`);
  console.log(`  Entity:      ${checkpoint.entityName}`);
  console.log(`  User:        ${checkpoint.userName}`);
  console.log(`  Input:       ${checkpoint.inputPath}`);
  console.log("");
  console.log("  Pipeline progress:");
  console.log(`    Pass 1 (Parse):      ${statusIcon(checkpoint.pass1.completed)} ${Object.keys(checkpoint.pass1.conversationHashes).length} conversations`);
  console.log(`    Pass 2 (Store):      ${statusIcon(checkpoint.pass2.completed)} ${checkpoint.pass2.storedIds.length} stored`);
  console.log(`    Pass 3 (Memories):   ${statusIcon(checkpoint.pass3.completed, checkpoint.pass3.failedDates.length)} ${checkpoint.pass3.processedDates.length} dates processed`);
  if (checkpoint.pass3.failedDates.length > 0) {
    console.log(`                         Failed dates: ${checkpoint.pass3.failedDates.join(", ")}`);
  }
  console.log(`    Pass 4 (Graph):      ${statusIcon(checkpoint.pass4.completed)} ${checkpoint.pass4.processedMemories.length} memories processed`);
}
