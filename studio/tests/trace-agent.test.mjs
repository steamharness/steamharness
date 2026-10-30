const key = project => `${project.uri}#entry=${project.entryId}`;
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
import { durableTraceState } from './fixtures/trace-agent.mjs';
register();
const { agentSession, latestAgentPlan, ownedActivity, orderedTasks, terminalTask, taskConversation } = await import('../extensions/studio-workstation/webview/trace-agent-model.ts');
const { TraceStore } = await import('../extensions/studio-workstation/src/workflow-trace-store.ts');

test('task navigation resolves anonymous and named children in live or settled snapshots', () => {
  assert.equal(taskConversation({ conversationId: 1, childConversationId: 2 }), 2);
  assert.equal(taskConversation({ conversationId: 1, childConversationId: 2, agent: { childConversationId: 3 } }), 3);
  assert.equal(taskConversation({ conversationId: 1 }), 1);
});

test('Trace projects the selected child context while the current marker follows the actual editor', () => {
  const state = durableTraceState(); state.selection.sessionId = 'child';
  const { agent, current } = agentSession(state);
  assert.equal(agent.conversationId, 2); assert.equal(agent.epoch, 7); assert.equal(agent.plan.version, 8); assert.equal(current, 1);
  state.snapshot.activeId = 'fork'; assert.equal(agentSession(state).current, 3);
  state.snapshot.activeId = 'local-draft'; assert.equal(agentSession(state).current, undefined);
  state.status = 'closed'; assert.equal(agentSession(state).connected, false);
  state.status = 'connected'; state.pending = true; assert.equal(agentSession(state).connected, false);
});
test('completed history is terminal and nested task ordering tolerates absent parents and cycles', () => {
  const agent = durableTraceState().snapshot.agents.main;
  assert.ok(agent.history.every(terminalTask)); assert.equal(orderedTasks(agent.history, agent.history).length, 65);
  const nested = orderedTasks([...agent.tasks].reverse(), agent.tasks); assert.deepEqual(nested.map(({ task, depth }) => [task.id, depth]), [[10, 0], [11, 1]]);
  const cycle = agent.tasks.map((task, index) => ({ ...task, parentId: index ? 10 : 11 }));
  assert.equal(orderedTasks(cycle, cycle).length, 2); assert.ok(orderedTasks(cycle, cycle).every(entry => entry.depth <= 2));
});
test('stop-all availability includes owned descendants and queued input but excludes independent forks', () => {
  const agent = durableTraceState().snapshot.agents.main;
  agent.foreground = false; agent.tasks = [{ ...agent.tasks[0], conversationId: 3 }]; assert.equal(ownedActivity(agent), false);
  agent.turns = [{ conversationId: 3, status: 'queued' }]; assert.equal(ownedActivity(agent), false);
  agent.turns.push({ conversationId: 2, status: 'queued' }); assert.equal(ownedActivity(agent), true);
});
test('Trace retains original, revised and approved plan boundaries after execution and reopening', () => {
  const request = id => ({ requestId: id, nodeName: 'agent', title: 'Plan ready', params: [], metadata: { type: 'agent-plan-approval' } });
  const text = (id, content) => ({ id, content, contentType: 'markdown', metadata: { kind: 'agent-part', partType: 'text' } });
  const decision = (id, value, preceding) => ({ requestId: id, request: request(id), values: { decision: value }, precedingOutputItemIds: preceding });
  const message = { role: 'assistant', content: '', items: [text('seven', 'Seven-day plan')], pendingInput: request('first') };
  assert.deepEqual(latestAgentPlan([message]), { text: 'Seven-day plan', state: 'awaiting_approval' });
  message.submittingInput = decision('first', 'decline', ['seven']); assert.equal(latestAgentPlan([message]).state, 'submitting');
  message.submittingInput = undefined; message.resolvedInputs = [decision('first', 'decline', ['seven'])]; message.pendingInput = undefined;
  assert.equal(latestAgentPlan([message]).state, 'changes_requested');
  message.items.push(text('thirty', 'Thirty-day plan')); message.pendingInput = request('second');
  assert.deepEqual(latestAgentPlan([message]), { text: 'Thirty-day plan', state: 'awaiting_approval' });
  message.resolvedInputs.push(decision('second', 'approve', ['seven', 'thirty'])); message.pendingInput = undefined; message.items.push(text('built', 'Build finished'));
  assert.deepEqual(latestAgentPlan(JSON.parse(JSON.stringify([message, { role: 'assistant', items: [text('chat', 'You are welcome')] }]))), { text: 'Thirty-day plan', state: 'approved' });
  message.resolvedInputs[1].precedingOutputItemIds = ['thirty']; assert.equal(latestAgentPlan([message]).text, 'Thirty-day plan');
  assert.equal(latestAgentPlan([{ role: 'assistant', items: [text('chat', 'Normal answer')] }]), undefined);
  assert.deepEqual(latestAgentPlan([{ role: 'assistant', items: [{ content: 'Fork plan', metadata: { plan: true } }] }]), { text: 'Fork plan', state: 'ready' });
});
test('plan projection excludes preambles, questions, tools, reasoning, rings and boundary-less Build results', () => {
  const message = { role: 'assistant', items: [{ id: 'ask', content: 'Which file?' }, { id: 'before', content: 'Inspecting' },
    { id: 'tool', metadata: { partType: 'tool' }, content: { result: 'not plan' } },
    { id: 'reason', metadata: { partType: 'reasoning' }, collapsed: true, content: 'reasoning' },
    { id: 'actual', content: 'Read README' }, { id: 'usage', content: 'Usage', display: { type: 'ring' } }],
    resolvedInputs: [{ requestId: 'ask', request: { metadata: { type: 'agent-ask' } }, values: {}, precedingOutputItemIds: ['ask'] }],
    pendingInput: { requestId: 'plan', metadata: { type: 'agent-plan-approval' } } };
  assert.deepEqual(latestAgentPlan([message]), { text: 'Read README', state: 'awaiting_approval' });
  assert.equal(latestAgentPlan([{ role: 'assistant', items: [{ content: 'Build result' }], resolvedInputs: [{ requestId: 'old', request: { metadata: { type: 'agent-plan-approval' } }, values: { decision: 'approve' } }] }]), undefined);
});
test('Trace commands retain owner/session identity, scoped errors, pending state and stale-source protection', () => {
  const fixture = durableTraceState(), project = { ...fixture.snapshot.project, uri: fixture.selection.projectUri }, sent = [];
  const store = new TraceStore(); store.update([project]);
  const binding = store.bind(project, 1, message => sent.push(message));
  const receive = (kind, value) => binding.receive({ type: 'workflow-trace', version: 1, kind, ...value });
  receive('state', { snapshot: fixture.snapshot }); receive('status', { status: 'connected' });
  store.select(key(project), { sessionId: 'child' });
  const action = { type: 'agent', sessionId: 'child', ownerId: 'owner-instance', conversationId: 2, command: { type: 'compact' } };
  assert.equal(store.action({ ...action, sessionId: 'main' }), false); assert.equal(store.action({ ...action, ownerId: 'old' }), false);
  assert.equal(store.action(action), true); assert.equal(store.state().pending, true); assert.equal(store.action(action), false);
  const requestId = sent[0].traceCommand.requestId; assert.equal(sent[0].traceCommand.sessionId, 'child');
  receive('command', { requestId: 'stale', error: 'Ignored' }); assert.equal(store.state().pending, true);
  receive('command', { requestId, error: 'Plan conflict' }); assert.equal(store.state().pending, false); assert.equal(store.state().error, 'Plan conflict');
  store.select(key(project), { sessionId: 'main' }); assert.equal(store.state().error, undefined);
  store.select(key(project), { sessionId: 'child' }); assert.equal(store.action(action), true);
  receive('status', { status: 'offline' }); assert.equal(store.state().pending, false); assert.equal(store.action(action), false);
  binding.dispose(); assert.equal(store.state().snapshot.agents.main.history.length, 65);
  const next = store.bind(project, 1, () => {}); assert.equal(store.state().snapshot.agents.main.history.length, 65);
  receive('command', { requestId: sent.at(-1).traceCommand.requestId, error: 'old source' }); assert.equal(store.state().error, undefined);
  next.dispose();
});
test('a durable built-in assistant exposes Trace while explicit opens select the timeline', () => {
  const fixture = durableTraceState(), project = { ...fixture.snapshot.project, uri: fixture.selection.projectUri,
    manifest: { version: '1.2.3' }, assistant: { standalone: true } };
  const store = new TraceStore(); store.update([]); const binding = store.bind(project, 1, () => {});
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'state', snapshot: fixture.snapshot });
  assert.equal(store.availableProjects().length, 1); assert.equal(store.selection.projectUri, key(project));
  assert.equal(store.state().projects[0].projectType, project.projectType);
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'open', target: { sessionId: 'main', messageId: 'reply' } });
  assert.equal(store.state().reveal, 1); assert.equal(store.selection.messageId, 'reply'); binding.dispose();
});

test('named work opens its child and exposes retry only for failed or cancelled attempts', async () => {
  const { retryableAgentTask, taskConversation } = await import('../extensions/studio-workstation/webview/trace-agent-model.ts');
  const task = { id: 42, conversationId: 1, status: 'failed', agent: { childConversationId: 2 } };
  assert.equal(retryableAgentTask(task), true); assert.equal(taskConversation(task), 2);
  assert.equal(retryableAgentTask({ ...task, status: 'queued' }), false);
  assert.equal(retryableAgentTask({ ...task, status: 'completed' }), false);
  assert.equal(retryableAgentTask({ ...task, status: 'aborted' }), true);
  assert.equal(retryableAgentTask({ ...task, agent: undefined }), false);
  assert.equal(taskConversation({ ...task, agent: undefined }), 1);
});
