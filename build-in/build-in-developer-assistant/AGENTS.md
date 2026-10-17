# Developer Assistant 内置项目规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- 本仓位于 monorepo 的 `build-in/build-in-developer-assistant`，随仓库一起提交。`dev` 和功能分支上用 `link:../../harness` / `link:../../cli` 引用开源源码根中的聚合仓库源码（CI 由 `scripts/prepare-local-siblings.mjs` 按清单相对路径准备检出），因此改 Core/CLI 不需要先发版；`alpha` 与 `main` 上必须是精确的已发布版本。`scripts/release-gate.mjs` 是这条规则的执行者：发布模式（alpha/main/tag）下拒绝相对路径、拒绝特性分支版本、要求声明的 Core/CLI 已在 registry 上发布，并在 tag 流水线上要求版本高于当前通道。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。
- 本仓库只维护 `developer-assistant` 内置项目，仓库根就是 Workflow 项目根；不得再引用旧 monorepo 内置项目目录或其它仓库内部路径。
- `skills/workflow-code-generator/AGENTS.md` 是 generator 专项规则入口；修改该目录前必须同时读取它。
- 节点 payload 必须继承 `WorkflowPayload`，成功时使用 `errCode: 0, errMessage: ""`。
- Studio 开发态从同级 `build-in/build-in-developer-assistant` 获取本项目依赖；VS Code 宿主通过 `STEAMHARNESS_DEVELOPER_ASSISTANT_HOST=vscode` 使用已有适配。宿主注入 `STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER` 时连接 Studio Control，使用现有工具权限和审批；不读取旧 Desktop Control 配置。原始控制凭据只传给 MCP 子进程，不进入编码工具 shell。
- 用户可见行为变化必须同步中文/英文 `CHANGELOG.next*.md`，并按实际影响更新 `../../docs` 文档。
- 代码变更必须补邻近 `__tests__/` 或 `scripts/__tests__/` 测试。提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage`、`pnpm build` 和 `git diff --check`。
- 发布分两条通道：正式通道的 tag 是 `builtin-developer-assistant/vX.Y.Z`、索引与资源在 `builtin-projects/developer-assistant/…`；Alpha 通道的 tag 是 `builtin-developer-assistant/alpha/vX.Y.Z`、索引与资源在 `builtin-projects/developer-assistant/alpha/…`。通道是 OSS 路径的一段，因此同一个项目版本可以两条通道各发一次。tag 流水线里没有分支可读，通道由 CI 从 tag 形状判定并显式传 `--channel`，不得靠分支推断。转正时在 `main` 上重新构建并发布正式通道——`components` 是烘进制品内 `package.json` 的，必须重建——版本号与 changelog 条目随转正一起到达，因此不再跑一次 `release:prepare`。
- 版本唯一来源是 `package.json`，正式 tag 为 `builtin-developer-assistant/vX.Y.Z`；`release:prepare` 原子维护版本与双语日志，CI tag 作业生成 schema v2 索引和 `all/all` 通用资源。
- 需要让宿主拿到本项目的改动时，直接走发布流程（`pnpm release:prepare` + tag），不必逐次请求用户确认；正式转正仍受根仓库对稳定版/生产发布的规则约束。GitLab 暂不可用的本地拆分阶段不配置虚假 remote。
