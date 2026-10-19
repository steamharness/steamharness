# Core 仓库规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。

## 仓库边界

- 本仓库维护 `steamharness` Core，仓库根就是 npm 包根；`workspace/**` 也归本仓维护，用于公开示例和 CLI/Core 兼容烟测。
- Shared workspace 依赖始终从已提交的 `vendor/shared` 刷新为 `.shared/*` 普通目录，刷新必须保留 pnpm 生成的包级 `node_modules`；不得把 `.shared/*` 链接到同级仓库。
- 同级 Shared 源码只由 CLI 和 Server 的 `dev` 运行入口通过运行时生成的 `.steamharness-local/tsconfig.json` / Vite alias 加载；`main`、tag、detached checkout 和 CI 必须只消费 `.shared/*` 的 vendor 快照。`STEAMHARNESS_REPOSITORY_MODE=main` 只能强制收紧到发布模式。
- `.steamharness-local` 以及任何跨仓 tsconfig/path alias 都不得提交。提交前和 CI 必须同时执行普通 `pnpm check:boundaries` 与 `STEAMHARNESS_REPOSITORY_MODE=main pnpm check:boundaries`。
- Core 不得相对导入同级 CLI、Studio、Server 或内置项目源码。CLI 联动变更在同级 `../cli` 完成，公开文档在同级 `../docs` 完成。
- 修改 Core 基础定义、公开 exports、节点 API、executor/provider 类型或 runtime report 时，必须同步 `.agents/skills/workflow-generator` 的 API 参考和生成规则。
- 所有节点 payload 必须继承 `RunPayload`，成功结果统一包含 `errCode: 0, errMessage: ""`。
- TypeScript 构建产物只能写入 `dist`；不得用忽略源码目录中的 `*.js` 或 `*.d.ts` 掩盖输出路径错误。
- Node.js 脚本必须兼容 Windows、macOS 和 Linux 路径，使用 `node:path` 与 `pathToFileURL` / `fileURLToPath` 处理文件入口。

## 文档、日志与测试

- 公开 API、行为、参数、错误或 runtime 语义变化必须同步同级 Docs 仓库的 `../docs/concepts/**`、`../docs/core-api/**` 或 `../docs/cli/**`。
- 用户可见变化必须同步中文/英文 `CHANGELOG.next.md` 与 `CHANGELOG.next.en.md`；纯拆仓、测试和内部 CI 调整不写公开日志。
- 代码变更必须补邻近 `src/__tests__/` 或 `scripts/__tests__/` 测试。提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm test:scripts`、`pnpm coverage`、`pnpm build`、`pnpm test:workspace` 和 `git diff --check`。
- 默认测试必须离线可复现，不依赖真实 GitLab、LLM、Server 或数据库。

## 发版与 Git

- `package.json` 是 Core 版本唯一来源，正式 tag 固定为 `steamharness/vX.Y.Z`。
- Core 是唯一需要先人工修改版本源的单元：先把 `package.json` 更新为目标版本，再执行 `pnpm release:prepare -- --version X.Y.Z`。prepare 事务式更新双语日志、Workspace 中精确的 `steamharness` 版本和 Workspace lockfile；不得改写 `@steamharness/cli` 版本。
- `main` 是正式发布分支，`alpha` 是自动测试发布分支，`dev` 是日常集成分支；三者声明版本遵循 `main <= alpha = dev`。普通 Alpha 发布保持基础版本不变，仅生成 `X.Y.Z-YYYYMMDDNNN`；只有明确收到“版本号 +1”指令时，才在 Alpha 和 Dev 一起递增 patch。发布前归档当前分支中英文 `CHANGELOG.next*` 到现有基础版本的历史条目并清空 next；新基础版本只有在显式 bump 时才建立。若提交范围只有版本字段、changelog、CI 或发布元数据，则跳过 npm、tag 和下游级联；源码、依赖或 vendor 内容变化才发布。Alpha 转正直接从已验证提交进入 `main`；成功后默认把 `alpha`、`dev` 对齐到 `main` 并跳过 CI，不发布空 Alpha。正式发布仍从准备完成的 `main` tag 触发。
- **特性分支可以直接发版**：在 `codex/*` 这类功能性分支上执行 `pnpm release:feature`（等价于 `node scripts/feature-release.mjs tag`），脚本会按当天的全局序号算出 `<基础版本>-YYYYMMDDNNN.<分支 slug>`、创建并推送 `feat/v<版本>` tag，CI 随后走与通道发布同一条 validate → pack → publish 路径，publish 到 dist-tag `feat-<分支 slug>`。这条通道**不动 `alpha`/`dev`/`latest`，也不同步下游**：内置项目与宿主把 pin 升到这个精确版本即可（版本号里的日期序号与 alpha/dev 共用计数空间，因此不可能撞版本）。序号耗尽、工作区不干净、或在 `main`/`alpha`/`dev` 上执行时脚本会拒绝。
- 每个 `release:npm*` 作业在打包前运行 `node vendor/shared/release-tools/release-gate.mjs publisher --manifest package.json --package steamharness`：拒绝已发布过的版本，稳定版还必须高于 `latest`。消费方一侧的检查（相对路径、特性分支版本、registry 读回、版本递增）由同一模块的 `verify` 子命令承担，内置项目与 `cli` 在各自 CI 里调用。
- 未经用户明确授权，不创建 tag、不发布 npm、不配置虚假 remote。GitLab 暂不可用时只维护本地分支与提交。
- 只允许提交不含凭据的 `*.env.example`。真实开发 `.env` 保留在本机并由 Git 忽略；正式发布凭据必须使用作用域为 `production` 的受保护 GitLab CI/CD Variables，日志和测试输出不得泄露变量值。

## 规则入口

- 修改 `workspace/**` 时同时读取 [workspace/AGENTS.md](./workspace/AGENTS.md)。
- 修改 `.agents/skills/workflow-generator/**` 时同时读取该目录的 [AGENTS.md](./.agents/skills/workflow-generator/AGENTS.md)。
