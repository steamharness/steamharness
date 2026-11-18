# 内置 SteamHarness Generator 规则

- 用户要求使用、切换、合并或推送 `dev` 时，仅有 `main` 分支的仓库一律按 `main` 处理；不得为此新建 `dev` 分支。
- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- 修改本 skill 或 workflow 生成规范前必须先读取并遵循本文件。
- 修改生成或编辑方法、Core API 约定、节点 API、executor/provider 类型时，必须同步 [steamharness-api.md](./references/steamharness-api.md)，确保生成规范与仓库当前 API 一致。
- 如果生成规范面向用户可见，还必须同步 Docs 仓库 `../../docs/concepts/**`、`../../docs/core-api/**` 或 `../../docs/cli/**` 中对应说明。

## 发版与日志规则

- 本目录是 Developer Assistant 发布资源中的 generator 唯一来源，不再与 Desktop 或 Core 仓库中的副本做隐式同步。
- 生成结果、模板依赖或 Core API 用法发生用户可见变化时，在仓库根的 `docs/guides/releases/builtin-developer-assistant/unreleased.mdx` 及对应 `docs/en/` 草稿记录。若主要影响 Core 或 CLI，改相应组件草稿，不抄第二份；定版遵守 `docs/AGENTS.md`。
- Core 或 CLI 版本变化时，模板中的依赖仍分别使用精确版本；不得把 Core 与 CLI 版本绑在一起，也不得改成非精确 range。
