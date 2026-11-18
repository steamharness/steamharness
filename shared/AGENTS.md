# Shared 仓库规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。
- 本仓库维护 Core、CLI、Server 与 Server Web 复用的 TypeScript 源码包，不作为 npm 发布单元。
- 新增模块必须使用 `<package-name>/package.json + index.ts` 的目录包形式；测试放在模块自身 `__tests__/`，不得在根目录继续增加散落入口。
- 涉及可复用 UI、样式、运行界面、视觉结构、交互、响应式或可访问性时，必须同时读取并遵循 [DESIGN.md](./DESIGN.md)。宿主只负责页面壳、theme bridge 与平台适配。
- 本地消费者通过同级 `../shared` 使用源码；独立 checkout 和 CI 使用各仓已提交的 `vendor/shared`。`pnpm build` 生成 `dist/source`，`pnpm sync:downstream` 默认只更新本地兄弟仓，远程同步必须显式设置 `STEAMHARNESS_SHARED_REMOTE_SYNC=true`。
- 消费仓的 `.shared/*` 始终是各自 `vendor/shared` 刷新的普通 workspace 目录，并保留 pnpm 生成的包级 `node_modules`；不得链接到本仓。`dev` 和功能分支仅通过被忽略的 `.steamharness-local/tsconfig.json` 与 Vite alias 加载本仓源码，`main`、tag、detached checkout 和 CI 必须禁用这些 alias。`repository-boundary` 扫描跨仓 import、相对 package 依赖、越界 tsconfig 引用和 main 源码链接；main 链接扫描只跳过 pnpm 管理的 `node_modules`，包根与业务源码子目录仍必须是普通文件。消费者 CI 必须在普通模式和 `STEAMHARNESS_REPOSITORY_MODE=main` 下各执行一次。
- `release-tools/release-gate.mjs` 保留给仍显式调用它的旧独立发布工具。它对 registry 的检查不适用于从源码打包 Core、CLI 的增强版产品，也不由 monorepo 的 npm 工作流调用。工具保持零运行时依赖；改动后按根 `AGENTS.md` 运行 `node scripts/check-vendor-copies.mjs --fix` 并一起提交所有受影响的副本。
- `pnpm audit:identity` 扫描本地拆分仓的生产源码、配置和公开文档；旧 `app` Desktop 契约只允许出现在检测后立即抛错的拒绝守卫中，不允许 alias、fallback 或双写。
- Shared 变化必须列出 Core、CLI、Server、Server Web 中的实际消费者，并在所有受影响仓执行 typecheck、test、coverage 与 build。用户可见变化在实际受影响组件的双语文档草稿中记录；Shared 不发布 npm，也没有独立版本页，根 `package.json` 的版本仅作为 `main`、`alpha`、`dev` 渠道基线与 vendor artifact 标识。
- 修改公开行为或界面时，同步同级 Docs 仓库 `../docs` 的对应页面。已有国际化资源必须同步维护中文与英文及回退测试。保留国际化 namespace `desktop` 以兼容现有协议，不得恢复 `app` alias。
- Node.js 脚本和测试必须兼容 Windows、macOS 与 Linux 路径和换行；默认测试不得依赖真实 GitLab、Server 或数据库。
- Shared 随 monorepo 提交进入 `dev`，增强版从固定的公开 gitlink 检出，不要求单独发布 Shared 制品或让下游先发版。不要为文档、CI 或元数据改动抬版本、打 tag 或推进 `main`、`alpha`。
- 提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm test:scripts`、`pnpm coverage`、`pnpm build` 和 `git diff --check`。
