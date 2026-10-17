# Workspace 规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- 本目录属于 Core 仓库，维护公开示例 Workflow、Conversation 与 Core/CLI 兼容烟测。
- 示例项目的 `steamharness` 和 `@steamharness/cli` 必须使用精确版本。Core 的 `release:prepare` 只同步 `steamharness`；CLI 版本由明确的跨仓兼容更新单独维护。
- 修改示例输入、payload、文件、conversation、provider、registry 或 CLI 调用时，必须同步同级 Docs 仓库 `../../docs` 下对应的 concepts、Core API 或 CLI 页面。
- 示例项目版本只表示项目自身版本，不参与 Desktop、Server 或 Core 的平台版本判断。
- 测试必须兼容 Windows、macOS 和 Linux 路径与换行，不得依赖真实外部服务。
