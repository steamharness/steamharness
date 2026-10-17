export function durableTraceState() {
  const context = { conversationId: 1, foreground: true, backgroundCount: 1, epoch: 2,
    configuration: { version: 3, provider: 'fixture', model: 'test-model', effort: 'high' }, prompt: { hash: 'sha256:fixture', version: 4 },
    plan: { version: 5, items: [{ id: 'read', text: 'Read the project', status: 'in_progress' }, { id: 'verify', text: 'Verify the implementation', status: 'pending' }] } };
  const task = { id: 10, conversationId: 1, kind: 'tool', label: 'Inspect workspace', toolName: 'read', status: 'running', background: false, stopping: false, blockedOn: [],
    arguments: { path: 'README.md' }, replay: 'safe', attempt: 2, definitionVersion: 3, checkpoint: { step: 'read' }, script: 'await tools.read({ path: "README.md" })', wakeAt: 1800000000000 };
  const agent = { ...context, version: 1, ownerId: 'owner-instance', revision: 1,
    contexts: [context, { ...context, conversationId: 2, epoch: 7, foreground: false, plan: { version: 8, items: [{ id: 'child', text: 'Child plan', status: 'pending' }] } }, { ...context, conversationId: 3, foreground: false }],
    conversations: [{ id: 1, title: 'Main', background: false }, { id: 2, parentId: 1, title: 'Read-only subagent', background: true }, { id: 3, parentId: 1, forkEntryId: 20, title: 'Independent fork', background: false }],
    tasks: [task, { ...task, id: 11, parentId: 10, label: 'Nested tool', conversationId: 2, background: true, blockedOn: [10], blockedReason: 'missing_task' }],
    history: Array.from({ length: 65 }, (_, index) => ({ ...task, id: 100 + index, label: `Completed tool ${index}`, status: index === 64 ? 'failed' : 'completed', stopping: true, details: index === 64 ? { error: 'Fixture failure' } : { result: 'File contents' } })),
    turns: [], receipts: [], records: [{ id: 30, conversationId: 1, kind: 'workflow.reset', label: 'workflow.reset', data: { handoff: 'Preserve the notes' } },
      { id: 31, conversationId: 2, kind: 'workflow.plan', label: 'workflow.plan', data: { child: true } }],
    usage: [{ conversationId: 1, models: { 'fixture/test-model': { totalTokens: 3755, input: 3642, output: 113, cost: { total: .001 } } }, tools: { read: { totalTokens: 12, cost: { total: 0 } } } },
      { conversationId: 2, parentId: 1, models: { 'fixture/child': { totalTokens: 100, cost: { total: .0001 } } }, tools: {} }],
    resources: { storage: 'sqlite', codeMode: true, environment: { id: 'local', label: 'Workspace', state: 'ready', remote: false },
      extensions: [{ name: 'Fixture extension', tools: ['read'], tasks: [{ name: 'timer', version: 2 }] }],
      catalogs: [{ id: 'studio-control', state: 'ready', tools: ['workspace_info', 'diagnostics'], loaded: ['workspace_info'] }] } };
  return { type: 'trace-state', generation: 1, reveal: 0, projects: [{ uri: 'file:///fixture', name: 'Fixture Assistant', projectType: 'conversation' }], selection: { projectUri: 'file:///fixture' },
    snapshot: { project: { id: 'fixture', name: 'Fixture Assistant', projectType: 'conversation' }, durable: true, running: true, activeId: 'main', agents: { main: agent }, sessions: [
      { id: 'main', title: 'Main', messages: [{ role: 'user', content: 'Prepare a plan', createdAt: 1000 }, { id: 'reply', role: 'assistant', content: '', status: 'running', createdAt: 1100,
        items: [{ id: 'plan', content: '## Implementation plan\n\n1. Read the project.\n2. Verify the changes.', contentType: 'markdown' }],
        pendingInput: { requestId: 'approval', nodeName: 'agent', title: 'Plan ready', params: [], metadata: { type: 'agent-plan-approval' } } }] },
      { id: 'child', title: 'Child', agentOwnerId: 'main', agentConversationId: 2, messages: [] },
      { id: 'fork', title: 'Fork', agentOwnerId: 'main', agentConversationId: 3, forkSource: { sessionId: 'main', entryId: 20 }, messages: [] },
    ] }, status: 'connected', pending: false };
}
