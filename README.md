# SteamHarness

`SteamHarness` 是驾驭 Agent 动力的开源平台：从运行时 SDK 到工作站、服务器，再到把项目装进别人机器的 Store。品牌取 "harness the power of steam"——像蒸汽机被挽具驾驭一样，让 Agent 的工具、权限与运行时受控发力。

本仓库是全部开源组件的**单一 monorepo**，由原先 GitLab 上 9 个独立仓库合并而来。

## 目录布局

| 目录 | 内容 | 包名 |
| --- | --- | --- |
| `harness/` | Agent 运行时 SDK 与示例工作流 | `steamharness` |
| `cli/` | 本地、工作区与服务器管理 CLI（命令 `steamharness`） | `@steamharness/cli` |
| `server/` | Server 与 Server Web 管理端 | `@steamharness/server`、`@steamharness/server-web` |
| `shared/` | 跨组件源码、发布工具与 i18n 资源（18 个子包） | `@steamharness/shared-workspace`、`@steamharness/*` |
| `studio/` | 基于 VS Code OSS 的工作站 | `studio-workstation` |
| `docs/` | 中英文公开文档 | `@steamharness/docs` |
| `build-in/build-in-developer-assistant/` | 内置小助手项目（skill 真相源） | 随 Studio 分发 |
| `build-in/build-in-studio-control/` | 内置 Studio 控制扩展宿主 | 随 Studio 分发 |
| `build-in/build-in-analysis/` | 内置本地与运行数据分析 | 随 Studio 分发 |

## 快速开始

```sh
pnpm install                      # harness / cli / server / shared / build-in 的单一 lockfile
pnpm check                        # skill 与 vendor 副本守卫 + 脚本测试
pnpm typecheck && pnpm test       # 按依赖顺序跑各包自检
```

`studio/` 与 `docs/` 使用各自的工具链（Studio 要求 Node 24.18.0+ 的 24.x 与 npm 11/12），不进入根 pnpm workspace：

```sh
pnpm -C studio install
pnpm -C docs install
```

Studio 依赖 `studio/upstream/vscode` 子模块（VS Code 上游 fork）：

```sh
git submodule update --init --depth 1 studio/upstream/vscode
```

示例工作流是嵌套的独立 workspace：

```sh
pnpm -C harness/workspace install
```

## 常用命令

| 命令 | 行为 |
| --- | --- |
| `pnpm check:skill-copies` | 保证 `build-in/build-in-developer-assistant/skills/` 与 `harness/.agents/skills/` 的共享载荷不漂移（`--fix` 同步） |
| `pnpm check:vendor-copies` | 保证 `shared/release-tools` 在 vendor 目录与内置项目里的逐字节副本不漂移（`--fix` 同步） |
| `pnpm server:dev` / `pnpm server:start` | 启动 Server（开发监听 / 仅开发源码） |
| `pnpm studio:dev` / `pnpm studio:web` | 启动工作站 Electron / 浏览器端 |
| `pnpm doc:dev` | 启动文档站开发服务 |

## 发布

公开包只有两个：运行时 SDK `steamharness` 与命令行 `@steamharness/cli`；其余包都是 `private: true`，发布流程不会带上它们。

发布走 **GitHub Release + npm Trusted Publishing**：

1. 在普通提交里把 `harness/package.json` 与 `cli/package.json` 的版本号一起抬高（两个包同一条版本线）
2. 打一个 Release，tag 以 `steamharness/v` 开头，例如 `steamharness/v0.1.0`
3. `.github/workflows/release.yml` 被触发：用 OIDC 向 npm 换取短期发布凭证，带 provenance 依次发布 SDK 与 CLI（顺序不能反，CLI 的类型解析依赖 SDK 的 `dist`）

仓库里不存放任何 npm token。前提是在 npm 后台把 `steamharness/steamharness` 与该 workflow 文件登记为 Trusted Publisher。

`shared/release-tools/` 里保留着旧的多仓库发布门禁脚本（alpha/dev 通道、特性分支版本、跨仓 pin 同步），它们服务于拆分仓库时期的流程，在 monorepo 下不再被调用；改动它们时不要顺手接线。

## 许可证与内部边界

本仓库只包含开源内容。内部专有功能（市场 Store、网关、官网等）保留在私有仓库，通过单个子模块引用本仓库的源码开发。
