# deltafore-agent

Delta Force data ReAct agent sample backed by the live OpenAPI service at `http://hookcode.win:7222/openapi.json`.

The workflow runs in conversation mode, keeps recommendation and reasoning logic inside the LLM, and exposes every current OpenAPI operation as a tool. The OpenAPI document is fetched on each run, so newly added API paths become available without editing the workflow source.

Default endpoints:

- OpenAPI: `http://hookcode.win:7222/openapi.json`
- Object config: `http://hookcode.win:7222/api/object-config`
- API base URL: `http://hookcode.win:7222`
- Swagger UI reference: `http://hookcode.win:7223`

You can override the live service with:

- `DELTAFORE_OPENAPI_URL`
- `DELTAFORE_API_BASE_URL`

The tool names are generated from HTTP method plus path. Examples:

- `get_api_guns(q?, limit?, offset?, caliber?, minFireSpeed?, maxFireSpeed?, sort?, order?)`
- `get_api_guns_objectId(objectId)`
- `get_api_guns_objectId_ammo(objectId)`
- `get_api_guns_objectId_attachments(objectId, scope?)`
- `get_api_guns_objectId_attachment_options(objectId, scope?, includeEffects?, limitPerSlot?)`
- `get_api_items(q?, primaryClass?, secondClass?, grade?, sort?, order?, limit?, offset?)`
- `get_api_object_search(objectName?, objectID?, page?, limit?)`
- `get_api_attachments(q?, secondClass?, sort?, order?, limit?, offset?)`
- `get_api_price_ocr_latest(objectID?, baseObjectId?, objectName?, primaryClass?, secondClass?, dataType?, condition?, ammoLevel?, limit?, offset?)`

`get_api_guns_objectId_attachment_options` is the preferred tool for automatic loadout analysis because it returns gun metadata, slot names/types, candidate attachments, numeric attachment effects, and advantage/disadvantage text in one response.

`POST /api/sync/*` operations are also exposed because they are part of the OpenAPI contract, but the prompt marks them as maintenance/sync tools. The agent should only call them when the user explicitly asks to sync, refresh, or inspect synchronization behavior. For safe smoke or validation, the prompt requires `dryRun=true` before any real sync write.

`createContext` also fetches `/api/object-config` once per run and turns stable dictionaries into the system prompt, including gun slot IDs, object type mappings, exchange groups, maps, and key types. Current slot APIs return `slotName` and `accType` directly; the injected dictionary remains a fallback for older or partial responses and prevents extra `get_api_object_config` calls.

## Flow

```text
createContext fetches latest OpenAPI and object-config dictionaries
user query
  -> conversation history
  -> react-thought-llm
  -> deltafore-agent-progress (streamed public Thought and Action text)
  -> equipment-tool (streamed running/completed HTTP tool card)
  -> deltafore-agent-progress (streamed Observation text)
  -> react-thought-llm
  -> deltafore-agent-output
  -> append user/assistant messages
```

The loop follows `Thought -> Action -> Observation -> Thought -> ... -> Final Answer`. The LLM must return one plain JSON ReAct object per round. A public `thought.summary` explains the current working assumption without exposing hidden reasoning. `phase: "action"` requests one HTTP tool call, and `phase: "final_answer"` returns the final Chinese answer. The `finalAnswer` string may use lightweight Markdown such as bold text, lists, and simple tables. Tool execution starts as a collapsed JSON card with `metadata.status: "running"`, simulates 1-3 seconds of network latency, then updates the same card to `success` or `failed` with timing, request URL, parameters, response summary, and compact evidence. The workflow writes an Observation from the real tool result back into the next ReAct round, including HTTP failures and empty data, so the model can change parameters, change tools, paginate, or answer conservatively.

Tool results separate UI preview from reasoning evidence. `preview` is only a small display sample and may be clipped, while `agentFacts` is the model-facing compact result. For normal API responses, `agentFacts.rows` keeps every returned row up to a safe high limit, and `agentFacts.page.hasMore` plus `agentFacts.nextPageArgs` tells the agent when it should fetch another API page. The prompt explicitly tells the LLM not to treat clipped preview rows as missing data.

## Files

- `index.ts`: ReAct workflow loop, executor params, and per-run OpenAPI/object-config loading.
- `nodes/nodes.ts`: input, ReAct Thought LLM, streamed progress, HTTP tool card, and final output nodes.
- `agent/`: prompt, input parsing, ReAct parsing, and Observation formatting.
- `tools/openapi.ts`: OpenAPI parsing, object-config prompt dictionaries, tool catalog generation, request building, and response summarization.
- `tools/runner.ts`: agent tool execution wrapper.

## Run

Create `.env` with an LLM provider:

```bash
cp ../hello/.env.example .env
```

Inspect structure:

```bash
workflow-code structure .
```

Execute:

```bash
workflow-code run . -- --message "我需要配置 M7，操控速度高"
```

Generate JSON report:

```bash
workflow-code json . -- --message "我需要配置 M7，操控速度高" --max-rounds 10
```

Run with conversation history:

```bash
workflow-code json . --conversation-id deltafore-agent-demo -- --message "我需要配置 M7，操控速度高" --max-rounds 10
workflow-code json . --conversation-id deltafore-agent-demo -- --message "继续找能提升操控速度的 M7 配件" --max-rounds 10
```

Conversation 模式下，默认 composer 固定映射到 `--message`；旧的 positional
文本和 `--query` 仍保留 CLI 兼容。
