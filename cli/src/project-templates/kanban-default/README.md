# __PROJECT_TITLE__

Local task board with three stages. Set an approved database ID in `config.json` under `databases.data` and declare
`"data"` in the entry's `databases` list in `steamharness.json` to save tasks. Without a binding, the board stays editable in
temporary mode and reloading loses its changes. Storage uses `steamHarnessKanban.databases.get('data').kv`.

本地三列任务看板。在根 `config.json` 的 `databases.data` 中填写获批数据库 ID，并在
`steamharness.json` 的入口 `databases` 中声明 `"data"` 后，任务保存到该数据库。
未绑定时可临时编辑，刷新页面会丢失修改。存储通过 `steamHarnessKanban.databases.get('data').kv` 访问。

Run / 运行: `pnpm dev`.
