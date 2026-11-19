# 内置 SteamHarness Generator 规则

- 每轮修改验证后，按[仓库提交规则](../../../../AGENTS.md#提交与推送)仅提交本轮相关改动并推送。用本技能维护其他项目时按目标仓自己的规则操作；只有 `main` 的仓库不擅自新建 `dev`。
- 修改本 skill 或 workflow 生成规范前必须先读取并遵循本文件。
- 修改生成或编辑方法、Core API 约定、节点 API、executor/provider 类型时，必须同步 [steamharness-api.md](./references/steamharness-api.md)，确保生成规范与仓库当前 API 一致。
- 如果生成规范面向用户可见，还必须同步 Docs 仓库 `../../docs/concepts/**`、`../../docs/core-api/**` 或 `../../docs/cli/**` 中对应说明。

## 发版与日志规则

- 本目录是 Developer Assistant 发布资源中的 generator 唯一来源，不再与 Desktop 或 Core 仓库中的副本做隐式同步。
- 生成结果、模板依赖或 Core API 用法发生用户可见变化时，在仓库根的 `docs/guides/releases/builtin-developer-assistant/unreleased.mdx` 及对应 `docs/en/` 草稿记录。若主要影响 Core 或 CLI，改相应组件草稿，不抄第二份；定版遵守 `docs/AGENTS.md`。
- Core 或 CLI 版本变化时，模板中的依赖仍分别使用精确版本；不得把 Core 与 CLI 版本绑在一起，也不得改成非精确 range。
