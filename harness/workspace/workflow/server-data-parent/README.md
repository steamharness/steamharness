# 服务器数据测试项目（父）

服务器数据层级示例的父项目。项目提供 `store` 与 `get` 两个独立工作流入口，数据固定写入 `context.storage.server`，并通过 alias `child` 与服务器子项目建立双边直接关系。

`store` 只需输入内容并返回随机 UUID；把该 UUID 直接传给 `get` 即可读取原内容。可选的 `alias` 放在辅助参数中，留空时操作当前项目。

```bash
CHILD_DIR="$(cd ../server-data-child && pwd)"
pnpm exec steamharness json . --entrypoint store -- --content "parent content"
CURRENT_ID="<store 返回的 id>"
pnpm exec steamharness json . --entrypoint get -- --id "$CURRENT_ID"

pnpm exec steamharness json . --entrypoint store --related-project "child=$CHILD_DIR" -- --content "hello child" --alias child
CHILD_ID="<store 返回的 id>"
pnpm exec steamharness json . --entrypoint get --related-project "child=$CHILD_DIR" -- --id "$CHILD_ID" --alias child
```

运行服务器组前需要登录 Server，并确保三个 UUID 已绑定对应云端项目。父项目没有声明孙项目，因此不能通过关联项目 API 越过子项目访问孙项目。完整的父子孙访问合同由 `workspace/__tests__/storage-hierarchy.test.ts` 离线维护。


## Project configuration

Declare fields in `configuration.json` and enter values in Project configurations (Studio or `steamharness web .`). Read them with `workflow.getConfig(key)` or `context.config`. Local CLI and Studio share values; project env files are not loaded.
