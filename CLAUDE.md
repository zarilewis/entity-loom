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
| `src/stages/staging-stage.ts` | Staging area: browse, search, tag, select, edit conversations before commit |
| `src/stages/significant-stage.ts` | Background significant memory extraction |
| `src/stages/daily-stage.ts` | Background daily memory extraction |
| `src/stages/graph-stage.ts` | Background graph population + graph CRUD + skip endpoint + finalize + zip download |
| `src/stages/signaled-llm.ts` | AbortSignal-aware LLM wrapper |
| `src/types.ts` | Shared types (ImportedConversation, WizardConfig, UploadEntry, etc.) |
| `src/config.ts` | WizardConfig persistence, checkpoint migration |
| `web/wizard.html` | Self-contained wizard UI (HTML/CSS/JS) |
| `web/graph.html` | Standalone graph viewer (vis-network, with back link to wizard) |
| `src/parsers/chatgpt.ts` | ChatGPT JSON parser (native title, date-range fallback) |
| `src/parsers/claude.ts` | Claude parser (JSONL + JSON array formats, thinking/thinking_blocks reasoning) |
| `src/parsers/sillytavern.ts` | SillyTavern JSONL parser (title from filename) |
| `src/parsers/letta.ts` | Letta agent chat log JSON parser (reasoning + system prompt extraction) |
| `src/parsers/kindroid.ts` | Kindroid/KinLog JSON parser (most-frequent-sender role detection, no timestamps) |
| `src/parsers/title-utils.ts` | Shared title generation with date-range fallback |
| `src/pipeline/chunker.ts` | Context window chunking (with platform passthrough) |
| `src/writers/db-writer.ts` | SQLite writes (conversations + messages + reasoning + platform tracking) |
| `src/writers/staging-writer.ts` | Staging SQLite layer (staging.db, FTS5 search, tags, tag sets, Psycheros compare) |
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

**Convert stage**: Users upload files and the platform is auto-detected (ChatGPT, Claude, SillyTavern). The platform can be changed per-file via a dropdown in the upload queue. Duplicate filenames are allowed (overwrites and resets to queued). "Convert All" parses every queued file, then auto-populates the staging area. Platform is tracked per-conversation in `chats.db` (extra column) and stripped during finalization. Reasoning/thinking chains from assistant messages are preserved in the `reasoning_content` column (SillyTavern: `extra.thinking`/`extra.reasoning`; ChatGPT o1/o3: thinking parts; Claude: `thinking` field). Reasoning is for Psycheros display only — not included in memory extraction prompts.

**Staging area** (sub-view within Convert panel, shown after parse): A review/curation step between Parse and Commit where users can browse, search, tag, select, and edit conversations before committing to `chats.db`. Features:
- **Browse tab**: Paginated conversation list with per-conversation include/exclude toggle, tags, and Psycheros comparison badges (new/existing/changed)
- **Search tab**: FTS5 full-text search across conversation titles and message content
- **Tags tab**: Apply arbitrary tags to conversations, save/load/apply/delete named tag sets that snapshot all tags + inclusion state for reuse across re-imports
- **Psycheros Compare tab**: Compare staged conversations against an existing Psycheros `chats.db` by content hash to flag new, existing, or changed conversations
- **Message viewer**: Click a conversation to view/edit individual messages (edits stored separately, applied on commit)
- **Commit Selected**: Writes included conversations (with any edits) to `chats.db`, updates checkpoint, advances wizard to Significant stage
- **Export Only**: One-click fast-track that commits selected conversations, skips all remaining pipeline stages (significant/daily/graph), finalizes the package, and shows the download button — for users who just want their chats in Psycheros without memory/graph processing

Staging data lives in `staging.db` (separate from `chats.db`) and is excluded from the download ZIP.

**Memory [via:] tags**: Daily and significant memories use `[via:platform]` (e.g. `[via:sillytavern]`, `[via:chatgpt]`) per bullet/conversation, derived from the source platform rather than the tool's instance ID. This is stored in `chats.db`'s `platform` column and removed during finalization.

**Conversation titles**: All parsers use `buildTitle()` from `src/parsers/title-utils.ts` to produce `[platform] Title` format. Priority: native title field > date range (e.g. "Jan 15 – Feb 3, 2025") > "[platform] Untitled". SillyTavern uses the filename as title (JSONL has no title field). Single-day conversations show just one date.

**Finalization**: After all stages complete, the "Finalize Package" button strips the `platform` column from `chats.db` so the database matches the Psycheros schema exactly. Once finalized, a "Download ZIP" button appears that streams the entire package directory as a `{entityName}-import.zip` file (with the `{entityName}-import/` prefix preserved inside), ready for one-click upload to Psycheros. The finalized state persists across page reloads.

Stages 3-5 run as background async tasks with SSE progress, abort support,
and per-item checkpointing. Only one stage runs at a time.

**Graph stage is optional**: The graph stage can be skipped entirely via "Skip Graph" in the UI or `POST /api/graph/skip`. When skipped, the checkpoint marks it as completed and finalize/download proceed normally. The graph viewer will be unavailable if skipped.

**Graph entity types**: Restricted to `self`, `person`, `place`, `health`, `tradition`. Abstract types (`topic`, `insight`, `preference`, `boundary`, `goal`) are excluded from extraction to reduce low-value noise.

**Batched graph extraction**: Daily memory files are processed in batches of ~14 (roughly two-week increments) in a single LLM call. This reduces API calls and improves entity consistency across memories (cross-referenced people, places, etc. get unified labels). Significant memories are still processed individually. No content is truncated at any stage — daily, significant, and graph processing all receive full content, chunking at message boundaries when needed.

**REST API**: All operations via `/api/*` endpoints. Staging area endpoints under `/api/staging/*` (populate, conversations CRUD, search, tags, tag-sets, commit, export-only, psycheros compare).
**SSE**: Real-time progress at `/api/events`.
**Checkpoint**: Saved after every item — supports abort/resume.
**Download**: `GET /api/download` streams the package as a zip after finalization.

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
├── staging.db        (staging area, excluded from ZIP download)
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
