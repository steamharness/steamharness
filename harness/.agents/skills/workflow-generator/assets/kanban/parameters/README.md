# {{name}}

这个示例只把看板标题和强调色作为命名配置。任务属于看板业务数据，应在页面内新建、编辑、移动和删除，不通过逗号分隔的参数维护。

任务使用 `window.steamHarnessKanban.kv` 持久化，键名为 `kanban.board-state.v1:<configurationId|default>`。每个命名配置拥有独立任务数据；直接打开页面且宿主未注入 Bridge 时，页面仍可在当前会话内编辑，但刷新后不会保留。

运行纯逻辑测试：

```bash
node --test tests/*.test.mjs
```
