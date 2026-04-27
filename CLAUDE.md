# Entity Loom — Agent System Card

Migration tool for importing AI companion chat histories from external platforms
(ChatGPT, Claude, SillyTavern, Kindroid, Letta) into self-contained import packages
ready for the Psycheros/entity-core ecosystem. Built on Deno 2.x.

Entity-loom weaves old memories into a new home — parsing foreign export formats,
generating daily and significant memories, and populating the knowledge graph.
Output is a structured directory package that Psycheros/entity-core can import.

## First-Person Convention

All prompts, memory content, and LLM instructions use the entity's first-person
perspective. The entity remembers *their* conversations, refers to the human by
name, and writes memories as their own experience. See the entity-philosophy docs
in Psycheros and entity-core for the full rationale. **Maintain this convention.**

## Commands

```bash
deno task dev          # Development with hot reload
deno task import      # Run full 5-pass import pipeline
deno task resume      # Resume from checkpoint
deno task status      # Show import state
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
| `src/types.ts` | Shared types (ImportedConversation, PipelineConfig, ManifestData, etc.) |
| `src/config.ts` | Configuration from env vars, flags, and interactive prompts |
| `src/cli/commands.ts` | Command handlers (import, resume, configure) |
| `src/cli/status.ts` | Checkpoint status display |
| `src/cli/graph.ts` | Graph preview CLI command |
| `src/graph/server.ts` | Graph preview HTTP server + REST API |
| `web/graph.html` | Standalone graph viewer (vis-network, list/graph views) |
| `src/parsers/chatgpt.ts` | ChatGPT JSON parser (tree traversal) |
| `src/parsers/claude.ts` | Claude JSONL parser |
| `src/parsers/sillytavern.ts` | SillyTavern JSONL parser |
| `src/pipeline/orchestrator.ts` | Pipeline orchestrator (5-pass controller) |
| `src/pipeline/pass1-parse.ts` | Parse + normalize + serialize raw conversations |
| `src/pipeline/pass2-store.ts` | Write to package-local SQLite DB |
| `src/pipeline/pass3-memorize.ts` | Daily memory generation (day-by-day from DB) |
| `src/pipeline/pass3b-significant.ts` | Significant memory extraction (conversation-level from raw) |
| `src/pipeline/pass4-graph.ts` | Knowledge graph population |
| `src/pipeline/packager.ts` | Package manifest finalization |
| `src/pipeline/chunker.ts` | Context window chunking (flat messages + conversation-aware) |
| `src/writers/db-writer.ts` | SQLite writes (conversations + messages) |
| `src/writers/memory-writer.ts` | Daily + significant memory files |
| `src/writers/graph-writer.ts` | Knowledge graph population (LLM-based extraction) |
| `src/writers/graph-consolidator.ts` | Post-extraction graph consolidation (rule-based pruning + merging) |
| `src/writers/manifest-writer.ts` | Package manifest generation |
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

**Pipeline flow**:
1. **Parse** — Platform export → ImportedConversation[] → serialize to raw/
2. **Store** — ImportedConversation[] → chats.db
3. **Daily Memories** — chats.db (day-by-day) → memories/daily/
4. **Significant Memories** — raw/ conversations (by conversation, chunked) → memories/significant/
5. **Graph** — memories/* → graph.db
6. **Package** — Write manifest.json

**Package structure**:
```
.loom-exports/{entityName}-{platform}/
├── manifest.json
├── checkpoint.json
├── chats.db
├── memories/
│   ├── daily/
│   └── significant/
├── graph.db
└── raw/
    └── conversations.json
```

**Significant memories**: Extracted from raw conversations (not the DB) by whole
conversation rather than by day, with overlapping chunking for long conversations.
This captures multi-day event arcs that day-bucketed processing would miss.

**Output compatibility**: All output must match Psycheros/entity-core formats exactly.
Memory files follow `getDateFormatInfo()` convention. DB writes use identical schemas.

## Related Projects

- [Psycheros](https://github.com/zarilewis/Psycheros) — Primary entity harness (web UI)
- [entity-core](https://github.com/zarilewis/entity-core) — MCP server for canonical identity and memory
