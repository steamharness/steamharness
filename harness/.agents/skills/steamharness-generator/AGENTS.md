# SteamHarness Generator 规则

- 每轮修改验证后，按[仓库提交规则](../../../../AGENTS.md#提交与推送)仅提交本轮相关改动并推送。
- 修改本 skill 或 workflow 生成规范前必须先读取并遵循本文件。
- 修改生成或编辑方法、Core API 约定、节点 API、executor/provider 类型时，必须同步 [steamharness-api.md](./references/steamharness-api.md)，确保生成规范与仓库当前 API 一致。
- 如果生成规范面向用户可见，还必须同步同级 Docs 仓库 `../docs/concepts/**`、`../docs/core-api/**` 或 `../docs/cli/**` 中对应说明。

## 发版与日志规则

- Core 中的 generator 不是独立发布单元。生成结果、模板依赖或 API 用法发生用户可见变化时，在仓库根的 `docs/guides/releases/<组件>/unreleased.mdx` 和对应 `docs/en/` 草稿各记一条。按主要影响选 `core`、`cli`、`studio` 或 `builtin-developer-assistant`；不跨组件重复，定版遵守 `docs/AGENTS.md`。
- 内置 Developer Assistant 的发布副本由 `../build-in/build-in-developer-assistant/skills/steamharness-generator` 独立维护；跨仓同步必须显式比较并分别提交。
- Core 或 CLI release prepare 才能分别更新模板中的精确依赖版本；generator 日常修改不得自行把 Core 与 CLI 版本绑在一起，也不得改成非精确 range。
