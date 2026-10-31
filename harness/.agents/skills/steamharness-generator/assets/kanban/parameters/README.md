# {{name}}

这个示例只把看板标题和强调色作为命名配置。任务属于看板业务数据，应在页面内新建、编辑、移动和删除，不通过逗号分隔的参数维护。

数据库需先申请、获批并绑定：在根 `config.json` 的 `databases.data` 中填写获批 ID，并在 `steamharness.json` 的入口 `databases` 中声明 `"data"`。任务使用 `window.steamHarnessKanban.databases.get("data").kv` 持久化，键名为 `kanban.board-state.v1:<configurationId|default>`。每个命名配置拥有独立任务数据；未绑定数据库或直接打开页面且宿主未注入 Bridge 时可临时编辑，页面会明确提示刷新后不会保留。读取失败时禁用编辑，避免覆盖已有任务。

运行纯逻辑测试：

```bash
node --test tests/*.test.mjs
```
