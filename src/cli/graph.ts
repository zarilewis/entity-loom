/**
 * Entity Loom — Graph Preview Command
 *
 * Starts a local HTTP server serving an interactive knowledge graph viewer.
 * Reads/writes graph.db directly — no MCP dependency.
 */

import { join } from "@std/path";
import { startGraphServer } from "../graph/server.ts";

export async function graphPreview(flags: Record<string, string | boolean>): Promise<void> {
  const entityCoreDir = (typeof flags["entity-core-dir"] === "string")
    ? flags["entity-core-dir"]
    : join(Deno.cwd(), "..", "entity-core", "data");

  const port = typeof flags["port"] === "string" ? parseInt(flags["port"], 10) : 8421;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${flags["port"]}`);
    Deno.exit(1);
  }

  await startGraphServer(entityCoreDir, port);
}
