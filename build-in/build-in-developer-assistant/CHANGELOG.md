# Changelog

本发布单元的所有重要公开变更均记录于此。

## 0.1.0 - 2026-07-22

### 新特性

- **内置开发者小助手**：面向本地项目提供内置的小助手，随 Desktop 一同分发。

### 新增

- 新增 面向本地项目的内置开发者小助手。

## 0.1.1 - 2026-07-30

### 新特性

- **Kanban 宿主配置**：小助手可更新 Kanban 的宿主配置，并复用 OpenCode 运行时。

### 新增

- 新增 小助手更新 Kanban 宿主配置的能力，并复用 OpenCode 运行时。

## 0.1.2 - 2026-08-21

### 新特性

- **多语言内置项目**：中文显示为「小助手」、英文显示为 `Project Assistant`，README 随界面语言切换。
- **生成器项目元数据参考**：Generator 参考覆盖默认名称、中英文名称、手工声明与展示平台契约。

### 破坏性变更

- 内置项目兼容要求改用 `minDesktopVersion`，不再接受 `minAppVersion`，最低要求 Desktop 0.1.20。
  迁移：把项目清单的 `minAppVersion` 改为 `minDesktopVersion` 并填入 0.1.20 或更高版本。

### 新增

- 新增 内置项目的多语言声明，中英文显示名与 README 随 Desktop 界面语言切换。
- 新增 Generator 参考中的默认名称、中英文名称、手工声明与展示平台契约，并明确新项目不自动声明多语言或多平台能力。

### 移除

- 移除 内置项目清单的 `minAppVersion` 字段，兼容要求只认 `minDesktopVersion`。

## 0.1.3 - 2026-08-24

### 新特性

- **V2 工作区清单**：Workflow 项目或普通文件夹都可作为主目标，关联文件夹按类型化根目录授权。
- **多项目联动修改**：主项目与任意多级关联项目间联动修改，失效分支告警且不阻塞其余项目。

### 新增

- 新增 V2 工作区清单，支持 Workflow 项目或普通文件夹作为主目标与类型化关联根目录。
- 新增 读取 Desktop 校验的多项目工作区清单，在主项目与多级关联项目之间联动修改。
- 新增 旧版 V1 项目清单的兼容读取。

### 变更

- 变更 多工作区授权要求 OpenCode 0.1.8 或更高版本，安装小助手时一并满足该最低依赖。

## 0.1.4 - 2026-08-26

### 新特性

- **精确 Core/CLI 声明**：Generator 约束项目精确声明组件版本，宿主只比较 Core 的 `major.minor` 兼容线。
- **显式存储上下文**：项目必须声明 `dataStorage.mode`，知识库 helper 走显式存储上下文。

### 新增

- 新增 发布索引与兼容清单原子记录项目精确声明的 Core/CLI 版本，供 Desktop 下载前筛选并核对。

### 变更

- 变更 小助手本体迁移到 Core/CLI `0.2.0`，声明 `dataStorage.mode: "both"` 并透传存储上下文，最低宿主为 Desktop `0.1.22`。
- 变更 Generator 改用 `context.storage.local.*` / `context.storage.server.*` 访问存储与知识库。
- 变更 Generator 不再产出 `context.kv` 与 `context.persistentValue` 调用。

## 0.1.5 - 2026-09-01

### 新特性

- **Desktop Control 标准 MCP**：小助手固定挂载该 MCP，直接操作主题、语言、更新、项目与 KV。
- **OpenAI Responses 适配**：复用 OpenCode 的多轮文本、图片、模型校验与流式输出，结果写入 `opencode-answer`。
- **OpenCode Permission 快捷参数**：快捷参数可在 `read-only`、`workspace` 与默认 `auto` 之间切换。

### 破坏性变更

- Generator 停止生成全局 KV、`.workflow` 存储作用域与 Kanban `dataSources`，改用当前项目、会话与关联项目 API。
  迁移：已有项目的 `context.kv`、`persistentValue` 与 `dataSources` 调用改写为当前项目、会话或 `projectInfo.relatedProjects` API。
- 小助手工作区清单只接受 schema v2 与通用关联资源类型，不再兼容旧版清单和缺少清单的旧 Desktop。
  迁移：旧版项目关联清单先转为 schema v2，宿主升级到声明 `minDesktopVersion` 的 Desktop。

### 新增

- 新增 OpenCode Permission 快捷参数，可在 `read-only`、`workspace` 与 `auto` 间切换并传入每次运行。
- 新增 OpenAI Responses 协议适配，复用多轮文本、图片、模型校验与流式输出，结果写入 `opencode-answer`。
- 新增 Desktop Control 标准 MCP 挂载，覆盖主题、语言、开机启动、更新、本地项目、项目信息与 KV 读写。
- 新增 Dock 打开工具，支持本次运行绑定的首页、本地项目或普通文件夹的右侧与底部面板。
- 新增 最多 100 项的项目 KV 批量读写与项目知识库查询修改，返回逐项结果。
- 新增 切换模型时通过 OpenCode resolver 刷新推理档位，`gpt-5.6-*` 额外提供 `max` / `ultra`。

### 变更

- 变更 固定挂载 Desktop Control MCP 后，最低宿主版本提升为 Desktop `0.1.23`。
- 变更 OpenAI 推理档位在快捷参数中统一显示为 `Effort`，并与模型值组成宿主 composer 摘要。
- 变更 项目清单显式采用通用的 `projectInfo.relatedProjects` 关系合同。
- 变更 OpenCode 只通过父 Workflow 的受控代理访问 Desktop Control，关键写操作默认审批，回环令牌不进入 shell。

### 修复

- 修复 Skill 或引用文件无法完整读取时仍继续编辑、并用旧版 CLI 结果误报完成，现在立即停止并报告未验证阶段。
- 修复 旧清单或结构校验失败降级出的普通文件夹无法修复，现在按授权根分阶段迁移并续接跨项目修复。
- 修复 源码迁移、宿主识别、代码目录授权与 KV 授权被混报为同一个完成状态。

### 移除

- 移除 Generator 的全局 KV、`.workflow` 存储作用域与 Kanban `dataSources` 输出。
- 移除 工作区清单对旧版项目关联清单的转换，以及对缺少清单的旧 Desktop 的兼容。

## 0.1.6 - 2026-09-13

### 新特性

- **Dock 页签管理**：小助手可读取、刷新和关闭 Dock 页签，并运行其中的 Run 与侧边项目。

### 新增

- 新增 读取与管理已有 Dock 页签，更新内容、关闭页签及运行其中的 Run 与侧边项目。
- 新增 打开 Dock 时随同一次调用携带已知的 URL、文件、run、conversation、数据源或侧边项目上下文。

### 变更

- 变更 小助手按全部 Desktop MCP 的 action 合同选择参数，并复用状态查询返回的 ID。

### 修复

- 修复 初始加载未应用 AI 配置默认模型，历史自动回填的模型不再覆盖新的配置默认值。
- 修复 首页侧边栏启动时因 `primaryTarget.kind` 无效而中止，现接受 Desktop 的 Home 工作区目标。
- 修复 克隆被误用 `import_project`，创建、克隆、导入与打开新建对话框现按用户意图严格分流。
- 修复 本地工具审批恢复未按项目、run 与输入请求去重，重复点击现在接续同一次执行。

## 0.1.7 - 2026-09-13

### 新特性

- **生成器契约对齐**：Generator skill 补齐入口分组、音频与视频、Conversation 网关与八种 `workflow.HarnessError`。
- **脚手架发布元数据**：生成的 `package.json` 带上 `steamHarness.projectCard` 与 `steamHarness.release`。

### 新增

- 新增 Generator skill 覆盖 `entrypoint.group`、音频输入、视频附件与输出、Conversation 的 `context.hostInput`。
- 新增 Generator skill 覆盖八种 `workflow.HarnessError` 与 `createLLMNode`。
- 新增 Generator skill 覆盖 `getLLMProvider` 与 `tokenUsage.getRunUsage()`。
- 新增 脚手架生成 `steamHarness.projectCard` 与 `steamHarness.release`，取值按项目类型默认。

### 变更

- 变更 发布门禁新增 `workflow-generator-contract` 守门，Core 契约漂移而 skill 未同步时直接失败。
- 变更 生成器依赖解析按包名识别仓库布局并支持日期型预发布版本，不再回退到宿主产品版本。

### 修复

- 修复 Generator skill 把 `steamHarness.release` 说成不写入源码、把已删除的 Kanban `dataSources` 说成可用能力。
- 修复 制品按文件 basename 过滤导致 `scripts/create_workflow.py` 未随发布出厂，小助手只能手写项目结构。

## 0.1.8 - 2026-09-13

### 变更

- 变更 发布前的 `workflow-generator-contract` 增加 App 运行标识检查，提前拦截会让 Desktop 身份校验失败的 skill 文本。

### 修复

- 修复 运行时平台说明复述已移除的 App 运行标识，同步进 Desktop 仓库后触发其身份校验失败。

## 0.1.9 - 2026-09-15

### 变更

- 变更 最低 OpenCode 依赖提升到 `0.1.10`，使 AI 配置默认模型的修复能随安装生效。

### 修复

- 修复 小助手沿用 OpenCode 内置项目的模型选择，依赖下限过低时安装拿不到默认模型修复。
