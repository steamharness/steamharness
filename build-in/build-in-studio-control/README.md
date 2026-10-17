# Studio Control

Studio Control 是连接 Studio VS Code 扩展宿主的内置 Workflow 项目，小助手通过标准 MCP 调用它。

也可以在 Studio 中直接打开本项目文件夹，识别后点击“运行项目”，选择入口并填写参数，按普通 Workflow 项目运行，无需通过小助手或配置模型。Studio 根据项目 UUID 自动注入本次运行页面专用的控制连接，使用打开目录中的项目和 CLI。项目位于工作区子目录时同样支持；普通运行默认使用项目目录，文件访问限定在当前登记的工作区内。关闭运行页面后连接失效。首次使用需要安装项目依赖；聚合仓库中使用 `pnpm install --ignore-workspace`。

| 入口 | 能力 |
| --- | --- |
| `studio_state` | 读取本轮权限、目录访问范围、当前工作区、活动编辑器、已安装主题和可打开的视图 |
| `get_related_projects` | 查询项目声明的关联项目、UUID、名称、Studio 导入状态及核验后的目录 |
| `open_file` | 打开当前权限允许的文件，可指定从 1 开始的行、列 |
| `get_diagnostics` | 读取当前权限范围或指定文件的 VS Code 错误与警告 |
| `set_theme` | 按状态查询返回的名称切换已安装主题 |
| `open_terminal` | 在当前权限允许的目录打开终端，不发送或执行命令 |
| `show_view` | 打开文件、搜索、源代码管理、终端或小助手视图 |

`get_related_projects` 的可选参数 `projectDir` 指定当前权限允许的 Workflow 项目目录；省略时使用项目运行目录或小助手的工作目录。结果包含源项目的 `projectId`、`projectDir` 和 `relatedProjects` 列表。每项包含 `alias`、`projectId`、`imported`、`name`、`uri` 和 `projectDir`。查询会重新校验导入项目的 UUID；未导入或不可用的项目仍返回声明，但名称与目录为 `null`。远程导入仅返回 URI，本地目录为 `null`。已导入状态不代表双向数据授权；文件访问由本轮 Permission 决定。

诊断查询按真实路径匹配文件，保留登记在原路径或符号链接路径上的诊断。文件打开过程中会重新检查工作区、信任和会话状态，撤销后不继续展示编辑器。

`set_theme` 显式选择主题时切换为手动模式，关闭自动跟随系统颜色和高对比度设置；已有工作区主题覆盖时更新该覆盖，否则更新用户设置。成功结果包含 `theme` 和 `mode: "manual"`。需要重新跟随系统时，可在 VS Code 设置中恢复自动检测。

Studio 为每个小助手会话创建临时的认证回环接口，注入 `WORKFLOW_STUDIO_CONTROL_BRIDGE_URL` 和 `WORKFLOW_STUDIO_CONTROL_BRIDGE_TOKEN`。小助手将本轮 Permission 通过 MCP 子进程环境 `WORKFLOW_STUDIO_CONTROL_PERMISSION_POLICY` 传给宿主，不作为模型工具参数。`auto` 允许访问当前进程可访问的任意本地目录；`workspace` 与 `read-only` 限定在登记的工作区内，符号链接按真实路径检查。`studio_state` 返回 `permissionPolicy` 与 `pathAccess`（`all` 或 `workspace`）。工作区移除、信任撤销或会话关闭后，控制能力失效。编辑器操作沿用工具权限与 Build/Plan 审批规则，状态、诊断和关联项目查询默认自动批准。

本项目不再提供旧 Desktop 的 Dock、登录启动项、更新、云应用发布或 Desktop 数据库控制。普通 CLI 或未连接宿主的 MCP 调用会明确报错。纯浏览器扩展不提供本地控制能力；须有 Studio 的 Node 扩展宿主。

开发依赖在聚合仓库中引用 `link:../../core` 和 `link:../../cli`。安装后执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage` 和 `pnpm build`。现有内置项目打包工具保留以便后续发布，本次只交付源码和宿主集成。

在聚合仓库的 `studio` 目录中执行 `npm run test:studio-control-live`，通过真实 stdio MCP 调用隔离的 VS Code Node 扩展宿主，验证 Studio 打包副本的全部 7 项功能、权限切换和会话撤销；同时通过普通项目的启动和运行接口验证导入源码的全部 7 个入口、项目默认目录和连接隔离。该检查使用无头浏览器和临时工作区，不操作本机可见窗口或剪贴板；完成后关闭服务和终端，并恢复测试实例的主题。结果保存在 `studio/.studio/studio-control-live/results.json`。需要已构建的 Studio、已安装的小助手依赖及 Chrome；可用 `STUDIO_CONTROL_TEST_BROWSER` 指定 Playwright 的其他浏览器 channel。
