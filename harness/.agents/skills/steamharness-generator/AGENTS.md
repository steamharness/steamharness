# SteamHarness Generator 规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- 修改本 skill 或 workflow 生成规范前必须先读取并遵循本文件。
- 修改生成或编辑方法、Core API 约定、节点 API、executor/provider 类型时，必须同步 [steamharness-api.md](./references/steamharness-api.md)，确保生成规范与仓库当前 API 一致。
- 如果生成规范面向用户可见，还必须同步同级 Docs 仓库 `../docs/concepts/**`、`../docs/core-api/**` 或 `../docs/cli/**` 中对应说明。

## 发版与日志规则

- Core 仓库中的 generator 不是独立发布单元，不维护自己的 package 版本或 CHANGELOG。
- 生成结果、模板依赖或 Core API 用法发生用户可感知变化时，必须更新本仓 `CHANGELOG.next*.md`；若改变 CLI 创建、检查或发布工作流的方式，还要更新同级 CLI 仓库 `../cli/CHANGELOG.next*.md`；若改变 Desktop 或 Developer Assistant 的体验，则分别更新 `../desktop` 或 `../build-in/build-in-developer-assistant` 仓库。
- 内置 Developer Assistant 的发布副本由 `../build-in/build-in-developer-assistant/skills/steamharness-generator` 独立维护；跨仓同步必须显式比较并分别提交。
- Core 或 CLI release prepare 才能分别更新模板中的精确依赖版本；generator 日常修改不得自行把 Core 与 CLI 版本绑在一起，也不得改成非精确 range。
