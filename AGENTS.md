# SteamHarness monorepo 规则

以下规则对全仓生效，目录级 `AGENTS.md`（`harness/`、`cli/`、`shared/`、`studio/`、`docs/`）补充各自细则，冲突时以目录级为准。

## 命名

- 品牌统一为 **SteamHarness**。npm scope 为 `@steamharness`，运行时 SDK 是裸包 `steamharness`，CLI 命令是 `steamharness`。
- 运行时 SDK 位于 `harness/` 目录（包名 `steamharness`）；内部仓库通过 `open-sources/` 子模块引用本仓库。

## 逐字节副本

同一份载荷在仓库内有多个副本，任何一份漂移都会让某个消费方更弱：

- **skill 载荷**：真相源是 `build-in/build-in-developer-assistant/skills/steamharness-generator/`，开发副本是 `harness/.agents/skills/steamharness-generator/`。改动共享载荷（`SKILL.md`、`references/**`、`scripts/**`、`assets/**`）后必须运行 `node scripts/check-skill-copies.mjs --fix` 并把两份一起提交；`AGENTS.md`、`agents/openai.yaml`、`references/project-repair.md` 是目录特有文件，不参与同步。
- **发布工具**：`shared/release-tools/` 在 `harness|cli/vendor/shared/release-tools/` 与两个内置项目的 `scripts/` 中有逐字节副本。改动后运行 `node scripts/check-vendor-copies.mjs --fix` 并一起提交。`builtin-release.mjs` 在 developer-assistant 里有意保留打包过滤，不参与守卫。

改动 `.gitmodules`、上述两个守卫脚本或根 workspace 配置后，必须在本地依次运行：

```sh
node scripts/check-skill-copies.mjs
node scripts/check-vendor-copies.mjs
node --test scripts/__tests__/*.test.mjs
```

三项全绿再提交。

## 工作区边界

- `harness`、`cli`、`shared/*`、`build-in/*` 属于根 pnpm workspace，共用一个 lockfile；`studio`（npm + Electron）独立安装，不进 workspace；`docs` 保存开发文档和导航，不含站点工具链。Core 测试集中在 `harness/src/__tests__`，文件系统集成测试按需生成并清理最小临时夹具，不维护嵌套示例 workspace。
- Server 与 Server Web 只在私有仓库维护。开源 Studio 不提供平台登录或发布入口；Core 和独立 CLI 的平台客户端需要显式连接。
- 内部专有内容不得进入本仓库。跨仓开发通过私有仓库的 `open-sources/` 子模块完成。

## 发布

- 公开包只有 `steamharness`（SDK）与 `@steamharness/cli`（CLI），两者同一条版本线，一起抬高版本号。其余包保持 `private: true`。
- npm 只用于独立公开分发，不是增强版应用发版的前置条件。不要为本地打包创建 tag 或发布 npm。需公开发布时，手动运行 `release.yml`：选定 `steamharness/vX.Y.Z` tag 发 `latest`，日期预发布 tag 发 `alpha`，或从 `dev` 分支发日期版到 `dev`。创建 GitHub Release 不触发 npm。凭证走 npm Trusted Publishing（OIDC），SDK 必须先于 CLI。
- 用户可见变化直接写到 `docs/guides/releases/<组件>/unreleased.mdx` 及 `docs/en/guides/releases/<组件>/unreleased.mdx`。发布时定版为双语 `v<版本>.mdx`，先确认版本页可访问，GitHub Release 正文链接到对应版本页。格式、校验和定版规则见 `docs/AGENTS.md`。
- npm 工作流使用 `scripts/npm-release.mjs`，不调用拆分仓库时期的 `shared/release-tools/` 发布门禁；不要给旧特性分支发布工具接入 npm 工作流。

## 测试

- 日常测试不得在用户正在使用的本机桌面前台启动 Electron、带窗口的浏览器、原生菜单或系统剪贴板测试；需要真实窗口时转入完整测试环境。详见 `studio/AGENTS.md`。
- 改动 `harness`、`cli` 或 `shared/*` 后运行对应包的 `typecheck` 与 `test`；改动 `docs` 运行 `node docs/scripts/validate-docs.mjs` 与 `node --test docs/scripts/__tests__/*.test.mjs`；改动内置项目运行其 `test`。

## 秘密

任何带 `--env-file` 的部署脚本禁止把含 `*_ACCESS_KEY_SECRET`、`*_PRIVATE_KEY` 等敏感字段的文件加入版本控制。`.env` / `.env.*` 由 `.gitignore` 强制忽略，只提交 `*.example`。根目录 `scripts/` 之外的私有内容不属于本仓库。
