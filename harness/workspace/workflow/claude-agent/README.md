# claude-agent workflow

Claude Agent SDK workflow sample. It opens or resumes a Claude Agent session,
streams assistant text through `RunOutputPayload.items`, maps tool activity
to collapsed output items, and stores the Claude Agent session id in workflow
conversation state.

## Install

```bash
cd workspace/workflow/claude-agent
pnpm install
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env` for local CLI runs. App and server runs should
set the same key through the saved workflow environment values for that target.

Optional environment values (also settable per-run via flags):

- `ANTHROPIC_BASE_URL` — override the Anthropic API endpoint, e.g. a proxy or
  compatible gateway. When unset, the SDK uses the default Anthropic API.
- `ANTHROPIC_MODEL` — Claude model id (e.g. `claude-sonnet-4-6`). When unset, the
  SDK falls back to its built-in default model.

## Run

Inspect structure:

```bash
steamharness structure .
```

Run a live Claude Agent turn:

```bash
steamharness json . --conversation-id claude-agent-demo -- \
  --message "List the files in this directory without making changes." \
  --workdir .
```

Limit available tools:

```bash
steamharness json . --conversation-id claude-agent-readonly -- \
  --message "Summarize the README." \
  --workdir . \
  --tools Read,Glob,Grep \
  --permission-mode dontAsk
```

## Tool permissions

This workflow registers Claude Agent tools with steamharness tool permissions:
`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `Bash`,
`BashOutput`, `KillBash`, `WebFetch`, `WebSearch`, `Task`, `ExitPlanMode`,
`ListMcpResources`, `ReadMcpResource`, `NotebookRead`, `NotebookEdit`,
`TodoRead`, `TodoWrite`, `AskUserQuestion`, `EnterWorktree`, `ExitWorktree`, and
`mcp__steamharness-knowledge-documents__knowledge_documents`. They are enabled and
auto-approved by default so CLI runs follow the executor defaults. App and
server embed runs can override those defaults from the Run workspace permissions
panel; disabled registered tools are removed from the SDK `tools` list, and
tools with auto approval off stay in `tools` but are removed from `allowedTools`
so the SDK `canUseTool` callback routes them through the shared user-input
approval flow. When any registered tool requires manual approval, the workflow
forces Claude SDK `permissionMode` to `default` for that run so `canUseTool` is
not bypassed by permissive SDK modes.

Pin a specific model and base URL for the run:

```bash
ANTHROPIC_BASE_URL="https://api.example.com" \
ANTHROPIC_MODEL="claude-sonnet-4-6" \
steamharness json . --conversation-id claude-agent-pinned -- \
  --message "Summarize the README." \
  --workdir . \
  --model claude-sonnet-4-6
```

Conversation 模式下，默认 composer 会固定映射到 `--message`；旧的
`--prompt` 仍可用于 CLI 兼容，但新的默认输入框协议统一使用
`--message`。

## What it demonstrates

- `@anthropic-ai/claude-agent-sdk` as a workflow-owned dependency.
- Claude Agent session reuse through `context.conversation` state.
- `tools`, `allowedTools`, `permissionMode`, `systemPrompt`, `cwd`, and `model`
  passed into `query(...)`.
- `ANTHROPIC_BASE_URL` forwarded through the SDK `env` option so the spawned
  Claude Code process uses the configured endpoint.
- `model` sourced from `--model` / `-m`, with fallback to the `ANTHROPIC_MODEL`
  env var and finally the SDK default.
- A custom in-process SDK MCP tool `knowledge_documents` registered through
  `createSdkMcpServer` and passed via `query()`'s `mcpServers` option, wrapping
  the steamharness knowledge helpers (`list` / `get` / `create` / `edit` /
  `delete` / `search` / `read_lines`) so the agent reads and writes
  PersistentValue-backed knowledge documents in the same way the rest of the
  repo does. Toggle with `--knowledge-tools` / `--no-knowledge-tools`
  (default: enabled).
- Partial message streaming bridged into `workflow.createOutputNode({ stream,
  format })` and `workflow.runStreamNode(...)`.
- Assistant text emitted as inline Markdown `Output` items.
- Tool use emitted as collapsed JSON output items with running/success status
  metadata.
- Manual `context.tokenUsage.report(...)` for SDK result usage, including
  Claude cache read and cache creation token details.

## Testing boundary

The default workspace test suite keeps this sample opted out of runtime smoke
because it starts an external Claude Code process and requires
`ANTHROPIC_API_KEY`. `pnpm test:workspace` still verifies the smoke fixture,
structure snapshot, executor params, conversation metadata, and token usage
metadata. Live SDK behavior should be checked with the opt-in commands above.
