# Project Assistant

小助手是一个聚合项目：`main` 是默认 Conversation 入口，`studio-control` 是内置 Workflow 入口，源码位于 `studio-control/`。两者共用同一个 projectId、依赖、版本和安装单元。Studio 控制工具按需通过本项目的 `mcp --entry studio-control` 发现和调用，无需单独安装或登记控制项目；也可以在 Studio 打开小助手项目根目录，直接运行该 Workflow 入口。

Studio 内置的独立小助手，基于 Core Agent 能力运行，使用宿主提供的 SteamHarness Server 系统 AI 配置。小助手的工作目录和授权根目录由宿主通过 `STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR` 与 `STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST` 提供，不从编辑器当前项目或 conversation 参数推断。

宿主默认为 `vscode`，也可显式设置 `STEAMHARNESS_DEVELOPER_ASSISTANT_HOST=vscode`。小助手使用 Core 编码工具、项目内的 `skill` 工具、`global_memory` 和文件/浏览器资源卡。Studio 注入控制连接时，还可通过 Studio Control 标准 MCP 读取工作区和诊断、查询聚合入口、打开文件并定位行列、切换已安装主题、打开终端及常用视图。编辑器操作沿用工具权限与 Build/Plan 审批规则，状态、诊断和入口查询默认自动批准。`get_entries` 返回聚合项目的 `projectId`、`entries` 和 `defaultEntry`；数据库访问需要单独申请、审批和绑定。控制连接缺失时保留编码能力，不连接旧 Desktop Control，通过通用配置工具管理三类项目的配置，不提供实时页面方法。

快捷参数中的 Permission 支持 `read-only`、`workspace` 和 `auto`，默认 `auto`（Auto approve）。普通消息与 OpenAI 请求在未指定策略时均使用该默认值。`read-only` 隐藏写入与命令工具；`workspace` 对读写和检索工具应用宿主授权的目录范围，但 shell 不是沙箱；`auto` 批准未被显式拒绝的权限，可读写、检索当前进程有权限的任意目录，包括工作区外的绝对路径。提示词和 Studio Control 均跟随本轮权限，`studio_state` 返回实际权限与目录访问范围。Build/Plan 由 Core 管理，Plan 可先调研、提问并等待批准。

本仓直接维护 `skills/steamharness-generator`，通过 `skill` 工具按需列出与读取，不安装到用户全局目录。实现 SteamHarness 时，小助手先读取该技能和相关 API 引用；其它任务仅选用相关技能。技能正文超过单页限制时，用返回的 `nextOffset` 继续读取，直至 `truncated: false`；外层截断可减小 `limit` 重试。仅在恢复后仍缺失、拒绝访问或不可读取时停止对应操作，并继续独立任务。小助手在同一轮内完成修改和相关验证，修正可恢复工具错误后继续。只读子代理包含 `skill`，默认继承当前模型和凭据；仅显式白名单允许模型覆盖。文件卡片使用 `target.filePath` 并省略 `preview`。

在 **项目信息 → 技能** 中查看实际技能名称、数量和来源，点击技能可只读预览完整 `SKILL.md` 及 Markdown 源码，无需开关或自动批准设置。小助手通过统一的 `skill` 工具读取这些指南：`{"action":"list"}` 返回名称、用途和文件清单，`{"action":"read","skill":"steamharness-generator"}` 读取技能正文，`{"action":"read","skill":"steamharness-generator","path":"references/task-map.md"}` 读取引用。`path` 相对于所选技能目录。读取脚本会返回脚本文本，执行步骤由小助手使用相应工具完成。完整参数、返回值和读取限制见 [createSkillTools](../../docs/core-api/create-skill-tools.mdx)。

Studio 内置小助手使用固定的系统分发身份，所有用户均无需创建个人服务器项目或重新申请 ID。应用检查成功后自动隐藏提示。普通项目不能通过填写相同 ID 或声明内置项目来跳过注册；服务器 AI 仍按当前账号授权。

小助手自身的 Knowledge、KV 和记忆与被协助项目的数据分离。工具不提供本运行作用域的 Knowledge 与 KV，避免把小助手存储误当成用户项目的数据。`global_memory` 只保存稳定偏好与长期决策，不保存凭据或临时进度。会话和 Agent 记忆保存在宿主用户数据目录，按聚合项目、入口和工作目录隔离。业务数据库必须声明需求，经宿主显式审批并绑定后访问。

本项目位于 monorepo 的 `build-in/build-in-developer-assistant`，harness 与 CLI 通过 `link:../../harness`、`link:../../cli` 使用。Studio 构建时从 `build-in/build-in-developer-assistant` 读取内置小助手源码，开发依赖可从本仓解析。修改后执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage`、`pnpm build` 和 `git diff --check`。Studio 的集成说明见其 `docs/workflow-workstation.md`。
