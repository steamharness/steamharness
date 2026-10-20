# deltaforce-openai-agent

Delta Force data workflow that reuses `../openai-agents` as its Agents SDK core.
The parent workflow owns Delta Force prompt construction, OpenAPI tool
registration, and conversation transcript writes.

## Flow

```text
parent input
  -> load Delta Force OpenAPI + object-config
  -> build Delta Force system prompt
  -> create Agents SDK function tools from OpenAPI operations
  -> parent output node starts workflow.runProject(openaiAgentsProject, ...)
  -> parent forwards the nested workflow output chunks unchanged
  -> parent format step appends user/assistant messages
```

The nested `openai-agents` call uses `conversationMode: "shared-readonly"` and
`kvMode: "isolated"`. It can read recent parent conversation messages, but it
does not append messages, set the title, or write `openaiAgents.runCount/facts/history`
into the parent workflow KV namespace. Its default hosted/native/sample tools are disabled:

- web search
- image generation
- local shell
- `read_context`
- `remember_fact`
- `test_tool`

Only Delta Force OpenAPI function tools are registered through `customTools`.
The parent output node calls `workflow.runProject(openaiAgentsProject, ...)`
with `onOutputChunk` and `onOutput`. If `openai-agents` streams output, those
chunks are forwarded as-is into the parent stream; if a reused child workflow is
non-streaming, the parent can still display its final output payload. The
parent does not rebuild or reorder the child text/tool items, so the UI follows
the called workflow's real output order. Delta Force tool calls appear because
`openai-agents` emits function tool invocations as collapsed streaming output
items; this parent workflow only forwards those chunks.

The parent still owns the final conversation write. After the nested workflow
finishes, it parses the nested workflow's final answer item only for Delta
Force metadata and transcript content, then appends the parent user/assistant
messages. Tool output items stay visible but are not mixed into final-answer
parsing.

## Environment

Delta Force API defaults match `deltafore-agent`:

- `DELTAFORE_OPENAPI_URL`
- `DELTAFORE_API_BASE_URL`

Agents SDK credentials use the same variables as `openai-agents`:

- `OPENAI_API_KEY` or `LLM_API_KEY`
- `OPENAI_BASE_URL` or `LLM_BASE_URL`
- `OPENAI_MODEL` or `LLM_MODEL`

The workspace smoke fixture sets `DELTAFORCE_OPENAI_AGENT_MOCK=1` and uses local
mock fetch data, so normal tests do not call real `hookcode.win` or OpenAI.

## Run

Inspect structure:

```bash
steamharness structure .
```

Run:

```bash
steamharness json . --conversation-id deltaforce-openai-demo -- \
  --message "我需要配置 M7，操控速度高" \
  --max-rounds 2
```

## Notes

The older `deltafore-agent` sample is intentionally left unchanged. This sample
is the OpenAI Agents SDK variant and keeps the parent workflow responsible for
conversation state so nested workflow reuse does not duplicate transcript rows.

第二阶段开始，这个 conversation 示例统一把默认 composer 映射到
`--message`；旧的 `--query` 仍保留给 CLI 兼容。


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
