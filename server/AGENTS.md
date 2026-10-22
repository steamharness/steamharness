# Server 仓库规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。

## 规则入口

- 本文件覆盖整个 Server 仓库。
- 修改 `web/**` 时同时读取 [web/AGENTS.md](./web/AGENTS.md)。管理端界面以 [shadcn 官方 Blocks](https://ui.shadcn.com/blocks) 为准。
- 修改 `docker/**`、部署脚本或生产环境变量时同时读取 [docker/AGENTS.md](./docker/AGENTS.md)。
- `web` 是 Server 自己的项目与数据管理后台，必须保留。Server 不执行项目代码，不提供 Runner、公开 Embed 或执行接入；保留经过鉴权的静态 Kanban 预览与数据桥接。仓库不托管 App renderer 的浏览器 Web Studio。

## 独立仓库边界

- 仓库根就是 Server 根；不要再假设外层 monorepo、`server/` 子目录或 `packages/**` 存在。
- Core 使用 `package.json` 中精确的 `steamharness` npm 版本。不得通过 TypeScript path alias 回连同级 Core 源码。
- Server 始终通过由 `vendor/shared` 刷新的 `.shared/*` 普通目录安装 Shared workspace 依赖；`dev` 和功能分支仅由运行时生成的 `.steamharness-local/tsconfig.json` 与 Server Web Vite alias 指向同级 `../shared` 源码，`main`、tag、detached checkout 和 CI 不得启用该 alias。业务源码统一导入 `@steamharness/*`。
- `pnpm dev` 在 `dev` 和功能分支直接 watch Server、同级 Core/Shared 源码，并由 Server 同源挂载 Server Web Vite HMR；`pnpm start:local` 保持同样的源码模式和开发端口，但关闭 Server watch 与 Server Web HMR。仓库已有的 `pnpm start` 仍用于运行已构建的 `dist/index.js`。在 `main`、tag 和 detached checkout 必须先执行 `build:all`，再只运行 `dist/index.js` 与 `public` 静态 Web。`STEAMHARNESS_REPOSITORY_MODE=main` 只能强制收紧到发布模式。
- 跨仓 Core alias 只能写入运行时生成且被忽略的 `.steamharness-local/tsconfig.json`，不得进入提交。提交前和 CI 必须同时执行普通 `pnpm check:boundaries` 与 `STEAMHARNESS_REPOSITORY_MODE=main pnpm check:boundaries`。
- Node.js 脚本必须兼容 Windows、macOS 和 Linux 路径；文件路径使用 `node:path`，ESM 入口使用 `pathToFileURL(path.resolve(process.argv[1]))` 或 `fileURLToPath(import.meta.url)` 比较。
- 只允许提交不含凭据的 `*.env.example`。真实开发 `.env` 保留在本机并由 Git 忽略；正式发布配置必须使用作用域为 `production` 的受保护 GitLab CI/CD Variables 注入。任何输出和测试日志都不得泄露 token、密码、密钥或完整连接串。

## 功能与文档

- web 平台只连接服务器；Server 不承接 App 的本地 SQLite、本地文件或 Electron 能力。
- 修改 HTTP API、鉴权、错误码、静态预览或数据访问行为时，同步同级 Docs 仓库的 `../docs/openapi/steamharness.openapi.yaml` 和相关说明。
- 修改项目管理、版本、文件、知识库、KV 或部署行为时，同步 `../docs/guides/server/**`；影响 CLI 调用结果时同步 `../docs/cli/workspace/**`。
- 上传与发布只处理静态元数据和文件，不安装依赖、不构建、不加载项目代码。版本快照不可变；源码与数据访问统一使用项目和组成员的 `guest / developer / maintainer / owner` 固定角色。
- 节点 payload 必须继承 `RunPayload`，成功结果统一包含 `errCode: 0, errMessage: ""`。
- 用户可见文案必须遵循现有国际化边界；已有语言资源需要成对维护并补测试。

## 测试

- 修改代码必须补对应回归测试，测试放在邻近 `__tests__/`；默认测试不得依赖生产 PostgreSQL、外部对象存储、LLM、GitLab 或远程服务。
- Server 交付门禁：`pnpm typecheck`、`pnpm test:server`、`pnpm test:scripts`、`pnpm coverage`、`pnpm build`。
- Server Web 交付门禁：`pnpm typecheck:web`、`pnpm test:web`、`pnpm build:web`。
- 根配置、lockfile、Shared vendor 或跨 Server/Server Web 行为变化时执行两组门禁，即 `pnpm typecheck:all`、`pnpm test`、`pnpm coverage`、`pnpm build:all`。
- 浏览器、Playwright、Electron、截图和开发服务器仅在用户明确要求真实页面验证时使用；默认执行离线测试、类型检查和构建。

## 分支与发版

- `main`、`alpha`、`dev` 分别承接正式、测试和日常集成，Server 与 Server Web 的声明版本遵循 `main <= alpha = dev`。普通 Alpha 发布保持基础版本不变，只生成同一基础版本的 `X.Y.Z-YYYYMMDDNNN` 日期版本；只有明确收到“版本号 +1”指令时，才让两个分支及两个 Server 单元一起递增 patch。提交范围只有版本字段、changelog、CI 或发布元数据时不发布；源码、依赖或实际 vendor 变化才进入 Alpha 级联。版本准备前把 Server 与 Server Web 当前分支各自中英文 `CHANGELOG.next*` 归档到现有历史条目并清空 next。Alpha 转正直接从已验证提交进入 `main`；成功后默认将 `alpha`、`dev` 对齐到 `main` 并跳过 CI，不发布空 Alpha。Alpha 与正式版共用 PostgreSQL 和对象存储目录，但代码、进程、日志和本地缓存隔离；数据库变更必须保持 expand-only。
- 本仓与所有子仓库一样维护 `dev`、`alpha`、`main` 三条分支。`dev` 和功能分支上内置项目与 `cli` 用 `link:../harness` 引用同级仓库，`alpha`/`main` 上必须是精确的已发布版本；`shared/release-tools/release-gate.mjs`（本仓 `vendor/shared/` 内）是这条规则的执行者，聚合仓库的 `pnpm check:release-references` 可一次检查全列车。
- Server 与 Server Web 是同仓库内两个独立发布单元。版本源分别为 `package.json` 和 `web/package.json`，正式 tag 分别为 `server/vX.Y.Z` 与 `server-web/vX.Y.Z`。
- 两个单元各维护中文/英文的 `CHANGELOG.md`、`CHANGELOG.en.md`、`CHANGELOG.next.md`、`CHANGELOG.next.en.md`。用户可见变化必须同步两份 next；内部拆仓、测试和 CI 整理不写公开日志。
- 准备版本使用 `pnpm release:prepare -- --unit <server|server-web> --version X.Y.Z`。发布准备只更新目标单元，且中英文历史版本、日期和 next 条目分类必须一致。
- 未经用户明确授权，不创建 tag、不部署生产、不写 stable metadata。CI 在匹配 tag 上独立构建对应产物；部署凭据和生产发布动作由 GitLab 受保护环境配置承接。

## PostgreSQL 与对象存储

- PostgreSQL 排查先做只读连通性、表结构、行数和少量样本检查；DDL 使用 migration，业务数据写入前先确认影响范围。
- 对象存储由 Server 写在本地磁盘：对象统一带 `storage/` 前缀，URL 从 Server 自身的公开来源生成。仓库不携带任何对象存储厂商实现或凭据；需要远端存储的私有部署在仓库之外配置。
- 输出必须脱敏 `api_key`、`token`、`secret`、`secret_hash` 和环境变量值。
