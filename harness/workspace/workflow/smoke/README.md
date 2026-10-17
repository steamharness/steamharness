# smoke

Workflow runtime smoke fixture for local checks.

```bash
cd workspace/workflow/smoke
pnpm exec workflow-code run . -- --message ok
pnpm exec workflow-code json . -- --message nope --mode fail
```

Conversation smoke:

```bash
WORKFLOW_KV_STORE_DIR="$PWD/.workflow-kv" \
  pnpm exec workflow-code json . --conversation-id smoke-demo -- --message hello
```

第二阶段开始，smoke conversation 示例也走默认 composer 的 `--message`
协议；`--mode` 和 `--wait-ms` 继续保留为辅助参数。
