import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as ai from '@earendil-works/pi-ai';
import { DurableAgent } from '../agent/durable-agent';
import type { AgentSessionSnapshot, AgentSessionOptions } from '../agent/session-types';

function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Delegation state did not settle.'); await new Promise(done => setTimeout(done, 10)); }
}

for (const named of [false, true]) test(`${named ? 'named' : 'anonymous'} delegation retains its child link while live, settled and reopened`, { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'subagent-projection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'session.sqlite');
  const options: AgentSessionOptions = { compaction: { enabled: false }, subagents: { tools: ['wait'], maxAgents: 1,
    ...(named ? { definitions: [{ id: 'researcher', description: 'Research', systemPrompt: 'Research', tools: ['wait'], maxConcurrency: 1 }] } : {}) } };
  function create() {
    const faux = ai.fauxProvider({ models: [{ id: 'test', contextWindow: 100000, maxTokens: 100 }] });
    const models = ai.createModels(); models.setProvider(faux.provider); const lease = latch();
    const instance = new DurableAgent({ models, databasePath, session: options, sessionLease: lease.promise, initialState: {
      systemPrompt: 'Parent', model: models.getModel('faux', 'test')!, thinkingLevel: 'off', messages: [], tools: [],
    } });
    let snapshot: AgentSessionSnapshot | undefined;
    instance.subscribe(event => { const value = event as unknown as { type: string; snapshot: AgentSessionSnapshot }; if (value.type === 'project_session') snapshot = value.snapshot; });
    return { instance, faux, lease, snapshot: () => snapshot! };
  }
  const first = create(), held = latch(); let entered = false;
  first.instance.state.tools = [{ name: 'wait', label: 'Wait', description: 'Wait', replay: 'safe', parameters: ai.Type.Object({}),
    execute: async () => { entered = true; await held.promise; return { content: [ai.fauxText('Evidence ready')], details: {} }; } }];
  const reply = (request: ai.TranscriptContext) => {
    const child = request.messages.some(message => message.role === 'user' && message.content === 'Inspect one video');
    const answer = child ? request.messages.some(message => message.role === 'toolResult') ? ai.fauxAssistantMessage('Child evidence')
      : ai.fauxAssistantMessage([ai.fauxToolCall('wait', {})], { stopReason: 'toolUse' })
      : request.messages.some(message => message.role === 'toolResult') ? ai.fauxAssistantMessage('Coordinator ready')
      : ai.fauxAssistantMessage([ai.fauxToolCall('subagent', { task: 'Inspect one video', background: true,
        ...(named ? { action: 'spawn', agentId: 'researcher', workId: 'video-1' } : {}) })], { stopReason: 'toolUse' });
    return answer;
  };
  first.faux.setResponses(Array.from({ length: 10 }, () => reply));
  first.instance.requestId = 'parent'; const running = first.instance.prompt('Delegate');
  t.after(async () => { held.resolve(); first.lease.resolve(); await running; await first.instance.close(); });
  await until(() => entered && !!first.snapshot()?.tasks.some(task => task.kind === 'project.delegation' && task.childConversationId));
  const delegation = first.snapshot().tasks.find(task => task.kind === 'project.delegation')!;
  const childId = delegation.childConversationId!;
  assert.equal(typeof delegation.startedAt, 'number'); assert.equal(delegation.endedAt, undefined);
  assert.ok(delegation.usage!.totalTokens > 0);
  assert.equal(first.snapshot().conversations.find(conversation => conversation.id === childId)?.parentId, first.snapshot().conversationId);
  held.resolve(); await until(() => !!first.snapshot()?.history.some(task => task.id === delegation.id));
  assert.equal(first.snapshot().history.find(task => task.id === delegation.id)!.childConversationId, childId);
  await until(() => first.snapshot().tasks.length === 0);
  const settled = first.snapshot(), finished = settled.history.find(task => task.id === delegation.id)!;
  const total = settled.contexts.find(item => item.conversationId === settled.conversationId)!.tokenUsage!;
  const childUsage = settled.contexts.find(item => item.conversationId === childId)!.tokenUsage!;
  assert.deepEqual(finished.usage, childUsage); assert.ok(childUsage.totalTokens > delegation.usage!.totalTokens); assert.equal(childUsage.calls, 2);
  assert.equal(finished.startedAt, delegation.startedAt); assert.ok(finished.endedAt! >= finished.startedAt!);
  assert.equal(total.totalTokens, settled.turns.filter(turn => turn.conversationId === settled.conversationId).reduce((n, turn) => n + (turn.usage?.totalTokens ?? 0), 0) + childUsage.totalTokens);
  assert.ok(settled.capturedAt! >= finished.endedAt!);
  const fork = await first.instance.control({ type: 'fork', requestId: 'fork', entryId: settled.turns.find(turn => turn.conversationId === settled.conversationId)!.answerId! });
  assert.equal(first.snapshot().contexts.find(item => item.conversationId === fork.forkId)!.tokenUsage!.totalTokens, 0);
  await first.instance.control({ type: 'submit', requestId: 'fork-input', targetId: fork.forkId, prompt: 'Independent', mode: 'followUp' });
  await until(() => first.snapshot().turns.some(turn => turn.requestId === 'fork-input' && turn.status === 'done'));
  assert.ok(first.snapshot().contexts.find(item => item.conversationId === fork.forkId)!.tokenUsage!.totalTokens > 0);
  assert.deepEqual(first.snapshot().contexts.find(item => item.conversationId === settled.conversationId)!.tokenUsage, total);
  first.lease.resolve(); await running; await first.instance.close();
  const second = create(); second.instance.requestId = 'parent'; const reopened = second.instance.prompt('Delegate');
  t.after(async () => { second.lease.resolve(); await reopened; await second.instance.close(); });
  await until(() => !!second.snapshot()?.history.some(task => task.id === delegation.id));
  assert.equal(second.faux.state.callCount, 0);
  assert.equal(second.snapshot().history.find(task => task.id === delegation.id)!.childConversationId, childId);
  assert.deepEqual(second.snapshot().history.find(task => task.id === delegation.id), finished);
  assert.deepEqual(second.snapshot().contexts.find(item => item.conversationId === settled.conversationId)!.tokenUsage, total);
  await second.instance.control({ type: 'delete', requestId: 'delete-child', targetId: childId });
  assert.equal(second.snapshot().history.find(task => task.id === delegation.id)!.childConversationId, undefined);
  assert.deepEqual(second.snapshot().history.find(task => task.id === delegation.id)!.usage, childUsage);
  assert.deepEqual(second.snapshot().contexts.find(item => item.conversationId === settled.conversationId)!.tokenUsage, total);
  second.lease.resolve(); await reopened; await second.instance.close();
});
