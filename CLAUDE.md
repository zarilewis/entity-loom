# Entity Loom — Agent System Card

Migration tool for importing AI companion chat histories from external platforms
(ChatGPT, Claude, SillyTavern, Kindroid, Letta) into the Psycheros/entity-core
ecosystem. Built on Deno 2.x.

Entity-loom weaves old memories into a new home — parsing foreign export formats,
generating Psycheros-compatible daily and significant memories, and populating the
entity-core knowledge graph.

## First-Person Convention

All prompts, memory content, and LLM instructions use the entity's first-person
perspective. The entity remembers *their* conversations, refers to the human by
name, and writes memories as their own experience. See the entity-philosophy docs
in Psycheros and entity-core for the full rationale. **Maintain this convention.**

## Commands

```bash
deno task dev          # Development with hot reload
deno task import      # Run full import pipeline
deno task resume      # Resume from checkpoint
deno task status      # Show import state
deno task analyze     # Core Prompt analysis only
deno task configure   # Interactive LLM configuration
deno run -A src/main.ts graph preview  # Interactive knowledge graph viewer
deno check src/main.ts  # Type check
deno lint              # Lint
deno test -A tests/    # Run tests
```

## Setup

```bash
deno run -A src/main.ts configure  # Interactive LLM setup (recommended)
# Or manually: cp .env.example .env, then set LLM_API_KEY
```

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | CLI entry point, argument parsing |
| `src/types.ts` | Shared types (ImportedConversation, PipelineConfig, etc.) |
| `src/config.ts` | Configuration from env vars, flags, and interactive prompts |
| `src/cli/commands.ts` | Command handlers (import, resume, status, analyze, configure) |
| `src/cli/graph.ts` | Graph preview CLI command |
| `src/graph/server.ts` | Graph preview HTTP server + REST API |
| `web/graph.html` | Standalone graph viewer (vis-network, list/graph views) |
| `src/parsers/chatgpt.ts` | ChatGPT JSON parser (tree traversal) |
| `src/parsers/claude.ts` | Claude JSONL parser |
| `src/parsers/sillytavern.ts` | SillyTavern JSONL parser |
| `src/pipeline/mod.ts` | Pipeline orchestrator (4-pass controller) |
| `src/writers/db-writer.ts` | SQLite writes (conversations + messages) |
| `src/writers/memory-writer.ts` | Daily + significant memory files |
| `src/writers/graph-writer.ts` | Knowledge graph population (LLM-based extraction) |
| `src/writers/graph-consolidator.ts` | Post-extraction graph consolidation (rule-based pruning + merging) |
| `src/writers/core-prompt.ts` | Identity analysis from system prompts |
| `src/dedup/checkpoint.ts` | Checkpoint/resume state management |
| `src/llm/client.ts` | OpenAI-compatible LLM client with connection test |

## Core Patterns

**Module structure**: Each `src/*/` has a `mod.ts` barrel file. Import from `mod.ts`.

**Adding a platform parser**:
1. Create `src/parsers/my-platform.ts` implementing `PlatformParser`
2. Register in `src/parsers/mod.ts` registry
3. Add platform type to `PlatformType` in `src/types.ts`

**Pipeline passes**: Each pass is independent and checkpointable. The orchestrator
loads checkpoint state, skips completed passes, and retries failed items.

**Output compatibility**: All output must match Psycheros/entity-core formats exactly.
Memory files follow `getDateFormatInfo()` convention. DB writes use identical schemas.

## Related Projects

- [Psycheros](https://github.com/zarilewis/Psycheros) — Primary entity harness (web UI)
- [entity-core](https://github.com/zarilewis/entity-core) — MCP server for canonical identity and memory
