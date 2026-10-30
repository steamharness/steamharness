import { describe, expect, it, vi } from 'vitest';
import { ConversationController } from '../web/conversation-controller';
import { composerOutputItems } from '../web/ui/output-display';
import { messageSettled, type ConversationMessage, type ConversationSession, type InputRequest, type Project, type Report, type Runtime } from '../web/workflow-types';

function fixture(options: { canStart?(): boolean; canDrain?(): boolean } = {}) {
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/test',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'test', uri: '', folderPath: '/test', name: 'Conversation', projectType: 'conversation', fields: [], entrypoints: [] };
  const runtime: Runtime = {
    available: true, inspect: vi.fn(), resolveParams: vi.fn(), run: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
    uploadFiles: vi.fn(), readFile: vi.fn(), deleteFiles: vi.fn(), cancelConversation: vi.fn(async () => {}), deleteConversation: vi.fn(), readResource: vi.fn(),
  };
  const save = vi.fn(async (_sessions: ConversationSession[], _activeId: string) => {});
  const controller = new ConversationController(project, runtime, {}, {
    ...options,
    save: (sessions, activeId) => save(JSON.parse(JSON.stringify(sessions)), activeId), changed: vi.fn(), log: vi.fn(),
  });
  return { controller, runtime, save };
}

it.each(['removeQueued', 'promoteQueued'] as const)('resolves edited ordinary queue input by submission identity for %s', async action => {
  const { controller, runtime } = fixture();
  controller.project.conversation = { inputQueue: { enabled: true } };
  controller.current.queuePaused = true;
  controller.current.queuedInputs = [
    { id: 'first', text: 'Remain paused', params: {}, attachments: [], createdAt: 1 },
    { id: 'original', requestId: 'edited', text: 'Edited input', params: {}, attachments: [], createdAt: 2 },
  ];
  vi.mocked(runtime.run).mockResolvedValue({ status: 'failed' });
  await controller[action]('edited'); await controller.idle();
  expect(controller.current.queuedInputs?.map(input => input.id)).toEqual(['first']);
  if (action === 'promoteQueued') expect(controller.current.messages.at(-2)?.content).toBe('Edited input');
  else expect(runtime.run).not.toHaveBeenCalled();
  controller.dispose();
});

it('retains queued inputs while Server setup is required and waits for an explicit action to drain them', async () => {
  let available = true;
  const { controller, runtime } = fixture({ canStart: () => available });
  controller.project.conversation = { inputQueue: { enabled: true } };
  let complete!: (report: Report) => void;
  vi.mocked(runtime.run).mockImplementationOnce(async () => new Promise(resolve => { complete = resolve; }));
  await controller.send({ text: 'First', params: {}, attachments: [] });
  await controller.send({ text: 'Keep queued', params: {}, attachments: [] });
  available = false; complete({ status: 'success' }); await controller.idle();
  expect(controller.current.queuedInputs?.map(input => input.text)).toEqual(['Keep queued']);
  expect(runtime.run).toHaveBeenCalledOnce();
  await expect(controller.send({ text: 'Blocked', params: {}, attachments: [] })).rejects.toThrow('Check again');
  await controller.runQueued(); await controller.idle();
  expect(runtime.run).toHaveBeenCalledOnce();
  expect(controller.current.queuedInputs?.map(input => input.text)).toEqual(['Keep queued']);
  available = true;
  expect(runtime.run).toHaveBeenCalledOnce();
  vi.mocked(runtime.run).mockResolvedValue({ status: 'success' });
  await controller.runQueued(); await controller.idle();
  expect(runtime.run).toHaveBeenCalledTimes(2); expect(controller.current.queuedInputs).toEqual([]);
});

it.each(['runQueued', 'promoteQueued'] as const)('pauses automatic queued work after a Server failure while allowing explicit %s and local sends', async action => {
  let drain = true;
  const { controller, runtime } = fixture({ canDrain: () => drain });
  controller.project.conversation = { inputQueue: { enabled: true } };
  let complete!: (report: Report) => void;
  vi.mocked(runtime.run).mockImplementationOnce(async () => new Promise(resolve => { complete = resolve; }));
  await controller.send({ text: 'Server operation', params: {}, attachments: [] });
  await controller.send({ text: 'Keep queued', params: {}, attachments: [] });
  await controller.send({ text: 'Run deliberately', params: {}, attachments: [] });
  drain = false; complete({ status: 'failed' }); await controller.idle();
  expect(controller.current.queuedInputs?.map(input => input.text)).toEqual(['Keep queued', 'Run deliberately']);
  expect(runtime.run).toHaveBeenCalledOnce();
  drain = true; await Promise.resolve(); expect(runtime.run).toHaveBeenCalledOnce();
  drain = false; vi.mocked(runtime.run).mockResolvedValue({ status: 'success' });
  if (action === 'runQueued') await controller.runQueued();
  else await controller.promoteQueued(controller.current.queuedInputs![1].id);
  await controller.idle();
  expect(runtime.run).toHaveBeenCalledTimes(2);
  expect(controller.current.messages.at(-2)?.content).toBe(action === 'runQueued' ? 'Keep queued' : 'Run deliberately');
  const remaining = action === 'runQueued' ? 'Run deliberately' : 'Keep queued';
  expect(controller.current.queuedInputs?.map(input => input.text)).toEqual([remaining]);
  const serverSession = controller.current; await controller.create(true);
  await controller.send({ text: 'Explicit local operation', params: {}, attachments: [] }); await controller.idle();
  expect(runtime.run).toHaveBeenCalledTimes(3);
  expect(serverSession.queuedInputs?.map(input => input.text)).toEqual([remaining]);
});

describe('Conversation answer action visibility', () => {
  it.each(['sending', 'running', 'waiting_for_input'])('keeps actions hidden while the answer is %s', status => {
    expect(messageSettled({ role: 'assistant', content: 'Partial answer', status })).toBe(false);
  });

  it.each(['success', 'failed', 'aborted', 'timed_out', undefined])('allows actions for a finished answer with status %s', status => {
    expect(messageSettled({ role: 'assistant', content: 'Finished answer', status })).toBe(true);
  });

  it('waits for outstanding approval, submission and cancellation instead of exposing terminal actions early', () => {
    const answer: ConversationMessage = { role: 'assistant', content: 'Plan', status: 'success' };
    const request = { requestId: 'approval', nodeName: 'gate', title: 'Approve?', params: [] };
    expect(messageSettled({ ...answer, pendingInput: request })).toBe(false);
    expect(messageSettled({ ...answer, submittingInput: { ...request, values: {}, submittedAt: '2026-10-20T00:00:00Z' } })).toBe(false);
    expect(messageSettled({ ...answer, status: 'aborted', cancelRequested: true })).toBe(false);
    expect(messageSettled({ ...answer, status: 'failed', recovering: true })).toBe(true);
  });

  it('retains finished historical actions while the next answer runs and restores its actions after failure', async () => {
    const { controller, runtime } = fixture();
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success' });
    await controller.send({ text: 'First', params: {}, attachments: [] }); await controller.idle();
    const first = controller.current.messages.at(-1)!;
    let finish!: (report: Report) => void;
    vi.mocked(runtime.run).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await controller.send({ text: 'Second', params: {}, attachments: [] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const current = controller.current.messages.at(-1)!;
    expect(controller.running).toBe(true); expect(messageSettled(first)).toBe(true); expect(messageSettled(current)).toBe(false);
    finish({ status: 'failed' }); await controller.idle();
    expect(messageSettled(current)).toBe(true); controller.dispose();
  });
});

describe('Conversation execution lifecycle', () => {
  it('coalesces a busy history writer and confirms each batch only after its snapshot is saved', async () => {
    const { controller, save } = fixture();
    let finishFirst!: () => void, finishSecond!: () => void;
    save.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
    const first = controller.persist();
    const pending: Promise<void>[] = [];
    for (let index = 0; index < 100; ++index) {
      controller.current.title = `Update ${index}`;
      pending.push(controller.persist());
    }
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0][0].title).not.toBe('Update 99');
    let confirmed = false;
    void pending.at(-1)!.then(() => { confirmed = true; });
    finishFirst(); await first;
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0][0].title).toBe('Update 99');
    expect(confirmed).toBe(false);
    finishSecond(); await Promise.all(pending);
    expect(confirmed).toBe(true);
    save.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(controller.persist()).rejects.toThrow('Disk unavailable');
    await controller.persist();
    expect(save).toHaveBeenCalledTimes(4);
    controller.dispose();
  });
  it.each(['message-time', 'array-order'] as const)('restores legacy conversation selection using %s when session timestamps are missing', kind => {
    const { controller, runtime, save } = fixture();
    const sessions = ['first', 'latest', 'last'].map((id, index) => ({
      ...controller!.current, id, createdAt: undefined, updatedAt: undefined,
      messages: kind === 'message-time' ? [{ role: 'user' as const, content: id, createdAt: [10, 30, 20][index] }] : [],
    }));
    const restored = new ConversationController(controller.project, runtime, { sessions, activeId: 'first' }, { save, changed: vi.fn(), log: vi.fn() });
    expect(restored.activeId).toBe(kind === 'message-time' ? 'latest' : 'last');
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('restores a versioned selection even when another conversation has newer activity', () => {
    const { controller, runtime, save } = fixture();
    const sessions = ['selected', 'newer'].map((id, index) => ({ ...controller!.current, id, updatedAt: index + 1 }));
    const restored = new ConversationController(controller.project, runtime, { sessions, activeId: 'selected', selectionVersion: 1 }, { save, changed: vi.fn(), log: vi.fn() });
    expect(restored.activeId).toBe('selected');
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('edits a queued message using its explicit target and deduplicates retries before and after consumption', async () => {
    const { controller, runtime } = fixture();
    controller.project.conversation = { inputQueue: { enabled: true } };
    let finish!: (report: Report) => void;
    vi.mocked(runtime.run).mockImplementationOnce(() => new Promise(done => { finish = done; })).mockResolvedValue({ status: 'success' });
    await controller.send({ text: 'First', params: {}, attachments: [] });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
    await controller.send({ text: 'Queued', params: {}, attachments: [] });
    const queuedId = controller.current.queuedInputs![0].id;
    await controller.editQueued(queuedId);
    await controller.navigate(controller.activeId, [{ id: controller.activeId, draft: { text: 'Next draft', attachments: [] } }]);
    const input = { text: 'Edited queue', params: {}, attachments: [] };
    await controller.send(input, controller.current, true, 'edited-request', 'followUp', queuedId);
    expect(controller.current.queuedInputs).toMatchObject([{ id: queuedId, requestId: 'edited-request', text: 'Edited queue' }]);
    expect(controller.current.draft?.text).toBe('Next draft');
    await controller.send(input, controller.current, true, 'edited-request', 'followUp', queuedId);
    expect(controller.current.queuedInputs).toHaveLength(1);
    finish({ status: 'success' }); await controller.idle();
    expect(runtime.run).toHaveBeenCalledTimes(2);
    await controller.send(input, controller.current, true, 'edited-request', 'followUp', queuedId);
    expect(runtime.run).toHaveBeenCalledTimes(2);
    await expect(controller.send(input, controller.current, true, 'other-request', 'followUp', queuedId)).rejects.toThrow();
    controller.dispose();
  });

  it('recovers the original run and replaces its existing text snapshot', async () => {
    const { controller, runtime, save } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    const session = controller.current;
    session.messages.push({ id: 'answer', runId: 'run', role: 'assistant', status: 'running', content: 'Partial',
      args: ['--message', 'Hello'], items: [{ id: 'body', content: 'Partial', contentType: 'markdown' }] });
    vi.mocked(runtime.run).mockImplementationOnce(async (request, emit) => {
      expect(request.runId).toBe('run'); expect(request.args).toEqual(['--message', 'Hello']);
      expect(restored.current.messages.at(-1)?.content).toBe('Partial');
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'body', content: 'Complete', contentType: 'markdown' } } });
      return { status: 'success', output: { items: [{ id: 'body', content: 'Complete', contentType: 'markdown' }] } };
    });
    const restored = new ConversationController(controller.project, runtime, { sessions: [session] }, { save, changed: vi.fn(), log: vi.fn() });
    expect(restored.current.messages[0].recovering).toBe(true);
    restored.recover(); await restored.idle();
    expect(restored.current.messages).toHaveLength(1);
    expect(restored.current.messages[0]).toMatchObject({ content: 'Complete', status: 'success', recovering: false });
    expect(restored.current.messages[0].items).toHaveLength(1);
  });

  it('pauses recovery for Server setup and retries the original run only when explicitly requested', async () => {
    const { controller, runtime } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    const answer: ConversationMessage = { id: 'answer', runId: 'original-run', role: 'assistant', status: 'running', recovering: true, content: 'Partial', args: ['--message', 'Hello'] };
    controller.current.messages.push(answer);
    vi.mocked(runtime.run).mockRejectedValueOnce(Object.assign(new Error('Complete Server setup'), { code: 'PROJECT_SERVER_SETUP_REQUIRED' }));
    controller.recover(); await controller.idle();
    expect(answer).toMatchObject({ status: 'failed', recovering: true, runId: 'original-run', content: 'Partial' });
    expect(controller.current.messages).toHaveLength(1); expect(runtime.run).toHaveBeenCalledOnce();
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success' });
    await controller.retry('answer'); await controller.idle();
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'original-run', args: ['--message', 'Hello'] }), expect.any(Function));
    expect(controller.current.messages).toHaveLength(1); expect(answer.recovering).toBe(false);
    controller.dispose();
  });

  it('automatically retries an interrupted worker with the same input identity', async () => {
    const { controller, runtime } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    vi.mocked(runtime.run).mockRejectedValueOnce(Object.assign(new Error('Killed'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }))
      .mockResolvedValueOnce({ status: 'success' });
    await controller.send({ text: 'Hello', params: {}, attachments: [] }); await controller.idle();
    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runtime.run).mock.calls[1][0]).toEqual({...vi.mocked(runtime.run).mock.calls[0][0],resumeConfiguration:true});
    expect(controller.current.messages).toHaveLength(2);
    expect(controller.current.messages.at(-1)?.status).toBe('success');
  });

  it('persists an in-flight approval decision on shutdown and replays it after reopen', async () => {
    const { controller, runtime, save } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    const request = { requestId: 'approval', nodeName: 'gate', title: 'Approve?', params: [{ name: 'approved', type: 'boolean' as const }] };
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: request });
    await controller.send({ text: 'Hello', params: {}, attachments: [] }); await controller.idle();
    const answer = controller.current.messages.at(-1)!;
    let fail!: (error: Error) => void;
    vi.mocked(runtime.run).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await controller.resume(answer.id!, request.requestId, { approved: true });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(2));
    controller.dispose(); fail(Object.assign(new Error('Closed'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }));
    await controller.idle();
    const saved = save.mock.calls.at(-1)![0];
    expect(saved[0].messages.at(-1)).toMatchObject({ status: 'running', submittingInput: { requestId: 'approval', values: { approved: true } } });
    const restored = new ConversationController(controller.project, runtime, { sessions: saved }, { save, changed: vi.fn(), log: vi.fn() });
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success' });
    restored.recover(); await restored.idle();
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ runId: answer.runId,
      resumeAfterRequestId: 'approval', resolvedInputs: [expect.objectContaining({ requestId: 'approval', values: { approved: true } })] }), expect.any(Function));
  });

  it('persists cancellation before cancelling a parked task and never resumes it on restart', async () => {
    const { controller, runtime, save } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: { requestId: 'gate', nodeName: 'gate', title: 'Approve?', params: [] } });
    await controller.send({ text: 'Hello', params: {}, attachments: [] }); await controller.idle();
    vi.mocked(runtime.cancelConversation).mockImplementationOnce(async () => {
      expect(save.mock.calls.at(-1)![0][0].messages.at(-1)?.cancelRequested).toBe(true);
    });
    await controller.stop();
    expect(runtime.cancelConversation).toHaveBeenCalledWith(controller.project, controller.current.id);
    expect(controller.current.messages.at(-1)).toMatchObject({ status: 'aborted' });
    expect(controller.current.messages.at(-1)?.pendingInput).toBeUndefined();
    const restored = new ConversationController(controller.project, runtime, { sessions: save.mock.calls.at(-1)![0] }, { save, changed: vi.fn(), log: vi.fn() });
    restored.recover(); await restored.idle();
    expect(runtime.run).toHaveBeenCalledOnce();
  });

  it('bounds worker recovery and retries the same unfinished run on the existing retry action', async () => {
    const { controller, runtime } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    vi.mocked(runtime.run).mockRejectedValue(Object.assign(new Error('Killed'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }));
    await controller.send({ text: 'Hello', params: {}, attachments: [] }); await controller.idle();
    const answer = controller.current.messages.at(-1)!;
    expect(runtime.run).toHaveBeenCalledTimes(4); expect(answer.status).toBe('failed');
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success' });
    await controller.retry(answer.id!); await controller.idle();
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ runId: answer.runId }), expect.any(Function));
    expect(controller.current.messages).toHaveLength(2); expect(answer.status).toBe('success');
  });

  it('releases a finished task even when saving its terminal state fails', async () => {
    const { controller, runtime, save } = fixture();
    let finish!: (report: Report) => void;
    vi.mocked(runtime.run).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await controller.send({ text: 'Hello', params: {}, attachments: [] });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
    save.mockRejectedValueOnce(new Error('Disk unavailable'));
    finish({ status: 'success' });
    await vi.waitFor(() => expect(controller.hasRuns).toBe(false));
    await controller.idle();
  });

  it('stops and joins the worker even when saving the cancellation intent fails', async () => {
    const { controller, runtime, save } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    let fail!: (error: Error) => void;
    vi.mocked(runtime.run).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    vi.mocked(runtime.cancel).mockImplementationOnce(() => { fail(new Error('Stopped')); });
    await controller.send({ text: 'Hello', params: {}, attachments: [] });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
    save.mockRejectedValueOnce(new Error('Disk unavailable'));
    try {
      await expect(controller.stop()).rejects.toThrow('Disk unavailable');
      expect(runtime.cancel).toHaveBeenCalledOnce();
      expect(controller.hasRuns).toBe(false);
      expect(controller.current.messages.at(-1)?.status).toBe('aborted');
    } finally { fail(new Error('Stopped')); }
  });

  it('cancels parked work when its cancellation save fails and releases its task record', async () => {
    const { controller, runtime, save } = fixture();
    controller.project.conversation = { recovery: { enabled: true } };
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: { requestId: 'gate', nodeName: 'gate', title: 'Approve?', params: [] } });
    await controller.send({ text: 'Hello', params: {}, attachments: [] }); await controller.idle();
    save.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(controller.stop()).rejects.toThrow('Disk unavailable');
    expect(runtime.cancelConversation).toHaveBeenCalledOnce();
    expect(controller.hasRuns).toBe(false); expect(controller.running).toBe(false);
    expect(controller.current.messages.at(-1)?.cancelRequested).toBeUndefined();
    expect(controller.current.messages.at(-1)?.pendingInput).toBeUndefined();
  });

  function inputFixture() {
    const fixtureResult = fixture();
    const { controller, runtime } = fixtureResult;
    controller.project.fields = [{ name: 'review', flag: '--review', type: 'boolean', panel: 'slash', defaultValue: 'true' },
      { name: 'model', flag: '--model', type: 'string', panel: 'auxiliary' }];
    controller.project.conversation = { inputQueue: { enabled: true }, userInput: { effects: [
      { when: { type: 'review', nodeName: 'confirm', values: { accepted: true } }, params: { review: 'false' } },
    ] } };
    const request: InputRequest = { requestId: 'approval', nodeName: 'confirm', title: 'Continue?', metadata: { type: 'review' },
      params: [{ name: 'accepted', type: 'boolean', defaultValue: 'false' }] };
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: request });
    return { ...fixtureResult, request };
  }

  it('applies declared effects only after acceptance, persists them and keeps the draft and other sessions', async () => {
    const { controller, runtime, save, request } = inputFixture();
    const params = { review: 'true', model: 'chosen' };
    controller.current.parameterValues = { '': params };
    await controller.send({ text: 'Review', params, attachments: [] }); await controller.idle();
    const session = controller.current, answer = session.messages.at(-1)!;
    const draft = { text: 'Unsent follow-up', attachments: [] };
    await controller.updateDraft(session.id, draft.text, draft.attachments);
    await controller.create(); const other = controller.current;
    await controller.select(session.id);
    let finish!: (report: Report) => void, emit!: (event: Record<string, unknown>) => void;
    vi.mocked(runtime.run).mockImplementationOnce((_request, callback) => { emit = callback; return new Promise(resolve => { finish = resolve; }); });
    await controller.resume(answer.id!, request.requestId, { accepted: true });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(2));
    expect(session.parameterValues?.['']).toEqual(params);
    expect(answer.pendingInput).toEqual(request);
    const resolved = { type: 'user_input_resolved', requestId: request.requestId, nodeName: request.nodeName, values: { accepted: true }, submittedAt: '2026-10-15T00:00:00Z' };
    emit(resolved);
    expect(session.parameterValues?.['']).toEqual({ review: 'false', model: 'chosen' });
    expect(session.parameterRevisions?.['']).toEqual({ review: expect.any(String) });
    expect(answer.pendingInput).toBeUndefined();
    expect(session.draft).toEqual(draft);
    expect(other.parameterRevisions).toBeUndefined();
    const revision = session.parameterRevisions![''].review;
    finish({ status: 'success', resolvedUserInputs: [resolved] }); await controller.idle();
    expect(session.parameterRevisions![''].review).toBe(revision);
    const restored = new ConversationController(controller.project, runtime, { sessions: save.mock.calls.at(-1)![0], activeId: session.id, selectionVersion: 1 },
      { save, changed: vi.fn(), log: vi.fn() });
    expect(restored.current.parameterValues?.[''].review).toBe('false');
    expect(restored.current.draft).toEqual(draft);
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success' });
    await restored.send({ text: 'Follow up', params: restored.current.parameterValues![''], attachments: [] }); await restored.idle();
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['--review', 'false', '--model', 'chosen', '--message', 'Follow up'] }), expect.any(Function));
  });

  it.each(['declined', 'different-type', 'different-node', 'failed', 'thrown'])('keeps original parameters for %s input', async kind => {
    const { controller, runtime, request } = inputFixture();
    if (kind === 'different-type') { request.metadata = { type: 'another-review' }; }
    if (kind === 'different-node') { request.nodeName = 'another-node'; }
    controller.current.parameterValues = { '': { review: 'true' } };
    await controller.send({ text: 'Review', params: { review: 'true' }, attachments: [] }); await controller.idle();
    if (kind === 'thrown') { vi.mocked(runtime.run).mockRejectedValueOnce(new Error('Cannot resume')); }
    else { vi.mocked(runtime.run).mockResolvedValueOnce({ status: kind === 'failed' ? 'failed' : 'success' }); }
    const answer = controller.current.messages.at(-1)!;
    await controller.resume(answer.id!, request.requestId, { accepted: kind !== 'declined' }); await controller.idle();
    expect(controller.current.parameterValues?.[''].review).toBe('true');
    expect(controller.current.parameterRevisions).toBeUndefined();
    expect(!!answer.pendingInput).toBe(kind === 'failed' || kind === 'thrown');
  });

  it('applies multiple generic effects in order once, without replaying them in later reports', async () => {
    const { controller, runtime, request } = inputFixture();
    controller.project.conversation!.userInput!.effects!.push(
      { when: { values: { accepted: true } }, params: { model: 'first' } },
      { when: { values: { accepted: true } }, params: { model: 'last' } });
    controller.current.parameterValues = { '': { review: 'true', model: 'old' } };
    await controller.send({ text: 'Review', params: { review: 'true' }, attachments: [] }); await controller.idle();
    const answer = controller.current.messages.at(-1)!;
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success' });
    await controller.resume(answer.id!, request.requestId, { accepted: true }); await controller.idle();
    expect(controller.current.parameterValues?.['']).toEqual({ review: 'false', model: 'last' });
    const revision = controller.current.parameterRevisions![''].model;
    controller.current.parameterValues![''].model = 'user-edit';
    const next = { ...request, requestId: 'next' }; answer.pendingInput = next;
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success', resolvedUserInputs: answer.resolvedInputs });
    await controller.resume(answer.id!, next.requestId, { accepted: false }); await controller.idle();
    expect(controller.current.parameterValues?.[''].model).toBe('user-edit');
    expect(controller.current.parameterRevisions![''].model).toBe(revision);
  });

  it('has no implicit parameter changes for an unconfigured plan approval', async () => {
    const { controller, runtime, request } = inputFixture();
    controller.project.conversation!.userInput = undefined; request.metadata = { type: 'agent-plan-approval' };
    controller.current.parameterValues = { '': { review: 'true' } };
    await controller.send({ text: 'Review', params: { review: 'true' }, attachments: [] }); await controller.idle();
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'success' });
    await controller.resume(controller.current.messages.at(-1)!.id!, request.requestId, { accepted: true }); await controller.idle();
    expect(controller.current.parameterRevisions).toBeUndefined();
    expect(controller.current.parameterValues?.[''].review).toBe('true');
  });

  it('always passes the standard message without a conversation input setting', async () => {
    const { controller, runtime } = fixture();
    controller.project.fields = [{ name: 'model', flag: '--model', type: 'string', panel: 'auxiliary' }];
    vi.mocked(runtime.run).mockResolvedValue({ status: 'success' });
    await controller.send({ text: 'Hello', params: { model: 'demo' }, attachments: [] });
    await controller.idle();
    expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({ args: ['--model', 'demo', '--message', 'Hello'] }), expect.any(Function));
  });

  it('does not run a Conversation with only auxiliary parameters and no message', async () => {
    const { controller, runtime } = fixture();
    await controller.send({ text: '   ', params: { model: 'demo' }, attachments: [] });
    await controller.idle();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(controller.current.messages).toEqual([]);
  });

  it('accepts an attachment-only turn through the standard input', async () => {
    const { controller, runtime } = fixture();
    vi.mocked(runtime.run).mockResolvedValue({ status: 'success' });
    const file = { id: 'image', name: 'image.png', mimeType: 'image/png', size: 1, kind: 'image', storage: 'local', createdAt: '2026-10-14T00:00:00Z' } as const;
    await controller.send({ text: '', params: {}, attachments: [file] });
    await controller.idle();
    expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({ args: ['--message', '', '--images', JSON.stringify([file])] }), expect.any(Function));
  });

  it.each(['success', 'waiting_for_input'])('persists and restores pinned output items of a %s turn', async status => {
    const { controller, runtime, save } = fixture();
    const item = { id: 'quota', title: 'Quota', content: { value: 12_345, total: 872_000 }, contentType: 'json', display: { type: 'ring', placement: 'composer-right' } } as const;
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item } });
      return { status, output: { items: status === 'success' ? [item] : [] },
        ...(status === 'waiting_for_input' ? { pendingUserInput: { requestId: 'approval', nodeName: 'approve', title: 'Approve', params: [] } } : {}),
      };
    });
    await controller.send({ text: 'Run', params: {}, attachments: [] }); await controller.idle();
    expect(composerOutputItems(controller.current.messages)).toEqual([item]);
    expect(controller.current.messages.at(-1)?.content).toBe('');
    const saved = save.mock.calls.at(-1)![0];
    expect(saved[0].messages.at(-1)?.items).toEqual([item]);
    const reopened = new ConversationController(controller.project, runtime, { sessions: saved, activeId: controller.activeId },
      { save, changed: vi.fn(), log: vi.fn() });
    expect(composerOutputItems(reopened.current.messages)).toEqual([item]);
    await reopened.create();
    expect(reopened.current.messages).toEqual([]);
  });

  it.each(['success', 'waiting_for_input'])('ignores late events and a %s report after an explicit stop', async status => {
    const { controller, runtime, save } = fixture();
    let finish!: (report: Report) => void, emit!: (event: Record<string, unknown>) => void;
    vi.mocked(runtime.run).mockImplementationOnce((_request, callback) => {
      emit = callback;
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'live', content: 'Before stop' } } });
      return new Promise(resolve => { finish = resolve; });
    });
    await controller.send({ text: 'Run', params: {}, attachments: [] });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
    const answer = controller.current.messages.at(-1)!;
    controller.stop();
    emit({ type: 'node_chunk', chunk: { type: 'output_item_delta', itemId: 'live', delta: ' after stop' } });
    emit({ type: 'user_input_requested', requestId: 'late', nodeName: 'late', title: 'Late', params: [] });
    finish({ status, output: { items: [{ content: 'Late report' }] }, pendingUserInput: { requestId: 'late', nodeName: 'late', title: 'Late', params: [] } });
    await controller.idle();
    expect(answer).toMatchObject({ status: 'aborted', content: 'Before stop' });
    expect(answer.events).toHaveLength(1); expect(answer.pendingInput).toBeUndefined();
    expect(answer.report).toBeUndefined(); expect(controller.running).toBe(false);
    expect(save.mock.calls.at(-1)).toBeDefined();
  });

  it('replaces provisional streaming content with an empty authoritative output', async () => {
    const { controller, runtime } = fixture();
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'provisional', content: 'Provisional' } } });
      return { status: 'success', output: { items: [] }, result: { data: 'Final result' } };
    });
    await controller.send({ text: 'Run', params: {}, attachments: [] }); await controller.idle();
    const answer = controller.current.messages.at(-1)!;
    expect(answer.items).toEqual([]); expect(answer.content).toBe(JSON.stringify('Final result'));
  });

  it.each([{ items: [] }, { items: [{ id: 'prefix', content: 'Before plan' }] }])('keeps streamed plan content when a paused report contains only completed outputs: $items', async ({ items }) => {
    const { controller, runtime, save } = fixture();
    const request = { requestId: 'plan-approval', nodeName: 'approve', title: 'Approve plan', params: [] };
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'prefix', content: 'Before plan' } } });
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'plan', content: 'Inspect project', metadata: { plan: true } } } });
      return { status: 'waiting_for_input', output: { items }, pendingUserInput: request };
    });
    await controller.send({ text: 'Plan', params: {}, attachments: [] }); await controller.idle();
    const answer = controller.current.messages.at(-1)!;
    expect(answer.items?.map(item => item.id)).toEqual(['prefix', 'plan']); expect(answer.pendingInput).toEqual(request);
    const saved = save.mock.calls.at(-1)![0];
    expect(saved[0].messages.at(-1)?.items).toEqual(answer.items);
  });

  it.each(['failed', 'aborted', 'timed_out'])('retains streamed diagnostics when an empty %s report has no final output', async status => {
    const { controller, runtime } = fixture();
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'partial', content: 'Partial diagnostics' } } });
      return { status, output: { items: [] } };
    });
    await controller.send({ text: 'Run', params: {}, attachments: [] }); await controller.idle();
    expect(controller.current.messages.at(-1)).toMatchObject({ status, content: 'Partial diagnostics', items: [{ id: 'partial' }] });
  });

  it.each([false, true])('retains every approved or revised plan across reports and reopening (full snapshot=%s)', async fullSnapshot => {
    const { controller, runtime, save } = fixture();
    const request = (id: string): InputRequest => ({ requestId: id, nodeName: 'plan-approval', title: 'Plan ready',
      metadata: { type: 'agent-plan-approval' }, params: [{ name: 'decision', type: 'string' }, { name: 'instructions', type: 'string' }] });
    const first = { id: 'plan-7', content: 'Read for seven days', contentType: 'markdown' };
    const revised = { id: 'plan-30', content: 'Read for thirty days', contentType: 'markdown' };
    const built = { id: 'built', content: 'Plan executed', contentType: 'markdown' };
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: first } });
      return { status: 'waiting_for_input', output: { items: [] }, pendingUserInput: request('revise') };
    });
    await controller.send({ text: 'Create a reading plan', params: {}, attachments: [] }); await controller.idle();
    const answer = controller.current.messages.at(-1)!;
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'user_input_resolved', requestId: 'revise', nodeName: 'plan-approval', values: { decision: 'decline', instructions: 'Thirty days' } });
      expect(answer.items).toEqual([first]);
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: revised } });
      return { status: 'waiting_for_input', output: { items: fullSnapshot ? [first, revised] : [] }, pendingUserInput: request('approve') };
    });
    await controller.resume(answer.id!, 'revise', { decision: 'decline', instructions: 'Thirty days' }); await controller.idle();
    expect(answer.items).toEqual([first, revised]);
    expect(answer.resolvedInputs![0].precedingOutputItemIds).toEqual(['plan-7']);
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'user_input_resolved', requestId: 'approve', nodeName: 'plan-approval', values: { decision: 'approve', instructions: '' } });
      expect(answer.items).toEqual([first, revised]);
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: built } });
      return { status: 'success', output: { items: fullSnapshot ? [first, revised, built] : [built] } };
    });
    await controller.resume(answer.id!, 'approve', { decision: 'approve' }); await controller.idle();
    expect(answer.items).toEqual([first, revised, built]);
    expect(answer.resolvedInputs?.map(input => input.precedingOutputItemIds)).toEqual([['plan-7'], ['plan-7', 'plan-30']]);
    const saved = save.mock.calls.at(-1)![0];
    const reopened = new ConversationController(controller.project, runtime, { sessions: saved, activeId: controller.activeId }, { save, changed: vi.fn(), log: vi.fn() });
    expect(reopened.current.messages.at(-1)?.items).toEqual([first, revised, built]);
    expect(reopened.current.messages.at(-1)?.resolvedInputs).toHaveLength(2);
    controller.dispose(); reopened.dispose();
  });

  it('keeps committed input history when a resumed report has empty authoritative output', async () => {
    const { controller, runtime } = fixture();
    const request: InputRequest = { requestId: 'approve', nodeName: 'gate', title: 'Continue?', params: [] };
    const plan = { id: 'plan', content: 'Keep this plan', contentType: 'markdown' };
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: plan } });
      return { status: 'waiting_for_input', output: { items: [] }, pendingUserInput: request };
    });
    await controller.send({ text: 'Plan', params: {}, attachments: [] }); await controller.idle();
    const answer = controller.current.messages.at(-1)!;
    vi.mocked(runtime.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'temporary', content: 'Provisional' } } });
      return { status: 'success', output: { items: [] } };
    });
    await controller.resume(answer.id!, request.requestId, {}); await controller.idle();
    expect(answer.items).toEqual([plan]); expect(answer.content).toBe(plan.content);
    controller.dispose();
  });
});
