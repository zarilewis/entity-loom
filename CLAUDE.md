# Entity Loom — Agent System Card

Migration tool for importing AI companion chat histories from external platforms
(ChatGPT, Claude, SillyTavern, Kindroid, Letta) into self-contained import packages
ready for the Psycheros/entity-core ecosystem. Built on Deno 2.x.

Entity-loom weaves old memories into a new home — parsing foreign export formats,
generating daily and significant memories, and populating the knowledge graph.
Output is a structured directory package that Psycheros/entity-core can import.

**Web wizard UI** — a browser-based wizard at `http://localhost:3210` guides users
through the 5-stage pipeline with real-time SSE progress, abort/resume support,
cost estimation, and memory review/edit.

## First-Person Convention

All prompts, memory content, and LLM instructions use the entity's first-person
perspective. The entity remembers *their* conversations, refers to the human by
name, and writes memories as their own experience. See the entity-philosophy docs
in Psycheros and entity-core for the full rationale. **Maintain this convention.**

## Commands

```bash
deno task start      # Start wizard server on port 3210
deno check src/main.ts  # Type check
deno lint              # Lint
deno test -A tests/    # Run tests
```

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Server entry point (starts HTTP wizard) |
| `src/server/server.ts` | HTTP server, static files, SSE stream |
| `src/server/router.ts` | Request routing to stage handlers |
| `src/server/sse.ts` | SSE broadcaster for real-time progress |
| `src/server/logger.ts` | Per-run log file in logs/ |
| `src/server/cost-estimator.ts` | Token/cost estimation |
| `src/server/stage-lock.ts` | Ensures only one stage runs at a time |
| `src/stages/setup-stage.ts` | Setup: save config, create package dir, resume, purge package |
| `src/stages/convert-stage.ts` | Multi-file upload queue, per-file platform, parse all, confirm |
| `src/stages/significant-stage.ts` | Background significant memory extraction |
| `src/stages/daily-stage.ts` | Background daily memory extraction |
| `src/stages/graph-stage.ts` | Background graph population + graph CRUD + finalize |
| `src/stages/signaled-llm.ts` | AbortSignal-aware LLM wrapper |
| `src/types.ts` | Shared types (ImportedConversation, WizardConfig, UploadEntry, etc.) |
| `src/config.ts` | WizardConfig persistence, checkpoint migration |
| `web/wizard.html` | Self-contained wizard UI (HTML/CSS/JS) |
| `web/graph.html` | Standalone graph viewer (vis-network, with back link to wizard) |
| `src/parsers/chatgpt.ts` | ChatGPT JSON parser |
| `src/parsers/claude.ts` | Claude JSONL parser |
| `src/parsers/sillytavern.ts` | SillyTavern JSONL parser |
| `src/pipeline/chunker.ts` | Context window chunking (with platform passthrough) |
| `src/writers/db-writer.ts` | SQLite writes (conversations + messages + platform tracking) |
| `src/writers/memory-writer.ts` | Daily + significant memory files (per-platform [via:] tags) |
| `src/writers/graph-writer.ts` | Knowledge graph population (LLM extraction) |
| `src/writers/graph-consolidator.ts` | Post-extraction graph consolidation |
| `src/dedup/checkpoint.ts` | Checkpoint/resume state management |
| `src/llm/client.ts` | OpenAI-compatible LLM client |

## Architecture

**5-stage wizard pipeline** (web UI at http://localhost:3210):

| Stage | What | Input | Output |
|-------|------|-------|--------|
| 1. Setup | Identity + LLM config | User form | config.json |
| 2. Convert | Multi-file upload with per-file platform | Export files | chats.db + raw/ |
| 3. Significant | Extract from raw conversations | raw/conversations.json | memories/significant/*.md |
| 4. Daily | Extract from converted DB | chats.db | memories/daily/*.md |
| 5. Graph | Populate knowledge graph + finalize | memories/* | graph.db |

**Convert stage**: Users upload files and the platform is auto-detected (ChatGPT, Claude, SillyTavern). The platform can be changed per-file via a dropdown in the upload queue. Duplicate filenames are rejected. "Convert All" parses every queued file. "Confirm & Store" writes to DB. Platform is tracked per-conversation in `chats.db` (extra column) and stripped during finalization.

**Memory [via:] tags**: Daily and significant memories use `[via:platform]` (e.g. `[via:sillytavern]`, `[via:chatgpt]`) per bullet/conversation, derived from the source platform rather than the tool's instance ID. This is stored in `chats.db`'s `platform` column and removed during finalization.

**Finalization**: After all stages complete, the "Finalize Package" button strips the `platform` column from `chats.db` so the database matches the Psycheros schema exactly.

Stages 3-5 run as background async tasks with SSE progress, abort support,
and per-item checkpointing. Only one stage runs at a time.

**REST API**: All operations via `/api/*` endpoints.
**SSE**: Real-time progress at `/api/events`.
**Checkpoint**: Saved after every item — supports abort/resume.

## Platform Tracking

During processing, each conversation's source platform is stored in `chats.db`:
- `conversations.platform` column (added during convert, stripped during finalize)
- Memory content uses `[via:platform]` tags per conversation header `[from: platform]`
- Daily memory filenames remain `<date>_entity-loom.md` (tool identity, not platform)

## Package Structure

```
.loom-exports/{entityName}-{platform}/
├── manifest.json
├── config.json
├── checkpoint.json
├── chats.db          (platform column stripped after finalize)
├── memories/
│   ├── daily/
│   └── significant/
├── graph.db
└── raw/
    ├── conversations.json
    └── uploads.json   (upload queue manifest)
```

## Core Patterns

**Module structure**: Each `src/*/` has a `mod.ts` barrel file.

**Adding a platform parser**:
1. Create `src/parsers/my-platform.ts` implementing `PlatformParser`
2. Register in `src/parsers/mod.ts` registry
3. Add platform type to `PlatformType` in `src/types.ts`

**CheckpointStateV2** extends v1 — existing packages can be loaded and resumed.
Migration maps old pass fields to new stage fields.

**Package management**: Packages can be resumed or purged from the Setup panel. Purge deletes the entire package directory (chats, memories, graph, raw exports).

## Related Projects

- [Psycheros](https://github.com/zarilewis/Psycheros) — Primary entity harness (web UI)
- [entity-core](https://github.com/zarilewis/entity-core) — MCP server for canonical identity and memory
