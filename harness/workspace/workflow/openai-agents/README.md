# openai-agents workflow

OpenAI Agents SDK workflow sample. It calls `@openai/agents`, passes workflow
conversation context into the SDK run, exposes SDK tools backed by workflow KV
and PersistentValue-backed project knowledge documents, and streams output
through the current `WorkflowOutputPayload.items` protocol.

## Install

```bash
cd workspace/workflow/openai-agents
npm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`. Set `OPENAI_BASE_URL` when the SDK should call
a compatible endpoint instead of the default OpenAI API. Terminal runs load `.env`; App and server runs use saved
workflow environment values through `workflow.getEnv`.

## Run

Inspect structure:

```bash
workflow-code structure .
```

Run a live Agents SDK turn:

```bash
workflow-code json . --conversation-id openai-agents-demo -- \
  --message "Remember project tone as concise" \
  --workdir .
```

Run with the local shell tool enabled when your OpenAI endpoint supports
Responses API shell tools:

```bash
workflow-code json . --conversation-id openai-agents-shell-demo -- \
  --message "Use local_shell to run pwd and summarize the result" \
  --workdir . \
  --local-shell
```

Ask the agent to call the custom HTTP test tool:

```bash
workflow-code json . --conversation-id openai-agents-test-tool-demo -- \
  --message "Use test_tool to GET https://example.com and summarize the status" \
  --workdir .
```

Ask the agent to search or update local project knowledge documents by assigning
PersistentValue its own local root:

```bash
WORKFLOW_PERSISTENT_VALUE_STORE_DIR="$PWD/.workflow-persistent-values" \
workflow-code json . --conversation-id openai-agents-knowledge-demo -- \
  --message "Use knowledge_documents to list project documents, then search for PersistentValue" \
  --workdir .
```

Without a local PersistentValue root, a configured server connection remains an
alternative backend. Local and server knowledge documents are isolated and are
not synchronized automatically.

Conversation 模式下，默认 composer 固定映射到 `--message`；旧的 positional
CLI 输入仍保留兼容，但推荐统一走 `--message`。

## Tool permissions

This workflow registers its Agents SDK tools with workflow-code tool
permissions: `web_search`, `image_generation`, `local_shell`, `test_tool`,
`knowledge_documents`, `remember_fact`, `read_context`, and `custom_tools`.
They are enabled and auto-approved by default so CLI runs keep the sample's
existing behavior. App and server embed runs can override those defaults from
the Run workspace permissions panel; disabled tools are omitted before the SDK
run starts. Function tools, custom tools, knowledge documents, memory tools, and
local shell calls use the shared user-input approval flow at call time when auto
approval is off. Hosted OpenAI tools (`web_search` and `image_generation`) do
not expose a local pre-call approval hook in the SDK, so this sample asks for a
run-level approval before starting the agent when either hosted tool requires
manual approval.

## What it demonstrates

- `@openai/agents` as a real workflow-owned npm dependency.
- `OPENAI_API_KEY` and optional `OPENAI_BASE_URL` read with
  `workflow.getEnv(...)`.
- `Agent`, `run`, `setDefaultOpenAIClient`, `tool`, and `shellTool` from the
  Agents SDK.
- Agents SDK streaming via `Runner.run(..., { stream: true })`, bridged into
  `workflow.createOutputNode({ stream, format })` and
  `workflow.runStreamNode(...)`.
- OpenAI built-in hosted tools: web search and image generation.
- A custom `test_tool` function tool that sends a small HTTP GET or POST
  request and returns status, content type, and a short response preview.
- A `knowledge_documents` function tool backed by the core Knowledge Documents
  helpers. It supports `list`, `get`, `create`, `edit`, `delete`, `search`, and
  `read_lines` actions against `context.storage.local.persistentValue`.
- Tool visibility: SDK raw stream text deltas are emitted as normal assistant
  text, while function tool execution is shown as separate `Tool: <name>`
  output items. Avoid forcing the main agent to emit a text preamble before tool
  calls because some OpenAI-compatible endpoints treat that text as the final
  answer and never emit the function call.
- Optional `--local-shell` support using a controlled local
  `shellTool({ environment: { type: "local" }, shell })` implementation that
  runs small commands inside `--workdir`.
- Zod schemas for SDK tool parameters.
- Workflow conversation state passed into the SDK `context`.
- `context.abortSignal` forwarded into `run(...)`.
- Conversation-scoped KV for remembered facts and lightweight SDK history.
- Manual `context.tokenUsage.report(...)` for an external SDK, including
  `cachedInputTokens` and `cacheCreationTokens` when the SDK reports cache read
  or cache write details.

## Reuse from another workflow

`openai-agents` can also be imported as a reusable Agents SDK core:

```ts
import { openaiAgentsWorkflow } from "../openai-agents/index";

const output = await workflow.runWorkflow(
  openaiAgentsWorkflow,
  {
    message: input.query,
    instructions: [systemPrompt],
    defaultTools: false,
    memoryTools: false,
    knowledgeTools: false,
    testTool: false,
    localShell: false,
    writeConversation: false,
    writeAgentState: false,
    customTools,
  },
  context,
  {
    name: "OpenAI Agents core",
    conversationMode: "shared-readonly",
    kvMode: "isolated",
    outputVisibility: "hidden",
  },
);
```

In normal CLI mode all sample tools stay enabled and the workflow writes
`openaiAgents.*` KV plus user/assistant conversation messages. In reuse mode,
the caller can disable hosted/native/default tools, memory tools, knowledge
tools, and pass only custom Agents SDK function tools. Use `knowledgeTools:
false` when a reusable parent workflow should not expose the project knowledge
base to the nested agent. Use `writeConversation: false` and `writeAgentState:
false` when the parent workflow owns transcript/title/history.
`conversationMode: "shared-readonly"` lets this workflow read recent parent
messages without appending duplicate messages or changing the title. Use
`kvMode: "isolated"` when this reusable workflow should not write
`openaiAgents.*` state into the parent workflow KV namespace, and
`outputVisibility: "hidden"` when the parent forwards the child stream itself.

The visible answer streams before final KV/conversation/token-usage writes
complete. Reuse callers that want to show this workflow exactly as-is should
call `workflow.runWorkflow(...)` from their own output node and forward
`onOutputChunk` / `onOutput` into the parent stream. Function tool calls are
also emitted as collapsed Markdown output items as soon as the SDK invokes the
tool. The final answer item starts only when answer text actually arrives, so
tool cards keep their real order instead of being inserted below an already
created answer placeholder. The workflow disables the Agents SDK default trace
exporter so a finished answer is not delayed by trace flush retries or noisy
abort logs. If the SDK Responses streaming terminal event is missing
`response.output`, the workflow keeps already streamed text as the final answer.
For OpenAI-compatible endpoints that incorrectly start a second/third turn after
streaming a complete text answer with empty `response.output`, the sample keeps
the first visible text, buffers the next turn, and stops if that next turn is
another empty-output text response. If the next turn resolves to normal SDK
items, such as a function call or message output, the buffered text is kept and
the run continues. If no text was emitted yet, it retries once with a
non-streaming SDK run and streams that final text through workflow output
chunks.

The sample defines these tools:

- `read_context`: returns the current conversation id, recent messages, run
  count, and remembered facts.
- `remember_fact`: writes a short `{ key, value }` fact into
  `context.storage.local.kv.conversation`.
- `test_tool`: sends a small HTTP `GET` or `POST` request to a provided
  `http`/`https` URL and returns a compact response summary. The offline test
  starts a local HTTP server to verify that the tool really sends the request,
  so normal test runs do not depend on external network access.
- `knowledge_documents`: lists, reads, creates, edits, deletes, searches, and
  reads line ranges from project markdown knowledge documents. It reuses the
  core `workflow.*KnowledgeDocument*` helpers and therefore writes only through
  `context.storage.local.persistentValue`. Local runs can use
  `WORKFLOW_PERSISTENT_VALUE_STORE_DIR`; otherwise they use a configured server
  backend. Calls fail only when neither backend nor an injected store is
  available, and they never fall back to ordinary local KV.
- `local_shell`: when `--local-shell` is set, executes small, safe local shell
  commands in the configured `--workdir`. The sample rejects common
  destructive/network/process commands, write redirection, overly long
  commands, and long-running commands. Treat this as workflow-level guardrail
  code, not as a full security sandbox. Some OpenAI-compatible base URLs may not
  support Responses API shell tools yet; leave `--local-shell` off for those
  providers.

The final answer is emitted as the inline Markdown `Output` item. Function tool
activity is emitted before or between answer chunks as a collapsed `Tool:
<name>` item with parameters, status, duration, and a compact result preview.
