import assert from 'node:assert/strict';
import test from 'node:test';
import * as ai from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTask, GenerationTask, hook, InboxDoc } from '@earendil-works/pi-durable';
import { DurableAgent } from '../agent/durable-agent';
import type { AgentSessionOptions, AgentSessionSnapshot } from '../agent/session-types';
import { testAgentStorage } from './runtime-test-storage';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Queue promotion did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function session(options: AgentSessionOptions = {}, storageKey?: string, resumeSession = false) {
  const faux = ai.fauxProvider({ models: [{ id: 'test', contextWindow: 100000, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const lease = latch();
  const instance = new DurableAgent({ models, sessionLease: lease.promise, retryDelayMs: 0, resumeSession,
    storage: storageKey ? testAgentStorage(storageKey) : undefined, session: { ...options, compaction: { enabled: false } },
    initialState: { systemPrompt: 'Queue test', model: models.getModel('faux', 'test')!, thinkingLevel: 'off', messages: [], tools: [] } });
  let snapshot: AgentSessionSnapshot | undefined;
  instance.subscribe(event => {
    const value = event as unknown as { type: string; snapshot: AgentSessionSnapshot };
    if (value.type === 'project_session') snapshot = value.snapshot;
  });
  return { instance, faux, lease, snapshot: () => snapshot };
}

for (const scenario of ['live owner', 'reopened receipt', 'queued reset', 'acknowledged before failure'] as const) {
  test(`an idle promotion starts the selected persisted input after failure (${scenario})`, async t => {
    const registry = createRegistry();
    const first = latch(), selected = latch(); let firstEntered = false, selectedEntered = false;
    const acknowledged = scenario === 'acknowledged before failure';
    if (acknowledged) registry.install(defineExtension({ name: 'test.first-request-gate', hooks: [hook(GenerationTask, {
      beforeRequest: async () => { if (!firstEntered) { firstEntered = true; await first.promise; } },
    })] }));
    const queuedReset = defineTask<null, { phase: 'enqueue' }, null>({ name: 'test.queued-reset', version: 1,
      initial: () => ({ phase: 'enqueue' }), phases: { enqueue: async (task, runtime, context) => {
        await runtime.commit(async tx => {
          const inbox = await tx.doc(InboxDoc, task.conversationId);
          const reset = await tx.createSubmission({ conversationId: task.conversationId, requestId: 'queued-reset', type: 'write', status: 'queued' });
          inbox.items.push({ id: reset.id, mode: 'write', entry: { kind: 'pi.reset', head: 'self', model: [{ role: 'user', content: 'Start fresh', timestamp: Date.now() }] } });
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }, context);
      } }, abort: async (_task, runtime, context) => {
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
      } });
    registry.install(defineExtension({ name: 'test.queue-control', tasks: [queuedReset] }));
    const storageKey = scenario === 'reopened receipt' ? `promote:${crypto.randomUUID()}` : undefined;
    const f = session({ registry }, storageKey);
    f.instance.state.tools = [
      { name: 'first_gate', label: 'First gate', description: 'Hold the first turn', replay: 'safe', parameters: ai.Type.Object({}),
        execute: async () => { firstEntered = true; await first.promise; return { content: [ai.fauxText('Ready')], details: {} }; } },
      { name: 'selected_gate', label: 'Selected gate', description: 'Hold the selected turn', replay: 'safe', parameters: ai.Type.Object({}),
        execute: async () => { selectedEntered = true; await selected.promise; return { content: [ai.fauxText('Ready')], details: {} }; } },
    ];
    let selectedContext = '';
    f.faux.setResponses([
      ...(!acknowledged ? [ai.fauxAssistantMessage([ai.fauxToolCall('first_gate', {})], { stopReason: 'toolUse' })] : []),
      ...Array.from({ length: 11 }, () => ai.fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'API error (503): Service temporarily unavailable' })),
      request => { selectedContext = JSON.stringify(request.messages); return ai.fauxAssistantMessage([ai.fauxToolCall('selected_gate', {})], { stopReason: 'toolUse' }); },
      ai.fauxAssistantMessage('Selected answer'), ai.fauxAssistantMessage('Older answer'),
    ]);
    f.instance.requestId = 'original';
    const running = f.instance.prompt('Original task');
    t.after(async () => { first.resolve(); selected.resolve(); f.lease.resolve(); await running; await f.instance.close(); });
    await until(() => firstEntered);
    await f.instance.control({ type: 'submit', requestId: 'older', prompt: 'Older queued input', mode: 'followUp' });
    const admitted = await f.instance.control({ type: 'submit', requestId: 'selected', prompt: 'Selected input', mode: 'followUp', images: [{ data: 'AA==', mimeType: 'image/png' }] });
    const command = { type: 'promote' as const, requestId: 'send-selected-now', inputId: 'selected' };
    const originalReceipt = acknowledged ? await f.instance.control(command) : undefined;
    first.resolve();
    await until(() => f.snapshot()?.turns.find(turn => turn.requestId === 'original')?.status === 'unanswered');
    assert.equal(f.snapshot()!.turns.find(turn => turn.requestId === 'selected')!.status, 'queued');
    if (scenario === 'queued reset') {
      const receipt = await f.instance.control({ type: 'task', name: 'test.queued-reset', input: null, requestId: 'add-reset' });
      await until(() => f.snapshot()?.history.some(task => task.id === receipt.taskId) === true);
    }
    const receipt = await f.instance.control(command);
    if (originalReceipt) assert.deepEqual(receipt, originalReceipt);
    assert.equal(receipt.submissionId, admitted.submissionId);
    await until(() => selectedEntered && f.snapshot()?.turns.find(turn => turn.requestId === 'selected')?.status === 'placed');
    assert.equal(f.snapshot()!.turns.find(turn => turn.requestId === 'older')!.status, 'queued');
    assert.equal(f.snapshot()!.turns.find(turn => turn.requestId === 'original')!.status, 'unanswered');
    assert.match(selectedContext, /Selected input/); assert.match(selectedContext, /AA==/);
    assert.doesNotMatch(selectedContext, /Older queued input/);
    if (scenario === 'queued reset') {
      assert.match(selectedContext, /Start fresh/); assert.doesNotMatch(selectedContext, /Original task/);
      assert.equal(f.snapshot()!.turns.find(turn => turn.requestId === 'selected')!.epoch, 1);
    }
    assert.deepEqual(await f.instance.control(command), receipt);
    assert.equal((await f.instance.control({ ...command, requestId: 'already-started' })).status, 'already_placed');
    selected.resolve();
    await until(() => f.snapshot()?.turns.find(turn => turn.requestId === 'older')?.status === 'done');
    const selectedTurn = f.snapshot()!.turns.find(turn => turn.requestId === 'selected')!;
    assert.equal(selectedTurn.status, 'done'); assert.equal(selectedTurn.mode, 'followUp');
    assert.ok(selectedTurn.entryId! < f.snapshot()!.turns.find(turn => turn.requestId === 'older')!.entryId!);
    assert.equal(f.snapshot()!.turns.filter(turn => turn.requestId === 'selected').length, 1);
    assert.doesNotMatch(JSON.stringify(f.snapshot()!.turns.find(turn => turn.requestId === 'original')!.items), /Selected answer|Older answer|selected_gate/);
    assert.equal((await f.instance.control({ ...command, requestId: 'already-finished' })).status, 'settled');
    assert.equal(f.faux.state.callCount, acknowledged ? 14 : 15);
    if (storageKey) {
      f.lease.resolve(); await running; await f.instance.close();
      const reopened = session({}, storageKey, true);
      reopened.instance.requestId = 'original';
      const resumed = reopened.instance.prompt('Do not repeat the bootstrap');
      t.after(async () => { reopened.lease.resolve(); await resumed; await reopened.instance.close(); });
      await until(() => !!reopened.snapshot());
      assert.deepEqual(await reopened.instance.control(command), receipt);
      assert.equal(reopened.faux.state.callCount, 0);
    }
  });
}
