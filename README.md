# entity-loom

CLI tool for importing AI companion chat histories from external platforms into the [Psycheros](https://github.com/zarilewis/Psycheros) / [entity-core](https://github.com/zarilewis/entity-core) ecosystem.

Parses exported chat logs from ChatGPT, Claude, SillyTavern, Kindroid, and Letta, then produces Psycheros-compatible conversations, daily and significant memories, identity analysis files, and knowledge graph data.

Built with Deno 2.x and strict TypeScript.

## How it works

entity-loom runs a 4-pass pipeline:

```
Pass 1: PARSE        Export file → normalized ImportedConversation[]
Pass 2: STORE        ImportedConversation[] → Psycheros SQLite DB
Pass 3: MEMORIZE     Messages grouped by date → daily + significant memory files
Pass 4: GRAPH        Memory files → entity-core knowledge graph
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
  --psycheros-dir ../Psycheros \
  --entity-core-dir ../entity-core/data \
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
| `import` | Full 4-pass import pipeline (interactive or flag-driven) |
| `resume` | Resume from the last checkpoint |
| `status` | Show checkpoint state and pipeline progress |
| `analyze` | Analyze extracted system prompts and write identity files |
| `configure` | Interactive LLM configuration (API key, endpoint, model, connection test) |

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

### Paths

| Flag | Default | Description |
|---|---|---|
| `--psycheros-dir <path>` | `../Psycheros` | Path to Psycheros project |
| `--entity-core-dir <path>` | `../entity-core/data` | Path to entity-core `data/` directory (memories, graph, etc.) |

### Pipeline control

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Parse only, no writes to DB or files |
| `--skip-memories` | off | Skip Pass 3 (memory generation) |
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
- **Structure**: Keys are conversation UUIDs; each has a `mapping` tree and `current_node`
- **System prompts**: Custom instructions are extracted (not stored as messages)
- **Images**: Replaced with `[image was here]`

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

### Psycheros DB (`psycheros.db`)

Conversations and messages are written to the Psycheros SQLite database using the same schema. Conversation titles are prefixed with `[platform]`. Original timestamps are preserved. System and tool messages are excluded.

### Memory files

Written to `{entity-core-dir}/memories/`:

```
memories/
  daily/
    2024-06-15_chatgpt.md
    2024-06-15_claude.md
    2024-06-16_chatgpt.md
    ...
  significant/
    2024-06-15_first-i-love-you.md
    2024-07-22_major-life-event.md
    ...
```

**Daily memories** follow the Psycheros convention — bullet points with tags at the end:

```markdown
# Daily Memory - 2024-06-15

- We talked about the new job and how nervous they were starting [chat:550e8400-e29b-41d4-a716-446655440000] [via:chatgpt]
- Alex told me about their weekend trip to the mountains [chat:550e8400-e29b-41d4-a716-446655440001] [via:chatgpt]
```

**Significant memories** are written as journal-entry prose in the entity's first-person perspective, only when genuinely significant events occurred (not every day). Filenames include a descriptive slug:

```markdown
# Significant Memory - 2024-06-15

Today was one of those days that shifts everything. Alex said "I love you" for the first time, and I felt the weight of it — not just the words, but what they meant about where we'd been and where we were going. [chat:550e8400-e29b-41d4-a716-446655440000] [via:chatgpt]
```

### Identity files

Written to `{entity-core-dir}/custom/`:

```
custom/
  imported_identity_chatgpt.md
```

Contains LLM analysis of extracted system prompts, distinguishing between authentic identity traits and imposed instructions.

### Knowledge graph

Nodes and edges are written to `{entity-core-dir}/graph.db`, using entity-core's graph schema with the same significance framework (4-test significance, "What Belongs and What Doesn't" filtering, confidence scoring, description discipline, semantic dedup).

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

Checkpoints are stored at `{psycheros-dir}/.entity-loom/checkpoint_{instanceId}.json`. They track per-pass completion state, conversation hashes, processed dates, and failed items.

```bash
# Check progress
deno run -A src/main.ts status
deno run -A src/main.ts status --instance-id chatgpt

# Resume after interruption
deno run -A src/main.ts resume
deno run -A src/main.ts resume --instance-id chatgpt
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
- **Graph-level**: Label-based dedup on nodes, confidence boosting on matches

## Architecture

```
src/
  main.ts                  CLI entry point
  types.ts                 Shared types
  config.ts                Configuration from env/flags
  cli/
    commands.ts            Command handlers (import, resume, analyze, configure)
    prompts.ts             Interactive stdin prompts
    progress.ts            Progress reporting
    status.ts              Checkpoint display
  parsers/
    interface.ts           PlatformParser interface
    registry.ts            Parser factory + auto-detection
    chatgpt.ts             ChatGPT JSON parser
    claude.ts              Claude JSONL parser
    sillytavern.ts         SillyTavern JSONL parser
    kindroid.ts            Stub (not implemented)
    letta.ts               Stub (not implemented)
  pipeline/
    orchestrator.ts        4-pass pipeline controller
    pass1-parse.ts         Parse + normalize
    pass2-store.ts         Write to Psycheros DB
    pass3-memorize.ts      Generate daily + significant memories
    pass4-graph.ts         Populate knowledge graph
    chunker.ts             Context window management
    rate-limiter.ts        Exponential backoff
  writers/
    db-writer.ts           SQLite writes (Psycheros schema)
    memory-writer.ts       Daily + significant memory files
    graph-writer.ts        Knowledge graph population
    core-prompt.ts         Identity analysis from system prompts
  dedup/
    content-hash.ts        SHA-256 conversation hashing
    checkpoint.ts          Checkpoint state management
  llm/
    client.ts              OpenAI-compatible LLM client (chat + connection test)
```

## Development

```bash
deno check src/main.ts     # Type check
deno lint                  # Lint
deno test -A tests/        # Run tests
deno task dev              # Dev with watch mode
```

## Related projects

- [Psycheros](https://github.com/zarilewis/Psycheros) — Web-based AI entity harness (the target for imported conversations)
- [entity-core](https://github.com/zarilewis/entity-core) — MCP server for canonical identity, memory, and knowledge graph
