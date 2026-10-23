---
name: workflow-generator
description: 生成、修改或迁移 steamharness Workflow、Conversation 或 Kanban 项目；适用于 executor、HTML 看板、参数配置、标准化 package 元数据、运行时约定，以及因旧清单或结构校验失败被 Desktop 降级为普通文件夹、需要关联项目授权的修复。
---

# 工作流代码生成器

## 核心流程

1. 将用户指定目录视为项目根目录；如果用户没有指定目录，使用当前工作目录。
2. 先明确项目类型。Workflow/Conversation 继续确认输入、输出和运行语义；Kanban 确认静态产物目录、HTML 入口、画面、静态资源以及是否需要命名参数配置。
3. 确认文案语言和国际化范围。生成项目默认采用简体中文的用户可见文案、示例数据、README、错误与页面 `lang`，且默认不创建翻译字典、locale 状态、语言切换、locale 检测或 i18n 依赖，也不自动声明 `multilingual` 或 `multiplatform`。仅当用户明确要求国际化或多语言支持时才适配：先确认默认语言、目标语言和切换方式，再复用项目既有国际化方案或选用成熟兼容方案，并将所有用户可见文本、ARIA 文案、错误及日期/数字格式纳入资源、回退和测试。用户仅提供英文名称、代码标识或单条英文文案不构成国际化请求。
4. 需要选择 API、定位公开类型或寻找项目示例时，先读短索引 `references/task-map.md`，再按其指向读取详细契约；要改参数入口或控件（`kind` / `fields` / `control`），先读 `references/param-panels.md`。
5. 项目不存在时使用 `scripts/create_workflow.py`。所有类型生成 `.steamharnessignore` 与 `configuration.json`；Workflow/Conversation 生成 TypeScript executor，Kanban 生成 HTML、状态与存储模块和测试。`--with-kanban-params` 在声明文件加入示例字段。
6. 如果项目已存在，先判断它是否处于 Desktop 普通文件夹降级、旧清单迁移或关联项目修复状态；命中任一情况时必须完整读取 `references/project-repair.md`。如果该必需引用缺失、被拒绝或只读取到部分内容，立即停止本次修复并准确报告读取失败与未验证阶段；不得继续编辑、转向无关优化、用旧工具的成功结果代替当前合同校验，或宣称修复完成。引用可用时再按当前授权根目录分阶段完成，不能把局部修复宣称为整体完成。
7. 再检查 `package.json` 是否精确记录当前兼容的 `steamharness` 与 `@steamharness/cli` dev dependency，并同步项目 lockfile；缺失、range 或 `workspace:*` 都必须修正。解析精确版本时先看注册表通道（`npm view steamharness dist-tags --json`、`npm view @steamharness/cli dist-tags --json`），取项目所处 `major.minor` 线（当前为 `0.2.x`）的通道版本；**不要用 `latest` 标签**，它可能停在旧版本，而同一条 `0.2.x` 线内的运行时 API 与本地 KV 存储格式都已经变化。安装后核对真正装上的版本（`node -p "require('<project-dir>/node_modules/steamharness/package.json').version"`），本地检查的结论只对这个版本成立。按项目类型检查入口。Kanban 不要求也不得补造 `index.ts` executor；已有 Vue/React/Vite 等项目先读取 `package.json.steamHarness.kanban.artifactDir` / `entry`，区分源码与预览产物。SteamHarness 宿主不负责构建，但本 skill 作为项目开发工具修改框架源码后，应按下方「依赖安装与环境」和 Kanban 规则安装依赖、执行项目已有的一次性构建并验证产物入口。
8. 所有项目运行 `steamharness structure <project-dir>`；只有 Workflow/Conversation 才运行 `steamharness json`、`run` 或 runtime smoke。运行前先把三个本地存储位置指到项目内的一次性目录（`STEAMHARNESS_KV_STORE_DIR`、`STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR`、`STEAMHARNESS_FILE_STORE_DIR`）：CLI 继承调用方进程的环境，宿主（Desktop、上层 agent 或父 CLI）注入过这些变量时，未隔离的检查会读写**调用方自己的存储**，既污染双方数据，也可能因为里面存在别的版本写下的条目而以存储错误失败（见「运行时排查」）。宿主仍把目录显示为普通文件夹时，structure 成功只是局部证据，不能代替 Desktop 当前清单合同与重新识别结果。
9. 新增功能时不要把所有功能都加在 `index.ts` 中，合理创建文件和文件夹组织代码。

## 项目修复边界

- 先读取系统提示词中的可信 `workspace_context`。只有 `roots` 列出的目录可写；`primaryTarget.kind: "folder"` 表示当前 run 只有普通文件夹能力，即使目录内存在 Workflow 声明，也不能据此自行扩大权限。
- 当前根看起来是被降级的 SteamHarness 项目时，先完成该根内可以独立验证的清单和源码迁移。需要其它项目配合时，继续完成不依赖外部根的部分，并明确报告“当前根已修复、整体关联尚未完成”，不要笼统声称项目已经修复。
- 关联项目未列入 `roots` 时，不扫描父目录、相邻目录或用户目录，也不要求用户关闭权限保护。按 `references/project-repair.md` 给出 Desktop 重新识别、管理关联资源和在新授权上下文中继续的具体步骤。
- 代码工作区授权与运行时 KV 授权是两套边界：有效的单边关系可让已导入项目进入后续小助手代码工作区；KV 读写仍要求双方关系确认，并读取目标项目对当前项目的 `grantToRelatedProject`。
- 项目内已安装的旧版 `steamharness structure` 只能作为补充证据，不能覆盖本 skill 的当前 package 字段白名单。必须先直接校验当前 `projectInfo` 合同；旧 CLI 返回 `0` 也不能证明 Desktop 能重新识别项目。
- API 语义以本 skill 为准。项目内 `node_modules/**/dist/**` 只是某个已安装版本的实现，不要从里面反推运行时 API，也不要把它的失败当成当前合同；本地 CLI 的结果与本文档冲突时，先按通道升级到同线最新的精确版本再复跑，而不是按旧实现改项目代码。

## 当前 API 规则

- workflow 源码使用注入的全局命名空间，可用的运行时成员只有 `references/runtime-api-index.md` 里列出的那些 `steamharness.*`（该清单由 Core 源码生成，`pnpm test` 校验，不在这里抄第二份）。这些名字之外的 `steamharness.*`（包括自己实现的 helper）不会进入 structure report 的 `definitions.apiCalls`，需要出现在报告里就改用清单里的成员。
- 不要在 workflow 源码中从 `"steamharness"` 导入 runtime API。
- **判断 `steamharness.*` 全局成员是否存在先读 `references/runtime-api-index.md`**：它由 Core 源码生成。`context.files` 与 Kanban 浏览器 Bridge 不属于全局成员清单，文件创建、读取与上传迁移的契约见 `references/steamharness-api.md`，不能因全局清单未列出就判断文件接口不存在。
- **API 与类型细节只从本 skill 取，不要去项目的 `node_modules` 里翻。** 先用 `references/task-map.md` 按任务定位公开类型、项目示例与详细章节，再读 `references/steamharness-api.md` 中对应契约；运行时成员是否存在以 `references/runtime-api-index.md` 为准。项目源码可从 `steamharness` 或 `steamharness/runtime-api` 使用 `import type` 获取公开类型，但不能导入运行时函数。**不要用 `read` / `grep` / `find` 去读已安装 `steamharness` 的 `dist/*.d.ts` 或打包后的 JS**：那是某个历史版本的构建产物，不是契约，照着它写出来的代码在宿主升级后就会失效，而且这条路会消耗掉大量轮次。bundled 技能不在工作区里，按文件路径 `read` 只会得到 ENOENT——`SKILL.md`、`references/*.md`、`assets/*`、`scripts/*` 一律用 `skill` 工具的 `action: "read"` 读（`path` 省略时读 `SKILL.md`），`action: "list"` 会列出全部文件。
- Workflow、Conversation 和 Kanban 的 `package.json` 都必须在 `devDependencies` 中精确固定 `steamharness` 和 `@steamharness/cli` 版本，不能使用 range 或 `workspace:*`。精确声明记录开发基线，但 Core 运行门禁只比较宿主与项目的 `major.minor`：同线任意 patch 或精确预发布版本可直接运行，不比较日期顺序；major 或 minor 变化必须升级宿主。Core `0.2.x` 与数据存储声明从 Desktop `0.1.22` 开始支持；采用 Core `0.2.x` 的内置项目必须把发布索引 `minDesktopVersion` 设为至少 `0.1.22`。CLI 独立发版，不要假定与 Core 同版本。**同一个 `major.minor` 不代表本地存储互相兼容**：本地 KV 的根目录布局与条目字段在 `0.2.x` 线内改过（早期版本只有 `global` / `workflow` / `conversation` 三种作用域并把工作流名写进 `projectName`，当前版本只有 project / conversation 两种作用域并写 `projectId`）。旧 CLI 一旦在同一个 KV 根目录里读到当前版本写下的条目，就会以 `Local workflow KV entry is invalid and cannot be read safely.` 失败——它每次写入都会枚举整个根目录；反过来，当前版本遇到没有格式标记的根目录会重建格式并删除 `.inspection`、`.locks`、`.transactions`、`conversation`、`global`、`project` 这些旧数据目录。所以任何版本都不要指向宿主或其它项目正在使用的 KV 根目录，也不要靠删除存储目录来「修复」这类错误。Kanban 不执行 Core runtime，但上传、发布和宿主管理仍读取这些声明。
- workflow `package.json` 只保留标准化源码元数据和第三方依赖。不要添加 package 内部的 `start`、`structure` 或 `json` scripts；终端运行应直接调用外层 `steamharness` CLI。
- workflow `package.json.id` 必须是顶层 UUID，不要再使用目录名、包名或 `steamHarness.id`。新 scaffold 应直接写入固定 UUID；上传、发布和数据权限边界都以这个顶层 UUID 为准。所有类型必须在 `package.json.steamHarness.projectType` 静态声明 `workflow`、`conversation` 或 `kanban`；Workflow/Conversation 的 executor 类型必须与之相同。
- 在 `interface.ts` 中定义最小本地类型，尤其是 `RunPayload`、`OutputItem`、`RunOutputPayload` 和 `ExecutorResult`，让 workflow 源码保持自包含。
- 所有节点 payload 类型都必须继承或包含 `RunPayload`：`errCode: number` 和 `errMessage: string`。成功输出统一使用 `errCode: 0, errMessage: ""`。
- 每个 executor 必须显式声明唯一运行类型 `projectType: "workflow" | "conversation"`。`"workflow"` 禁止声明 `conversation`；`"conversation"` 自动启用 conversation id、上下文、持久化和标准主输入框，不提供关闭或自定义主输入框的配置。`conversation` 承载 `attachments.images/videos/files`、`inputQueue`、可选的 `openai` 网关和输入框外的纯文字 `footer`；禁止生成 `conversation.defaultInput` 或旧的 `conversation.enabled`。Conversation 的 `params` 只允许 Auxiliary、Quick、Mode 和 Slash，不声明普通主字段，主文本和附件使用固定 flags。
- `steamharness.defineExecutor(...)` 必须接收可静态分析的内联对象字面量，并把返回值导出为 executor。Workflow executor 必须声明静态 `defaultEntrypoint` 和非空 `entrypoints` 数组，每项直接调用 `steamharness.defineEntrypoint({ id, title, ... })`；`workflow`、`params`、`createInput`、resolver、tools、token usage、registry 和 context factory 都属于具体入口，不得放在 Workflow executor 顶层。Conversation executor 继续使用单入口顶层执行配置。不要生成 `defineExecutor(config)` 动态配置，也不要生成顶层 `workflow`、`createInput`、`projectType` 分散导出的旧式入口。
- Workflow entrypoint 是同一项目下可独立启动的扁平入口，不表达强制父子关系。需要组合业务流程时在 workflow 内显式调用 `steamharness.runProject(...)`；不要生成多级入口路径或让子入口先运行默认入口。
- 多入口项目按业务域折叠时，在入口对象上声明静态 `group: { id, title, order? }`。`group` 必须是内联对象字面量且只含这三个属性；`id`、`title` 是非空静态字符串，`order` 一旦声明就必须是非负整数（写 `order: undefined` 也算失败）；同一个 `group.id` 在所有入口上的 `title` 和 `order` 必须逐字一致。分区只影响 Desktop Run 区和 CLI Web 的折叠展示，本地 CLI、MCP 和 OpenAI 接口 仍只按 `entrypoint.id` 执行；不要把业务层级编码进 `group.id`。单入口或不需要分组的项目不要声明 `group`。
- 需要被宿主识别的失败、暂停和取消必须抛 `steamharness.HarnessError({ type, message, nodeName?, metadata? })`，类型取 `input_validation`、`execution_aborted`、`user_input_required`、`tool_permission_denied`、`node_execution`、`provider_call`、`project_execution`、`stream_interrupted`。普通 `Error` 只会被归类成 `project_execution`；`runNode` 抛出的 `user_input_required` 与 `execution_aborted` 必须原样向上传递，不要吞掉或包装。
- `package.json.steamHarness.release` 只声明关联项目交付策略：`{ dependencies: {} }`。`dependencies` 的 alias 必须与 `projectInfo.relatedProjects` 双向一致，每个值是 `"included"` 或 `"external"`。Server 对所有类型仅保存完整源码与不可变版本，不提供执行目标或源码模式；上传和发布不安装依赖、不构建、不加载项目代码。源码下载不限制操作系统。
- 项目卡片只在用户明确要求时写入 `steamHarness.projectCard`：`icon` 取注册图标名（`workflow`、`message-circle`、`bot`、`sparkles`、`code`、`git-branch`、`boxes`、`zap`、`database`、`file-text`、`cpu`、`brain`），`iconUrl` 只接受 `http(s)`，`iconColor` / `iconBackgroundColor` 必须是 `#RRGGBB`。不要写已移除的 `kind` 字段（旧键 `appCard` 仍可读，但同样禁止 `kind`）。
- 音频输入用 `type: "file"` 加 `control: "audio"` 和可选 `audio: { maxDurationSeconds, maxBytes }`；音频参数必须单文件、不能声明 `options`、不能放进 Quick，限制值必须是正的有限数（`maxBytes` 必须是正整数）。Conversation 视频附件只有在 `conversation.attachments.videos: true` 时才走 `--videos`，否则继续走 `--files`；视频输出使用 `contentType: "video"` 的 item，`content` 为 `{ src, mimeType: "video/mp4", name, durationMs?, format? }`，`src` 只接受 `data:video/...;base64,...` 或 `http(s)` URL。
- Conversation 可选接入宿主 OpenAI Responses 网关：声明 `conversation.openai: { enabled: true, outputItemId: "<最终纯文本答案的稳定 item id>" }`，并在 `createInput` 里用 `steamharness.readOpenAIConversationHostInput(context)` 读取宿主输入（非 OpenAI 宿主返回 `undefined`，必须保留普通输入分支）。走网关时不要把请求或答案正文再写进普通 conversation、KV 或自定义日志。
- 需要 LLM 的自定义节点用 `steamharness.createLLMNode({ name?, provider, mapInput, mapOutput?, historyLimit?, metadata? })`（非流式）或 `steamharness.createLLMStreamNode({ name?, provider, mapInput, historyLimit?, metadata? })`（流式）；在节点内部解析 provider 时用 `steamharness.getLLMProvider(context, nodeName, source?)`，它会按「节点名绑定 → source → 默认 provider → `context.providers.llm` → fallback 引用」解析并自动上报 token usage。用户从 Server 账户选择模型时优先 `getServerLLMCredentials`，并在未显式指定模型时使用凭据的 `defaultModelId`。
- 知识库 helper 的 create、edit、delete 需要原子写入：目标 `persistentValue` namespace 必须提供 `withLock` 或 store 提供 `executeMutation`，两者都没有时会抛 `project_execution`；`deleteKnowledgeDocument` 对不存在的 id 返回 `{ id, deleted: false }` 而不是抛错。`searchKnowledgeDocuments` 的 `pageSize`/`maxMatches` 上限 1000、上下文行 0–50；`readKnowledgeDocumentLines` 单次最多 1000 行。
- Workflow 确实适合后台定时运行时，可在 `package.json.steamHarness.schedulePresets` 声明建议计划。每项使用唯一静态 `id`、标题、可选 `description`、现有 `entrypointId`、IANA 时区、`window-interval` 或五字段 Cron，以及 JSON `paramValues`；最多 20 项，`title` ≤100 字符，每天最多 12 个窗口，`intervalMinutes` ≤1440，`weekdays` 取 1–7（1 为周一），未知字段会被拒绝。宿主只展示并要求用户确认，不能因导入项目自动启用。Conversation 和 Kanban 禁止声明该字段。计划参数不支持日期占位模板，需要动态日期时由 Workflow 按业务时区读取当前时间。
- 导出具名 workflow、`executor`、别名 `export { namedProject as workflow }`，以及默认 workflow。
- 用户可见输出必须使用 output node。当前协议是 `RunOutputPayload.items: OutputItem[]`；不要生成顶层 output `content` 作为可见聚合输出。使用 `steamharness.createOutputPayload(...)`、`steamharness.createOutputItem(...)`、`steamharness.addOutputItem(...)` 和 `steamharness.createOutputItemChunk(...)`，不要手写 id 或旧式 Markdown details 块。
- 数值辅助输出使用 `display: { type: "ring", placement: "composer-right" }` 和 `content: { value, total?, unit? }` 可固定到 Conversation 输入栏右侧；使用跨轮稳定的 item id 更新。Core Agent 的上下文用量使用此标准协议，不另写 context 专用宿主逻辑；省略 placement 时圆环在输出列表中展示。默认 Markdown/text 主回答仍直接平铺。
- Core Agent 在运行开始就发送上下文圆环，并在流式消息、工具结果和压缩后更新。编程式运行时通过 `getContextUsage()` 查询、`updateContextUsage({ used, total })` 提交绝对测量值，运行中的更新沿用 `context_usage` 事件；计费用量由 `host.reportUsage` 按每次模型响应增量上报，不能把它的累计值当作当前上下文大小。
- Agent 的持久扩展用公开 registry/task/doc/hook API；延迟工具目录、Code Mode 和远端 ExecutionEnv 均由 session 显式启用，调用仍经过授权和审批，执行目标不回退到本机。任务检查点、计时、资源释放、自定义存储及离线备份契约见 `references/steamharness-api.md` 的 Agent 章节；不要直接依赖 Pi SDK 或另写持久执行引擎。
- 手动 `/compact` 总结全部已有上下文，自动压缩才保留最近对话；复用 Core 的执行中、完成和失败协议。只有正常结束的非空摘要才替换真实 transcript，失败、截断或取消时保留原始记录，不得将不完整摘要当作成功结果。
- 默认对所有用户可见 output node 使用流式输出。定义 `steamharness.createOutputNode({ async *stream, format })`，并用 `steamharness.runStreamNode(...)` 执行。叙述文本、LLM/AI/agent 正文、最终答案和普通状态文案优先直接 `yield "文本"`，让 runtime 自动生成 inline `Output` item；只有工具调用、trace、日志、调试 JSON、文件/音频描述等结构化辅助信息才使用 `steamharness.createOutputItemChunk(...)`。流式输出能让 本地 CLI Web 渐进渲染，并让平台用最终 report 替换 live items，避免重复内容。非流式 `steamharness.runNode(...)` 只保留给确定瞬时完成或不属于用户可见文本的输出。
- 默认让所有用户可见 output item 直接展示。不要把叙述文本、项目介绍、状态更新、最终答案、分支结果或已完成任务摘要包在 collapsed/details 块里。AI/LLM/agent 正文必须渲染为 inline `Output`：`title: "Output"`、`contentType: "markdown"` 或 `"text"`、`collapsed` 不是 `true`、没有 `metadata`、没有 `icon`/`iconPreset`。如果为了稳定 live/final 合并必须手动创建正文 item，也必须保持这些字段；不要给正文加 `metadata.kind = "answer"` 之类标记，因为 shared UI 会把带 metadata/icon 的 item 当成 detail/block。手动创建正文 item 时不能跨工具调用一直 patch 同一个正文 item；遇到工具调用前先结束当前正文段，工具完成后的后续 AI 文本重新创建新的 inline `Output` item，确保最终 `items` 顺序与事件顺序一致。工具调用才应该创建 detail item，并用 `metadata: { kind: "...-tool", status: "running" | "success" | "failed" }` 加 `iconPreset` 展示进行中和完成状态。
- 只有 workflow 必须暂停等待人工回答并在同一 run 中恢复时，才使用 `steamharness.createUserInputNode(...)`。它的 `params` 复用与所选 entrypoint（Conversation 则为 executor）相同的 `ParamDefinition` 结构，不要发明第二套表单 schema。字段由外部 agent 或当前节点输入动态产生时，保留静态 `params` 默认定义，并用无副作用、对同一输入保持确定性的 `resolveRequest(input, context)` 返回本次 `title`、`description`、`params` 和 `defaultValues`；恢复同一个 requestId 时字段名和 option value 必须稳定。
- 当业务逻辑需要在 Diagram 中明确呈现为分支时，使用 `steamharness.runIf(input, context, { name, branches, else })`。尽量让 `branches` 和 `else` 保持静态对象或数组字面量。
- 当重复业务步骤需要在 Diagram 中明确呈现为循环时，使用 `steamharness.runFor(input, context, { name, items, run, maxIterations })` 或 `steamharness.runWhile(input, context, { name, condition, run, maxIterations })`。
- 当 workflow 需要复用另一个 imported workflow，且父 workflow 拥有最终 conversation 写入或可见输出时，使用 `steamharness.runProject(...)`，只在确有桥接需求时设置 `conversationMode: "shared-readonly"`、`kvMode: "isolated"`、`outputVisibility: "hidden"`。
- 当业务阶段需要在本地运行界面中显示计时卡片时，使用 `steamharness.createTimerNode(...)` 加 `await steamharness.endTimer(timer, context, { status, message })`。
- 业务配置统一在项目配置面板管理，用 `steamharness.getConfig(name)` 或 `context.config` 读取运行快照；`configuration.json` 声明 fields、原生默认值、说明和敏感标记。不生成或加载项目 env 文件，不回退读取 `process.env`。Server 部署和 Studio 内部通信变量由宿主管理。
- 每个项目必须在 `package.json.steamHarness.projectInfo.dataStorage.mode` 显式声明 `local`、`server` 或 `both`。`local` 只能访问本地且可离线运行，`server` 只能访问同 UUID 云端项目且要求登录，`both` 允许源码按需显式选择；禁止跨位置访问、自动回退或隐式同步。
- 轻量运行态状态使用 `context.storage.local.kv` 或 `context.storage.server.kv`，独立持久值使用同一位置下的 `persistentValue`。顶层对象直接表示当前 UUID 项目，只有 `.conversation` 子作用域；不得生成 `.workflow` 或全局作用域。Core 0.2 不再提供 `context.kv` / `context.persistentValue`；选择位置必须与项目声明一致。
- 跨项目 KV 必须在双方 `package.json.steamHarness.projectInfo.relatedProjects` 中显式声明。调用方以自己的 alias 使用 `context.storage.<local|server>.relatedProjects.get(alias).kv.getValue/setValue/updateValue/deleteValue`，实际权限读取目标项目授予调用方的 `grantToRelatedProject`；只允许直接关系，同一调用严格停留在所选位置，不递归、不回退。新关系默认显式使用 `read: all`、`write: none`，单边声明仅为待确认，不授予 KV 权限。
- 本地运行生成文件时使用 `context.files.createFile({ name, mimeType, buffer, kind })`；需要保存到服务器时显式使用服务器文件存储或 CLI `workspace file-upload`，数据写入独立校验成员权限。
- 项目知识库 workflow 优先使用 PersistentValue-backed helpers：`steamharness.listKnowledgeDocuments`、`steamharness.getKnowledgeDocument`、`steamharness.createKnowledgeDocument`、`steamharness.editKnowledgeDocument`、`steamharness.deleteKnowledgeDocument`、`steamharness.searchKnowledgeDocuments` 和 `steamharness.readKnowledgeDocumentLines`。每个 helper 的第一个参数必须是明确的 `context.storage.local` 或 `context.storage.server`。
- 对 conversation-to-knowledge workflow，启用 `executor.conversation`，从 `context.conversation.conversationId` 派生稳定文档 id，通过 `context.conversation` 追加消息，再用知识文档 helper upsert 完整 transcript。
- Conversation workflow 使用 `context.conversation.getValue()`、`context.conversation.setValue(key, value)` 和 `context.conversation.appendMessage(...)`；不要使用旧的 `getState()` API。
- 需要在 conversation 的当前 run 尚未结束时继续接受主输入框消息时，在 `executor.conversation` 声明 `inputQueue: { enabled: true }`。这是本地执行宿主的持久化输入队列，后续消息会作为新的 conversation turn 顺序执行；它不同于 `createUserInputNode(...)` 的同一 run 暂停与恢复。
- 项目需要的是「agent 对话」而不是自研运行时的时候，优先复用 Core 的 agent 组件：`steamharness.createAgentConversationProject(...)`、`steamharness.createAgentNode(...)`、`steamharness.createAgent(...)`，以及一步生成完整 executor 的 `steamharness.defineAgentConversationExecutor(...)`。要让参数面板接上 SteamHarness Server 的系统 AI 配置，用 `steamharness.createAgentProjectParamResolver()`：模型选项来自项目配置中的 `STEAMHARNESS_AGENT_MODELS` 列表（`type: "json"`、`control: "ai-models"`），Provider 参数隐藏，默认列表第一项。配置面板分别添加系统订阅模型与第三方 API 模型；系统 AI 每轮鉴权并使用回环代理，第三方连接由配置面板保存，源码与输入参数不保存任何 Key。**不要在项目内自己拼 LLM 工具循环，也不要把 Core 的 provider 适配到项目自有的 LLM 抽象上**——接口、消息格式和流式协议都不相同，适配层只会带来长期维护成本。
- 如果 workflow 业务逻辑需要 LLM，使用全局 LLM helper，例如 `steamharness.createLLMProviderRef(...)`、`steamharness.createLLMProviderFromConfig()`、`steamharness.getServerLLMCredentials(...)`、`steamharness.createLLMStreamNode(...)` 和 `steamharness.createQuestionClassifierNode(...)`。用户从 SteamHarness Server 账户配置中选择 provider/model 时，优先使用 `getServerLLMCredentials`，不要把真实上游 Key 写入 workflow 参数或环境变量。联网搜索必须在 `credential.modelDetails` 中找到当前模型，并检查其 `capabilities.webSearch`；只有明确为 `true` 时才能调用 `createProvider({ model, webSearch: true })`，workflow 不要自行按模型 ID 推断。只接受 HTTP base URL 的 agent SDK 使用凭据对象的 `startLLMProxyBridge({ signal })`，并在 `finally` 中关闭桥；兼容方法 `startOpenAIProxyBridge()` 仅用于 OpenAI Responses。

## 依赖安装与环境

- 小助手和其它开发 agent 处在开发者侧，运行在用户本机的项目目录里。依赖没装不是停下来的理由：先判断环境，再决定装还是停。
- 环境可用要同时满足三件事：项目根在当前可写的 `roots` 内、`packageManager` 声明或现有 lockfile 指向的包管理器在 PATH 上可执行、安装确属当前任务必需（要跑项目已有的 `<manager> run build`、要执行 `steamharness structure`，或按核心流程第 7 步核对并固定 Core/CLI 精确版本）。三条都满足就直接执行安装一次，不必等用户明确要求：先用一句话说明要装什么、为什么，装完把原先被卡住的检查复跑一遍。
- 安装只补「缺」，不动「依赖图」：只运行 `<manager> install`，并优先使用与现有 lockfile 对齐的不可变模式（`pnpm install --frozen-lockfile`、`npm ci`、`yarn install --immutable` 或等价形式）。不得 `add`、`remove`、`update` 或 `upgrade` 任何依赖，不得修改 `package.json` 里的依赖版本，不得创建或改写 `build` 脚本——这些是设计决策，必须先问用户。只有当不可变模式因为 lockfile 与 `package.json` 不一致而失败时，才退回普通安装让包管理器补齐 lockfile，并在结论里说明 lockfile 变了什么。
- 环境不满足时不要绕路：没有可用包管理器、无网络、目录只读或运行在不可写的宿主沙箱里时，保留真实错误，说明哪一步、哪个版本没有验证，不要改用其它 registry、手工下载 tarball、往 `node_modules` 里塞包，也不要为了绕开缺失的依赖去改项目源码。

## 本地 CLI 与服务器身份

- Studio 启动的项目和内置终端使用 Studio 账户会话；独立 CLI 使用自己的登录配置。使用当前环境实际可用的 `steamharness`，不假设旧 Desktop 工具存在。
- 判断上传与发布目标时读取 `steamharness workspace status` 的 `effective` 字段，包括有效 serverUrl 与来源 env / flag / file / default。`serverUrl` 只表示 CLI 保存的登录，不能据此推断当前调用的目标。
- 上传前核对项目顶层 UUID、`steamHarness.projectType`、完整 `projectInfo` 与版本号。使用 `steamharness workspace upload <project> --path <dir> --create` 保存源码，再用 `workspace publish <project>` 发布不可变版本；关联项目按 `steamHarness.release.dependencies` 的 included/external 声明使用项目组命令固化版本锁。Server 只校验和保存文件；依赖安装、结构检查和静态产物构建在本地完成。只能按实际命令结果陈述执行情况。

## Kanban 项目

- 在 `package.json.steamHarness.projectType` 声明 `"kanban"`。默认产物目录为项目根目录 `.`，默认入口为相对产物目录的 `index.html`；需要自定义时使用 `steamHarness.kanban.artifactDir` 和 `steamHarness.kanban.entry`。禁止生成 `index.ts`、`interface.ts`、executor、Run 输出、对话或无意义的 Node runtime 依赖。
- `artifactDir` 和 `entry` 必须是使用 `/` 语义的安全相对路径；禁止绝对路径、盘符、UNC、`..`、符号链接和 `.git`、`.hg`、`.svn`、`node_modules`。入口必须是 `.html` 或 `.htm`，且 iframe 只能读取 `artifactDir` 内资源。
- Vue、React、Vite 等构建工具由项目开发者维护，SteamHarness Desktop/Server 宿主不会自动安装依赖、运行构建或连接 dev server。使用本 skill 修改框架源码时，小助手或其它开发 agent 属于开发者侧：如果 `package.json` 已定义非 watch 的一次性 `build` 脚本，完成源码修改后必须执行该脚本，使配置的 `artifactDir` / `entry` 与源码一致；依赖缺失时按「依赖安装与环境」判断环境并补齐，而不是跳过构建。
- 执行构建前先读取脚本内容，优先使用 `packageManager` 声明的包管理器，否则按现有 lockfile 选择，并只运行现有的 `<manager> run build`。禁止启动 `dev`、`watch`、`serve`、HMR 或任何长期占用端口的任务；安装的许可条件与边界（只补缺、不改依赖图、不编造构建脚本）以「依赖安装与环境」为准。
- 构建完成后必须确认 `<artifactDir>/<entry>` 存在，再运行 Kanban structure 检查。构建脚本缺失、依赖装不上、脚本实际是 watch 任务或构建失败时，保留真实错误并明确说明预览产物未更新，不能声称预览已经更新；直接修改 `artifactDir` 内静态文件时不需要额外构建。
- 只允许系统 AI 的项目在 `configuration.json` 显式声明 `STEAMHARNESS_AGENT_MODELS`（`type: "json"`、`control: "ai-models"`、`allowThirdParty: false`、`defaultValue: []`、`secret: true`），并保留模型字段的发布结构；不要生成自定义 URL/API Key 直连分支。省略限制时仍可添加第三方模型。
- 底图、初始化文件等文件配置声明 `type: "file"` 和 `accept`，由项目配置面板选择并上传到服务器；不要将文件配置降级为要求用户填写引用的 JSON 文本框。单文件保存服务器元数据对象，多文件保存引用数组，文件内容和本机路径不进入配置。
- 无声明字段时生成 `{ "version": 1, "fields": [] }` 的 `configuration.json`。三种类型始终保留项目配置入口，用户可以添加自定义字段。
- Kanban 页面必须同时适配全屏工作区、手机、平板和 Conversation 对话卡片中的小预览；“小卡片”是对话资源卡片内的 Kanban 页面，不是另一种设备。Desktop 标题栏提供全屏（默认填满可用区域）、手机 `390×844`、平板 `768×1024`、小卡片 `360×200` 的真实 iframe 视口；对话卡片的实际宽高还会随容器变化，至少覆盖 `340–500px` 宽及 `180–200px` 高的紧凑场景，不能只适配这几个固定数字。
- HTML 声明 `meta name="viewport" content="width=device-width, initial-scale=1"`，以页面自身 iframe 的宽高进行响应式布局，使用 CSS media/container query、弹性布局或 ResizeObserver；不要依赖父窗口尺寸、设备 UA、固定桌面最小宽度或整页缩放。手机与平板保持核心功能可操作；小卡片优先呈现主要内容与必要操作，收敛页头、留白和次要面板，长内容在有界区域滚动，不能出现文字重叠、控件越界或只有空白首屏。图像、地图和 canvas 随容器重新测量并保持可检查的内容。
- 手机、平板和小卡片预览均可拖动或输入宽高，并可恢复当前模式默认尺寸；不能把模式与某一固定尺寸绑定。宿主切换或调整尺寸不重载页面或切换命名配置；页面的 resize 处理必须保留草稿、选择、存储状态和进行中的图片/文件请求。布局变化不能重建业务数据或重复提交上传与保存，卸载时清理尺寸监听。
- 页面通过 `window.steamHarnessKanban.getPresentation()` 读取 `{ mode: "fullscreen" | "phone" | "tablet" | "card" }`，监听 `steamharness:kanban-presentation-change` 的 `CustomEvent.detail` 更新展示状态；实际 Conversation 卡片也使用 `card`。这不是业务参数，不能写入 KV、切换配置或通过宽高猜测模式。地图、图片等内容预览或用户指定的只读小卡片应隐藏页头、工具栏、侧栏、详情和编辑浮层，关闭绘制、实体拖动及修改快捷键，让主要内容占满画布并随容器适应取景；返回其它模式时恢复编辑状态。
- 参数项目使用 `{ "version": 1, "params": [...] }`。字段直接复用 executor 参数定义，支持 string、number、boolean、positional、file、枚举和多选；file 必须使用平台文件引用，页面不能读取本地绝对路径。
- `configuration.json` 只承载同一页面的视图或行为配置，例如标题、主题、过滤条件和显示模式。任务、卡片、记录等页面业务数据必须在 HTML 内提供新建、编辑、删除等操作，并通过 KV Bridge 保存；禁止把业务列表编码成逗号分隔 textarea 或要求用户在配置区维护。
- 页面通过 `window.steamHarnessKanban.getConfiguration()` 读取 `{ id, name, params }`，并监听 `steamharness:kanban-configuration-change` 的 `CustomEvent.detail` 实时重绘。配置切换时 iframe 不会重新加载；异步读取旧配置数据时使用请求代次，禁止旧响应覆盖新配置。
- 用户需要 Agent 查询或操作页面时，通过 `window.steamHarnessKanban.methods.register({ name, description, inputSchema, readOnly? }, handler)` 注册业务白名单方法，保存返回的注销函数并在卸载时调用。handler 接收 JSON 对象与 `{ signal, configuration, presentation }`，自行校验业务参数并返回 JSON；检查取消信号，配置 ID 变化后按新配置重新注册。不要依靠全局函数名、模拟按钮或自建消息协议。Desktop 小助手先用 `steamharness-kanban_kanban_methods` 的 `action: "list"` 发现方法和具体实例，再用该实例的 `instanceId`、`configurationId`、`method`、`args` 调用；主区、Dock、对话卡片独立，不能因项目 ID 相同而误控其它预览。超时后先查询状态，禁止自动重试相对缩放、平移或写入。此 capability 需要已启用的 Desktop 本地宿主桥，独立 CLI/Server 和托管 Web 不具备页面连接；详细限制见 API 参考。
- 需要持久化页面数据时使用 `window.steamHarnessKanban.kv.getValue(key)` / `setValue(key, jsonValue)`；需要项目 markdown 文档时使用 `window.steamHarnessKanban.knowledge` 的 list/get/create/edit/delete/search/readDocumentLines。Bridge 固定当前项目和 project scope，禁止让页面传入 projectName、scope、数据库路径、项目 ID 或发布 target，也不要自行构造宿主消息协议。
- 图片和文件使用 `window.steamHarnessKanban.files.createFile({ name, mimeType?, buffer })`、`readFile(fileId)`、`deleteFile(fileId)`。`buffer` 接受 Blob、ArrayBuffer 或 Uint8Array；read 返回 `{ file, buffer: ArrayBuffer }`，可转 Blob 与临时 object URL 显示，卸载时释放 URL。文件始终写入当前连接服务器的受鉴权存储，与 Workflow/Conversation 的 `context.files.createFile` 一致；宿主未连接、未获同 UUID 服务器项目授权或服务器不支持接口时明确失败，不回退本地。单文件上限 50 MiB，文件 Bridge 超时 120 秒；KV 只保存文件引用与标注，禁止把图片分块或 base64 写入 KV。现有本地图片可用 `steamharness workspace file-upload <项目 UUID> --file <路径>` 上传，`file-download <文件 ID> --output <新文件>` 读回核对原始字节；业务文件上传与项目源码上传、版本发布独立。
- Kanban 消费关联项目 KV 时，复用 `package.json.steamHarness.projectInfo.relatedProjects`，并调用 `window.steamHarnessKanban.relatedProjects.get(alias).kv.getValue(key)` 或 `setValue(key, value)`。宿主每次按双方当前声明验证目标对当前项目的读写授权；页面只能传 alias 和 key，不能动态传目标 UUID、scope、target 或数据库路径。旧 `steamHarness.kanban.dataSources` 与 `window.steamHarnessKanban.dataSources` 已删除，存在即校验失败。
- 需要响应关联项目 KV 更新时，使用 `window.steamHarnessKanban.relatedProjects.get(alias).kv.subscribe(listener)` 并在卸载时调用返回的取消函数。listener 只接收 `{ alias, revision }`；revision 不透明且不表示具体 key。把连续变化防抖合并为一次重读，自动刷新期间保留最后一次成功内容，失败显示非阻塞警告。不要自行监听文件、构造 SSE 或从 revision 推断存储信息。
- Desktop 只会从已关联并导入的目标项目本地 KV 读取；Server Web 看板预览 要求访问者可读当前 Kanban，双方关系已确认后即可按目标项目授予当前项目的规则访问，无需访问者成为目标项目成员。公开 Kanban 仍要求登录。关系撤销立即生效；自动联动只发生在同一宿主后端，Desktop 与 Server 的 KV 后端彼此独立。
- `steamHarness.projectInfo.relatedProjects` 是通用项目关系与项目依赖的唯一声明。只有双方确认的关系可以作为 `included` 随 project-group v1 交付并固化目标精确版本与 source hash；单边待确认关系和明确外部关系不联动下载。项目组只传源码，禁止携带 KV、知识库、计划、运行历史、`.env*`、SQLite 或宿主用户配置。
- KV key 必须稳定且带 schema 版本；按命名配置隔离时推荐 `<feature>.v1:${configuration.id || "default"}`。`setValue` 不能传 `undefined`、函数、非有限数字或循环引用；第一版没有 KV list/delete。保存使用串行防抖队列，失败记录必须按 storage key 保留内存状态并提供重试，不能因切换配置而清空；切回配置时先恢复失败值，页面隐藏或卸载前主动冲刷待保存值。
- Bridge 调用必须处理 Promise reject。页面同时最多有 16 个请求，单次 15 秒超时；直接打开 `index.html` 时 Bridge 不存在，仍应提供明确的只读或内存降级，不能因此阻塞首屏。
- HTML、CSS、JS、图片和字体必须使用产物目录内相对路径，不能通过 `..` 读取源码或项目元数据。ES module、动态 import、WASM 和 `fetch()` 可以读取宿主自动续期的短期预览 capability 下的同源产物，页面不应缓存或解析 capability URL；页面运行在 `sandbox="allow-scripts"` 和离线 CSP 下，不能请求公网、父页面 DOM、Node/preload、弹窗、下载或顶层导航。
- 上传清单只由项目根目录 `.steamharnessignore` 控制，`.gitignore` 不参与。规则支持目录、glob、`**` 与 `!` 反向包含；缺失或空规则会上传全部普通文件。`.steamharnessignore` 必须是普通文件（符号链接会被拒绝）且为 UTF-8；自身始终上传，`package.json`、项目入口和已有 `configuration.json` 不得被忽略。Workflow/Conversation 的必备上传路径是 `package.json` 与 `index.ts`。Kanban 规则不得排除实际 `artifactDir`；是否把产物提交 Git 与是否上传无关。
- 必须验证没有参数时的全幅布局、有参数时的命名配置、配置事件更新、存储损坏回退、配置隔离、保存顺序与失败重试，以及全屏、手机、平板和对话小卡片的宽高适配；覆盖 760px 以下与低高度卡片布局，确认内容不溢出或重叠，尺寸切换保留草稿、上传与保存状态。

## Executor 参数

- 新 Workflow 有用户输入时，应在 `steamharness.defineEntrypoint({ params, createInput })` 中声明；Conversation 继续在 executor 上声明，让本地 CLI 和 CLI Web 共享相同参数语义。
- Workflow 的 `params` 必须是 entrypoint object 内部的静态数组字面量；Conversation 的 `params` 保持在 executor object 内。静态结构分析只读取字面量字段。数组中可按顺序写多个 `kind: "auxiliary" | "quick" | "mode" | "slash"` 入口；Mode/Slash 仅用于 Conversation。Auxiliary/Quick 的 `fields` 也是内联字段数组，源码字段不写 `panel`。结构报告会展平字段并用 `paramLayout.actions` 保留入口顺序。
- 每个 param 应包含稳定的 `name`、`flag` 和 `type`。支持类型为 `"string"`、`"number"`、`"boolean"`、`"positional"` 和 `"file"`。
- 长文本参数使用 `control: "textarea"`，让本地运行界面显示多行输入。
- 日期参数使用 `type: "string"` 和 `control: "date" | "time" | "datetime" | "date-range"`；固定格式分别为 `YYYY-MM-DD`、`HH:mm:ss`、本地 `YYYY-MM-DDTHH:mm:ss` 和闭区间 `YYYY-MM-DD/YYYY-MM-DD`。只放在主字段或 Auxiliary，不用于 Quick，不声明 `options` 或 `multiple: true`，也不通过 resolver 返回 option 补丁。无效值会阻止宿主提交，生成 workflow 时应给出合法默认值或保留空值。
- 高频枚举参数放进 `kind: "quick"` 的 `fields`，并用 `summary` 显式指定摘要字段；每个 Quick 声明产生一个独立入口，组内字段使用 `control: "select" | "radio" | "checkboxes"`。同一个 Quick 内可放多个字段，多个 Quick 按声明顺序排列，重置只影响本组。业务输入从 `createInput({ paramValues })` 读取结构化单值或多选数组。
- 偶尔修改的字段放进 `kind: "auxiliary"` 的 `fields`；每个 Auxiliary 是一个可收缩面板，允许声明多个。Conversation 中单击轮换的模式声明为 `kind: "mode"`，要求至少两个 `options`，名称可以是任意稳定字段名。完整呈现及限制见 `references/param-panels.md`。
- Conversation 的 `/` 菜单使用 `kind: "slash"`，声明 `name`、`flag` 和 `type: "string" | "boolean"`，不写 `control`、`panel` 或 `multiple`。单选使用 `options`，选项 `command` 默认取 `value`；boolean 的参数级 `command` 默认取 `name`，选择后切换开关。命令在项目内唯一且匹配 `/^[a-z][a-z0-9_-]*$/`，选择只更新参数并消费命令文字，不发送消息。输入框外底部文字使用静态 `conversation.footer`，每项二选一 `{ text, localizedText? }` 或 `{ param }`，可加 `when: { param, value }`；内容为纯文字。小助手默认 Build，以 `/plan` 切换并按条件显示 Plan 模式提示，不增加专用宿主判断。
- 需要参数互斥或联动时，定义无写入副作用、幂等的 `resolveParams({ draftText, paramValues, trigger })`，返回值、可见性、禁用状态、`resolvedOptions` 或 option 状态补丁；初始化以及 main、Advanced、Quick 的 Form 参数变化都会触发。互斥字段隐藏时必须同时返回 `{ visible: false, value: null }`，因为只隐藏不会清空旧值，旧值仍会进入 args。Raw 模式初始化补丁只更新对应已声明参数，其它 Raw 参数保持不变。`resolvedOptions` 数组替换静态选项，`null` 恢复静态选项。只有联动确实依赖主输入文本时，才在相关参数上声明 `resolveOnInput: true`；不要在该回调中写 KV/文件。确需读取服务器动态目录时只能调用支持 `AbortSignal` 的只读 API，例如 `steamharness.getServerLLMCredentials({ signal: abortSignal })`。
- 平台托管运行附件使用 `"file"` params。workflow 期望 file references 时，包含 `multiple`、`accept` 和 `format: "json"`，并在 `createInput` 中解析 JSON 字符串。
- 同步维护对应 entrypoint（Conversation 则为 executor）的 `params`、`createInput({ args })`、输入类型和 README 命令。
- 用户输入节点的 `params` 是独立的等待表单，继续声明普通字段，不使用 executor 的 Auxiliary/Quick/Mode 分组。保持名称稳定，因为提交答案会存储在 `values[param.name]` 下。
- Conversation 的用户输入交互使用静态 `conversation.userInput`：`hideComposer` 默认 true，待回答期间隐藏主输入区，确认答案或停止后恢复并保留草稿，可设 false 保留输入区。答案影响参数时声明 `effects: [{ when: { type?, nodeName?, values? }, params: { ... } }]`，按请求 `metadata.type`、节点名和已确认的答案匹配，至少一个条件、多个条件须全部匹配；只更新已有参数，boolean 用字符串，后项覆盖前项。小助手批准计划关闭 `/plan` 也通过该通用声明实现，不在宿主中加入 Plan 特判。
- Boolean params 为 true 时只追加 flag。Positional params 会追加到 argv，仍应包含稳定的 `flag` 供静态提取。
- File params 追加 `flag` 加 file references JSON 字符串；在 workflow 内用 `steamharness.createFileInputNode(...)` 解析这些 references。

## 编辑检查清单

- 输入变化：同步更新输入类型、`params`、`createInput`、README 示例，以及任何 parser nodes。
- 输出变化：同步更新 payload 类型、output node `format`、inline 正文 item 与工具/detail item 的边界、README 输出示例，以及 tests/smoke 命令。LLM/agent 正文回归测试要断言正文 item 没有 `metadata`/`icon`/`iconPreset`；工具调用测试要断言同一个工具 item 从 `running` patch 到 `success` 或 `failed`。
- 节点变化：优先使用显式 `steamharness.runNode` / `steamharness.runStreamNode` 串联；用户可见分支用 `steamharness.runIf`；用户可见循环用 `steamharness.runFor` / `steamharness.runWhile`。
- 可调试节点变化：用静态数组字面量把稳定节点注册到对应 entrypoint 的 `registry`；Conversation 仍使用 `executor.registry`。
- 外部服务变化：用 `steamharness.getConfig(name)` 读取配置，将字段定义加入 `configuration.json`，README 说明字段用途；敏感字段不写真实默认值。项目 package 只声明真正使用的 npm 依赖。
- Package 变化：保持 Core/CLI 精确 dev dependency 与真实第三方依赖，并用根目录 `.steamharnessignore` 显式选择上传文件；不要依赖 `.gitignore` 或宿主隐式排除生成产物、secret、cache、`node_modules`。
- 定时预设变化：确认每个 `schedulePresets` 项引用现有 entrypoint，时区与触发规则有效，`paramValues` 符合入口静态参数；同步 README，并用 structure 检查预设目录。预设不能代替 Workflow 内部的日期和幂等处理。
- Kanban 框架源码变化：读取现有 `build` 脚本，依赖缺失时按「依赖安装与环境」判断环境并补齐，再执行一次性构建，确认配置的 `artifactDir` / `entry` 存在且 structure 通过；不要启动 dev/watch server，也不要把旧产物当作验证结果。
- 绑定阶段变化：如果用户要把本地 workflow 接到 server，提醒他保留顶层 `package.json.id` UUID；Desktop/CLI 已支持向 server 创建项目并把返回的 UUID 写回该字段，不能再从目录名推导远程项目 ID。

## 运行时排查

只有在调查本地运行、外部 CLI 副作用、第三方回调或服务器源码与数据访问问题时使用本节。普通 scaffold/edit 流程不需要加载本节。

本地静态和运行时检查：

```bash
# 先隔离本地存储：CLI 继承当前进程环境，宿主注入过 STEAMHARNESS_*_STORE_DIR 时
# 未隔离的运行会读写调用方自己的存储（另一个项目的会话、token usage 也在里面），
# 旧版本还会在枚举时读到不认识的条目并直接失败。
STEAMHARNESS_KV_STORE_DIR=<workflow-dir>/.tmp/kv \
STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR=<workflow-dir>/.tmp/persistent-value \
STEAMHARNESS_FILE_STORE_DIR=<workflow-dir>/.tmp/files \
steamharness structure <workflow-dir>

STEAMHARNESS_KV_STORE_DIR=<workflow-dir>/.tmp/kv \
STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR=<workflow-dir>/.tmp/persistent-value \
STEAMHARNESS_FILE_STORE_DIR=<workflow-dir>/.tmp/files \
steamharness json <workflow-dir> --conversation-id <id> -- --dry-run --payload '<sample-json>'

NODE_PATH=<repo-root>/node_modules pnpm -C <repo-root> exec tsc -p <workflow-dir>/tsconfig.json --typeRoots <repo-root>/node_modules/@types
```

`os.tmpdir()/steamharness-kv` 只是没有配置时的默认值，不代表实际使用的目录。任何「本地 KV/存储格式错误」都要先确认运行进程真正拿到的存储路径（`env | grep -E 'STEAMHARNESS_.*STORE'`）以及实际安装的 CLI/Core 版本，再判断是不是项目代码的问题；不要删除宿主或其它项目的存储目录，也不要靠反复清理目录来排除故障——目录不在你推测的位置时，清理不会有任何效果。

**没有任何输出、退出码为 0，都不等于通过。** CLI 的入口判断比较的是解析软链接之后的 `import.meta.url` 和未经解析的 `process.argv[1]`，所以在 pnpm 这类把包软链进 `node_modules/.pnpm` 的安装方式下，命令可能什么都不打印就返回 0（`@steamharness/cli@0.2.4-20260917002` 上可复现；npm 的实体安装目录不受影响）。解读任何检查结果之前，先用 `--help` 或一条必然失败的输入确认命令真的执行了——把「空输出」当成「全过」，会把排查方向整整带偏一轮。

检查服务器保存的源码版本时，打包、上传、发布并查看 versions；这些动作不会执行项目代码：

```bash
steamharness workspace pack <workflow-name> --path <workflow-dir> --output /tmp/<workflow>.tgz
curl -X POST -H 'Authorization: Bearer <server-token>' -H 'Content-Type: application/gzip' -H 'X-SteamHarness-Package-Name: <workflow>.tgz' --data-binary @/tmp/<workflow>.tgz http://localhost:<port>/api/projects/<workflow>/package
curl -X POST -H 'Authorization: Bearer <server-token>' -H 'Content-Type: application/json' -d '{"releaseLog":"publish source snapshot"}' http://localhost:<port>/api/projects/<workflow>/publish
curl -H 'Authorization: Bearer <server-token>' http://localhost:<port>/api/projects/<workflow>/versions
```

服务器连接异常时检查 `health` 和服务日志；项目运行日志只在本地宿主查看：

```bash
curl -i http://localhost:<port>/health
tail -200 server/.data/logs/server.log
rg '<requestId>|postgres|database|storage' server/.data/logs/server.log
```

通过外部 CLI 或 API 发送格式化消息时，先发一条小型 smoke message，再判断 workflow 格式是否正确：

```bash
<message-cli> --help
<message-cli> <send-command> --markdown '**smoke test**'
```

## 推荐 Scaffold

```bash
python <skill-dir>/scripts/create_workflow.py <workflow-name> --dir <target-dir> \
  --project-type workflow \
  --description "一句话描述" \
  --prompt "默认文本"
```

Kanban：

```bash
python <skill-dir>/scripts/create_workflow.py <kanban-name> --dir <target-dir> \
  --project-type kanban

# 需要命名配置和参数表单时
python <skill-dir>/scripts/create_workflow.py <kanban-name> --dir <target-dir> \
  --project-type kanban --with-kanban-params
```

生成文件：

- `package.json`：顶层 UUID `id`、package `name`、`version`、`type`、精确 Core/CLI dev dependency，以及必要时才加入的真实第三方依赖。
- `.steamharnessignore`：上传文件的唯一忽略规则；Workflow/Conversation 默认排除构建输出，Kanban 默认保留可能作为静态产物的 `dist/build/out`。
- `configuration.json`：为所有业务配置声明字段和安全默认值；无字段时使用空 fields。实际值不进入源码，由面板及 Studio Control 管理。
- `interface.ts`：本地 `RunPayload`、`ExecutorResult`、输入类型、输出 payload 和输出结果类型。
- `index.ts`：全局 `steamharness.*` 节点、具名 workflow、带静态 params 的 executor、默认导出。
- `README.md`：真实 structure、run 和 JSON report 命令。

Kanban scaffold 额外包含 `board-state.js`、`board-storage.js` 和 `tests/*.test.mjs`。任务操作留在页面内，通过 KV Bridge 持久化；所有 scaffold 均生成配置声明，参数化版本声明标题和强调色。

## 验收

- workflow 项目结构命令能识别 nodes、params 和 registry，且没有 violations。
- executor 命令能显示用户可见输出，且源码 package 精确记录用于兼容判断的 Core 与本地工具 CLI 版本。
- JSON report 命令能输出完整 report。
- 生成文件不包含 secret，也不包含平台 provider 配置。
- Kanban 的 structure 能识别 `projectType: "kanban"`、`artifactDir`、HTML `entry` 和可选清单；框架源码变化后已有的一次性 build 已成功更新该入口；`run`/`json` 被明确拒绝，页面能响应配置事件、通过项目级 Bridge 持久化数据、按静态 alias 读取关联项目数据、在 Bridge 缺失或失败时降级，且不违反离线 sandbox。涉及项目组交付时，依赖锁仍由宿主发布阶段生成，项目源码不应自行写入 delivery/version/sourceHash，但 `steamHarness.release` 的发行意图必须写在源码里。
- Workflow 声明定时建议时，structure 能返回 `schedulePresets`，宿主导入后不会自动启用，参数和入口都能通过当前项目校验。

- 可分享配置使用 configuration.json v2 的 sharing（publish/includeValue/editable）与 JSON Pointer paths。默认不携带个人值，默认值也必须过滤。通过 Studio Control 查询权限、管理在线 publication.save 草稿，不能用导入、父对象替换或自定义字段绕过锁定；完整备份与分享模板分开。
