<!-- runtime-api-index:begin -->

# 运行时 API 索引（生成物）

由 `scripts/runtime-api-index.mjs` 依据 Core 源码生成，`pnpm test` 校验它与运行时一致。
**判断「运行时有没有某个能力」时先读这里**，不要去安装包的 `dist/*.d.ts` 或打包产物里翻：
那是某个历史版本的构建产物，不是契约，而且答案就在下面。这里没有列出的能力就是没有。

## 聚合入口与数据库（`context.entries` / `context.databases`）

### 聚合入口目录（`EntriesContext`）

- `list()`
- `get(entryId)`

### Workflow 入口（`EntryContext`）

- `registration`
- `listEntrypoints()`
- `runEntrypoint(entrypointId, args)`

### 数据库目录（`DatabasesContext`）

- `list()`
- `get(alias)`

### 独立数据库空间（`DatabaseContext`）

- `listValues(input)`
- `kv`
- `knowledge`
- `getBinding()`
- `getRevision()`
- `subscribe(listener, options)`
- `transaction(operation)`

### 知识库与附件（`DatabaseKnowledgeContext`）

- `listDocuments(input)`
- `getDocument(documentId)`
- `createDocument(input)`
- `editDocument(input)`
- `deleteDocument(documentId)`
- `searchDocuments(input)`
- `files`
- `readDocumentLines(input)`

数据库按入口内 alias 访问，清单只记录 alias 与已获批的 databaseId；支持多库和跨入口共享，权限由宿主维护。每次访问重新校验授权。
会话 KV 按 projectId + entryId + conversationId 隔离。跨入口调用保留用户身份、取消信号与工具权限，加载目标配置快照。

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
- `steamharness.createKnowledgeDocument(...)`
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
- `steamharness.deleteKnowledgeDocument(...)`
- `steamharness.defineEntrypoint(...)`
- `steamharness.defineExecutor(...)`
- `steamharness.defineProject(...)`
- `steamharness.editKnowledgeDocument(...)`
- `steamharness.endTimer(...)`
- `steamharness.getConfig(...)`
- `steamharness.getProjectConfiguration(...)`
- `steamharness.getKnowledgeDocument(...)`
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
- `steamharness.listKnowledgeDocuments(...)`
- `steamharness.listProjectCapabilityToolIds(...)`
- `steamharness.normalizeMcpServers(...)`
- `steamharness.readKnowledgeDocumentLines(...)`
- `steamharness.runStreamNode(...)`
- `steamharness.runWhile(...)`
- `steamharness.runProject(...)`
- `steamharness.searchKnowledgeDocuments(...)`
- `steamharness.HarnessError(...)`

每个成员的契约（参数、返回值、错误码）在 `references/steamharness-api.md` 里按小节说明。

<!-- runtime-api-index:end -->

`UserSettingParamBinding` is the public parameter binding type (`key: "agent.permissionPolicy"`, `mode?: "default" | "fixed"`); it is metadata, not a runtime function.
