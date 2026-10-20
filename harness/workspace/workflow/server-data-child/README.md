# 服务器数据测试子项目

服务器层级示例的中间项目。项目提供 `store` 与 `get` 两个独立工作流入口，通过 alias `parent` 连接父项目，通过 alias `grandchild` 连接孙项目；两条关系均为双方确认的直接关系。

`store` 只需输入内容并返回随机 UUID；把该 UUID 直接传给 `get` 即可读取原内容。可选的 `alias` 放在辅助参数中，留空时操作当前项目。

```bash
PARENT_DIR="$(cd ../server-data-parent && pwd)"
GRANDCHILD_DIR="$(cd ../server-data-grandchild && pwd)"
pnpm exec steamharness json . --entrypoint store -- --content "child content"
CURRENT_ID="<store 返回的 id>"
pnpm exec steamharness json . --entrypoint get -- --id "$CURRENT_ID"

PARENT_ID="<父项目 store 返回的 id>"
pnpm exec steamharness json . --entrypoint get --related-project "parent=$PARENT_DIR" -- --id "$PARENT_ID" --alias parent
pnpm exec steamharness json . --entrypoint store --related-project "grandchild=$GRANDCHILD_DIR" -- --content "hello grandchild" --alias grandchild
```

运行服务器组前需要登录 Server，并确保三个 UUID 已绑定对应云端项目。本项目是父项目与孙项目之间唯一的关系节点，但关联 KV 权限不会递归传递。


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
