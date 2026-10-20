# smoke

Workflow runtime smoke fixture for local checks.

```bash
cd workspace/workflow/smoke
pnpm exec steamharness run . -- --message ok
pnpm exec steamharness json . -- --message nope --mode fail
```

Conversation smoke:

```bash
STEAMHARNESS_KV_STORE_DIR="$PWD/.workflow-kv" \
  pnpm exec steamharness json . --conversation-id smoke-demo -- --message hello
```

第二阶段开始，smoke conversation 示例也走默认 composer 的 `--message`
协议；`--mode` 和 `--wait-ms` 继续保留为辅助参数。


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
