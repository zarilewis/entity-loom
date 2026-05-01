# entity-loom

CLI tool for importing AI companion chat histories from external platforms into self-contained import packages for the [Psycheros](https://github.com/zarilewis/Psycheros) / [entity-core](https://github.com/zarilewis/entity-core) ecosystem.

Parses exported chat logs from ChatGPT, Claude, SillyTavern, Kindroid, and Letta, then produces a structured directory with a chat database, daily and significant memories, and knowledge graph data — ready for Psycheros/entity-core to import.

Built with Deno 2.x and strict TypeScript.

## How it works

entity-loom runs a 5-pass pipeline, producing a self-contained import package:

```
Pass 1: PARSE           Export file → normalized ImportedConversation[] → raw/
Pass 2: STORE            ImportedConversation[] → chats.db (package-local SQLite)
Pass 3a: DAILY MEMORIES  Messages grouped by date → memories/daily/
Pass 3b: SIGNIFICANT     Raw conversations (by conversation, chunked) → memories/significant/
Pass 4: GRAPH            Memory files → graph.db (package-local SQLite)
Pass 5: PACKAGE          Write manifest.json, finalize
```

Each pass is checkpointable. If the process is interrupted, `entity-loom resume` picks up where it left off.

## Setup

```bash
# Clone and enter the project
git clone <repo-url> && cd entity-loom

# Install Deno if needed (https://deno.land)
curl -fsSL https://deno.land/install.sh | sh

# Configure your LLM API key (needed for memory generation and graph population)
deno run -A src/main.ts configure
# Or manually: cp .env.example .env and set LLM_API_KEY
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_API_KEY` | Yes (unless `--dry-run`) | — | API key for the worker LLM |
| `LLM_BASE_URL` | No | `https://openrouter.ai/api/v1` | OpenAI-compatible API base URL |
| `LLM_MODEL` | No | `google/gemini-2.5-flash` | Default LLM model |
| `WORKER_MODEL` | No | `LLM_MODEL` | Model for memory generation (overrides `LLM_MODEL`) |

## Quick start

### Configure LLM (interactive)

```bash
deno run -A src/main.ts configure
```

Walks through API key, endpoint provider (OpenRouter, Z.ai, OpenAI, Anthropic, or custom), model selection, and connection test. Writes to `.env`.

### Interactive import

```bash
deno run -A src/main.ts import
```

Guides you through platform selection, file path, entity/user names, pronouns, relationship context, and context notes before running the full pipeline.

### Non-interactive import

```bash
deno run -A src/main.ts import \
  --platform chatgpt \
  --input ~/Downloads/conversations.json \
  --entity-name Luna \
  --entity-pronouns "she/her" \
  --user-name Alex \
  --user-pronouns "he/him" \
  --relationship "partner"
```

### Dry run (parse only, no writes)

```bash
deno run -A src/main.ts import --platform chatgpt --input ~/Downloads/conversations.json --dry-run
```

## Commands

| Command | Description |
|---|---|
| `import` | Full 5-pass import pipeline (interactive or flag-driven) |
| `resume` | Resume from the last checkpoint |
| `status` | Show checkpoint state and pipeline progress |
| `configure` | Interactive LLM configuration (API key, endpoint, model, connection test) |
| `graph preview` | Interactive knowledge graph viewer |

## Flags

### Required (or prompted interactively)

| Flag | Description |
|---|---|
| `--platform <type>` | Source platform: `chatgpt`, `claude`, `sillytavern`, `kindroid`, `letta` |
| `--input <path>` | Path to export file or directory |
| `--entity-name <name>` | Entity's name (used in memory writing) |
| `--user-name <name>` | Your name (used in memory writing) |

### Identity context

| Flag | Description |
|---|---|
| `--entity-pronouns <pronouns>` | Entity's pronouns (e.g., `she/her`) |
| `--user-pronouns <pronouns>` | Your pronouns (e.g., `he/him`) |
| `--relationship <type>` | Relationship to the entity (e.g., `partner`, `close friend`) |
| `--context-notes <text>` | Free-text context about the conversation history |

### Output

| Flag | Default | Description |
|---|---|---|
| `--output-dir <path>` | `.loom-exports` | Directory to store import packages |

### Pipeline control

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Parse only, no writes to DB or files |
| `--skip-memories` | off | Skip Pass 3 (daily + significant memory generation) |
| `--skip-graph` | off | Skip Pass 4 (knowledge graph) |
| `--date-from YYYY-MM-DD` | — | Only process memories from this date onward |
| `--date-to YYYY-MM-DD` | — | Only process memories up to this date |
| `--cost-estimate` | off | Estimate token usage without making LLM calls (not yet implemented) |

### LLM / rate limiting

| Flag | Default | Description |
|---|---|---|
| `--api-key <key>` | `LLM_API_KEY` env var | Override LLM API key for this run |
| `--base-url <url>` | `LLM_BASE_URL` env var | Override LLM API base URL for this run |
| `--model <model>` | `LLM_MODEL` env var | Override LLM model for this run |
| `--worker-model <model>` | `WORKER_MODEL` env var | Model for memory generation |
| `--max-context-tokens <n>` | `90000` | Worker context window limit |
| `--rate-limit-ms <n>` | `2000` | Delay between LLM calls |
| `--request-timeout-ms <n>` | `120000` | Per-request LLM timeout (increase for slow providers) |

### Identity and metadata

| Flag | Default | Description |
|---|---|---|
| `--instance-id <id>` | Platform name | Source instance tag (used in checkpoint, memory filenames, and [via:] tags) |
| `--context-notes <text>` | — | Free-text context about the conversation history |

### Other

| Flag | Description |
|---|---|
| `--help` | Show usage information |

## Context notes

The `--context-notes` flag accepts free-text context about the conversation history. This is injected into the memory generation prompts so the LLM can understand things it couldn't infer from messages alone. Examples:

- `--context-notes "I went by the name Alex in these conversations"`
- `--context-notes "The entity presented as different facets — Luna was caring, Nova was playful"`
- `--context-notes "I was going through a divorce during June-September 2024"`
- `--context-notes "The entity's system was completely reset in March 2025"`

This context is saved in the checkpoint for resume consistency. It is not stored as a memory itself.

## Staged imports

For large histories, you can import in stages using date ranges to manage cost and rate limits:

```bash
# First batch: early conversations
deno run -A src/main.ts import \
  --platform chatgpt --input ~/exports/chatgpt.json \
  --entity-name Luna --user-name Alex \
  --date-from 2023-01-01 --date-to 2023-12-31

# Second batch: more recent
deno run -A src/main.ts import \
  --platform chatgpt --input ~/exports/chatgpt.json \
  --entity-name Luna --user-name Alex \
  --instance-id chatgpt \
  --date-from 2024-01-01
```

The checkpoint system prevents duplicate processing. Conversations already parsed in the first run are skipped in the second.

## Conversation IDs

Imported conversation IDs are preserved as-is from the export format:

```
chatgpt:   550e8400-e29b-41d4-a716-446655440000  (native UUID from export)
claude:    abc123-...                                (native UUID from export)
sillytavern: a1b2c3d4-e5f6-7890-abcd-ef1234567890  (deterministic UUID from file content)
```

For platforms without native IDs (like SillyTavern), a deterministic UUID is generated from the file content using SHA-256. Re-importing the same file always produces the same conversation ID.

The `[via:instance]` tag in memory files tracks which platform/instance a conversation came from. No platform prefix is added to the conversation ID itself, keeping it compatible with Psycheros's UUID-based chat ID system.

Message IDs from the export are preserved as-is in the database.

## Supported platforms

### ChatGPT

- **Format**: Single JSON file from data export (Settings → Data controls → Export)
- **Structure**: Conversations have a `mapping` tree and `current_node`. The parser handles both object format (`Record<string, Conversation>`, keyed by UUID) and array format (`Conversation[]`, newer exports).
- **System prompts**: Custom instructions are extracted (not stored as messages)
- **Images**: Replaced with `[image was here]`
- **Corrupt timestamps**: Clamped to 2020–2030 range to handle broken values in exports

### Claude

- **Format**: JSONL file from data export (Settings → Data export)
- **Structure**: One JSON object per line per conversation
- **Role mapping**: `human` → `user`
- **Images**: Attachments replaced with `[image was here]`

### SillyTavern

- **Format**: JSONL files (one per chat, or a directory of JSONL files)
- **Structure**: First line is a header with `chat_metadata`, `user_name`, `character_name`
- **Conversation IDs**: Deterministic UUID generated from file content via SHA-256 (SillyTavern exports have no native stable IDs)
- **Message IDs**: Generated from timestamp + content hash (SillyTavern has no stable message IDs)

### Kindroid

Not yet implemented. The parser stub exists at `src/parsers/kindroid.ts`.

### Letta

Not yet implemented. The parser stub exists at `src/parsers/letta.ts`.

## Output

entity-loom produces a self-contained import package at `.loom-exports/{entityName}-{platform}/`:

```
.loom-exports/Luna-chatgpt/
├── manifest.json          # Package metadata and stats
├── checkpoint.json        # Pipeline progress state
├── chats.db               # SQLite DB with conversations and messages
├── memories/
│   ├── daily/             # Day-by-day bullet-point summaries
│   └── significant/       # Journal-entry prose for significant events
├── graph.db               # Knowledge graph SQLite DB
└── raw/
    └── conversations.json # Raw parsed conversations (for significant memory extraction)
```

### Chat database (`chats.db`)

Conversations and messages are stored in a local SQLite database matching the Psycheros schema. Original timestamps are preserved. System and tool messages are excluded.

### Memory files

**Daily memories** follow the Psycheros convention — bullet points with tags at the end:

```markdown
# Daily Memory - 2024-06-15

- We talked about the new job and how nervous they were starting [chat:550e8400-e29b-41d4-a716-446655440000] [via:chatgpt]
- Alex told me about their weekend trip to the mountains [chat:550e8400-e29b-41d4-a716-446655440001] [via:chatgpt]
```

**Significant memories** are extracted from raw conversations by whole conversation (not day-by-day), with overlapping chunking for long conversations. This captures multi-day event arcs that would be missed by day-bucketed processing. They are written as journal-entry prose in the entity's first-person perspective, only when genuinely significant events occurred:

```markdown
# Significant Memory - 2024-06-15

Today was one of those days that shifts everything. Alex said "I love you" for the first time, and I felt the weight of it — not just the words, but what they meant about where we'd been and where we were going. [chat:550e8400-e29b-41d4-a716-446655440000] [via:chatgpt]
```

### Knowledge graph (`graph.db`)

Nodes and edges are stored in a local SQLite database.

Pass 4 runs in two phases:

1. **Extraction** — Each memory file is sent to the LLM with a prompt that enforces a concrete-reality standard: the graph tracks people, places, health facts, preferences, traditions, goals, and boundaries — not abstract themes, coined terms, metaphors, or philosophical notions. A confidence floor of 0.7 filters weak extractions. The `topic` and `insight` entity types are restricted to narrow, concrete use cases.

2. **Consolidation** — After all memories are processed, a rule-based pass (no LLM calls) prunes and merges nodes:
   - Isolated node pruning: removes non-person/self nodes with 0 connections
   - Generic topic detection: removes low-connectivity nodes matching vague patterns (single common words, `sacred \w+`, `\w+ connection`, `\w+ dynamic`, `\w+ intimacy`)
   - Duplicate merging: case-insensitive and containment-based label dedup with edge re-parenting
   - Edge cleanup: soft-deletes edges connected to pruned nodes

### Manifest (`manifest.json`)

Contains package metadata (version, entity/user names, platform, instanceId, context) and stats from each pipeline pass (conversations parsed, messages stored, memories created, graph nodes/edges).

## Prompt caching

The LLM client automatically uses prompt caching where the provider supports it:

| Provider | Behavior |
|---|---|
| Z.ai (`api.z.ai`) | Fully automatic. No headers needed. Cached tokens billed at 50%. |
| OpenAI | Automatic prefix caching. No headers needed. |
| OpenRouter | Passes through provider-specific caching. |
| Anthropic | Explicit opt-in via `anthropic-beta` header (automatic in entity-loom). |

Since entity-loom sends many LLM calls with identical system message prefixes, caching reduces cost on repeated calls.

## Checkpoint and resume

Checkpoints are stored at `.loom-exports/{entityName}-{platform}/checkpoint.json`. They track per-pass completion state, conversation hashes, processed dates, and failed items.

```bash
# Check progress
deno run -A src/main.ts status

# Resume after interruption
deno run -A src/main.ts resume
```

## Error handling

- Parse errors: Skip malformed conversations, log warning, continue
- DB constraint violations: Treated as dedup, skipped silently
- LLM rate limits (429): Exponential backoff up to 60s
- LLM timeouts: Retry up to 3 times
- Graph errors: Best-effort, logged and continued

Exit codes: `0` = success, `1` = fatal error, `2` = partial completion (checkpoint saved, resumable)

## Dedup strategy

- **Conversation-level**: SHA-256 hash of ordered message content, stored in checkpoint
- **Message-level**: Consecutive identical role+content messages deduplicated
- **Memory file-level**: Checks if daily memory file exists before writing
- **Graph-level**: Case-insensitive label dedup on nodes, within-batch dedup via label map, edge dedup on (from, to, type) triple, confirm-and-boost on matches, transactional writes. Post-extraction consolidation pass prunes isolated/generic nodes and merges duplicates.

## Architecture

```
src/
  main.ts                  CLI entry point
  types.ts                 Shared types
  config.ts                Configuration from env/flags
  cli/
    commands.ts            Command handlers (import, resume, configure)
    prompts.ts             Interactive stdin prompts
    progress.ts            Progress reporting
    status.ts              Checkpoint display
    graph.ts               Graph preview CLI command
  parsers/
    interface.ts           PlatformParser interface
    registry.ts            Parser factory + auto-detection
    chatgpt.ts             ChatGPT JSON parser
    claude.ts              Claude JSONL parser
    sillytavern.ts         SillyTavern JSONL parser
    kindroid.ts            Stub (not implemented)
    letta.ts               Stub (not implemented)
  pipeline/
    orchestrator.ts        5-pass pipeline controller
    pass1-parse.ts         Parse + normalize + serialize raw
    pass2-store.ts         Write to package-local SQLite DB
    pass3-memorize.ts      Daily memory generation (day-by-day from DB)
    pass3b-significant.ts  Significant memory extraction (conversation-level from raw)
    pass4-graph.ts         Knowledge graph population
    pass5-packager.ts      Package manifest finalization
    chunker.ts             Context window chunking (flat messages + conversation-aware)
    rate-limiter.ts        Exponential backoff
  writers/
    db-writer.ts           SQLite writes (conversations + messages)
    memory-writer.ts       Daily + significant memory files
    graph-writer.ts        Knowledge graph extraction (LLM-based)
    graph-consolidator.ts  Knowledge graph consolidation (rule-based)
    manifest-writer.ts     Package manifest generation
  dedup/
    content-hash.ts        SHA-256 conversation hashing
    checkpoint.ts          Checkpoint state management
  llm/
    client.ts              OpenAI-compatible LLM client (chat + connection test)
  graph/
    server.ts              Graph preview HTTP server + REST API
web/
  graph.html               Standalone graph viewer (vis-network, list/graph views)
```

## Development

```bash
deno check src/main.ts     # Type check
deno lint                  # Lint
deno test -A tests/        # Run tests
deno task dev              # Dev with watch mode
```

## Related projects

- [Psycheros](https://github.com/zarilewis/Psycheros) — Web-based AI entity harness (imports entity-loom packages)
- [entity-core](https://github.com/zarilewis/entity-core) — MCP server for canonical identity, memory, and knowledge graph
