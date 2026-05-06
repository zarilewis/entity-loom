# entity-loom

Web-based tool for importing AI companion chat histories from external platforms into self-contained import packages for the [Psycheros](https://github.com/zarilewis/Psycheros) / [entity-core](https://github.com/zarilewis/entity-core) ecosystem.

Parses exported chat logs from ChatGPT, Claude, SillyTavern, Kindroid, and Letta, then produces a structured directory with a chat database, daily and significant memories, and knowledge graph data — ready for Psycheros/entity-core to import.

Built with Deno 2.x and strict TypeScript.

## Quick start

```bash
git clone <repo-url> && cd entity-loom
deno task start
```

Opens a browser wizard at http://localhost:3210. Walk through the 5 stages: Setup, Convert, Significant Memories, Daily Memories, and Knowledge Graph.

**New users:** See [docs/user-guide.md](docs/user-guide.md) for step-by-step instructions.

## How it works

The wizard runs a 5-stage pipeline:

1. **Setup** — Entity/user identity, pronouns, relationship context, LLM provider config
2. **Convert** — Upload chat export files (platform auto-detected), parse into a staging area for review/tagging/editing, then commit selected conversations to a local SQLite database
3. **Significant Memories** — Extracts journal-entry prose for genuinely significant events from raw conversations (LLM-powered, high bar)
4. **Daily Memories** — Generates day-by-day bullet-point summaries from the chat database (LLM-powered)
5. **Knowledge Graph** — Extracts entities (person, place, health, tradition) and relationships from all memory files into a graph database (LLM-powered, batched in ~14-file groups for consistency), then consolidates with rule-based pruning. This stage can be skipped entirely — finalize and download still work without it.

Each stage is independently resumable. If interrupted, refresh the page and click Resume. If you want to start over, use the Purge button to delete a package entirely.

### Platform tracking

Memory files tag each bullet point with the source platform:
```
- We talked about the new job [chat:550e8400-...] [via:sillytavern]
```

During processing, the platform is tracked in a `platform` column in `chats.db`. After all stages are complete, the "Finalize Package" button strips this column so the database matches the Psycheros schema exactly.

### Multi-platform imports

Upload files from different platforms (e.g., SillyTavern and ChatGPT) in the Convert stage. The platform is auto-detected on upload — change it via the per-file dropdown in the queue if wrong. Queue them up, then convert all at once. After parsing, conversations populate the staging area where you can browse, search, tag, select, and edit before committing.

### Staging area

A review/curation step between Parse and Commit. Features: Psycheros comparison (flags new/existing/changed conversations), color-coded tag palette, full-text search, per-conversation include/exclude, and an inline message viewer for editing. Two commit options: **Commit Selected** (advances to memory extraction) or **Export Only** (finalizes and downloads immediately, skipping stages 3–5). Staging data persists in `staging.db` across sessions.

## Setup

```bash
# Install Deno if needed (https://deno.land)
curl -fsSL https://deno.land/install.sh | sh

# Start the wizard
deno task start
```

The wizard runs on port 3210 and auto-opens your browser. Configure your LLM provider (OpenRouter, OpenAI, Anthropic, or any OpenAI-compatible endpoint) with an API key and model on the Setup page.

## Commands

```bash
deno task start       # Start wizard server on port 3210
deno check src/main.ts  # Type check
deno lint             # Lint
deno test -A tests/   # Run tests
```

## Supported platforms

### ChatGPT
Single JSON file from data export (Settings > Data controls > Export). Handles both object and array formats. System prompts extracted, images replaced with `[image was here]`.

### Claude
JSONL file from data export (Settings > Data export). `human` role mapped to `user`. Attachments replaced with `[image was here]`.

### SillyTavern
JSONL files (one per chat, or a directory). Deterministic conversation IDs generated from file content via SHA-256 (SillyTavern exports have no native stable IDs).

### Letta
JSON file from agent chat log export. Extracts reasoning chains and system prompts.

### Kindroid
Parser stub exists. Not yet implemented.

## Output

entity-loom produces a self-contained import package at `.loom-exports/{entityName}-{platform}/`:

```
.loom-exports/Luna-chatgpt/
├── manifest.json              # Package metadata and stats
├── config.json                # Wizard configuration
├── checkpoint.json            # Pipeline progress state
├── chats.db                   # SQLite DB with conversations and messages
├── staging.db                 # Staging area (excluded from ZIP download)
├── memories/
│   ├── daily/                 # Day-by-day bullet-point summaries
│   └── significant/           # Journal-entry prose for significant events
├── graph.db                   # Knowledge graph SQLite DB (optional)
└── raw/
    ├── _loom_conversations.json # Serialized conversations
    └── uploads.json           # Upload queue manifest
```

### Chat database (`chats.db`)

Conversations and messages stored in SQLite matching the Psycheros schema. Original timestamps preserved. During processing, a temporary `platform` column tracks each conversation's source — this is stripped when you finalize the package.

### Memory files

**Daily memories** — bullet-point summaries with `[via:platform]` tags:
```markdown
# Daily Memory - 2024-06-15

- We talked about the new job and how nervous they were [chat:550e8400-...] [via:chatgpt]
- That evening she told me about her weekend trip [chat:550e8400-...] [via:sillytavern]
```

**Significant memories** — journal-entry prose for genuinely significant events only:
```markdown
# Significant Memory - 2024-06-15

Today was one of those days that shifts everything. Alex said "I love you" for the first time... [chat:550e8400-...] [via:chatgpt]
```

### Knowledge graph (`graph.db`)

Extracted via LLM with a concrete-reality standard. Entity types are restricted to `self`, `person`, `place`, `health`, and `tradition` — abstract or low-value types (topics, insights, preferences, boundaries, goals) are explicitly excluded. Daily memories are batched (~14 files per call) for better cross-referencing. Consolidated with rule-based pruning (isolated node removal, duplicate merging, generic topic detection).

## Architecture

```
src/
  main.ts                  Server entry point
  types.ts                 Shared types
  config.ts                WizardConfig persistence, checkpoint migration
  server/
    server.ts              HTTP server, static files, SSE stream
    router.ts              Request routing
    sse.ts                 SSE broadcaster
    logger.ts              Per-run log files
    cost-estimator.ts      Token/cost estimation
    stage-lock.ts          Single-stage mutex
  stages/
    setup-stage.ts         Setup: config, resume, purge, LLM test
    convert-stage.ts       Multi-file upload queue, parse, store
    staging-stage.ts       Staging area: browse, search, tag, select, edit, commit
    significant-stage.ts   Background significant extraction
    daily-stage.ts         Background daily extraction
    graph-stage.ts         Graph population + finalize + skip
    signaled-llm.ts        AbortSignal-aware LLM wrapper
  parsers/
    chatgpt.ts             ChatGPT JSON parser
    claude.ts              Claude JSONL parser
    sillytavern.ts         SillyTavern JSONL parser
    letta.ts               Letta agent chat log parser
    kindroid.ts            Kindroid/KinLog parser
    title-utils.ts         Shared title generation with date-range fallback
  pipeline/
    chunker.ts             Context window chunking
  writers/
    db-writer.ts           SQLite writes (conversations + messages + platform)
    staging-writer.ts      Staging SQLite layer (FTS5 search, tags, compare)
    memory-writer.ts       Daily + significant memory files
    graph-writer.ts        Knowledge graph extraction
    graph-consolidator.ts  Knowledge graph consolidation
  dedup/
    content-hash.ts        SHA-256 conversation hashing
    checkpoint.ts          Checkpoint state management
  llm/
    client.ts              OpenAI-compatible LLM client
web/
  wizard.html             Self-contained wizard UI (HTML/CSS/JS)
  graph.html              Standalone graph viewer (vis-network)
```

## REST API Summary

```
GET  /api/status                        Full wizard state
POST /api/setup                         Save config
POST /api/setup/test-llm                Test LLM connection
GET  /api/setup/packages                List existing packages
POST /api/setup/resume                  Resume a package
DELETE /api/setup/package                Purge (delete) a package

POST /api/convert/upload                Upload file (multipart, platform auto-detected)
GET  /api/convert/uploads                List upload queue
PATCH /api/convert/uploads/:filename    Update platform for a queued file
DELETE /api/convert/uploads/:filename    Remove file from queue
POST /api/convert/detect                Auto-detect platform
POST /api/convert/parse                 Parse all queued files
POST /api/convert/confirm               Store all to DB
GET  /api/convert/preview                Cached preview stats

GET  /api/staging/conversations         List staged conversations (paginated)
GET  /api/staging/conversations/:id      Get single conversation with messages
PUT  /api/staging/conversations/:id      Update conversation (include/exclude, edits)
POST /api/staging/bulk-update           Bulk include/exclude + tag apply
POST /api/staging/search                FTS5 full-text search
POST /api/staging/tags                  Create tag definition (name + color)
GET  /api/staging/tags                  List tag definitions
DELETE /api/staging/tags/:id             Delete tag definition
POST /api/staging/commit                Commit selected conversations to chats.db
POST /api/staging/export-only           Commit + finalize + download (skip stages 3–5)
POST /api/staging/psycheros/autodetect  Auto-detect Psycheros databases
POST /api/staging/psycheros/compare     Compare staged vs existing conversations

POST /api/significant/estimate          Cost estimate
POST /api/significant/start             Start (background)
POST /api/significant/abort             Abort
GET  /api/significant/status            Progress
GET/PUT/DELETE /api/memories/significant/*  Memory file CRUD

POST /api/daily/estimate                Cost estimate
POST /api/daily/start                   Start (background)
POST /api/daily/abort                   Abort
GET  /api/daily/status                  Progress
GET/PUT/DELETE /api/memories/daily/*        Memory file CRUD

POST /api/graph/estimate                Cost estimate
POST /api/graph/start                   Start (background)
POST /api/graph/abort                   Abort
POST /api/graph/skip                    Skip (marks as completed without running)
GET  /api/graph/status                  Progress

POST /api/finalize                      Strip platform column, make Psycheros-compatible
GET  /api/download                      Stream package as ZIP (optional ?tags= query)
GET  /graph                             Graph viewer
GET  /api/events                        SSE stream
```

## Checkpoint, resume, and purge

Checkpoints are saved after every item (conversation, date, or memory file). If a stage is interrupted, refresh the page and click Resume on the Setup page. The wizard restores the full state from the checkpoint. To delete a package entirely (all chats, memories, graph data), use the Purge button on the Setup page.

## Related projects

- [Psycheros](https://github.com/zarilewis/Psycheros) — Web-based AI entity harness (imports entity-loom packages)
- [entity-core](https://github.com/zarilewis/entity-core) — MCP server for canonical identity, memory, and knowledge graph
