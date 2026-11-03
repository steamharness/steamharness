<!-- runtime-api-index:begin -->

# 运行时 API 索引（生成物）

由 `scripts/runtime-api-index.mjs` 依据 Core 源码生成，`pnpm test` 校验它与运行时一致。
**判断「运行时有没有某个能力」时先读这里**，不要去安装包的 `dist/*.d.ts` 或打包产物里翻：
那是某个历史版本的构建产物，不是契约，而且答案就在下面。这里没有列出的能力就是没有。

## 聚合入口与数据库（`context.entries` / `context.databases` / `context.knowledgeBases`）

### 聚合入口目录（`EntriesContext`）

- `list()`
- `get(entryId)`

### Workflow 入口（`EntryContext`）

- `registration`
- `listEntrypoints()`
- `runEntrypoint(entrypointId, args, options)`

### 关系型数据库连接（`RelationalDatabasesContext`）

- `connect(descriptor)`

### 知识库目录（`KnowledgeBasesContext`）

- `list()`
- `get(alias)`

### 知识库与附件（`KnowledgeBaseContext`）

- `listDocuments(input)`
- `getDocument(id)`
- `createDocument(input)`
- `editDocument(input)`
- `deleteDocument(id, expectedRevision)`
- `searchDocuments(input)`
- `readDocumentLines(input)`
- `getRevision()`
- `files`

数据库在 steamharness.database.ts 与 steamharness.schema 中定义，入口 databases 声明别名，context.databases.connect(descriptor) 连接生成客户端。databaseId 绑定由 Server 按账号、projectId、entryId、alias 管理，绑定不授予权限。每次操作重新校验授权。
会话运行存储按账号、projectId + entryId + conversationId 隔离，与业务关系表独立。跨入口调用保留用户身份、取消信号与工具权限，加载目标配置快照。

## 运行时成员（`steamharness.*`）

项目源码里能调用的运行时成员，除此之外的 `steamharness.*` 都不存在：

- `steamharness.getUserSettings(...)`
- `steamharness.createAgent(...)`
- `steamharness.createAgentRegistry(...)`
- `steamharness.defineAgentTask(...)`
- `steamharness.defineAgentExtension(...)`
- `steamharness.defineAgentDoc(...)`
- `steamharness.agentHook(...)`
- `steamharness.AgentToolTask(...)`
- `steamharness.AgentGenerationTask(...)`
- `steamharness.enqueueAgentWork(...)`
- `steamharness.enqueueAgentWorks(...)`
- `steamharness.readAgentWorkContext(...)`
- `steamharness.AgentWorkProgressDoc(...)`
- `steamharness.AgentSessionLifecycleDoc(...)`
- `steamharness.createAgentConversationProject(...)`
- `steamharness.createAgentNode(...)`
- `steamharness.createAgentProjectInput(...)`
- `steamharness.createAgentProjectParamResolver(...)`
- `steamharness.createAgentProjectParams(...)`
- `steamharness.defineAgentConversationExecutor(...)`
- `steamharness.connectMcpServer(...)`
- `steamharness.createFileInputNode(...)`
- `steamharness.addOutputItem(...)`
- `steamharness.createDetailsOutputNode(...)`
- `steamharness.createInputNode(...)`
- `steamharness.createLLMNode(...)`
- `steamharness.createLLMProviderFromConfig(...)`
- `steamharness.createLLMProviderRef(...)`
- `steamharness.createLLMStreamNode(...)`
- `steamharness.createMcpTools(...)`
- `steamharness.createMcpToolCatalog(...)`
- `steamharness.createOutputItem(...)`
- `steamharness.createOutputItemChunk(...)`
- `steamharness.createOutputNode(...)`
- `steamharness.createOutputPayload(...)`
- `steamharness.createQuestionClassifierNode(...)`
- `steamharness.createSkillTools(...)`
- `steamharness.createUserInputNode(...)`
- `steamharness.createTimerNode(...)`
- `steamharness.createToolApprovalGate(...)`
- `steamharness.createProjectCapabilityServer(...)`
- `steamharness.createProjectCapabilityTools(...)`
- `steamharness.defineEntrypoint(...)`
- `steamharness.defineExecutor(...)`
- `steamharness.defineProject(...)`
- `steamharness.endTimer(...)`
- `steamharness.getConfig(...)`
- `steamharness.getProjectConfiguration(...)`
- `steamharness.getRuntimeLocale(...)`
- `steamharness.getRuntimePlatform(...)`
- `steamharness.getLLMProvider(...)`
- `steamharness.getServerLLMCredentials(...)`
- `steamharness.isCli(...)`
- `steamharness.isDesktop(...)`
- `steamharness.isProjectCapabilityAvailable(...)`
- `steamharness.parseConversationDefaultInputArgs(...)`
- `steamharness.readOpenAIConversationHostInput(...)`
- `steamharness.runFor(...)`
- `steamharness.runIf(...)`
- `steamharness.runNode(...)`
- `steamharness.runSkillAction(...)`
- `steamharness.runProjectCapabilityAction(...)`
- `steamharness.listProjectCapabilityToolIds(...)`
- `steamharness.normalizeMcpServers(...)`
- `steamharness.runStreamNode(...)`
- `steamharness.runWhile(...)`
- `steamharness.runProject(...)`
- `steamharness.HarnessError(...)`

每个成员的契约（参数、返回值、错误码）在 `references/steamharness-api.md` 里按小节说明。

<!-- runtime-api-index:end -->

`UserSettingParamBinding` is the public parameter binding type (`key: "agent.permissionPolicy"`, `mode?: "default" | "fixed"`); it is metadata, not a runtime function.
