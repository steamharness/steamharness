# conversation-knowledge

Conversation application that mirrors each conversation into one project
knowledge-base markdown document.

For a real local write, give the conversation state and knowledge base separate
local roots:

```bash
steamharness structure .
STEAMHARNESS_KV_STORE_DIR="$PWD/.workflow-kv" \
STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR="$PWD/.workflow-persistent-values" \
  steamharness json . --conversation-id demo-thread -- --message "记录今天的结论"
```

`--dry-run` is still available when only a markdown preview is needed; it does
not write a knowledge document to either local or server storage.

On the server, publish the workflow and run it through the server API so a
document is created or updated in PostgreSQL with a stable conversation id.
`$STEAMHARNESS_ID` is the UUID bound to the server project, not the workflow
display name:

```bash
curl -X POST "$STEAMHARNESS_SERVER_URL/api/workflows/$STEAMHARNESS_ID/run" \
  -H "Authorization: Bearer $STEAMHARNESS_SERVER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "draft",
    "conversation_id": "demo-thread",
    "args": ["--message", "记录今天的结论", "--title", "Demo conversation"]
  }'
```

Each run appends a user message and a deterministic assistant acknowledgement to
`context.conversation`, then rewrites the knowledge document with the full
conversation transcript. The document id is derived from the conversation id, so
subsequent runs with the same conversation id update the same markdown document.
The local and server documents are intentionally separate, even when they use
the same conversation id; no automatic synchronization is performed.

第二阶段开始，这个示例的默认 composer 固定映射到 `--message`；`--title`
和 `--dry-run` 继续作为辅助参数保留在 Advanced options / CLI 里。
