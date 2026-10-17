# Changelog

本发布单元的所有重要公开变更均记录于此。

## 0.1.1 - 2026-07-29

### 变更

- 变更 CLI 改为独立版本和独立 tag 发布，并通过 peer dependency 声明兼容的 Core 范围。

## 0.1.2 - 2026-07-30

### 破坏性变更

- 项目打包只读取根目录 `.workflowignore`，其它忽略文件不再生效。
  迁移：在 `.workflowignore` 中显式排除凭据、依赖目录和临时文件。

### 新增

- 新增 `workspace pack`、`upload`、`publish` 和 `download` 支持 Kanban 静态项目，无损传输二进制资源。

## 0.1.3 - 2026-08-07

### 新特性

- **全局 `--locale` 开关**：切换本地与 Workspace 输出，并传递给 Server 和 Workflow runtime。
- **`--entrypoint` 参数**：本地与远程命令均可指定入口，省略时使用默认入口。参见 [CLI](../docs/cli/workflow-code.mdx)。

### 破坏性变更

- 项目组打包与下载排除 PersistentValue 数据和 CLI 登录凭据，并逐包校验 SHA-256。
  迁移：自引用、锁不一致或内容被修改的响应会被拒绝，需重新生成依赖锁。

### 新增

- 新增 全局 `--locale <zh-CN|en>` 切换输出语言，项目可用 `workflow.getRuntimeLocale()` 读取。
- 新增 本地 `run`、`json`、`resolve-params` 与远程 `run`、`debug-node` 支持 `--entrypoint <id>`。
- 新增 `structure` 校验并输出按入口、时区、时间窗口或 Cron 声明的计划建议。
- 新增 Workspace 命令按精确依赖锁交付和恢复 Kanban 项目组，不传输宿主数据。

### 变更

- 变更 发布日志同步维护中英文内容，Docs 按当前文档语言展示对应版本。

## 0.1.4 - 2026-08-24

### 新特性

- **按平台下载发行版**：`workspace download` 发送当前平台并把 `latest` 解析为该系统最新兼容版本。
- **按版本选择发行目标**：`workspace upload/publish` 可为不可变版本选择 Server runtime 与 Desktop 下载目标。

### 破坏性变更

- Desktop 本地运行事件环境变量改为 `WORKFLOW_DESKTOP_RUNTIME_EVENTS`。
  迁移：旧 `WORKFLOW_APP_RUNTIME_EVENTS` 不再生效，替换为新变量名。

## 0.1.5 - 2026-08-26

### 修复

- 修复 日期版 Alpha Core 按项目声明的 caret 范围兼容同一 minor 的更高 patch，避免兼容升级被误判不支持。

## 0.2.0 - 2026-08-26

### 破坏性变更

- CLI 升级到 0.2.0 并精确绑定 Core 0.2，执行前校验 CLI 与项目的精确 Core 声明。
  迁移：只允许相同 `major.minor` 兼容线，该线上的任意 patch 可直接运行。
- 本地运行按项目 `dataStorage.mode` 配置明确的本地/服务器存储上下文。
  迁移：缺少声明或非法跨位置访问会直接失败，需在项目中补齐 `dataStorage.mode`。

## 0.2.3 - 2026-09-01

### 新特性

- **本地 MCP 入口**：`workflow-code mcp <workflow-dir>` 把每个 entrypoint 暴露为标准 stdio MCP tool。
- **关联项目访问**：`--related-project` 显式启用双方已确认的关联项目 KV 访问。
- **MCP 生命周期上报**：由 Desktop 无窗口启动器托管时，CLI 经独立 IPC 上报完整快照。参见 [CLI](../docs/cli/workflow-code.mdx)。

### 破坏性变更

- 移除 `--grant-data-access` 与 Kanban `dataSources` 授权流程。
  迁移：项目组依赖改由双方确认的 `workflowCode.projectInfo.relatedProjects` 生成。
- `workspace upload --create` 要求 package 预先声明顶层 UUID 与 `dataStorage.mode`。
  迁移：不再由 Server 分配或回写项目 ID。

### 新增

- 新增 `workflow-code mcp <workflow-dir>`，把每个 entrypoint 暴露为标准 stdio MCP tool。
- 新增 本地运行支持可重复的 `--related-project <alias>=<绝对项目目录>`。

### 变更

- 变更 本地 `kv.*` 与 `persistentValue.*` 直接绑定当前项目，不再经过全局作用域。
- 变更 Desktop 无窗口启动器托管 MCP 时，CLI 经独立 IPC 上报同一 runId 的生命周期快照。
- 变更 stdio stdout 只承载 JSON-RPC，原始 input、CLI args、report、stdout 与 stderr 保留在快照中。

### 修复

- 修复 MCP 表单 elicitation 返回非法内容或传输、恢复失败时终止等待中的运行并记录诊断。
- 修复 OpenAI Responses 内部 runner 不再把 AI SDK 可选参数兼容性 warning 写入 `stderr`。
- 修复 `workflow-code structure` 在静态分析前校验完整 `projectInfo` 合同，不支持字段返回退出码 `1`。

## 0.2.4 - 2026-09-05

### 新特性

- **关联项目的知识库与入口**：`--related-project` 现在可读目标项目知识库并调用其授权入口。
- **软链接调用修复**：pnpm 等软链安装下 `workflow-code structure .` 不再空跑并以退出码 0 假通过。
- **状态页显示真实服务器**：`workspace status` 新增 `effective` 字段，说明命令实际会用哪台服务器。

### 破坏性变更

- CLI 不再有 `--web-runtime` / `--no-web-runtime`，`web` 发行目标随中继与 Web 入口一并删除。
  迁移：浏览器里的运行由 Desktop 首页的 Web 构建承担；继续传这两个选项会明确报错而非静默忽略。
- 服务端位置的关联项目目标只交出 KV，知识库与入口调用会以明确错误说明本机无法抵达。
  迁移：把目标项目改为 `local` 位置，或把需要的能力放到本地可运行的入口。
- 本地关联项目只在配置了持久值目录时开放知识库，且与目标子运行共用同一个目录。
  迁移：显式传入 `--persistent-value-store-dir` 或设置 `WORKFLOW_PERSISTENT_VALUE_STORE_DIR`。

### 新增

- 新增 CLI 识别视频 output item，普通文本输出显示成片链接，JSON 输出保留结构化描述对象。
- 新增 `--videos` 读取默认对话的视频文件引用，并识别常用视频路径的 MIME。
- 新增 CLI 运行时支持带音频控件的 file 参数和音频文件引用。
- 新增 `workspace status` 输出 `effective`，说明实际使用的服务器、凭据来源和取值优先级。
- 新增 关联项目可读目标项目的知识库，按 `grantToRelatedProject` 的 `knowledge` 声明逐 key 授权。
- 新增 关联项目可调用目标项目授权的入口，参数即该入口 `createInput` 解析的命令行参数。
- 新增 `structure` 保留 Workflow entrypoint 的可选 `group` 展示元数据。

### 变更

- 变更 项目组 `workspace upload` 改为返回 `202` 与 `jobId` 并轮询部署状态，不再同步等待构建。
- 变更 依赖的 `workflow-code` 升到 dev 通道版本，系统 AI 的模型属性改由 Server 的模型目录提供。
- 变更 模型 effort 档位按模型声明的支持范围收敛，上下文用量分母取模型真实窗口。
- 变更 宿主传来的图片附件引用经工作流文件存储解析后再进入模型，读不出时明确失败。
- 变更 远程运行使用版本入队时固化的 Runner 制品和镜像 digest，不被后续上传覆盖。

### 修复

- 修复 经软链接调用时 CLI 不再空跑，比较 `process.argv[1]` 的原始形式与解析后的真实路径。
- 修复 关联项目的存储根与目标子运行现在指向同一个目录，不再一边写一边看不见。
- 修复 关联项目入口调用失败时抛出该入口自己的错误信息，不再被当成空结果。
- 修复 关联项目入口调用不再只对 `local` 目标可用，`server` 位置的入口照常读写服务端。
