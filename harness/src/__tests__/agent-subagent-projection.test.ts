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
    if (child) return request.messages.some(message => message.role === 'toolResult') ? ai.fauxAssistantMessage('Child evidence')
      : ai.fauxAssistantMessage([ai.fauxToolCall('wait', {})], { stopReason: 'toolUse' });
    return request.messages.some(message => message.role === 'toolResult') ? ai.fauxAssistantMessage('Coordinator ready')
      : ai.fauxAssistantMessage([ai.fauxToolCall('subagent', { task: 'Inspect one video', background: true,
        ...(named ? { action: 'spawn', agentId: 'researcher', workId: 'video-1' } : {}) })], { stopReason: 'toolUse' });
  };
  first.faux.setResponses(Array.from({ length: 10 }, () => reply));
  first.instance.requestId = 'parent'; const running = first.instance.prompt('Delegate');
  t.after(async () => { held.resolve(); first.lease.resolve(); await running; await first.instance.close(); });
  await until(() => entered && !!first.snapshot()?.tasks.some(task => task.kind === 'project.delegation' && task.childConversationId));
  const delegation = first.snapshot().tasks.find(task => task.kind === 'project.delegation')!;
  const childId = delegation.childConversationId!;
  assert.equal(first.snapshot().conversations.find(conversation => conversation.id === childId)?.parentId, first.snapshot().conversationId);
  held.resolve(); await until(() => !!first.snapshot()?.history.some(task => task.id === delegation.id));
  assert.equal(first.snapshot().history.find(task => task.id === delegation.id)!.childConversationId, childId);
  first.lease.resolve(); await running; await first.instance.close();
  const second = create(); second.instance.requestId = 'parent'; const reopened = second.instance.prompt('Delegate');
  t.after(async () => { second.lease.resolve(); await reopened; await second.instance.close(); });
  await until(() => !!second.snapshot()?.history.some(task => task.id === delegation.id));
  assert.equal(second.faux.state.callCount, 0);
  assert.equal(second.snapshot().history.find(task => task.id === delegation.id)!.childConversationId, childId);
  await second.instance.control({ type: 'delete', requestId: 'delete-child', targetId: childId });
  assert.equal(second.snapshot().history.find(task => task.id === delegation.id)!.childConversationId, undefined);
  second.lease.resolve(); await reopened; await second.instance.close();
});
