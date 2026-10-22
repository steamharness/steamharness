# Docs 内容仓规则

本目录只维护 SteamHarness 的**公开文档内容**，不再包含 Docusaurus 站点、依赖或构建脚本。站点由独立工作区消费这些源文件生成。

- 内容形态固定为 Markdown/MDX、`docs.json` 导航、`openapi/` 规范与 `images/` 静态图。不要在 `docs/` 下重新引入 `package.json`、Docusaurus 配置、主题、插件或构建产物。
- 简体中文使用根路径，英文使用 `/en/**` 镜像。新增、移动或删除 MDX 或 OpenAPI 时，必须同步两种语言与 `docs.json` 的同一信息架构；英文站内绝对链接必须带 `/en/` 前缀。
- 公开文档只写用户可执行的功能、配置、API、限制和排查方法，不写内部 issue、MR、构建机、本机路径、私有域名、未脱敏凭据或过程性讨论。
- 浏览器产品统一称为 “Server Web 管理端”；它连接 Server 并管理云端项目。不得再描述 Desktop renderer Web Studio、`app/out/studio-web`、7133 端口或在浏览器执行 Electron 本地逻辑。
- Studio、Core、CLI、Server、Server Web 和六个内置项目的用户可见行为由同级目录维护；相关变化必须在同次工作中同步本目录对应页面。发布日志页由各发布仓提供的稳定 metadata/历史输入更新，不在正文手工编造版本事实。
- 校验命令（都不需要安装依赖）：

```sh
node scripts/validate-docs.mjs
node --test --test-reporter=spec scripts/__tests__/*.test.mjs
```

- `scripts/validate-docs.mjs` 检查导航、双语页面、站内链接、OpenAPI 文件与已删除术语；`scripts/generate-release-notes.mjs` 从各仓 CHANGELOG 生成发布日志。
- 发布与部署不在本目录进行。本目录的任何改动都不会生成或提交站点产物。
- 任务完成后，将本次任务产生的全部更改提交并推送到远程。若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明。
