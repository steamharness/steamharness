# 本地数据测试项目（父）

本地数据层级示例的父项目。项目提供 `store` 与 `get` 两个独立工作流入口，数据固定写入 `context.storage.local`，并通过 alias `child` 与本地子项目建立双边直接关系。

`store` 只需输入内容并返回随机 UUID；把该 UUID 直接传给 `get` 即可读取原内容。可选的 `alias` 放在辅助参数中，留空时操作当前项目。

```bash
CHILD_DIR="$(cd ../local-data-child && pwd)"
pnpm exec steamharness json . --entrypoint store -- --content "parent content"
CURRENT_ID="<store 返回的 id>"
pnpm exec steamharness json . --entrypoint get -- --id "$CURRENT_ID"

pnpm exec steamharness json . --entrypoint store --related-project "child=$CHILD_DIR" -- --content "hello child" --alias child
CHILD_ID="<store 返回的 id>"
pnpm exec steamharness json . --entrypoint get --related-project "child=$CHILD_DIR" -- --id "$CHILD_ID" --alias child
```

父项目没有声明孙项目，关联 KV 权限不会通过子项目递归传递。
