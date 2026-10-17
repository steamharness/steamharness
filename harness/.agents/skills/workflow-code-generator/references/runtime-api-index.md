<!-- runtime-api-index:begin -->

# 运行时 API 索引（生成物）

由 `scripts/runtime-api-index.mjs` 依据 Core 源码生成，`pnpm test` 校验它与运行时一致。
**判断「运行时有没有某个能力」时先读这里**，不要去安装包的 `dist/*.d.ts` 或打包产物里翻：
那是某个历史版本的构建产物，不是契约，而且答案就在下面。这里没有列出的能力就是没有。

## 关联项目（`context.storage.<local|server>.relatedProjects.get(alias)`）

### 关联项目上下文（`WorkflowRelatedProjectStorageContext`）

- `kv`
- `knowledge`
- `listEntrypoints()`
- `runEntrypoint(entrypointId, args)`

### 关联项目知识库（`WorkflowRelatedProjectKnowledgeContext`）

- `listDocuments(input)`
- `getDocument(documentId)`
- `createDocument(input)`
- `editDocument(input)`
- `deleteDocument(documentId)`
- `searchDocuments(input)`
- `readDocumentLines(input)`

### 关联项目入口运行器（`WorkflowRelatedProjectRunner`）

- `listEntrypoints()`
- `run(entrypointId, args)`

关联项目只到这里为止：**会话 KV、目标项目的其它持久值、目标项目的其它入口都不在列表里**，
就是没有开放；关系只走一跳（被调起来的项目自己不能再访问关联项目）。
授权由目标项目在 `grantToRelatedProject` 的 `read` / `write` / `knowledge` / `entrypoints` 里声明。

## 运行时成员（`workflow.*`）

项目源码里能调用的运行时成员，除此之外的 `workflow.*` 都不存在：

- `workflow.createAgent(...)`
- `workflow.createAgentRegistry(...)`
- `workflow.defineAgentTask(...)`
- `workflow.defineAgentExtension(...)`
- `workflow.defineAgentDoc(...)`
- `workflow.agentHook(...)`
- `workflow.AgentToolTask(...)`
- `workflow.AgentGenerationTask(...)`
- `workflow.createAgentConversationWorkflow(...)`
- `workflow.createAgentNode(...)`
- `workflow.createAgentProjectInput(...)`
- `workflow.createAgentProjectParamResolver(...)`
- `workflow.createAgentProjectParams(...)`
- `workflow.defineAgentConversationExecutor(...)`
- `workflow.connectMcpServer(...)`
- `workflow.createFileInputNode(...)`
- `workflow.addOutputItem(...)`
- `workflow.createDetailsOutputNode(...)`
- `workflow.createKnowledgeDocument(...)`
- `workflow.createInputNode(...)`
- `workflow.createLLMNode(...)`
- `workflow.createLLMProviderFromEnv(...)`
- `workflow.createLLMProviderRef(...)`
- `workflow.createLLMStreamNode(...)`
- `workflow.createMcpTools(...)`
- `workflow.createMcpToolCatalog(...)`
- `workflow.createOutputItem(...)`
- `workflow.createOutputItemChunk(...)`
- `workflow.createOutputNode(...)`
- `workflow.createOutputPayload(...)`
- `workflow.createQuestionClassifierNode(...)`
- `workflow.createSkillTools(...)`
- `workflow.createUserInputNode(...)`
- `workflow.createTimerNode(...)`
- `workflow.createToolApprovalGate(...)`
- `workflow.createWorkflowCapabilityServer(...)`
- `workflow.createWorkflowCapabilityTools(...)`
- `workflow.deleteKnowledgeDocument(...)`
- `workflow.defineEntrypoint(...)`
- `workflow.defineExecutor(...)`
- `workflow.defineWorkflow(...)`
- `workflow.editKnowledgeDocument(...)`
- `workflow.endTimer(...)`
- `workflow.getEnv(...)`
- `workflow.getKnowledgeDocument(...)`
- `workflow.getRuntimeLocale(...)`
- `workflow.getRuntimePlatform(...)`
- `workflow.getLLMProvider(...)`
- `workflow.getServerLLMCredentials(...)`
- `workflow.isCli(...)`
- `workflow.isDesktop(...)`
- `workflow.isWorkflowCapabilityAvailable(...)`
- `workflow.parseConversationDefaultInputArgs(...)`
- `workflow.readOpenAIConversationHostInput(...)`
- `workflow.runFor(...)`
- `workflow.runIf(...)`
- `workflow.runNode(...)`
- `workflow.runSkillAction(...)`
- `workflow.runWorkflowCapabilityAction(...)`
- `workflow.listKnowledgeDocuments(...)`
- `workflow.listWorkflowCapabilityToolIds(...)`
- `workflow.normalizeMcpServers(...)`
- `workflow.readKnowledgeDocumentLines(...)`
- `workflow.runStreamNode(...)`
- `workflow.runWhile(...)`
- `workflow.runWorkflow(...)`
- `workflow.searchKnowledgeDocuments(...)`
- `workflow.WorkflowError(...)`

每个成员的契约（参数、返回值、错误码）在 `references/workflow-code-api.md` 里按小节说明。

<!-- runtime-api-index:end -->
