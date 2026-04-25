/**
 * Entity Loom — CLI Entry Point
 *
 * Migrates AI companion chat histories from external platforms
 * into the Psycheros/entity-core ecosystem.
 */

import { parseFlags } from "./config.ts";

const COMMANDS = ["import", "resume", "status", "analyze", "configure"] as const;
type Command = typeof COMMANDS[number];

function showHelp(): void {
  console.log(`
entity-loom — AI companion migration tool for Psycheros/entity-core

Usage:
  entity-loom <command> [flags]

Commands:
  import     Full 4-pass import pipeline
  resume     Resume from last checkpoint
  status     Show import state / checkpoint info
  analyze    Core Prompt analysis only
  configure  Interactive LLM configuration

Flags:
  --platform <type>          Source platform (chatgpt, claude, sillytavern, kindroid, letta)
  --input <path>             Path to export file or directory
  --psycheros-dir <path>     Path to Psycheros project (default: ../Psycheros)
  --entity-core-dir <path>   Path to entity-core data dir (default: ../entity-core/data)
  --entity-name <name>       Entity's name (for memory writing)
  --entity-pronouns <pro>    Entity's pronouns (e.g., she/her)
  --user-name <name>         User's name (for memory writing)
  --user-pronouns <pro>      User's pronouns (e.g., he/him)
  --relationship <type>      Relationship type (e.g., partner, close friend)
  --context-notes <text>     Context about the conversation history
  --instance-id <id>         Source instance tag (default: platform name)
  --id-prefix <prefix>       Custom prefix for imported chatIDs (default: platform name)
  --worker-model <model>     Model for memory generation
  --max-context-tokens <n>   Worker context limit (default: 90000)
  --rate-limit-ms <n>        Delay between LLM calls (default: 2000)
  --api-key <key>            Override LLM API key for this run
  --base-url <url>           Override LLM API base URL for this run
  --model <model>            Override LLM model for this run
  --dry-run                  Parse only, no writes
  --skip-graph               Skip knowledge graph population
  --skip-memories            Skip memory generation
  --date-from YYYY-MM-DD     Only process memories from this date (for staged imports)
  --date-to YYYY-MM-DD       Only process memories up to this date
  --cost-estimate            Estimate token usage and API cost without making calls
  --help                     Show this help
`);
}

async function main(): Promise<void> {
  const args = Deno.args;

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    Deno.exit(0);
  }

  const command = args[0] as Command;
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error("Run 'entity-loom --help' for usage.");
    Deno.exit(1);
  }

  const flags = parseFlags(args.slice(1));

  // Dynamic imports to avoid loading everything for simple commands
  switch (command) {
    case "import": {
      const { importCommand } = await import("./cli/commands.ts");
      await importCommand(flags);
      break;
    }
    case "resume": {
      const { resume } = await import("./cli/commands.ts");
      await resume(flags);
      break;
    }
    case "status": {
      const { status } = await import("./cli/status.ts");
      await status(flags);
      break;
    }
    case "analyze": {
      const { analyze } = await import("./cli/commands.ts");
      await analyze(flags);
      break;
    }
    case "configure": {
      const { configure } = await import("./cli/commands.ts");
      await configure(flags);
      break;
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[entity-loom] Fatal: ${message}`);
  Deno.exit(1);
});
