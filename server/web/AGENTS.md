# Server Web 规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- 修改 `web/**` 前必须先读取根 [AGENTS.md](../AGENTS.md) 和本文件。
- Server Web 是 Server 自己的管理后台，不是 App renderer 的 Web Studio。它由 Server 同源提供 API 与静态资源；不得引入 App 本地文件、SQLite、Electron 或 `7133` Web Studio 托管能力；不再提供公开 Embed 入口，后端的 `/embed` 路由由 Server 单独负责下架。
- 管理端只管理项目、版本和持久化数据，不展示执行入口、运行日志、运行统计、服务器项目环境变量、Webhook 或 Runner。需要调整 Shared 共享源码时同时读取同级拆分仓库的 [Shared 规则](../../shared/AGENTS.md) 与 [Shared 设计规则](../../shared/DESIGN.md)，管理端的私有样式与控件仍归本仓库所有。
- 管理端使用 [shadcn 官方 Blocks](https://ui.shadcn.com/blocks)、New York source components 与 Tailwind CSS v4。调整组件前读取 [shadcn skill](../.agents/skills/shadcn/SKILL.md)。颜色、尺寸、圆角、阴影及状态样式使用官方组件默认值，不维护额外的私有设计系统。
- 项目与数据表格使用服务端分页和筛选，不向浏览器传完整数据集用于前端聚合。
- 修改登录、项目、版本、知识库、KV、静态预览或移动端体验时，同步 `../../docs/guides/server/**`；展示新的 API 字段时同时检查 `../../docs/openapi/workflow-code.openapi.yaml`。
- 用户可见文案遵循现有国际化边界，维护全部已支持语言、回退路径和测试。
- 异步操作必须区分 loading、empty、error，禁用重复触发入口，并在失败后提供明确反馈和恢复入口。
- 交付前执行 `pnpm -C .. typecheck:web`、`pnpm -C .. test:web`、`pnpm -C .. build:web`。仅在用户明确要求时启动浏览器或视觉调试。

## 发版

- Server Web 版本唯一来源是 `package.json`，正式 tag 为 `server-web/vX.Y.Z`；不得因为 Server 发版而联动提升版本。
- 中文/英文历史与 next 日志位于本目录。用户可见变化必须成对更新；同时改变 Server API 时也更新根目录 Server 日志。
- 使用 `pnpm -C .. release:prepare -- --unit server-web --version X.Y.Z` 准备版本。未获明确发布授权时不创建 tag、不部署生产。
