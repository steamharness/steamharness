# Changelog

本发布单元的所有重要公开变更均记录于此。

> 0.1.0 起为 SteamHarness 发布线（包名 `steamharness` / `@steamharness/cli`，MIT）；此前条目属于更早的发布线，仅作历史参考。

## 历史发布线 0.1.1 - 2026-07-29

### 变更

- 变更 Core 版本成为 Workflow 运行兼容性的唯一依据，并保持独立发版。

## 历史发布线 0.1.2 - 2026-07-30

### 新增

- 新增 Kanban 静态项目类型、产物入口、配置校验和结构报告，无需 executor 或 Node.js runtime 即可识别看板项目。

## 历史发布线 0.1.3 - 2026-08-07

### 新特性

- **多入口执行**：`defineEntrypoint()` 声明多个独立入口，运行上下文、报告与结构结果携带实际入口 ID 与标题。
- **双语运行输出**：`workflow.getRuntimeLocale()` 读取运行语言，运行错误按简体中文或英文生成并稳定回退。
- **计划建议声明**：`schedulePresets` 按入口声明时区、时间窗口或五字段 Cron，结构校验通过但宿主不自动启用。

### 破坏性变更

- Workflow executor 不再接受顶层 `workflow`、`params`、`createInput` 等执行字段。
  迁移：执行字段移入非空 `entrypoints` 并设置有效的 `defaultEntrypoint`，Conversation executor 保持单入口结构。

### 新增

- 新增 `workflow.getRuntimeLocale()` 和双语运行错误，缺少语言或翻译时稳定回退。
- 新增 `defineEntrypoint()` 声明多个独立入口，运行上下文、报告与结构结果携带实际入口 ID 与标题。
- 新增 Kanban 限定项目 UUID 与 key 前缀的只读 `workflow-kv` 数据源，来源更新后经 revision 订阅安全重读。
- 新增 `package.json.steamHarness.schedulePresets` 计划建议，支持入口、IANA 时区、时间窗口与五字段 Cron。
- 新增 Kanban 版本级依赖锁与 project-group v1 协议，区分随组交付源码与 external 引用且不传输宿主数据。

### 变更

- 变更 结构分析按真实 import/export 绑定解析跨文件入口，隔离不同入口的同名 registry。
- 变更 Core 发布日志同步维护中英文内容，发布元数据提供可按语言读取的 Markdown 正文。

## 历史发布线 0.1.4 - 2026-08-24

### 破坏性变更

- Electron 本地运行平台标识改为 `desktop`，`workflow.isDesktop()` 取代 `workflow.isApp()`。
  迁移：本地运行传入 `desktop`；旧 `app` 值不再被接受。

### 修复

- 修复 独立仓库结构检查缺少项目路径时显示的 CLI 用法提示。
- 修复 执行器缺失、动态声明或含旧版 `projectType` 配置时被静态迁移校验误拦截。

## 历史发布线 0.1.5 - 2026-08-26

### 修复

- 修复 日期版 Alpha Core 按项目 caret 范围兼容同 minor 更高 patch，避免 prerelease 语义误判不支持。

## 历史发布线 0.2.0 - 2026-08-26

### 破坏性变更

- 项目必须声明 `steamHarness.projectInfo.dataStorage.mode`，它限制 KV、PersistentValue 与知识库可访问位置。
  迁移：补齐 `dataStorage.mode`；`server` 位置要求登录并绑定同 UUID 项目。
- 移除 `context.kv` 与 `context.persistentValue`，改用 `context.storage.<位置>.*`。
  迁移：本地改写为 `context.storage.local.*`，服务器改写为 `context.storage.server.*`；旧属性运行时只抛出迁移错误。
- 知识库 helper 必须显式接收对应存储位置上下文，不再隐式沿用当前存储域。
  迁移：调用知识库 helper 时显式传入 `context` 或目标存储位置。

### 变更

- 变更 项目必须在 `devDependencies.steamharness` 写入精确 SemVer，宿主只比较 `major.minor` 兼容线。
- 变更 同线任意 patch 或日期 Alpha 可直接运行，major 或 minor 变化在加载用户模块前要求升级宿主。

## 历史发布线 0.2.3 - 2026-09-01

### 新特性

- **关联项目授权**：`projectInfo.relatedProjects` 声明关联项目与授权清单，按双方当前声明逐次生效。
- **OpenAI 宿主适配**：`conversation.openai` 适配器接收独立 `hostInput`，AI SDK 流保留完整结束原因、用量与 provider metadata。

### 破坏性变更

- 移除全局 KV、`kv.workflow` 与 `persistentValue.workflow`，旧作用域不会自动迁移。
  迁移：`kv.*` 与 `persistentValue.*` 直接读写当前 UUID 项目，仅保留 `.conversation` 子作用域。
- Kanban 不再接受 `dataSources` 声明，原 Bridge 已删除。
  迁移：`dataSources` 改写为 `projectInfo.relatedProjects`，KV 访问走 `relatedProjects.get(alias).kv`。

### 新增

- 新增 `projectInfo.relatedProjects` 声明关联项目与授权清单，读写按双方当前声明逐次判定。
- 新增 `context.storage.<位置>.relatedProjects.get(alias).kv` 关联项目 KV 读写，本地与服务器位置严格隔离。
- 新增 Conversation executor 的 `conversation.openai` 适配器，接收独立 `hostInput` 类型化 OpenAI Responses 输入。
- 新增 OpenAI Responses `hostInput` 支持 `system` / `developer` 消息角色与 `verbosity` 回复详略设置。

### 变更

- 变更 AI SDK 流保留完整的结束原因、用量、错误和 provider metadata。
- 变更 AI SDK Provider 不把 SDK 的 `unsupported` / `compatibility` 警告升级为运行错误。
- 变更 降级信息保留在 `providerMetadata["steamharness"].warnings`，真实调用异常仍会失败。
- 变更 KV 与 PersistentValue 使用独立存储域，知识库改用项目级 PersistentValue，Token 统计只维护项目和会话总量。
- 变更 生成脚手架显式输出空的 `projectInfo.relatedProjects`，API 参考同步项目与会话 Token 统计合同。
- 变更 本地与服务器数据层级示例改为 `store` / `get` 双入口，`store` 返回随机 UUID，`get` 只需该 id。

### 移除

- 移除 Kanban 的 `dataSources` Bridge，改用通用关联项目 KV。

## 历史发布线 0.2.4 - 2026-09-05

### 新特性

- **Agent 能力层**：基于 pi agent SDK 新增 `workflow.createAgent(...)`、`createAgentNode(...)` 与对话 executor。
- **跨轮会话恢复**：pi 的 `AgentMessage[]` 存入 `agent.transcript.<sessionKey>`，下一轮写回 `initialState.messages`。
- **关联项目知识库与入口调用**：`relatedProjects.get(alias)` 提供目标项目的知识库与入口调用，授权逐 key 判定。

### 新增

- 新增 输出协议支持 `contentType: "video"`，保留视频描述对象与流式 output item 类型。
- 新增 `workflow.createAgent(...)` 可编程驱动的 agent 运行时。
- 新增 `workflow.createAgentNode(...)` 放进任意 workflow 的 agent 节点。
- 新增 `workflow.defineAgentConversationExecutor(...)` 一步生成完整 conversation executor。
- 新增 该 executor 含 conversation 配置、token usage、工具、参数与 OpenAI 网关对接。
- 新增 需过结构校验的项目可用 `createAgentConversationProject(...)` 与 `createAgentProjectParams(...)` 拆分形式。
- 新增 `workflow.createAgentProjectParamResolver()` 从 `workflow.getServerLLMCredentials(...)` 取模型选项。
- 新增 Agent 默认接入宿主系统 AI，每轮经 `startLLMProxyBridge()` 建立回环代理，运行时不持有上游 Key。
- 新增 Agent 输入支持 `prompt`、`images`、`workdir`、`provider`、`model` 与 `baseUrl`。
- 新增 Agent 输入支持 `effort`、`agent`、`permissionPolicy`、`contextWindow`、`compact` 与审批恢复载荷。
- 新增 `effort` 取 `off` 到 `max`，`ultra` 等同 `max`，超出模型支持范围自动收敛。
- 新增 `agent` 取 `build` 或 `plan`，plan 模式正文只渲染成一条 Plan 行并在轮末请求批准。
- 新增 plan 审批沿用 `decision` 单选与可选 `instructions`，批准后在同一会话以 build 模式继续。
- 新增 `permissionPolicy` 取 `read-only`、`workspace`、`auto`，三者都不为内置工具弹审批。
- 新增 输出项使用 `agent-part`、`agent-notice`、`agent-error`、`agent-answer` 中性 `metadata.kind` 族。
- 新增 输出 payload 带 `contextUsage: { used, total }`，宿主据此显示已用与总量并提供压缩入口。
- 新增 `--context-window` 覆盖上下文用量分母。
- 新增 工具审批复用 `context.toolPermissions`，plan 审批复用 `context.userInput`。
- 新增 token 用量经 `context.tokenUsage.report(...)` 上报一次，项目侧无需实现。
- 新增 依赖 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`，宿主安装 `steamharness` 即自带。
- 新增 `AgentNodeOptions.createTools` 可返回 `{ tools, close?() }`，`close` 在本轮结束时调用。
- 新增 `AgentNodeOptions.createTools(context)` 组装内置 7 个工具之外的工具，编程式运行时用 `AgentRuntimeOptions.extraTools`。
- 新增 `AgentInput.systemPrompt` 逐轮给出本轮系统提示词，`AgentInput.images` 随 prompt 发给模型。
- 新增 `workflow.connectMcpServer(...)` 启动并握手 stdio MCP 服务并列出其暴露的工具。
- 新增 `workflow.createMcpTools(...)` 把 MCP 工具变成 agent 工具，名字保持 `<服务 id>_<工具名>`。
- 新增 `workflow.normalizeMcpServers(...)` 在启动任何子进程之前校验服务定义。
- 新增 带能力的变量只能按名继承：`allowedInheritedEnvKeys` 列出允许项，`inheritEnvironment` 申请。
- 新增 `workflow.createProjectCapabilityTools({ context })` 渲染能力为 agent 原生工具。
- 新增 `workflow.createProjectCapabilityServer(toolId, { context })` 渲染同一能力为 MCP 服务端。
- 新增 `workflow.runProjectCapabilityAction(toolId, context, args)` 按工具 id 直接执行，供审批恢复使用。
- 新增 `workflow.listProjectCapabilityToolIds({ globalMemory? })` 列出本次运行会提供的工具。
- 新增 `workflow.isProjectCapabilityAvailable(toolId)` 报告能力在当前进程能否工作。
- 新增 四个内置工作流能力工具：知识库、KV、跨会话记忆与宿主配置，工具 id 与内置 OpenCode 项目一致。
- 新增 `workflow.createSkillTools({ directories, approve? })` 把技能做成按需读取的工具。
- 新增 `workflow.runSkillAction(directories, args)` 供审批恢复时按名字重跑同一动作。
- 新增 KV 与 PersistentValue namespace 的 `deleteValue(key)`，返回是否真的删除了已存在的条目。
- 新增 plan 模式 agent 的内置工具 `ask_user`，可中途提问并支持选项、多选与自定义回答。
- 新增 参数定义可声明 `step` 把多问题请求分步，同一问题的字段留在同一步。
- 新增 `relatedProjects.get(alias)` 的知识库 helper，作用于目标项目的文档读写。
- 新增 `listEntrypoints()` 与 `runEntrypoint(id, args)` 列出并调用目标项目授权的入口。
- 新增 关联项目授权字段 `knowledge: { read, write }` 与 `entrypoints`，不写即不授权。
- 新增 系统 AI 模型属性随 `getServerLLMCredentials()` 返回，用于上下文窗口、effort 档位与模态。
- 新增 `modelAttributes` 让自定义 provider 声明 `contextWindow`、`maxTokens`、`cost` 与 `thinkingLevelMap`。
- 新增 Workflow entrypoint 静态 `group: { id, title, order? }` 展示元数据并透传到结构报告。
- 新增 `ServerLLMCredential.defaultModelId` 暴露 Server 合并后的系统/用户默认模型。
- 新增 参数契约支持 `type: "file", control: "audio"` 及音频时长与大小限制。
- 新增 Conversation 默认输入契约的视频附件与常用视频 MIME 推断。

### 变更

- 变更 Agent 会话正文写在被说出的位置，每段文字成一条 `agent-part` 文本行。
- 变更 宿主驱动的运行保持原样，`conversation.openai.outputItemId` 声明的条目只在其中产出。
- 变更 一轮内的输出项按结束顺序排列，工具与推理在前、正文停在真正写完的位置。
- 变更 plan 模式的工具审批才暂停运行，build 回合执行已批准计划时不再弹确认。
- 变更 运行报告的错误信息附带上游 HTTP 响应体摘要，只带状态短语的错误不再掩盖原因。

### 修复

- 修复 Agent 会话上下文从未实现，每轮用户消息是新进程，模型只看得到本轮那一句。
- 修复 恢复的记录超过模型窗口时请求直接失败，现在调用模型前按需自动压缩。
- 修复 被取消或中断的轮次留下未回答工具调用的消息导致 provider 拒收，落盘前修剪未收尾尾部。
- 修复 `agent.transcript.<sessionKey>` 读写失败不再让整轮失败，改以一行说明代替。
- 修复 Agent 类项目的 OpenAI / Responses 适配器必然以「did not produce output item」结束。
- 修复 `createAgentConversationProject({ outputItemId })` 不再按会话派生 id，改用声明的 id。
- 修复 工作区内的软链接可让 `read` / `write` / `edit` / `grep` / `find` 访问工作区之外的路径。
- 修复 `bash` 超时或中止只结束 shell，现在连同整棵进程树一起结束。
- 修复 取消运行未真正中止本轮，`context.abortSignal` 现在调用 pi 的 `agent.abort()`。
- 修复 `read` 把整个文件读进内存，超过 8 MiB 按请求行区间流式读取。
- 修复 `edit` 把 `$&`、`$'` 当替换模式展开，改为字面量替换。
- 修复 上下文压缩切分点可能把整份记录（含当前任务）交给摘要。
- 修复 `/compact` 在没有可压缩内容时闪现压缩行。
- 修复 `effort` 传空字符串被当作档位，OpenAI 类端点因此收不到 `reasoningEffort`。
- 修复 上下文用量按 4 字符 1 token 估算，中文此前被低估约 3 倍。
- 修复 `kv_store` 能写入运行时自己的 `tokenUsage.*`、`conversation.state` 与 `agent.*` 键。
- 修复 能力声明的长度上限（知识库、记忆与 KV 的 `markdown`、`title`、`query`、`cursor`、`key`）未在实现里执行。
- 修复 跨会话记忆的 `cursor` 在 `list` 与 `search` 语义不同，返回值不带 `list:` / `search:` 前缀。
- 修复 宿主配置回环桥地址不合法时抛异常打断其它能力，`isAvailable` 现在返回 `false`。
- 修复 MCP 服务发布的工具 schema 非对象、过深或超过 256 KiB 时在注册阶段压垮进程。
- 修复 MCP 工具总数上限在合并分页之后才检查。
- 修复 本轮结束时释放系统 AI 桥与自带工具收尾抛错，会把 `user_input_required` 换成失败。
- 修复 MCP 工具列表分页遇到重复游标时无限请求，现在重复游标直接报错。
- 修复 宿主配置 `values` 丢失键与值校验，越界参数不再穿透到宿主桥。
- 修复 skill 文件清单被 60 条上限截断时不作说明。
- 修复 节点输出的 `workdir` / `provider` / `model` / `effort` / `agent` 取自运行时选项而非本轮输入。
- 修复 `createAgentInputFromArgs` 把不认识的 `--flag` 及其取值拼进 prompt。
- 修复 只调用工具、没有正文的一轮往 conversation 写入空 assistant 消息。
- 修复 带 `hostInput` 的一轮同时写 workflow conversation，宿主会话记录被写两份。
- 修复 自定义端点写进进程级模型目录，同一 id 的两次运行互相覆盖端点与凭据。
- 修复 内置项目收不到服务器配置的默认模型，凭证目录校验丢弃了 `defaultModelId`。
- 修复 `defaultModelId` 校验大小写敏感，仅因大小写差异静默丢失默认模型。
- 修复 `AgentInput.workdir` 只影响输出 payload，内置工具仍在建运行时的工作区内操作。
- 修复 图片附件在进入模型前消失，宿主传来的 `imageFiles` 现在读成 base64。
- 修复 只发图片、没有文字的一轮以 `Prompt is required.` 结束。
- 修复 `--images` 对 `defineAgentConversationExecutor` / `createAgentProjectInput` 形态的项目被吞掉。
- 修复 智能体的模型调用没有重试预算，第一次 502 或流中途断开就终止整个 run。
- 修复 模型在回答中途断流时整轮以 `terminated` 失败，现在续写并保留已生成内容。
- 修复 被模型输出上限截断的一轮被当成正常答完，现在走续写通道且预算独立为 2 次。
- 修复 宣告了工具调用、调用却没传过来的消息被当成成功的纯文本回答。
- 修复 模型流没有收尾就结束时本轮永远挂着，现在合成为可恢复错误。
- 修复 reasoning 攒到整轮结束才输出，高 effort 模型思考期间宿主一行都拿不到。
- 修复 关联项目的知识库写入绕过按 key 授权，在 mutation 路径上索引与文档可直接改写。
- 修复 `readEntrypointOutput(...)` 把失败的入口结果当成 payload 返回。
- 修复 关联项目知识库不可达时只说「关系未确认」，不说宿主缺少持久值句柄。
## 0.1.1 - 2026-10-18

### 变更

- 以 SteamHarness 包名重新发布：`steamharness` 从 0.1.0 起独立版本线，
  不与更早的发布线保持兼容。
- 发布改由 GitHub Release 触发，使用 npm Trusted Publishing（OIDC）完成，不再需要长期令牌。
- 运行时依赖改为 peer 声明 `^0.1.0`，安装时给出明确的兼容范围。

## 0.1.2 - 2026-10-27

- 【修复】运行报告通过 `error` 字段保留结构化失败信息；远程存储失败携带服务器、项目和关联别名，让宿主准确引导 `both` 项目的显式服务器访问，避免将模型错误误判为项目缺失。

- 【修复】Windows 深层数据目录中的持久 Agent 可以正常创建、重开、备份和导入 SQLite 会话，避免因数据库或所有权锁路径过长而报错。

- 【修复】显式与恢复配置快照重新校验源码的系统 AI 限制及发布模板只读字段，阻止通过快照绕过字段或模型来源权限；等待任务保留原已验证模板和值，恢复与工具调用继续校验当前角色及固定模式。

- 【新增】项目角色配置策略固定基础模式与字段值；按应用、Server 和账号隔离个人配置，执行、恢复与工具调用重新确认权限，离线仅开放访客默认配置。

- 【改进】本地项目配置按应用 UUID 共享，同一应用的不同窗口与安装目录共用配置列表、自定义字段、值和当前选择；首次使用保留当前目录原有配置，运行恢复快照仍按目录隔离。

- 【修复】系统 AI 源码限制不再被旧模板覆盖；分发时独立保留策略，隐藏模型字段也不会丢失，历史第三方草稿按最终发布内容校验。

- 【新增】AI 模型字段支持源码声明 allowThirdParty: false；按运行冻结系统 AI 限制，拒绝第三方模型及直连覆盖，旧配置保留可清理。

- 【新增】Conversation 支持在代码中配置 collapseIntermediate 显示默认值；Agent executor 默认开启已结束回合的中间过程折叠，成功保留最终回复，失败保留错误原因，允许显式关闭，完整输出保持保留。

- 【修复】本地配置存储随项目源码变更重新识别 Agent 模型字段，无需重开面板；未变源码复用静态分析结果。

- 【新增】Core Agent 从项目配置的统一模型列表解析系统订阅与第三方 API，输入框只选择模型；按运行冻结选择并严格校验订阅，第三方连接无需系统 AI 登录。

- 【改进】Agent 重试输出携带续写来源；宿主恢复使用独立的 `recovery` 类型，界面静默续跑，网络重试与最终失败继续展示。

- 【修复】宿主断开支持挂起持久 Agent 并保留检查点；区分请求取消和 provider 意外 aborted，断流或缺失终态使用自动重试，后续轮次和续写耗尽保留具体失败原因。

- 【修复】持久 Agent 的忙碌请求被拒绝时保留原任务与检查点，不再写入持久失败；宿主支持 `{ resume: true }` 重连控制通道并恢复任务，无需再次提交初始消息。

- 【修复】发布过滤保留隐藏父路径下子项继承的锁定规则；源码升级到未验证模板时阻止配置读写，保留个人值及等待任务的原快照。

- 【新增】项目配置支持版本化分享模板、字段及 JSON 子路径权限，离线读取已验证模板与附件；运行快照只合并获准的个人值，升级保留个人配置和类型冲突草稿。

- 【修复】项目配置支持文件字段，直接选择并上传到服务器后保存文件引用；支持类型限制、替换和清除，上传失败保留原值。

- 【修复】切换字段声明时保留已保存值与暂被声明隐藏的自定义定义；显式 SDK 配置随运行持久冻结，持久会话可按配置代次重载；配置读取与必填校验不再误用对象原型成员。

- 【变更】以 `configuration.json` 声明和项目配置面板替换业务 env：新增运行隔离的 `context.config`、`getConfig`、本地配置存储与恢复快照；支持自定义字段、多套配置、版本检查和完整导入导出。旧 env 与 Kanban 配置不迁移，宿主通信变量保留。

- 【新增】Agent 根据模型能力默认启用 OpenAI / Anthropic 原生联网搜索，支持逐轮关闭，展示搜索活动与来源，并保存引用及续聊内容；补齐暂停续接、中断恢复和子会话隔离。

### 变更

- 【修复】普通 Agent 与持久会话在每次模型请求前检查上下文，默认达到 90% 时自动压缩，覆盖同一轮工具循环与自定义窗口；超限错误压缩后有限重试，超长历史分块总结并保留工具调用关系、取消保护和完整用量。

### 变更

- 【新增】Core Agent 内置 `i-have-adhd` 沟通技能，默认在系统提示词中加载完整指南，普通模式、plan 模式和自定义提示词均适用；保留用户语言、格式要求与关闭该风格的选择，随发布包分发原文及 MIT 许可。

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

## 0.2.0 - 2026-11-18

### 新特性

- **Bot 项目记忆**：Bot 默认开启项目记忆，自动保存长期事实并在每轮按输入检索
- **本地运行持久化**：运行历史与 Agent 检查点默认保存到本地 SQLite，回复路径不再等待远程读写
- **可取消的等待**：内置 `sleep({ seconds })` 保存截止时间，恢复后只等待剩余时间

### 破坏性变更

- 发行结构采用带版本标识的 Brotli + Base64 编码，项目与入口摘要保留明文。
- SDK 统一解码后读取入口、参数与模型定义，拒绝损坏、超限或旧格式载荷。
  迁移：重新从源码构建旧发行包；通过统一结构解码器读取入口、参数和模型。
- Conversation 项目改为 Bot，统一使用 defineBot 与 Core Agent。
- 固定输入解析、输出与持久会话，提供输入准备和可恢复的完成通知，写工具可声明始终审批。
  迁移：将 Conversation 项目声明迁至 defineBot，并按 Bot 输入、输出和持久会话契约接入。
- 完全移除 KV、PersistentValue 与本地 KV API；对话与运行记录默认使用本地 SQLite，可显式选择 Server 仓储。
  迁移：改用运行持久化接口；旧 KV/SQLite 数据不会自动迁移，请先评估并迁移所需记录。
- 项目身份、名称、版本和声明改用独立的 `steamharness.json`；不再读取或写回 `package.json.id` 与 `steamHarness`。
- 聚合项目须显式登记子入口，由子目录配置提供图标、声明与计划。
- 未登记配置不生效，上传下载保留父子结构。
  迁移：把旧 package.json 项目字段移至 steamharness.json，并显式登记聚合子入口。
- 项目改用根 projectId 与 entries/defaultEntry 聚合入口，支持同类型多入口、逐入口配置和执行隔离。
- 跨入口调用继承身份与取消信号并重新校验权限。
  迁移：在根清单声明 projectId、entries 和 defaultEntry，并按目标入口调整调用与配置。

### 新增

- 新增 Kanban 结构报告保留显式 Web 应用声明，支持完整本地 H5 的宿主接入。
- 新增 Bot 记忆改为静默维护：模型自动判断并记录长期事实，每轮开始按当前输入检索。
- 新增 支持多关键词、相关性排序与有界摘要的 `memory_search`，默认最多 5 条，避免载入全部记忆。
- 新增 默认开启的 Bot 项目记忆，可通过项目配置或 `defineBot.memory.enabled` 调整。
- 新增 内置存、取、改、删工具及操作提示，按项目、Bot 入口、分类与独立条目保存，支持并发版本校验和跨会话检索。
- 新增 本地运行日志按真实时间读取活动记录的接口。
- 新增 返回有界的截图引用、活动区间及当前时刻详情，保留原有分页和历史。
- 新增 文件参数的 `image` 裁剪开关与最小／最大宽高声明，结构报告和等待输入保留图片设置，并校验像素范围。
- 新增 数值参数的 `control: "range"` 与 `range: { min, max, step }`，支持滑块展示，参数解析和联动检查范围。
- 新增 项目生成规范中的结构化活动记录，用于分层展示业务事件、完整文字和宿主附件。
- 新增 本地 Workflow 历史的增量输出日志及分页读取，最终局部快照不截断此前输出。
- 新增 删除与备份包含完整日志。
- 新增 Kanban 桥接补齐内层会话的剪贴板及编辑路由，保留沙箱与会话边界，并在关闭时清理复制请求。
- 新增 Kanban 自定义引用支持 `suggest: false`：保留历史显示名称，同时从提及菜单隐藏该条目。
- 新增 Kanban 原生会话卡片的带标签操作；回调仅传卡片 `id` 与 `requestId`，不接受 URL 或脚本。
- 新增 Kanban Conversation UI 的有界纯文本 `messageCards`，按请求 ID 关联原生回复，不开放脚本或导航。
- 新增 子 Agent 队列清空后以持久内部状态输入续行主 Agent，并提前结束相关 sleep。
- 新增 保留真实结果、通知去重、取消和失败边界，普通定时等待保持原时长。
- 新增 内置可取消的 `sleep({ seconds })`，保存截止时间并在恢复后只等待剩余时间；宿主禁用的内置及自带工具从模型列表中移除。
- 新增 支持显式声明只读 Workflow 操作供本地知识卡片与 Kanban 预览读取。
- 新增 宿主逐次校验操作并拒绝预览写入。
- 新增 支持校验和运行压缩发行包，保留可读入口结构，隔离开发与发行会话及配置。
- 新增 Kanban 原生 Conversation 嵌入接口的发送生命周期与按原身份重试。
- 新增 业务消息区可即时展示发送状态并直接合并已授权回执。
- 新增 Kanban Conversation 公开类型的项目自定义 @ 选项、动态 UI 更新、展示插槽及提交回执回调。
- 新增 可复用原生输入框构建多人话题。
- 新增 聚合 Bot 入口控制与可信调用来源，保留原用户、权限和取消信号。
- 新增 支持持久回执、快照、审批、停止及显式恢复。
- 新增 持久会话快照提供子 Agent 的执行耗时和用量，以及包含所属子 Agent 的会话总用量。
- 新增 失败、停止和隐藏子会话仍保留已消耗用量，重试、重开和独立分支不会重复累计。
- 新增 提供 `steamharness/runtime-storage` 服务端 Agent 存储。
- 新增 该存储按账号、工作区和会话隔离 PostgreSQL 记录，支持租约接管、幂等提交和文档检查点。
- 新增 自定义宿主也可显式接入。
- 新增 子 Agent 总并发与角色并发支持显式 `null` 不设数量上限，保留默认 FIFO 限额。
- 新增 已证明未发出的工具请求可按业务回执恢复重试，权限拒绝、取消与未知副作用仍阻止重放。
- 新增 项目可为子 Agent 配置总尝试上限与退避。
- 新增 失败后复用原任务、子会话和检查点自动继续。
- 新增 完成回执核验、不可重试标记、持久次数与取消边界防止误报成功和无限重复。
- 新增 子任务最终失败回传主 Agent；耗尽配置的尝试上限时，同时附带上限提示。
- 新增 子 Agent 可通过项目配置单选统一模型，或由开发者指定默认模型。
- 新增 复用现有模型列表，支持跟随主模型、独立连接与凭据、能力匹配及系统 AI 权限校验。
- 新增 持久任务快照的委派项提供 `childConversationId`。
- 新增 匿名与命名子 Agent 在运行、完成和重开历史中均可定位对应子会话，供对话与 Trace 展示执行详情。
- 新增 命名 Agent 角色、持久 FIFO 并发队列、统一管理命令及安全检查点重试。
- 新增 动态会话和自定义 executor 继承 durable，恢复重新校验角色权限，保留业务任务历史与进度。
- 新增 Core Agent 的 skills.directories 技能目录声明，运行时自动组装带权限校验的技能工具。
- 新增 宿主可列出项目及 Core 内置技能，并按目录 ID 只读预览完整 SKILL.md，无需运行工具工厂或任务。
- 新增 Core Agent 内置小助手参数，defineExecutor 自动继承参数与模型解析。
- 新增 支持字段定制、隐藏、禁用、固定值和分组，以及业务 workflow 的 coreAgent 引用。
- 新增 输入 helper 支持 ExecutorContext，静态结构报告共用同一参数契约。
- 新增 用户设置支持模型列表，Agent 节点与直接调用可免连接配置运行。
- 新增 支持显式选择用户或旧项目来源，模型参数默认跟随且允许覆盖，始终执行系统 AI 来源及授权限制。
- 新增 公开用户设置快照 API `getUserSettings`、`withUserSettings` 与宿主校验 `parseUserSettings`，隔离并发执行并复制冻结设置。
- 新增 Agent 显式 `permissionPolicy: "inherit"` 继承用户权限，无宿主时回退 `auto`。
- 新增 未配置仍默认 `workspace`，本轮输入优先，工具与路径范围使用同一有效值。

### 变更

- 变更 本地项目加载允许缺省或非 UUID 项目 ID，按规范目录生成稳定存储身份且不写回清单。
- 变更 仅本地加载的 ID 规则，发行和分发仍校验源码 UUID。

- 变更 项目生成规范同步 Kanban 后台 Workflow 控制、分页和运行图片接口。
- 变更 项目生成规范统一使用 dist/steamharness/ 管理缓存、报告和发行产物，并同步项目产物与上传校验契约。
- 变更 sleep 运行进度显示预计结束时间，结果保存实际结束时间。
- 变更 实时工具进度同步到对话与持久会话快照，恢复后保留原截止时间。
- 变更 入口编译与静态产物按源码根归入 dist/steamharness 的 build/<entryId>/。
- 变更 拒绝占用其他入口的构建目录。
- 变更 入口名称和路径禁止与受管产物目录及 Windows 设备名冲突，避免构建清理覆盖缓存或报告。
- 变更 可重建产物统一使用聚合根 dist。独立 SDK 运行历史默认保存到用户目录 ~/.steamharness/runtime/<projectId>/<entryId>/，不再写入项目。
- 变更 Conversation 状态、用量与默认 Agent 会话使用本地持久化；新增版本化会话快照及分叉、独立化和取消接口。
- 变更 显式 Server 仓储仍在租约失效时中止执行，旧 KV/SQLite 不自动迁移。
- 变更 Agent 模型改为设置／项目两种独立模式：Studio 隐藏项目 AI 配置，独立 CLI Web 自动使用项目模型。
- 变更 空设置不回退，项目模型只保留系统 AI／第三方 AI 两种来源。
- 变更 开发用项目生成技能统一命名为 steamharness-generator，技能副本与相关检查、生成脚本引用同步更新。
- 变更 默认 Conversation 参数将模型与 effort 拆为两个独立 Quick 入口。
- 变更 用户模型快照支持完整宿主内置目录，同时保留 100 个自定义模型限制及全局唯一 ID 校验。
- 变更 参数绑定新增 `userSetting: { key: "agent.permissionPolicy", mode: "fixed" | "default" }`。
- 变更 fixed 控件仅显示当前系统权限并打开用户设置；default 控件保留三个可选权限。
- 变更 系统值作为默认且重置后继续跟随；继承状态与项目覆盖分开保存，现有任务保持原权限。

### 修复

- 修复 Kanban 桥接错误会带上操作与错误码。
- 修复 资源未声明、未登录等已知失败显示明确提示，未知宿主异常仍保留安全的通用消息。
- 修复 默认记忆工具覆盖 `agent.extraTools` 的问题，项目配置的工具可与每轮 `createTools` 同时使用；两处均拒绝与 Core 记忆工具重名。
- 修复 Bot 记忆默认值与项目配置不一致的问题：按实际导出的 Bot 读取默认值，补齐显式开关字段的缺省值，并正确处理发行替代入口。
- 修复 终端流式输出未立即显示输出项初始正文的问题。
- 修复 空闲或上轮失败后提升持久队列输入只返回回执而不执行的问题。
- 修复 沿用原输入身份和图片开始新轮，先应用排队中的上下文写入，重复提升保持幂等。
- 修复 压缩后重开未完成请求时复用原摘要和工具结果。
- 修复 重开时按当前权限收窄旧请求中的工具声明；恢复部分回答时保留系统提示。
- 修复 宿主禁用规则覆盖会话工具、原生工具和延迟目录工具。
- 修复 跨轮替换目录会释放旧连接、更新回调并保留历史与定义校验。
- 修复 同一运行时拒绝并发执行，避免覆盖在途状态。
- 修复 请求前自动压缩上下文后恢复当前系统提示和工具声明，避免长任务在压缩后失去工具而提前结束。
- 修复 保留当前授权范围和已加载的延迟工具。
- 修复 后台报告统一按业务身份去重并合并待处理进度。
- 修复 父轮次失败或停止后保存结果，明确继续时读取，避免完成通知反复开启模型重试。
- 修复 运行配置拒绝保留独立错误类型和重校验文案，同一输入不重置授权重试预算。
- 修复 子 Agent 默认最多 3 个并行，多余工作持久排队并自动补位。
- 修复 运行配置授权失败最多重新校验 10 次，权限恢复后继续原任务。
- 修复 项目生成器从相邻 CLI 包读取精确版本，移除对仓内示例工程的依赖，保持 SDK 与 CLI 版本独立。
- 修复 Agent 命令提交回执与会话快照发送解耦，避免慢投影造成确认超时。
- 修复 快照投影和声明为 safe 的工具失败最多重试 3 次，恢复后自动继续，保留请求身份、权限与取消边界。
- 修复 Kanban 聚合 Workflow 调用使用独立的 120 秒 Bridge 时限，避免持久回执被普通请求时限中断。
- 修复 宿主挂起持久 Agent 时中断外层项目执行，避免将尚未完成的回复记录为成功。
- 修复 重开后继续沿用原检查点。
- 修复 持久 Agent 的思考与正文条目保留模型请求的起止时间（含首包等待），工具条目使用持久任务跨度，重开后仍可显示轨迹耗时。
- 修复 系统 AI 目录按连接在进程内缓存 30 秒并合并并发刷新，避免每次执行重复加载。
- 修复 支持显式刷新，短期凭据临近到期仍在线刷新，拒绝授权后不复用旧 token。
- 修复 托管文件的缓存读取：先在线发出条件请求验证访问，再复用有界缓存内容。
- 修复 默认运行历史与 Agent 检查点使用本地 SQLite，移除首字路径上的远程逐条读写。
- 修复 提供 `createLocalRuntimePersistence` 和按需后台快照复制 `copyRuntimePersistence`，保留显式 Server 仓储与既有数据。
- 修复 持久 Agent 只保留最新完整会话快照，合并慢消费者的待发快照并串行发布。
- 修复 避免多 Agent 长时间运行时历史快照积累耗尽内存。
- 修复 流式节点可用 `accumulateChunk` 自定义内存收集，原始 chunk hooks 保持完整。
- 修复 独立复制对话时保留内容相同的文档版本变化与删除后重建身份，确保后续历史分支读取正确检查点。
- 修复 持久 Agent 回合快照提供实际执行起止时间，宿主可在子会话首次打开或历史恢复时还原耗时。
- 修复 会话分支导出为独立根会话，保留截断历史和 asOf 文档检查点，重新生成执行身份。
- 修复 分支隔离：不继承任务、审批、队列和用量，原会话停止或删除不影响新对话。
- 修复 持久会话支持离线分叉已提交历史，与活动会话共用原子分叉及回执去重逻辑。
- 修复 保留文档继承策略，不启动模型、工具或待执行任务。
- 修复 生成器对数字开头名称和多行提示词的处理。
- 修复 会话取消原子停止目标执行树并等待清理，防止协调者在逐项取消间派发残留任务。
- 修复 宿主主动取消同时终止后台批次和子任务。
- 修复 已有 Agent 会话可通过工具搜索发现并保存授权目录中新增加的工具，避免新增 Studio 诊断工具使整个旧目录失效。
- 修复 原有工具的描述、参数及 replay 定义继续固定，拒绝不兼容变更和未授权工具。
- 修复 向排队、收尾或已结束的子 Agent 发送消息时返回当前状态和送达回执，避免正常生命周期变化报错或重新执行任务。
- 修复 多 Agent 并发角色校验合并正在进行的查询，临时网络与服务故障在原时限内有界重试，明确拒权仍立即停止。
- 修复 所有模型请求错误统一进行最多 10 次兜底重试，不再依赖错误文案或状态码分类。
- 修复 覆盖流式输出、持久会话、延迟响应与摘要压缩。
- 修复 重试保留正文、工具结果和逐次用量，未完成调用不执行。
- 修复 失败不推进消息队列，主动停止立即生效。
- 修复 多 Agent 并发队列释放未命中的等待订阅，避免长批次累积无效等待。
- 修复 显式管理动作忽略模型附带的旧结果字段，避免列举、查询任务被误拒绝。
- 修复 受限项目配置在临时断网或角色降级时保留已选模式，权限恢复及重新打开后继续使用原选择。
- 修复 访客回退仍严格限制执行权限，显式切换 Ask 正常保存。
- 修复 Core Agent 项目及 coreAgent 包装入口自动继承宿主恢复能力。
- 修复 强退后按原 runId 接回未完成任务，避免后续输入被残留 busy 阻塞。
- 修复 补齐模型请求同步抛错、流读取与终态取回异常、摘要及延迟响应拒绝的暂态重试。
- 修复 识别嵌套网络码与 HTTP 408/409/5xx。
- 修复 手动压缩使用有界重试，保留正文、工具结果及每次摘要用量，宿主存储和回调故障不误重试。
- 修复 模型上游暂时不可用、无 HTTP 状态的流内 upstream_error 及 ECONNRESET 等连接失败正常触发自动重试。
- 修复 普通请求、持久会话与自动压缩统一处理。
- 修复 保留原始原因、已有正文和工具结果，仍受原有重试预算约束。
- 修复 技能目录与文件清单的分页遗漏问题。
- 修复 长子代理结果的 JSON 字节分页和变化校验，并限制写入回显大小。
- 修复 大文件尾部与只读环境长行无法读取、搜索和列表静默遗漏的问题。
- 修复 shell 截断标记及超时说明丢失、预取消仍启动命令的问题。
- 修复 子代理失败误报完成及 MCP schema 多字节大小校验。
- 修复 技能读取按 JSON 字节分页，支持 offset/limit 与 nextOffset 完整续读，避免中文指南被持久工具层截断。
- 修复 子代理模型覆盖只暴露已允许的精确值，并说明默认继承。
- 修复 文件卡片目标 schema 与纠错提示，并忽略不适用的 preview=false。
- 修复 Core Agent 输入统一过滤禁用字段并强制固定用户设置绑定，保留旧模型与模式参数，避免消息内容被误读为选项。
- 修复 静态参数继承支持简写引用和命名空间导入，undefined 字段定制保留原默认值。
- 修复 受限项目配置的在线角色查询允许最多 30 秒，避免慢查询把有效开发者或所有者误判为访客；查询失败仍撤销提升权限。
- 修复 普通 Agent 的自动用户模型参数保留继承关系，直接调用正确加载显式项目模型。
- 修复 模型连接与继承权限使用同一宿主快照，缓存连接保留开发者模型属性与系统搜索限制。
- 修复 模型 ID `inherit` 可正常选择。

### 移除

- 移除 全局与账号记忆及其工具、技能、授权、服务接入和设置入口。
