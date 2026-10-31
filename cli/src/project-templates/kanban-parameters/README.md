# __PROJECT_TITLE__

Local task board. Project parameters configure the title and completed-task visibility.
Set an approved database ID in `config.json` under `databases.data` and declare
`"data"` in the entry's `databases` list in `steamharness.json` to persist tasks.
Configurations keep separate tasks. Without a binding, changes are temporary and lost on reload.

本地任务看板。通过项目参数设置标题及已完成任务是否显示。
在根 `config.json` 的 `databases.data` 中填写获批数据库 ID，并在 `steamharness.json` 的入口
`databases` 中声明 `"data"` 后可保存任务，各配置的数据相互独立。
未绑定时可临时编辑，刷新页面会丢失修改。

Run / 运行: `pnpm dev`. Parameters / 参数: `configuration.json`.
