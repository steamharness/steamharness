# Unreleased

### 技能工具

- 明确 `skill` 的显示名、用途与参数说明，补充发现技能、读取入口和引用文件的调用顺序、返回字段及截断限制。

### Pi Durable

- 【修复】模型请求完整成功后重置重试与续写预算，后续失败重新从 Retry 1 / 10 开始；连续失败、断流和进程恢复仍保留当前预算，重复编号的重试记录独立展示并保留历史位置。

- 【修复】自动重试记录在中断内容之后、续写之前实时输出，不再等运行结束才追加到末尾；持久会话与重新打开的历史保留原位置及折叠详情。

- 【修复】持久会话按回答轮次投影模型用量，隔离独立 fork、继承历史和后续输入，保留失败重试及轮内压缩消耗；逐会话提供最新上下文占用，跟随后续输入、流式响应、压缩与重置更新。无有效模型校准时估算包含实际系统提示、提示段和工具定义。

- 【修复】持久 Agent 完整处理流式思考、正文和工具块的开始及增量，避免内容索引空洞导致读取 type 失败或重复正文；运行时异常会取消同一 owner 下未完成的任务与队列，保存失败并发布真实终态，重开不会继续已失败的工作。正常关闭仍保留检查点供恢复。

- 【修复】持久任务进入终态后不再将保留的取消请求标记投影为停止中，取消完成与重新打开会话后的历史均显示真实终态。
- 【新增】持久会话支持将已排队输入原子转为本轮补充，保留原请求身份、图片与确认回执；已消费的输入不会重复发送。

- 【修复】工具输出以已提交的 assistant 消息隔离调用身份，避免模型在不同轮次复用 call ID 时遗漏工具事件或关联错误的历史工具；审批绑定持久任务，避免普通 Agent 模式下后续同 ID 调用复用批准；任务快照保留提交参数，便于检查嵌套调用。
- 【修复】持久会话命令在排队前固定 JSON 快照，无效任务输入不占用请求身份；预声明工具目录重开时校验持久定义，SQLite 导出同时保护源与目标 owner，避免恢复定义漂移和目标创建竞态。
- 【新增】持久 Agent 扩展 registry/hooks、自定义任务与计时检查点、授权工具发现和延迟 MCP；可显式启用 QuickJS Code Mode 与远端 ExecutionEnv，嵌套调用保留审批、取消和恢复策略。新增资源诊断、自定义存储及离线 SQLite 导入导出，公开扩展类型随包分发。
- 【新增】持久 Agent 会话控制：Harness 输入队列、steer/撤回、后台压缩、上下文 reset/handoff、独立分叉、版本化配置和事务计划；公开完整快照与宿主 lease，前台结束后保留后台工具和 AI bridge。
- 【新增】项目显式启用的受限子 Agent、持久结果单次回传及嵌套工具调用；工具/模型白名单、并发上限、caller/审批和分范围取消共同约束，快照分别展示父子任务与用量。
- 修复内存 Agent 暂停审批后丢失任务、初始 transcript 覆盖已有持久历史的问题；进程在流式回答期间中断后保留已提交正文并续写，丢弃未完成的工具调用。
- 修复本地 KV 崩溃后并发回收旧锁时可能删除新 owner 锁的竞态，防止并发更新失去互斥。
- Agent 升级至 Pi / Pi Durable 1.2.0，以 Harness 与 SQLite 作为唯一持久执行后端；支持稳定请求去重、跨进程工具与审批恢复、用量幂等投影及持久取消，不再读取旧 KV transcript。未知结果的写入与命令不自动重放。

### 变更

- 移除服务器执行平台与 isWeb；保留本地执行和显式服务器数据访问。
- 文件存储错误与生成规范明确由本地宿主执行，服务器只提供项目和数据存储。

### 新特性

- **Conversation 统一主输入框**：固定使用标准输入框，附件能力改为 `conversation.attachments`。
- **Conversation 资源卡片**：Agent 可按稳定 `cardId` 创建、更新、固定或移除卡片，浏览器卡片支持 `preview` 控制右上预览。
- **Agent 上下文圆环**：首次运行在模型响应前展示占用，流式内容、工具结果与压缩后实时更新。

### 破坏性变更

- **产品改名**：SDK 全局 `workflow` 改为 `steamharness`；`defineWorkflow` / `runWorkflow` / `defineWorkflowExecutor` / `defineWorkflowEntrypoint` 改为 `defineProject` / `runProject` / `defineProjectExecutor` / `defineProjectEntrypoint`，其余 `Workflow*` 导出同步改名。
- **字段改名**：`workflowId` / `workflowName` 改为 `projectId` / `projectName`；`WorkflowError` 改为 `HarnessError`，错误类型 `workflow_execution` 改为 `execution`；运行上下文与错误 metadata 的 `workflow` 键改为 `project`。
- Conversation 移除输入开关与自定义主字段，旧配置在结构校验时报错。
  迁移：附件声明改用 `conversation.attachments`，参数只保留 Auxiliary / Quick / Mode / Slash。
- Executor 的 `params` 改为有序入口声明，旧 `panel` 声明不再接受。
  迁移：Auxiliary 和 Quick 分别定义多个组，Conversation Mode 显式声明；结构报告用 `paramLayout.actions` 保留顺序。

### 新增

- 新增 通用 `userInput` 配置：等待回答时默认隐藏主输入区，可显式保留。
- 新增 `userInput` 支持按请求类型、节点名和答案声明参数更新规则，运行时确认后应用。
- 新增 Conversation 通用执行命令，可运行项目操作或导出会话，结构校验覆盖命令冲突与静态声明。
- 新增 Conversation 参数支持 `/` 菜单中的单选和 boolean 开关。
- 新增 Conversation 输入框下方支持纯文字、参数值与条件提示，结构校验与参数联动使用统一声明。
- 新增 Quick 参数可声明 Codicon 图标，结构报告保留图标配置，Agent 默认 AI 与权限菜单分别使用 sparkle、shield 图标。
- 新增 `workflow-ui_present_card` 顶层 `preview` 开关，独立于 Kanban 参数的临时预览模式。
- 新增 Agent 在模型响应前展示上下文圆环，流式内容、工具结果与压缩后实时更新。
- 新增 `getContextUsage()` / `updateContextUsage()` 查询和更新上下文占用，避免压缩恢复后使用旧计数。
- 新增 输出项支持通用 `display` 圆环展示和输入栏右侧固定。
- 新增 Core Agent 通过标准流式输出项展示上下文用量，随会话保存和恢复，主回答保持正文展示。
- 新增 Agent 与 MCP 共用 `steamharness-kanban_kanban_methods`，可发现并调用预览实例注册的方法。
- 新增 `steamharness-kanban_kanban_methods` 支持结构化返回和取消，避免误控其它配置或重复重试视角操作。
- 新增 浏览器资源卡片可通过 `preview` 参数控制 Desktop 右上预览。
- 新增 Agent 可调用 `workflow-ui_present_card` 按稳定 `cardId` 创建、更新、固定或移除资源卡片。

### 变更

- 变更 Kanban 生成规范增加可调预览尺寸和展示模式 API，地图、图片或只读小卡片隐藏编辑界面并阻止修改。
- 变更 Kanban 生成规范要求适配全屏、手机、平板与 Conversation 小卡片预览，按 iframe 实际宽高调整布局。
- 变更 Executor `params` 以展平的 `params` 和 `paramLayout.actions` 保留字段归属及展示顺序。
- 变更 Conversation Mode 显式声明并可重复定义，不再靠参数名识别；未指定 Mode 默认值时使用首个选项。

### 修复

- 修复 手动上下文总结立即处理已有上下文，展示执行中及完成或失败状态。
- 修复 仅接受正常结束的完整摘要，模型失败、截断或取消时保留原始记录。
- 修复 上下文总结的模型响应同样上报计费用量，失败及取消后的已消耗 token 不再遗漏。
- 修复 公开压缩 helper 可通过 `onUsage` 获取模型 usage。
- 修复 Agent 按每次模型响应增量上报计费用量，工具循环中即可更新且不重复累计。
- 修复 编程式 Agent 正确加载 `extraTools`，提前停止读取流时中止模型并完成用量上报。
- 修复 不同中文或带空格的 sessionKey 使用独立的上下文圆环输出 ID，ASCII 会话键的 ID 保持稳定。
- 修复 Conversation Kanban 资源卡片支持指定命名配置 ID，预览无需修改工作区配置。
- 修复 Remote 文件存储通过托管端点鉴权读回服务器文件，避免相对 URL 失败与凭据泄露。
- 修复 Plan 修改要求后的每轮修订都重新请求独立审批，相同正文的修订也必须重新确认。
- 修复 续跑输出使用独立标识，保留旧计划、相关输出和答案顺序。
- 修复 Plan 模式的 `ask_user` 提问、调研说明及异常退出前的文字保持普通对话展示。
- 修复 只有完成的计划生成 Plan 卡片并请求审批，对话历史保留计划前的说明和最终计划。
- 修复 资源卡片移除命令仅接受 `cardId`，预览开关仅适用于 Kanban、项目或浏览器卡片。
- 修复 Agent 工具执行完成后保留调用参数，避免资源卡片等工具展示丢失目标信息。

### 移除

- 移除 Conversation 的输入开关与自定义主字段声明。
- 移除 Executor `params` 的旧 `panel` 声明。
