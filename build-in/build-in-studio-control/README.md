# Studio Control

Studio Control 是连接 Studio VS Code 扩展宿主的内置 Workflow 项目，小助手通过标准 MCP 调用它。

也可以在 Studio 中直接打开本项目文件夹，识别后点击“运行项目”，选择入口并填写参数，按普通 Workflow 项目运行，无需通过小助手或配置模型。Studio 根据项目 UUID 自动注入本次运行页面专用的控制连接，使用打开目录中的项目和 CLI。项目位于工作区子目录时同样支持；普通运行默认使用项目目录，文件访问限定在当前登记的工作区内。关闭运行页面后连接失效。首次使用需要安装项目依赖；聚合仓库中使用 `pnpm install --ignore-workspace`。

| 入口 | 能力 |
| --- | --- |
| `get_configurations` | 查询或完整导出明确的本地/Server 项目的字段、配置、值、选择和版本 |
| `manage_configurations` | 管理配置和自定义字段、设置或清除值、原子导入；检查版本并拒绝只读写入 |
| `open_configurations` | 打开目标项目的配置面板 |
| `studio_state` | 读取本轮权限、目录访问范围、当前工作区、活动编辑器、已安装主题和可打开的视图 |
| `get_entries` | 查询聚合项目的入口清单、类型、代码根目录及数据库需求 |
| `open_file` | 打开当前权限允许的文件，可指定从 1 开始的行、列 |
| `get_diagnostics` | 读取当前权限范围或指定文件的 VS Code 错误与警告 |
| `set_theme` | 按状态查询返回的名称切换已安装主题 |
| `open_terminal` | 在当前权限允许的目录打开终端，不发送或执行命令 |
| `show_view` | 打开文件、搜索、源代码管理、终端或小助手视图 |

配置操作不依赖面板打开。JSON `input` 指定 `storage: "local"` 和 `projectDir`，或 `storage: "server"`、`projectId`、`target`。先查询，再给写入操作传返回的 `revision`；值和配置修改显式指定 `id`。导入生成新 ID 并保留当前选择，导出包含全部敏感值。详见[项目配置](../../docs/concepts/project-configuration.mdx)。

`get_entries` 的可选参数 `projectDir` 指定当前权限允许的聚合项目目录；省略时使用项目运行目录或小助手工作目录。返回 `projectId`、`projectDir`、`defaultEntry` 和 `entries`。每个入口包含 `entryId`、类型、名称、代码根目录、入口文件、配置定义和数据库需求。入口不再作为独立项目导入；数据库空间必须在所声明的 local 或 server 宿主中申请、审批和绑定。文件访问仍受当前 Permission 限制。

诊断查询按真实路径匹配文件，保留登记在原路径或符号链接路径上的诊断。文件打开过程中会重新检查工作区、信任和会话状态，撤销后不继续展示编辑器。

`set_theme` 显式选择主题时切换为手动模式，关闭自动跟随系统颜色和高对比度设置；已有工作区主题覆盖时更新该覆盖，否则更新用户设置。成功结果包含 `theme` 和 `mode: "manual"`。需要重新跟随系统时，可在 VS Code 设置中恢复自动检测。

Studio 为每个小助手会话创建临时的认证回环接口，注入 `STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL` 和 `STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN`。小助手将本轮 Permission 通过 MCP 子进程环境 `STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY` 传给宿主，不作为模型工具参数。`auto` 允许访问当前进程可访问的任意本地目录；`workspace` 与 `read-only` 限定在登记的工作区内，符号链接按真实路径检查。`studio_state` 返回 `permissionPolicy` 与 `pathAccess`（`all` 或 `workspace`）。工作区移除、信任撤销或会话关闭后，控制能力失效。编辑器操作沿用工具权限与 Build/Plan 审批规则，状态、诊断和入口查询默认自动批准。

本项目不再提供旧 Desktop 的 Dock、登录启动项、更新、云应用发布或 Desktop 数据库控制。普通 CLI 或未连接宿主的 MCP 调用会明确报错。纯浏览器扩展不提供本地控制能力；须有 Studio 的 Node 扩展宿主。

开发依赖在聚合仓库中引用 `link:../../harness` 和 `link:../../cli`。安装后执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage` 和 `pnpm build`。现有内置项目打包工具保留以便后续发布，本次只交付源码和宿主集成。

在聚合仓库的 `studio` 目录中执行 `npm run test:studio-control-live`，通过真实 stdio MCP 调用隔离的 VS Code Node 扩展宿主，验证 Studio 打包副本的7 项编辑器功能、权限切换和会话撤销；同时通过普通项目的启动和运行接口验证导入源码的7 个编辑器入口、项目默认目录和连接隔离。该检查使用无头浏览器和临时工作区，不操作本机可见窗口或剪贴板；完成后关闭服务和终端，并恢复测试实例的主题。结果保存在 `studio/.studio/studio-control-live/results.json`。需要已构建的 Studio、已安装的小助手依赖及 Chrome；可用 `STUDIO_CONTROL_TEST_BROWSER` 指定 Playwright 的其他浏览器 channel。
