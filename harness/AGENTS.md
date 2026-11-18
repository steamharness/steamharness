# Core 仓库规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。

## 仓库边界

- 本目录维护 `steamharness` Core，也是 npm 包根；通用能力使用 `src/__tests__/` 普通测试，加载器与文件系统测试按需生成并清理最小临时夹具，不维护常驻示例工程或独立安装夹具依赖。
- Shared workspace 依赖始终从已提交的 `vendor/shared` 刷新为 `.shared/*` 普通目录，刷新必须保留 pnpm 生成的包级 `node_modules`；不得把 `.shared/*` 链接到同级仓库。
- 同级 Shared 源码只由 CLI 和 Server 的 `dev` 运行入口通过运行时生成的 `.steamharness-local/tsconfig.json` / Vite alias 加载；`main`、tag、detached checkout 和 CI 必须只消费 `.shared/*` 的 vendor 快照。`STEAMHARNESS_REPOSITORY_MODE=main` 只能强制收紧到发布模式。
- `.steamharness-local` 以及任何跨仓 tsconfig/path alias 都不得提交。提交前和 CI 必须同时执行普通 `pnpm check:boundaries` 与 `STEAMHARNESS_REPOSITORY_MODE=main pnpm check:boundaries`。
- Core 不得相对导入同级 CLI、Studio、Server 或内置项目源码。CLI 联动变更在同级 `../cli` 完成，公开文档在同级 `../docs` 完成。
- 修改 Core 基础定义、公开 exports、节点 API、executor/provider 类型或 runtime report 时，必须同步 `.agents/skills/steamharness-generator` 的 API 参考和生成规则。
- 所有节点 payload 必须继承 `RunPayload`，成功结果统一包含 `errCode: 0, errMessage: ""`。
- TypeScript 构建产物只能写入 `dist`；不得用忽略源码目录中的 `*.js` 或 `*.d.ts` 掩盖输出路径错误。
- Node.js 脚本必须兼容 Windows、macOS 和 Linux 路径，使用 `node:path` 与 `pathToFileURL` / `fileURLToPath` 处理文件入口。

## 文档、日志与测试

- 公开 API、行为、参数、错误或 runtime 语义变化必须同步同级 Docs 仓库的 `../docs/concepts/**`、`../docs/core-api/**` 或 `../docs/cli/**`。
- 用户可见变化写入 `../docs/guides/releases/core/unreleased.mdx` 与对应英文镜像；纯重构、测试和 CI 调整不写公开日志。
- 代码变更必须补邻近 `src/__tests__/` 或 `scripts/__tests__/` 测试。提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm test:scripts`、`pnpm coverage`、`pnpm build`、`pnpm test:agent-dist` 和 `git diff --check`。CLI 命令兼容测试在同级 `../cli` 的测试体系运行。
- 默认测试必须离线可复现，不依赖真实 GitLab、LLM、Server 或数据库。

## 发版与 Git

- `package.json` 是 Core 版本唯一来源，正式 tag 固定为 `steamharness/vX.Y.Z`。
- Core 先人工更新 `package.json` 并定版双语文档，再执行 `pnpm release:prepare -- --version X.Y.Z`。该命令校验版本源与对应版本页，不改写日志、消费者版本和 lockfile，也不安装依赖。
- Core 和 CLI 使用同一包版本。增强版产品可直接打包构建产物，无须等待 npm、打 tag 或单独抬版本。需要独立公开分发时才手动运行 GitHub npm 工作流；校验两个组件的双语定版页后先发 SDK，再发 CLI。渠道和 tag 见根目录 `AGENTS.md`。
- 未经用户明确授权，不创建 tag、不发布 npm、不配置虚假 remote。GitLab 暂不可用时只维护本地分支与提交。
- 只允许提交不含凭据的 `*.env.example`。真实开发 `.env` 保留在本机并由 Git 忽略；正式发布凭据必须使用作用域为 `production` 的受保护 GitLab CI/CD Variables，日志和测试输出不得泄露变量值。

## 规则入口

- 修改 `.agents/skills/steamharness-generator/**` 时同时读取该目录的 [AGENTS.md](./.agents/skills/steamharness-generator/AGENTS.md)。
