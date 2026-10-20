# Unreleased

### 破坏性变更

- 项目 API 从 `/api/workflows` 改为 `/api/projects`，字段改为 `projectId` / `projectName`，请求头 `X-Workflow-Locale` 改为 `X-SteamHarness-Locale`。
- 数据库表 `workflows` / `workflow_*` 改为 `projects` / `project_*`，账户表去掉 `workflow_` 前缀；发布前执行 `docker-internal/deploy/migrate-project-tables.sql`。
- 审计事件类型 `workflow.*` 改为 `project.*`；对象存储前缀与磁盘数据目录改为 `projects/`。

### 变更

- 变更 发布 API 支持版本和源码哈希校验，阻止发布被其他操作替换的草稿。
- Server 改为项目与数据存储服务：移除全部项目执行及 Runner，保留安全上传、不可变源码版本、知识库、KV 和文件；writer 数据写入与源码下载独立授权。
- 清理旧执行错误与权限说明，数据访问错误仅描述服务器存储授权。

### 新特性

- **Kanban 页面方法注入**：注入接口支持方法注册与注销、方法目录、JSON 返回和取消协议。
- **Kanban 展示模式桥接**：Bridge 提供 `getPresentation()` 与模式变化事件，覆盖全屏、手机、平板和对话小卡片。

### 新增

- 新增 Kanban 注入接口的方法注册与注销、方法目录、JSON 返回和取消协议。
- 新增 Kanban 页面 Bridge 的 `getPresentation()` 与展示模式变化事件，覆盖全屏、手机、平板和对话小卡片。
- 新增 Kanban Bridge 项目固定作用域的文件创建、读取与删除，最大 50 MiB，拒绝跨项目和会话附件访问。

### 修复

- 修复直接访问或刷新 Server Web `/projects` 页面时，被已移除 API 的路由拦截并返回 JSON 404 的问题。
