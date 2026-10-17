# SteamHarness monorepo 规则

本仓库合并了原先 GitLab 上的 9 个开源仓库。以下规则对全仓生效，目录级 `AGENTS.md`（`harness/`、`cli/`、`server/`、`shared/`、`studio/`、`docs/`）补充各自细则，冲突时以目录级为准。

## 命名

- 品牌统一为 **SteamHarness**。npm scope 为 `@steamharness`，运行时 SDK 是裸包 `steamharness`，CLI 命令是 `steamharness`。
- `workflow` 出现在两处含义，必须区分：**领域词**（workflow 运行、调度、输出、`WorkflowRunner`/`WorkflowContext`、`*-workflow` 示例包后缀、`workflow-ids`/`workflow-mcp`/`workflow-schedules` 子包名、`studio.openWorkflow*` 命令）保持不变；**产品词**必须使用新形式——manifest 键 `steamHarness`（原 `workflowCode`）、事件前缀 `steamharness:`（原 `workflow-code:`）、环境变量 `STEAMHARNESS_*`（原 `WORKFLOW_*`）、配置目录 `~/.steamharness`（原 `~/.workflow-code`）、cookie、docker/数据库名同理。
- 仓库旧名 `core` 已随目录改名为 `harness`；旧聚合目录名 `open-soucres`（拼写错误）已不存在，内部仓库通过 `open-sources/` 子模块引用本仓库。

## 逐字节副本

同一份载荷在仓库内有多个副本，任何一份漂移都会让某个消费方更弱：

- **skill 载荷**：真相源是 `build-in/build-in-developer-assistant/skills/workflow-code-generator/`，开发副本是 `harness/.agents/skills/workflow-code-generator/`。改动共享载荷（`SKILL.md`、`references/**`、`scripts/**`、`assets/**`）后必须运行 `node scripts/check-skill-copies.mjs --fix` 并把两份一起提交；`AGENTS.md`、`agents/openai.yaml`、`references/project-repair.md` 是目录特有文件，不参与同步。
- **发布工具**：`shared/release-tools/` 在 `harness|cli|server/vendor/shared/release-tools/` 与三个内置项目的 `scripts/` 中有逐字节副本。改动后运行 `node scripts/check-vendor-copies.mjs --fix` 并一起提交。`builtin-release.mjs` 在 developer-assistant 里有意保留打包过滤，不参与守卫。

改动 `.gitmodules`、上述两个守卫脚本或根 workspace 配置后，必须在本地依次运行：

```sh
node scripts/check-skill-copies.mjs
node scripts/check-vendor-copies.mjs
node --test scripts/__tests__/*.test.mjs
```

三项全绿再提交。

## 工作区边界

- `harness`、`cli`、`server`、`shared/*`、`build-in/*` 属于根 pnpm workspace，共用一个 lockfile；`studio`（npm + Electron）与 `docs`（Docusaurus）独立安装，不进 workspace；`harness/workspace` 是示例工作流的嵌套 workspace。
- 内部专有内容不得进入本仓库。跨仓开发通过私有仓库的 `open-sources/` 子模块完成。

## 发布

发布通道（npm `alpha`/`dev`/`latest`、`release:feature`、`release-gate` 门禁）当前处于休眠状态，尚未为 monorepo 重建。`shared/release-tools/` 下的脚本保留且可运行，但 CI 不会触发发布；恢复发布流程需要单独的任务，不要在无关改动里顺手接线。

## 测试

- 日常测试不得在用户正在使用的本机桌面前台启动 Electron、带窗口的浏览器、原生菜单或系统剪贴板测试；需要真实窗口时转入完整测试环境。详见 `studio/AGENTS.md`。
- 改动 `harness`、`cli`、`server` 或 `shared/*` 后运行对应包的 `typecheck` 与 `test`；改动 `docs` 运行 `pnpm -C docs validate`；改动内置项目运行其 `test`。
- `server` 的测试依赖 PostgreSQL 测试容器，先确认 Docker 可用。

## 秘密

任何带 `--env-file` 的部署脚本禁止把含 `*_ACCESS_KEY_SECRET`、`*_PRIVATE_KEY` 等敏感字段的文件加入版本控制。`.env` / `.env.*` 由 `.gitignore` 强制忽略，只提交 `*.example`。根目录 `scripts/` 之外的私有内容不属于本仓库。
