# {{name}}

这是一个可直接运行的 SteamHarness Kanban 项目。任务在页面内新建、编辑、拖拽和删除，不通过配置表单维护；首次打开时显示固定示例任务。

项目的 `configuration.json` 初始 fields 为空，统一配置面板支持添加自定义字段。任务通过 `window.steamHarnessKanban.kv` 自动持久化，键名为 `kanban.board-state.v1:default`。直接打开页面且宿主未注入 Bridge 时仍可在当前会话内编辑，但刷新后不会保留。

新增、编辑、拖拽和删除会立即更新界面，并经过 300ms 防抖后按顺序写入 KV。页面顶部显示加载、保存和失败状态；写入失败不会回滚当前任务，可通过“重试”再次保存。

宿主还会注入 `window.steamHarnessKanban.knowledge`，可用于项目知识库的查询和维护。KV 与知识库都固定到当前项目，页面不能指定其它项目、scope 或数据库路径。

运行纯逻辑测试：

```bash
node --test tests/*.test.mjs
```

使用 `steamharness structure .` 可以验证项目类型和 HTML 入口。
