/**
 * Entity Loom — Graph Preview Command
 *
 * Starts a local HTTP server serving an interactive knowledge graph viewer.
 * Reads/writes graph.db directly — no MCP dependency.
 */

import { join } from "@std/path";
import { startGraphServer } from "../graph/server.ts";

export async function graphPreview(flags: Record<string, string | boolean>): Promise<void> {
  const graphDbPath = (typeof flags["graph-db"] === "string")
    ? flags["graph-db"]
    : undefined;

  // If no explicit graph.db path, look in .loom-exports packages
  let finalDbPath: string = "";

  if (graphDbPath) {
    finalDbPath = graphDbPath;
  } else {
    // Find the first package with a graph.db
    const outputDir = (typeof flags["output-dir"] === "string")
      ? flags["output-dir"]
      : join(Deno.cwd(), ".loom-exports");

    let found = false;
    try {
      for await (const entry of Deno.readDir(outputDir)) {
        if (!entry.isDirectory) continue;
        const candidate = join(outputDir, entry.name, "graph.db");
        try {
          await Deno.stat(candidate);
          finalDbPath = candidate;
          found = true;
          break;
        } catch {
          // no graph.db here
        }
      }
    } catch {
      // outputDir doesn't exist
    }

    if (!found) {
      console.error("No graph.db found in .loom-exports/. Run entity-loom import first.");
      Deno.exit(1);
    }
  }

  const port = typeof flags["port"] === "string" ? parseInt(flags["port"], 10) : 8421;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${flags["port"]}`);
    Deno.exit(1);
  }

  await startGraphServer(finalDbPath, port);
}
