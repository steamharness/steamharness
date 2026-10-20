# 按任务查找 API 与类型

先选项目形态，再只读取当前任务对应的详细章节。`references/runtime-api-index.md` 是可用 `steamharness.*` 成员的完整名单；下表只负责导航，不另定义签名。公开类型均由 Core 的 `steamharness` 导出，`RuntimeApi` 也可从 `steamharness/runtime-api` 导入。项目中只写 `import type`，运行时函数使用宿主注入的 `steamharness`。

| 要完成的任务 | 首选入口 / 公开类型 | 详细契约与示例 | 验证 |
| --- | --- | --- | --- |
| 新建或调整 Workflow 的多个入口 | `steamharness.defineProject`、`defineExecutor`、`defineEntrypoint`；`EntrypointDefinition`、`ExecutorDefinition` | `steamharness-api.md`「Workflow 与 Executor」；`scripts/create_workflow.py` | `steamharness structure` 检查入口与执行序列 |
| 新建普通 Conversation | `steamharness.defineProject`、`defineExecutor`；`ConversationExecutorDefinition`、`ExecutorContext` | `steamharness-api.md`「Workflow 与 Executor」；`scripts/create_workflow.py --project-type conversation` | `structure` 后做一次隔离存储的 run |
| 新建有参数与工具的 Agent 项目 | `steamharness.createAgentConversationProject`、`createAgentProjectInput`、`createAgentProjectParamResolver`；`AgentInput`、`AgentOutputPayload`、`RuntimeApi` | `assets/examples/agent-conversation/index.ts`；`steamharness-api.md`「Agent（pi SDK 能力层）」 | `structure` 检查参数、工具、conversation 与 token usage |
| 在已有 workflow 中嵌入 Agent 节点 | `steamharness.createAgentNode`；`AgentNodeOptions`、`AgentInput` | `steamharness-api.md`「Agent（pi SDK 能力层）」与「节点」 | 对节点做类型检查及运行 smoke |
| 仅在宿主或测试中构造 Agent executor | `steamharness.defineAgentConversationExecutor`；`AgentProjectOptions` | `steamharness-api.md`「Agent（pi SDK 能力层）」 | 不把返回对象当作项目的静态声明 |
| 定义 Workflow 主字段、Conversation Quick/Mode/Auxiliary 或联动 | `ParamDeclaration`、`ConversationParamDeclaration`、`ParamResolverContext`、`ParamResolveResult` | `references/param-panels.md`；`steamharness-api.md`「参数」 | `structure` 检查 `params` 与 `paramLayout.actions` |
| 输出正文、详情或文件 | `steamharness.createOutputNode`、`runStreamNode`、`createOutputItemChunk`；`RunOutputPayload`、`OutputItem` | `steamharness-api.md`「必需本地类型」与「节点」 | run/json 检查正文 item 与详情 item |
| 读取或修改项目数据 | `RunContext`、`RelatedProjectStorageContext` | `steamharness-api.md`「运行时 KV 与 Conversation 状态」「项目知识文档」 | 用隔离存储运行，按声明权限检查 |
| 处理 Kanban 页面与命名参数 | `steamHarness.kanban`、`configuration.json` | `steamharness-api.md`「Kanban 静态项目」；`assets/kanban/` | 构建产物入口及 `structure` |
| 上传图片、文件或迁移本地底图 | `context.files`、Kanban `files`、CLI `workspace file-upload/file-download` | `steamharness-api.md`「Kanban 静态项目」与 File param 契约 | 服务器引用及原始字节读回，KV 只存引用 |

项目源码的类型提示可以使用 `import type { AgentInput, ParamDeclaration } from "steamharness"`，或 `import type { RuntimeApi } from "steamharness/runtime-api"`。`steamharness` 本身必须来自宿主注入；不要从包中做运行时 import。声明要进入 Desktop 的结构报告时，`defineExecutor` 接收内联对象；`params`、`tools`、`conversation` 和 `tokenUsage` 保持内联字面量。详细字段与限制以对应章节为准。

已有项目先读取现有声明与测试，按正在修改的能力查找；不要为了使用示例而重写项目架构。创建新项目先用 scaffold，再把业务逻辑和声明替换为对应形态。所有本地 CLI 检查遵守 `SKILL.md` 的存储隔离规则。
