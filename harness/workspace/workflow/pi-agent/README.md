# pi-agent workflow

Pi Coding Agent SDK workflow sample. It embeds `@earendil-works/pi-coding-agent`
inside a steamharness sample, streams assistant text through
`WorkflowOutputPayload.items`, records the turn in workflow conversation state,
and keeps the smoke fixture offline through an explicit `--dry-run`.

## Install

```bash
cd workspace/workflow/pi-agent
pnpm install
cp .env.example .env
```

The SDK supports its normal `~/.pi/agent` auth and model configuration. This
workflow also accepts runtime provider configuration through environment values:

- `PI_API_KEY` - generic API key override.
- `PI_AGENT_PROVIDER` - optional default provider, `anthropic` or `openai`.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`.
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`.

`OPENAPI_API_KEY`, `OPENAPI_BASE_URL`, and `OPENAPI_MODEL` are accepted as
OpenAI aliases for environments that already use that spelling.

## Run

Inspect structure:

```bash
steamharness structure .
```

Run a live Pi turn:

```bash
PI_API_KEY="sk-..." \
steamharness json . --conversation-id pi-agent-live -- \
  --message "List the files in the current directory without changing files." \
  --workdir . \
  --provider anthropic \
  --model claude-opus-4-5 \
  --base-url "https://api.anthropic.com" \
  --tools read
```

`knowledge_documents` is enabled by default. If you pass `--tools`, the
workflow appends `knowledge_documents` to that allowlist unless you also pass
`--no-knowledge-tools`.

## Tool permissions

This workflow registers all Pi tools with steamharness tool permissions:
`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and
`knowledge_documents`. They are enabled and auto-approved by default so CLI runs
keep the same behavior unless a host supplies an override. App and server embed
runs show these tools in the Run workspace permissions panel, where a user can
disable a tool or require per-call approval before execution.

Run the offline path used by tests:

```bash
steamharness json . --conversation-id pi-agent-dry-run -- \
  --message "Summarize this repository without changing files." \
  --workdir . \
  --provider anthropic \
  --tools read,bash \
  --dry-run
```

Conversation 模式下，默认 composer 会固定映射到 `--message`；旧的
`--prompt` 仍保留为 CLI 兼容入口，但新的 App / Web 示例都以 `--message`
作为主输入协议。

## What it demonstrates

- `@earendil-works/pi-coding-agent` as a workflow-owned dependency.
- `createAgentSession(...)` with `SessionManager.inMemory()`.
- Runtime API key injection through `AuthStorage.inMemory()` and
  `setRuntimeApiKey(...)`.
- Advanced Run workspace provider switching through the `--provider` radio
  param, rendered in the existing auxiliary / Advanced options panel.
- `ModelRegistry.registerProvider(...)` base URL overrides from env or
  `--base-url`, plus optional `ModelRegistry.find(provider, model)` lookup for
  pinned live runs.
- Pi `session.subscribe(...)` events bridged into
  `workflow.createOutputNode({ stream, format })`.
- A custom Pi SDK `knowledge_documents` tool backed by workflow
  PersistentValue project documents. It supports `list` / `get` / `create` /
  `edit` / `delete` / `search` / `read_lines`, matching the OpenAI and Claude
  agent samples.
- Assistant text renders as inline `Output` segments; tool lifecycle events use
  metadata-backed output detail rows between the surrounding text segments.
- Pi SDK token stats are uploaded through `context.tokenUsage.report(...)`,
  including cache read as `cachedInputTokens` and cache write as
  `cacheCreationTokens`.
- Explicit dry-run session that shares the same adapter contract as the live SDK
  path, so workspace tests remain offline and deterministic while normal runs
  call the configured provider.

## Testing boundary

`pnpm test:workspace` runs the explicit dry-run path and verifies this sample's
fixture, structure snapshot, output items, conversation metadata, and token usage
report. Normal runs are live by default, require provider credentials, and may
execute Pi tools in the selected working directory.
