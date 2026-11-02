# {{name}}

这是一个可直接运行的 SteamHarness Kanban 项目。任务在页面内新建、编辑、拖拽和删除，不通过配置表单维护；首次打开时显示固定示例任务。

项目的 `configuration.json` 初始 fields 为空，统一配置面板支持添加自定义字段。任务通过 `window.steamHarnessKanban.databases.get("data").kv` 自动持久化，键名为 `kanban.board-state.v1:default`。未绑定数据库或直接打开页面且宿主未注入 Bridge 时可临时编辑，页面会明确提示刷新后不会保留。读取失败时禁用编辑，避免覆盖已有任务。

新增、编辑、拖拽和删除会立即更新界面，并经过 300ms 防抖后按顺序写入 KV。页面顶部显示加载、保存和失败状态；写入失败不会回滚当前任务，可通过“重试”再次保存。

模板现有 KV 读写需要入口声明 `databases: ["data"]`，并在根 `config.json` 的 `databases.data` 中填写宿主批准的 ID；模板不会生成或绑定虚构资源。知识库独立通过 `window.steamHarnessKanban.knowledgeBases.get("docs")` 访问：入口声明 `knowledgeBases: ["docs"]`，根配置映射 `knowledgeBases.docs`，并在 Server 建立账号、项目与入口绑定。知识库与 KV 的同名别名互相独立；页面不能选择未声明的资源或任意数据库路径。

运行纯逻辑测试：

```bash
node --test tests/*.test.mjs
```

使用 `steamharness structure .` 可以验证项目类型和 HTML 入口。
