# 服务器数据测试孙项目

服务器层级示例的孙项目。项目提供 `store` 与 `get` 两个独立工作流入口，只通过 alias `parent` 连接服务器子项目，不直接声明服务器父项目。

`store` 只需输入内容并返回随机 UUID；把该 UUID 直接传给 `get` 即可读取原内容。可选的 `alias` 放在辅助参数中，留空时操作当前项目。

```bash
PARENT_DIR="$(cd ../server-data-child && pwd)"
pnpm exec steamharness json . --entrypoint store -- --content "grandchild content"
CURRENT_ID="<store 返回的 id>"
pnpm exec steamharness json . --entrypoint get -- --id "$CURRENT_ID"

PARENT_ID="<子项目 store 返回的 id>"
pnpm exec steamharness json . --entrypoint get --related-project "parent=$PARENT_DIR" -- --id "$PARENT_ID" --alias parent
```

运行服务器组前需要登录 Server，并确保三个 UUID 已绑定对应云端项目。对父项目的越级访问必须失败，这一行为由 workspace 层级访问测试维护。
