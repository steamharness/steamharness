# Studio Control

Studio Control 是小助手聚合项目内的 `studio-control` Workflow 入口，源码随小助手一起安装和分发，共用小助手的 projectId、依赖及版本。默认入口 `main` 仍是 Conversation。小助手按需通过 `steamharness mcp <小助手项目目录> --entry studio-control` 发现并调用控制操作。

在 Studio 中打开小助手项目根目录后，也可以直接运行 `studio-control` 入口，选择内部操作并填写参数，无需启动模型对话。Studio 按小助手 projectId 与入口 ID 注入本次运行的控制连接；默认目录为聚合项目根目录，普通运行限制在登记的工作区内，关闭最后一个运行标签后连接失效。不要把本目录作为独立项目打开或安装。

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

配置操作不依赖面板打开。JSON `input` 指定 `storage: "local"` 和 `projectDir` 和 `entryId`，或 `storage: "server"`、`projectId`、`entryId`、`target`。先查询，再给写入操作传返回的 `revision`；值和配置修改显式指定 `id`。导入生成新 ID 并保留当前选择，导出包含全部敏感值。详见[项目配置](../../../docs/concepts/project-configuration.mdx)。

`get_entries` 的可选参数 `projectDir` 指定当前权限允许的聚合项目目录；省略时使用项目运行目录或小助手工作目录。返回 `projectId`、`projectDir`、`defaultEntry` 和 `entries`。每个入口包含 `entryId`、类型、名称、代码根目录、入口文件、配置定义和数据库需求。入口不再作为独立项目导入；数据库空间必须在所声明的 local 或 server 宿主中申请、审批和绑定。文件访问仍受当前 Permission 限制。

诊断查询按真实路径匹配文件，保留登记在原路径或符号链接路径上的诊断。文件打开过程中会重新检查工作区、信任和会话状态，撤销后不继续展示编辑器。

`set_theme` 显式选择主题时切换为手动模式，关闭自动跟随系统颜色和高对比度设置；已有工作区主题覆盖时更新该覆盖，否则更新用户设置。成功结果包含 `theme` 和 `mode: "manual"`。需要重新跟随系统时，可在 VS Code 设置中恢复自动检测。

Studio 为每个小助手会话创建临时的认证回环接口，注入 `STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL` 和 `STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN`。小助手将本轮 Permission 通过 MCP 子进程环境 `STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY` 传给宿主，不作为模型工具参数。`auto` 允许访问当前进程可访问的任意本地目录；`workspace` 与 `read-only` 限定在登记的工作区内，符号链接按真实路径检查。`studio_state` 返回 `permissionPolicy` 与 `pathAccess`（`all` 或 `workspace`）。工作区移除、信任撤销或会话关闭后，控制能力失效。编辑器操作沿用工具权限与 Build/Plan 审批规则，状态、诊断和入口查询默认自动批准。

本项目不再提供旧 Desktop 的 Dock、登录启动项、更新、云应用发布或 Desktop 数据库控制。普通 CLI 或未连接宿主的 MCP 调用会明确报错。纯浏览器扩展不提供本地控制能力；须有 Studio 的 Node 扩展宿主。

在上级小助手项目目录执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage` 和 `pnpm build`。测试使用隔离的宿主模拟，通过真实 stdio MCP 验证同一项目的控制入口、认证、取消和三种权限；Studio 日常检查在后台运行。
