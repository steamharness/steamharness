# Docs 仓库规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。
- 本仓库只维护对外公开的 SteamHarness 文档，使用 Docusaurus 生成可部署的静态站点；跟随 workspace 维护 `dev`、`alpha`、`main` 三条分支，日常开发提交到 `dev`，发布仍然只在 `main` 上进行。本仓不维护 SemVer 或 changelog。
- 简体中文使用根路径，英文使用 `/en/**` 镜像。新增、移动或删除 MDX、OpenAPI 或导航时，必须同步两种语言与 `docs.json` 的同一信息架构；英文站内绝对链接必须带 `/en/` 前缀。
- 公开文档只写用户可执行的功能、配置、API、限制和排查方法，不写内部 issue、MR、构建机、本机路径、私有域名、未脱敏凭据或过程性讨论。
- 浏览器产品统一称为 “Server Web 管理端”；它连接 Server 并管理云端项目。不得再描述 Desktop renderer Web Studio、`app/out/studio-web`、7133 端口或在浏览器执行 Electron 本地逻辑。
- Studio、Core、CLI、Server、Server Web 和六个内置项目的用户可见行为由同级独立仓库维护；相关变化必须在同次工作中同步本仓对应页面。生成的发布日志页由各发布仓提供的稳定 metadata/历史输入更新，不在正文手工编造版本事实。
- `pnpm validate` 检查导航、双语页面、站内链接、OpenAPI 结构与已删除 Web Studio 术语；`pnpm test` 覆盖构建和部署事务；`pnpm build` 生成带精确 commit 的 Docusaurus `dist/site` 静态产物。
- `main` CI 只部署当前精确 `CI_COMMIT_SHA` 的构建产物。部署根必须通过受保护的绝对路径变量 `STEAMHARNESS_DOCS_DEPLOY_ROOT` 提供，服务重启通过绝对路径 `STEAMHARNESS_DOCS_DEPLOY_HOOK` 与 JSON 参数数组显式配置；不得依赖外层 monorepo checkout 或远端分支最新状态。
- 修改后提交前执行 `pnpm validate`、`pnpm test`、`pnpm build` 和 `git diff --check`。默认不启动浏览器、Docusaurus dev server 或真实部署。
