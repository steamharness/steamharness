# CLI 仓库规则

- 每轮修改验证后，按[仓库提交规则](../AGENTS.md#提交与推送)仅提交本轮相关改动并推送。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。
- 本仓库维护 `@steamharness/cli`，仓库根就是 npm 包根；只暴露 `steamharness` bin，本地命令位于顶层，远程管理命令位于 `steamharness workspace`。
- CLI 只能通过 `steamharness` 的公开 exports 使用 Core，不得相对导入同级 `../core/src/**`。Core 通过精确 devDependency 支持构建与测试，`peerDependencies.steamharness` 明确公开兼容范围。
- CLI 始终通过由 `vendor/shared` 刷新的 `.shared/*` 普通目录安装 Shared workspace 依赖；`dev` 和功能分支仅由运行时生成的 `.steamharness-local/tsconfig.json` 指向同级 `../shared` 源码，`main`、tag、detached checkout 和 CI 不得启用该 alias。
- `pnpm dev` 在 `dev` 和功能分支直接运行 CLI 与同级 Core/Shared 源码；在 `main`、tag 和 detached checkout 必须先构建，再只运行 `dist/index.js`、精确 npm Core 与已提交的 `vendor/shared`。`STEAMHARNESS_REPOSITORY_MODE=main` 只能强制收紧到发布模式。
- 跨仓 Core alias 只能写入运行时生成且被忽略的 `.steamharness-local/tsconfig.json`，不得进入提交。提交前和 CI 必须同时执行普通 `pnpm check:boundaries` 与 `STEAMHARNESS_REPOSITORY_MODE=main pnpm check:boundaries`。
- 修改本地命令、参数、输出、退出码或环境变量时，必须同步同级 Docs 仓库 `../docs/cli/steamharness*`；修改 Workspace 命令时同步 `../docs/cli/server-workspace.mdx` 与 `../docs/cli/workspace/**`。
- 用户可见变化写入 `../docs/guides/releases/cli/unreleased.mdx` 与对应英文镜像；纯重构、测试和 CI 调整不写公开日志。
- 代码变更必须补邻近 `src/__tests__/` 或 `scripts/__tests__/` 测试。提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm test:scripts`、`pnpm coverage`、`pnpm build`、`pnpm pack --pack-destination .release` 和 `git diff --check`。
- Node.js 脚本和测试必须兼容 Windows、macOS 与 Linux 路径和换行；默认测试不得依赖真实 Server、GitLab 或数据库。
- `package.json` 是 CLI 版本唯一来源。先定版双语文档，再用 `pnpm release:prepare -- --version X.Y.Z` 校验版本页并更新 CLI 版本，不改写 Core 或 Workspace。
- CLI 与 Core 版本一致。增强版产品从源码打包两者，不等待 npm。仅独立公开分发时手动运行根目录的 GitHub npm 工作流，先 Core 后 CLI。渠道、tag 与发布门禁见根目录 `AGENTS.md`。未经用户明确授权，不创建发布 tag 或发布 npm。
- 本地模板包模式必须把 Core 和 CLI 的归档一起写入项目，使用相对 `file:` 引用；编译项目发行包时保留两个归档及精确版本。不同目录的源码链接不属于此模式。
- 环境文件遵守[仓库根的秘密规则](../AGENTS.md#秘密)；日志、测试输出和示例不得泄露凭据。
