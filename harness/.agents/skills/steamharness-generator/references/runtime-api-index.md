<!-- runtime-api-index:begin -->

# 运行时 API 索引（生成物）

由 `scripts/runtime-api-index.mjs` 依据 Core 源码生成，`pnpm test` 校验它与运行时一致。
**判断「运行时有没有某个能力」时先读这里**，不要去安装包的 `dist/*.d.ts` 或打包产物里翻：
那是某个历史版本的构建产物，不是契约，而且答案就在下面。这里没有列出的能力就是没有。

## 聚合入口（`context.entries`）

### 聚合入口目录（`EntriesContext`）

- `caller`
- `conversations`
- `list()`
- `get(entryId)`

### Workflow 入口（`EntryContext`）

- `registration`
- `listEntrypoints()`
- `runEntrypoint(entrypointId, args, options)`

会话运行存储按账号、projectId + entryId + conversationId 隔离。跨入口调用保留用户身份、取消信号与工具权限，加载目标配置快照。

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
- `steamharness.submitAgentNotification(...)`
- `steamharness.readAgentWorkContext(...)`
- `steamharness.AgentWorkProgressDoc(...)`
- `steamharness.AgentSessionLifecycleDoc(...)`
- `steamharness.defineBot(...)`
- `steamharness.createAgentNode(...)`
- `steamharness.createAgentProjectInput(...)`
- `steamharness.createAgentProjectParamResolver(...)`
- `steamharness.createAgentProjectParams(...)`
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
