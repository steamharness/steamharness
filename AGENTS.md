# SteamHarness monorepo 规则

本仓库合并了原先 GitLab 上的 9 个开源仓库。以下规则对全仓生效，目录级 `AGENTS.md`（`harness/`、`cli/`、`server/`、`shared/`、`studio/`、`docs/`）补充各自细则，冲突时以目录级为准。

## 命名

- 品牌统一为 **SteamHarness**。npm scope 为 `@steamharness`，运行时 SDK 是裸包 `steamharness`，CLI 命令是 `steamharness`。
- 运行时 SDK 位于 `harness/` 目录（包名 `steamharness`）；内部仓库通过 `open-sources/` 子模块引用本仓库。

## 逐字节副本

同一份载荷在仓库内有多个副本，任何一份漂移都会让某个消费方更弱：

- **skill 载荷**：真相源是 `build-in/build-in-developer-assistant/skills/workflow-generator/`，开发副本是 `harness/.agents/skills/workflow-generator/`。改动共享载荷（`SKILL.md`、`references/**`、`scripts/**`、`assets/**`）后必须运行 `node scripts/check-skill-copies.mjs --fix` 并把两份一起提交；`AGENTS.md`、`agents/openai.yaml`、`references/project-repair.md` 是目录特有文件，不参与同步。
- **发布工具**：`shared/release-tools/` 在 `harness|cli|server/vendor/shared/release-tools/` 与三个内置项目的 `scripts/` 中有逐字节副本。改动后运行 `node scripts/check-vendor-copies.mjs --fix` 并一起提交。`builtin-release.mjs` 在 developer-assistant 里有意保留打包过滤，不参与守卫。

改动 `.gitmodules`、上述两个守卫脚本或根 workspace 配置后，必须在本地依次运行：

```sh
node scripts/check-skill-copies.mjs
node scripts/check-vendor-copies.mjs
node --test scripts/__tests__/*.test.mjs
```

三项全绿再提交。

## 工作区边界

- `harness`、`cli`、`server`、`shared/*`、`build-in/*` 属于根 pnpm workspace，共用一个 lockfile；`studio`（npm + Electron）独立安装，不进 workspace；`docs` 只保存 Markdown/MDX、导航与 OpenAPI 源，不含站点工具链；`harness/workspace` 是示例工作流的嵌套 workspace。
- 内部专有内容不得进入本仓库。跨仓开发通过私有仓库的 `open-sources/` 子模块完成。

## 发布

- 公开包只有 `steamharness`（SDK）与 `@steamharness/cli`（CLI），两者同一条版本线，一起抬高版本号。其余包保持 `private: true`。
- 发布由 GitHub Release 触发（tag 形如 `steamharness/v0.1.0`），凭证走 npm Trusted Publishing（OIDC），仓库里不存 npm token。修改 `.github/workflows/release.yml` 或 npm 的 Trusted Publisher 配置前先确认发布顺序：SDK 必须先于 CLI。
- `shared/release-tools/` 下的发布门禁脚本属于拆分仓库时期的产物，当前不被调用。改动它们时不要顺手接线；要恢复 alpha/dev 通道或特性分支版本，另开任务。

## 测试

- 日常测试不得在用户正在使用的本机桌面前台启动 Electron、带窗口的浏览器、原生菜单或系统剪贴板测试；需要真实窗口时转入完整测试环境。详见 `studio/AGENTS.md`。
- 改动 `harness`、`cli`、`server` 或 `shared/*` 后运行对应包的 `typecheck` 与 `test`；改动 `docs` 运行 `node docs/scripts/validate-docs.mjs` 与 `node --test docs/scripts/__tests__/*.test.mjs`；改动内置项目运行其 `test`。
- `server` 的测试依赖 PostgreSQL 测试容器，先确认 Docker 可用。

## 秘密

任何带 `--env-file` 的部署脚本禁止把含 `*_ACCESS_KEY_SECRET`、`*_PRIVATE_KEY` 等敏感字段的文件加入版本控制。`.env` / `.env.*` 由 `.gitignore` 强制忽略，只提交 `*.example`。根目录 `scripts/` 之外的私有内容不属于本仓库。
