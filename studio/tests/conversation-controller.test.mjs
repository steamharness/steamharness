import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { ConversationController } = await import('../extensions/studio-workstation/src/conversation-controller.ts');
const { resolvedProjectValues, redactProjectData, projectFormValue } = await import('../extensions/studio-workstation/src/workflow-types.ts');
const { conversationResourceCards } = await import('../extensions/studio-workstation/src/resource-cards.ts');
const project = { id: '5ee91340-71ed-4b74-ac97-f523eaa0c9a0', uri: 'file:///fixture', folderPath: '/fixture', name: 'Fixture', projectType: 'conversation', fields: [], entrypoints: [], conversation: { inputQueue: { enabled: true } } };
const input = (text) => ({ text, params: {}, attachments: [] });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(saved = {}, options = {}) {
  const calls = []; const writes = []; const cancelled = []; const logs = []; const removed = [];
  const runtime = {
    run: (request, event) => new Promise((resolve, reject) => calls.push({ request, event, resolve, reject })),
    cancel: (id) => { cancelled.push(id); calls.find((call) => call.request.runId === id)?.reject(new Error('Stopped')); },
    deleteConversation: async (_project, id) => { removed.push(id); },
  };
  const controller = new ConversationController(options.project ?? project, runtime, saved, {
    save: async (sessions, activeId) => { writes.push({ sessions, activeId }); if (options.failSave) { throw new Error('Storage unavailable'); } },
    changed: () => undefined, log: (message) => logs.push(message),
  });
  const finish = async (index, report = { status: 'success', output: { items: [{ id: 'reply', contentType: 'text', content: 'Done' }] } }) => { calls[index].resolve(report); await flush(); };
  return { controller, calls, writes, cancelled, logs, removed, finish };
}

test('New reuses an empty conversation and preserves drafts in independent conversations', async () => {
  const { controller } = fixture(); const first = controller.activeId;
  await controller.create(); await controller.create(); assert.equal(controller.activeId, first); assert.equal(controller.sessions.length, 1);
  await controller.updateDraft(first, 'Unsent draft', []); await controller.create();
  assert.notEqual(controller.activeId, first); assert.equal(controller.sessions.length, 2);
  await controller.select(first); assert.equal(controller.current.draft.text, 'Unsent draft');
});

test('New promotes a reused blank conversation and persists creation and activity times', async (t) => {
  let now = 2000; t.mock.method(Date, 'now', () => now);
  const blank = { id: 'blank', title: 'New', createdAt: 100, updatedAt: 100, messages: [], draft: { text: '', attachments: [] } };
  const history = { id: 'history', title: 'History', messages: [{ role: 'user', content: 'Earlier message', createdAt: 1000 }] };
  const f = fixture({ sessions: [blank, history], activeId: history.id });
  await f.controller.create();
  assert.equal(f.controller.activeId, blank.id); assert.deepEqual(f.controller.sessions.map((entry) => entry.id), ['history', 'blank']);
  assert.equal(f.controller.current.createdAt, 100); assert.equal(f.controller.current.updatedAt, 2000);
  now = 3000; await f.controller.updateDraft(blank.id, 'Unsent draft', []); await f.controller.create();
  assert.notEqual(f.controller.activeId, blank.id); assert.equal(f.controller.current.createdAt, 3000); assert.equal(f.controller.current.updatedAt, 3000);
  const restored = fixture(f.writes.at(-1)).controller;
  assert.equal(restored.activeId, f.controller.activeId); assert.equal(restored.current.createdAt, 3000); assert.equal(restored.current.updatedAt, 3000);
  assert.equal(restored.sessions.find((entry) => entry.id === blank.id).draft.text, 'Unsent draft');
});

test('legacy conversations derive stable times from history without promoting old empty sessions', async () => {
  const f = fixture({ sessions: [
    { id: 'history', title: 'History', messages: [{ role: 'user', content: 'Question', createdAt: 1000 }, { role: 'assistant', content: 'Answer', createdAt: 1500 }] },
    { id: 'blank', title: 'New', messages: [] },
  ], activeId: 'history' });
  assert.equal(f.controller.current.createdAt, 1000); assert.equal(f.controller.current.updatedAt, 1500);
  const blank = f.controller.sessions.find((entry) => entry.id === 'blank');
  assert.equal(blank.createdAt, 0); assert.equal(blank.updatedAt, 0);
  await f.controller.persist(); const restored = fixture(f.writes.at(-1)).controller;
  assert.equal(restored.current.updatedAt, 1500); assert.equal(restored.sessions.find((entry) => entry.id === 'blank').updatedAt, 0);
});

test('running conversations can be switched and run concurrently, cancellation stays scoped', async () => {
  const f = fixture(); const a = f.controller.activeId;
  await f.controller.send(input('A')); await flush();
  await f.controller.create(); const b = f.controller.activeId;
  await f.controller.send(input('B')); await flush();
  assert.equal(f.calls.length, 2); assert.equal(f.controller.sessions.filter((entry) => entry.activeRunId).length, 2);
  await f.controller.select(a); f.controller.stop(); await flush();
  assert.deepEqual(f.cancelled, [f.calls[0].request.runId]); assert.equal(f.controller.sessions.find((entry) => entry.id === b).messages.at(-1).status, 'running');
  await f.finish(1); await f.controller.idle(); assert.equal(f.controller.hasRuns, false);
});

test('queue keeps an edited entry until saved, supports reordering, and dispatches exactly once', async () => {
  const f = fixture(); await f.controller.send(input('First')); await flush();
  await f.controller.send(input('Second')); await f.controller.send(input('Third'));
  const [second, third] = f.controller.current.queuedInputs;
  await f.controller.reorderQueued([third.id, second.id]); await f.controller.editQueued(second.id);
  await f.finish(0); assert.equal(f.calls.length, 1);
  await f.controller.send(input('Edited second')); await flush(); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].request.args, ['--message', 'Third']);
  await f.finish(1); assert.equal(f.calls.length, 3); assert.deepEqual(f.calls[2].request.args, ['--message', 'Edited second']);
  await f.finish(2); await f.controller.idle(); assert.equal(f.controller.current.queuedInputs.length, 0);
});

test('promoting a queued input stops its own run and immediately dispatches the selected input', async () => {
  const f = fixture(); await f.controller.send(input('Running')); await flush();
  await f.controller.send(input('Later')); const queued = f.controller.current.queuedInputs[0];
  await f.controller.promoteQueued(queued.id); await flush();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].request.args, ['--message', 'Later']);
  await f.finish(1); await f.controller.idle();
});

test('durable approval resumes the same run with typed answers and releases its queued messages', async () => {
  const f = fixture(); await f.controller.send(input('Needs approval')); await flush();
  const pending = { requestId: 'approval', nodeName: 'tool-approval', title: 'Approve', params: [{ name: 'approved', type: 'boolean', required: true }] };
  await f.finish(0, { status: 'waiting_for_input', pendingUserInput: pending });
  await f.controller.send(input('Queued')); assert.equal(f.calls.length, 1);
  const answer = f.controller.current.messages.at(-1);
  await f.controller.resume(answer.id, pending.requestId, { approved: 'true' }); await flush();
  assert.equal(f.calls[1].request.runId, f.calls[0].request.runId);
  assert.equal(f.calls[1].request.resolvedInputs[0].values.approved, true);
  assert.equal(f.calls[1].request.resumeAfterRequestId, pending.requestId);
  await f.finish(1); assert.equal(f.calls.length, 3);
  await f.finish(2); await f.controller.idle();
});

test('titles honor locks, full history restores beyond former limits, and interrupted runs recover', async () => {
  const saved = { sessions: Array.from({ length: 25 }, (_, index) => ({ id: `session-${index}`, title: `Title ${index}`, messages: Array.from({ length: 250 }, () => ({ role: 'assistant', content: 'Saved', status: 'running' })) })), activeId: 'session-0' };
  const f = fixture(saved); assert.equal(f.controller.sessions.length, 25); assert.equal(f.controller.current.messages.length, 250);
  assert.equal(f.controller.current.messages[0].status, 'aborted');
  await f.controller.rename('session-0', 'Locked title'); await f.controller.send(input('New turn')); await flush();
  f.calls[0].event({ type: 'conversation_title_updated', title: 'Suggested title' }); assert.equal(f.controller.current.title, 'Locked title');
  await f.controller.lockTitle('session-0', false); f.calls[0].event({ type: 'conversation_title_updated', title: 'Suggested title' }); assert.equal(f.controller.current.title, 'Suggested title');
  await f.finish(0); await f.controller.idle();
});

test('deleting a running conversation never dispatches its queue and clears runtime storage', async () => {
  const f = fixture(); const id = f.controller.activeId; await f.controller.send(input('Running')); await flush(); await f.controller.send(input('Never dispatch'));
  await f.controller.remove(id); assert.equal(f.calls.length, 1); assert.deepEqual(f.removed, [id]); assert.equal(f.controller.sessions.length, 1); assert.notEqual(f.controller.activeId, id);
});

test('retry preserves the original auxiliary parameters, disabled states and attachments', async () => {
  const f = fixture({ }, { project: { ...project, fields: [{ name: 'subject', type: 'string', flag: '--subject', panel: 'auxiliary', required: true }] } });
  const file = { id: 'wf_file', name: 'photo.png', kind: 'image', mimeType: 'image/png', previewUrl: 'preview', storage: 'local' };
  await f.controller.send({ text: 'Original', params: { subject: 'A subject' }, attachments: [file] }); await flush(); await f.finish(0);
  await f.controller.retry(f.controller.current.messages.at(-1).id); await flush();
  assert.deepEqual(f.calls[1].request.args, f.calls[0].request.args); assert.equal(f.calls[1].request.args.join(' ').includes('preview'), false);
  await f.finish(1); await f.controller.idle();
});

test('Conversation always uses the standard message without an input setting', async () => {
  const f = fixture({}, { project: { ...project, conversation: undefined, fields: [{ name: 'topic', type: 'string', flag: '--topic', panel: 'auxiliary' }] } });
  await f.controller.send({ text: 'Standard message', params: { topic: 'Details' }, attachments: [] }); await flush();
  assert.deepEqual(f.calls[0].request.args, ['--topic', 'Details', '--message', 'Standard message']); await f.finish(0); await f.controller.idle();
});

test('Conversation auxiliary parameters cannot replace the standard message', async () => {
  const f = fixture({}, { project: { ...project, fields: [{ name: 'topic', type: 'string', flag: '--topic', panel: 'auxiliary' }] } });
  await f.controller.send({ text: '  ', params: { topic: 'Details' }, attachments: [] }); await f.controller.idle();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.controller.current.messages, []);
});

test('storage failures fail before executing and leave no background rejection', async () => {
  const f = fixture({}, { failSave: true }); await assert.rejects(f.controller.send(input('Do not run')), /Storage/); await f.controller.idle(); await flush();
  assert.equal(f.calls.length, 0); assert.equal(f.controller.hasRuns, false); assert.equal(f.controller.current.messages.at(-1).status, 'failed'); assert.ok(f.logs.length > 0);
});

test('resolved input types match Core and diagnostic redaction preserves legitimate resolver patches', () => {
  assert.deepEqual(resolvedProjectValues([{ name: 'approved', type: 'boolean' }, { name: 'count', type: 'number' }, { name: 'data', type: 'string', format: 'json' }], { approved: 'true', count: '1.5', data: '{"answer":42}' }), { approved: true, count: 1.5, data: { answer: 42 } });
  const data = { apiKey: 'sensitive', params: { secretChoice: { value: 'allowed' } }, message: 'token-value' };
  assert.deepEqual(redactProjectData(data, ['token-value'], false), { ...data, message: '[redacted]' });
  assert.equal(redactProjectData(data).apiKey, '[redacted]');
});

test('business timers merge live events with final reports and stop on cancellation', async () => {
  const f = fixture(); await f.controller.send(input('Timing')); await flush();
  const timer = { timerId: 'phase', title: 'Phase', status: 'running', startedAt: new Date().toISOString() };
  f.calls[0].event({ type: 'timer_started', timer });
  assert.equal(f.controller.current.messages.at(-1).timers[0].status, 'running');
  f.calls[0].event({ type: 'timer_finished', timer: { ...timer, status: 'success', durationMs: 40 } });
  await f.finish(0, { status: 'success', timers: [{ ...timer, status: 'success', durationMs: 45 }] });
  assert.equal(f.controller.current.messages.at(-1).timers[0].durationMs, 45);
  await f.controller.send(input('Cancelled timer')); await flush(); f.calls[1].event({ type: 'timer_started', timer });
  f.controller.stop(); await f.controller.idle();
  assert.equal(f.controller.current.messages.at(-1).timers[0].status, 'cleared');
  assert.ok(f.writes.at(-1).sessions[0].messages.at(-1).timers[0].endedAt);
});

test('resumed inputs preserve structured defaults and managed file references', async () => {
  const f = fixture(); await f.controller.send(input('Structured defaults')); await flush();
  const file = { id: 'wf_01234567890123456789012345678901', name: 'note.txt', kind: 'file', mimeType: 'text/plain', storage: 'local' };
  const pending = { requestId: 'structured', nodeName: 'input', title: 'Structured', params: [
    { name: 'files', type: 'file', multiple: true }, { name: 'data', type: 'string', format: 'json' },
    { name: 'tags', type: 'string', multiple: true },
  ], defaultValues: { files: [file], data: { answer: 42 }, tags: ['a', 'b'] } };
  assert.equal(projectFormValue(pending.params[0], pending.defaultValues.files), JSON.stringify([file]));
  await f.finish(0, { status: 'waiting_for_input', pendingUserInput: pending });
  await f.controller.resume(f.controller.current.messages.at(-1).id, pending.requestId, {}); await flush();
  assert.deepEqual(f.calls[1].request.resolvedInputs[0].values, pending.defaultValues);
  await f.finish(1); await f.controller.idle();
});

test('failed input submissions restore the prompt and never persist an unconfirmed answer', async () => {
  const f = fixture(); await f.controller.send(input('Needs input')); await flush();
  const pending = { requestId: 'retry-input', nodeName: 'input', title: 'Input', params: [{ name: 'notes', type: 'string', required: true }] };
  await f.finish(0, { status: 'waiting_for_input', pendingUserInput: pending });
  const answer = f.controller.current.messages.at(-1);
  await f.controller.resume(answer.id, pending.requestId, { notes: 'Keep my answer' }); await flush();
  assert.equal(answer.submittingInput.values.notes, 'Keep my answer');
  assert.equal(f.writes.at(-1).sessions[0].messages.at(-1).submittingInput, undefined);
  f.calls[1].reject(new Error('Temporary transport failure')); await f.controller.idle();
  assert.equal(answer.pendingInput.requestId, pending.requestId); assert.equal(answer.status, 'waiting_for_input');
  assert.equal(answer.resolvedInputs, undefined); assert.equal(answer.submittingInput, undefined);
  await f.controller.resume(answer.id, pending.requestId, { notes: 'Keep my answer' }); await flush();
  f.calls[2].event({ type: 'user_input_resolved', requestId: pending.requestId, nodeName: pending.nodeName, values: { notes: 'Keep my answer' }, submittedAt: new Date().toISOString(), request: pending });
  assert.equal(answer.resolvedInputs.length, 1);
  await f.finish(2); await f.controller.idle();
});

test('confirmed answers keep their output boundary when Core reports are rehydrated', async () => {
  const f = fixture(); await f.controller.send(input('A plan')); await flush();
  f.calls[0].event({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'before', content: 'Before the question', contentType: 'markdown' } } });
  const pending = { requestId: 'boundary', nodeName: 'input', title: 'Input', params: [{ name: 'answer', type: 'string' }] };
  await f.finish(0, { status: 'waiting_for_input', pendingUserInput: pending });
  const answer = f.controller.current.messages.at(-1); await f.controller.resume(answer.id, pending.requestId, { answer: 'My choice' }); await flush();
  const resolved = { requestId: pending.requestId, nodeName: pending.nodeName, values: { answer: 'My choice' }, submittedAt: new Date().toISOString(), request: pending };
  f.calls[1].event({ type: 'user_input_resolved', ...resolved });
  await f.finish(1, { status: 'success', resolvedUserInputs: [resolved], output: { items: [{ id: 'before', content: 'Before the question' }, { id: 'after', content: 'After the question' }] } });
  assert.deepEqual(answer.resolvedInputs[0].precedingOutputItemIds, ['before']); assert.equal(answer.resolvedInputs.length, 1);
  await f.controller.idle();
});

test('resource cards share Core presentation/removal semantics and reject unsafe paths and URLs', () => {
  const item = (content) => ({ id: 'tool', metadata: { kind: 'agent-part', partType: 'tool' }, content: { status: 'success', tool: 'workflow-ui_present_card', input: content } });
  const upsert = item({ action: 'upsert', cardId: 'knowledge', kind: 'knowledge', title: 'Notes', target: { source: 'current', documentId: 'doc' } });
  assert.deepEqual(conversationResourceCards([upsert], project.id, 'session')[0].target, { source: 'local', documentId: 'doc', projectId: project.id });
  const map = item({ action: 'upsert', cardId: 'map', kind: 'kanban', target: { source: 'current', projectId: 'workspace', entryId: 'map-2d', configurationId: 'official' } });
  assert.deepEqual(conversationResourceCards([map], project.id, 'session')[0].target,
    { source: 'local', projectId: 'workspace', entryId: 'map-2d', configurationId: 'official' });
  assert.deepEqual(conversationResourceCards([upsert, item({ action: 'remove', cardId: 'knowledge' })], project.id, 'session'), []);
  for (const target of [{ kind: 'browser', target: { url: 'command:workbench.action' } }, { kind: 'file', target: { filePath: '../secret' } }]) {
    assert.deepEqual(conversationResourceCards([item({ action: 'upsert', cardId: 'unsafe', ...target })], project.id, 'session'), []);
  }
});
