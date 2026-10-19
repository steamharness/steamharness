# CLI 仓库规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。
- 本仓库维护 `@steamharness/cli`，仓库根就是 npm 包根；只暴露 `steamharness` bin，本地命令位于顶层，远程管理命令位于 `steamharness workspace`。
- CLI 只能通过 `steamharness` 的公开 exports 使用 Core，不得相对导入同级 `../core/src/**`。Core 通过精确 devDependency 支持构建与测试，`peerDependencies.steamharness` 明确公开兼容范围。
- CLI 始终通过由 `vendor/shared` 刷新的 `.shared/*` 普通目录安装 Shared workspace 依赖；`dev` 和功能分支仅由运行时生成的 `.steamharness-local/tsconfig.json` 指向同级 `../shared` 源码，`main`、tag、detached checkout 和 CI 不得启用该 alias。
- `pnpm dev` 在 `dev` 和功能分支直接运行 CLI 与同级 Core/Shared 源码；在 `main`、tag 和 detached checkout 必须先构建，再只运行 `dist/index.js`、精确 npm Core 与已提交的 `vendor/shared`。`STEAMHARNESS_REPOSITORY_MODE=main` 只能强制收紧到发布模式。
- 跨仓 Core alias 只能写入运行时生成且被忽略的 `.steamharness-local/tsconfig.json`，不得进入提交。提交前和 CI 必须同时执行普通 `pnpm check:boundaries` 与 `STEAMHARNESS_REPOSITORY_MODE=main pnpm check:boundaries`。
- 修改本地命令、参数、输出、退出码或环境变量时，必须同步同级 Docs 仓库 `../docs/cli/steamharness*`；修改 Workspace 命令时同步 `../docs/cli/server-workspace.mdx` 与 `../docs/cli/workspace/**`。
- 用户可见变化必须同步中文/英文 `CHANGELOG.next.md` 与 `CHANGELOG.next.en.md`；纯拆仓、测试和内部 CI 调整不写公开日志。
- 代码变更必须补邻近 `src/__tests__/` 或 `scripts/__tests__/` 测试。提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm test:scripts`、`pnpm coverage`、`pnpm build`、`pnpm pack --pack-destination .release` 和 `git diff --check`。
- Node.js 脚本和测试必须兼容 Windows、macOS 与 Linux 路径和换行；默认测试不得依赖真实 Server、GitLab 或数据库。
- `package.json` 是 CLI 版本唯一来源，正式 tag 固定为 `steamharness-cli/vX.Y.Z`。`pnpm release:prepare -- --version X.Y.Z` 事务式更新版本与双语日志，不跨仓改写 Core 或 Workspace。
- `main` 是正式发布分支，`alpha` 是自动测试发布分支，`dev` 是日常集成分支；三者声明版本遵循 `main <= alpha = dev`。普通 Alpha 发布保持基础版本不变，仅生成 `X.Y.Z-YYYYMMDDNNN`；只有明确收到“版本号 +1”指令时，才在 Alpha 和 Dev 一起递增 patch。版本递增前归档当前分支中英文 `CHANGELOG.next*` 到现有历史条目并清空 next。若提交范围只有版本字段、changelog、CI 或发布元数据，则跳过 npm、tag 和下游级联；源码、依赖或 vendor 内容变化才发布。Alpha 转正直接从已验证提交进入 `main`；成功后默认把 `alpha`、`dev` 对齐到 `main` 并跳过 CI，不发布空 Alpha。未经用户明确授权，不创建正式 tag、不发布正式 npm 版本、不配置虚假 remote；GitLab 暂不可用时只维护本地分支与提交。
- 每个 `release:npm*` 作业在打包前运行 `node vendor/shared/release-tools/release-gate.mjs publisher --manifest package.json --package @steamharness/cli`：拒绝已发布过的版本，稳定版还必须高于 `latest`。
- **特性分支可以直接发版**：在 `codex/*` 这类功能性分支上执行 `pnpm release:feature`（等价于 `node scripts/feature-release.mjs tag`），脚本会按当天的全局序号算出 `<基础版本>-YYYYMMDDNNN.<分支 slug>`、创建并推送 `feat/v<版本>` tag，CI 随后走与通道发布同一条 validate → pack → publish 路径，publish 到 dist-tag `feat-<分支 slug>`。这条通道**不动 `alpha`/`dev`/`latest`，也不同步下游**：需要它的仓库把 pin 升到这个精确版本即可（版本号里的日期序号与 alpha/dev 共用计数空间，因此不可能撞版本）。序号耗尽、工作区不干净、或在 `main`/`alpha`/`dev` 上执行时脚本会拒绝。
- `.env` 可以提交，但日志、测试输出和示例不得泄露凭据。
