<!-- runtime-api-index:begin -->

# 运行时 API 索引（生成物）

由 `scripts/runtime-api-index.mjs` 依据 Core 源码生成，`pnpm test` 校验它与运行时一致。
**判断「运行时有没有某个能力」时先读这里**，不要去安装包的 `dist/*.d.ts` 或打包产物里翻：
那是某个历史版本的构建产物，不是契约，而且答案就在下面。这里没有列出的能力就是没有。

## 关联项目（`context.storage.<local|server>.relatedProjects.get(alias)`）

### 关联项目上下文（`RelatedProjectStorageContext`）

- `kv`
- `knowledge`
- `listEntrypoints()`
- `runEntrypoint(entrypointId, args)`

### 关联项目知识库（`RelatedProjectKnowledgeContext`）

- `listDocuments(input)`
- `getDocument(documentId)`
- `createDocument(input)`
- `editDocument(input)`
- `deleteDocument(documentId)`
- `searchDocuments(input)`
- `readDocumentLines(input)`

### 关联项目入口运行器（`RelatedProjectRunner`）

- `listEntrypoints()`
- `run(entrypointId, args)`

关联项目只到这里为止：**会话 KV、目标项目的其它持久值、目标项目的其它入口都不在列表里**，
就是没有开放；关系只走一跳（被调起来的项目自己不能再访问关联项目）。
授权由目标项目在 `grantToRelatedProject` 的 `read` / `write` / `knowledge` / `entrypoints` 里声明。

## 运行时成员（`steamharness.*`）

项目源码里能调用的运行时成员，除此之外的 `steamharness.*` 都不存在：

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
