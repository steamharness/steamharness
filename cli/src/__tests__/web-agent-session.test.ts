import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionCommand, AgentSessionReceipt, AgentSessionSnapshot, AgentSessionTurn } from 'steamharness/agent';
import { ConversationController } from '../web/conversation-controller';
import { conversationPrompt } from '../web/conversation-paths';
import { messageSettled, type Project, type Report, type Runtime } from '../web/workflow-types';

const controllers: ConversationController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); });
function fixture(configurationRevision?: () => number, userSettings?: () => import('steamharness').UserSettings) {
  const project: Project = { id: 'durable', uri: '', folderPath: '/fixture', name: 'Agent', projectType: 'conversation', entrypoints: [],
    fields: [{ name: 'model', flag: '--model', type: 'string' }], conversation: { durable: { enabled: true }, recovery: { enabled: true }, inputQueue: { enabled: true } } };
  const runs: { emit(event: Record<string, unknown>): void; finish(report: Report): void; fail(error: Error): void }[] = [];
  const runtime: Runtime = { available: true, inspect: vi.fn(), resolveParams: vi.fn(), uploadFiles: vi.fn(), readFile: vi.fn(), readResource: vi.fn(), deleteFiles: vi.fn(),
    cancelConversation: vi.fn(async () => {}), deleteConversation: vi.fn(async () => {}), dispose: vi.fn(), agentControl: vi.fn(),
    run: vi.fn((_request, emit) => new Promise<Report>((resolve, reject) => runs.push({ emit, finish: resolve, fail: reject }))),
    cancel: vi.fn(() => runs.at(-1)?.finish({ status: 'aborted' })),
  };
  const save = vi.fn(async () => {});
  const controller = new ConversationController(project, runtime, {}, { save, changed: vi.fn(), log: vi.fn(), configurationRevision, userSettings }); controllers.push(controller);
  const snapshot = (): AgentSessionSnapshot => ({ version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: false, backgroundCount: 0, epoch: 0,
    configuration: { version: 0, provider: 'fixture', model: 'one', effort: 'off' }, prompt: { hash: 'digest', version: 1 }, plan: { version: 0, items: [] },
    tasks: [], history: [], receipts: [], records: [], usage: [], conversations: [{ id: 1, title: 'Main', background: false }], contexts: [],
    turns: [{ requestId: `${controller.current.messages[1]?.runId}:agent:build`, conversationId: 1, prompt: 'First', mode: 'reject', status: 'done', epoch: 0, entryId: 1, answerId: 2,
      items: [{ id: 'first', title: 'Output', content: 'First answer', contentType: 'markdown', collapsed: false, metadata: { kind: 'agent-part', partType: 'text' } }] }],
  });
  const emit = (value: AgentSessionSnapshot) => runs.at(-1)!.emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'agent-session', content: value, metadata: { kind: 'agent-session' } } } });
  const start = async () => {
    await controller.send({ text: 'First', params: { model: 'one' }, attachments: [] });
    await vi.waitFor(() => expect(runs).toHaveLength(1)); emit(snapshot());
  };
  const finish = async () => { runs.at(-1)?.finish({ status: 'success' }); await controller.idle(); };
  return { controller, runtime, runs, snapshot, emit, start, finish, save };
}

it('checkpoints streaming projections once a second while explicit saves include the newest frame immediately', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.start(); f.save.mockClear();
  const initial = f.snapshot();
  for (let revision = 2; revision <= 10; revision++) {
    f.emit({ ...initial, revision }); await vi.advanceTimersByTimeAsync(100);
  }
  expect(f.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100); expect(f.save).toHaveBeenCalledOnce();
  f.emit({ ...initial, revision: 11 });
  await f.controller.persist(); expect(f.save).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000); expect(f.save).toHaveBeenCalledTimes(2);
  await f.finish(); expect(f.save.mock.calls.length).toBeGreaterThan(2);
});

it('shares a progress checkpoint across concurrently streaming conversations', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.start(); const first = f.snapshot();
  await f.controller.create(true); await f.controller.send({ text: 'Second', params: {}, attachments: [] });
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  f.emit({ ...f.snapshot(), ownerId: 'second-owner' });
  f.runs[0].emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: {
    id: 'agent-session', content: { ...first, revision: 2 }, metadata: { kind: 'agent-session' },
  } } });
  f.save.mockClear(); await vi.advanceTimersByTimeAsync(1000); expect(f.save).toHaveBeenCalledOnce();
  for (const run of f.runs) run.finish({ status: 'success' });
  await f.controller.idle();
});

it('deduplicates a committed durable turn without requiring saved input presentation metadata', async () => {
  const f = fixture(); await f.start();
  const initial = f.snapshot();
  f.emit({ ...initial, revision: 2, turns: [...initial.turns,
    { requestId: 'already-committed', conversationId: 1, prompt: 'Follow-up', mode: 'followUp', status: 'done', epoch: 0, entryId: 3, answerId: 4, items: [] }] });
  expect(f.controller.current.messages.at(-1)).toMatchObject({ sessionRequestId: 'already-committed' });
  expect(f.controller.current.messages.at(-2)?.input).toBeUndefined();
  await f.controller.send({ text: 'Follow-up', params: { model: 'one' }, attachments: [] }, f.controller.current, true, 'already-committed');
  expect(f.runtime.agentControl).not.toHaveBeenCalled();
  expect(f.controller.current.messages).toHaveLength(4);
  await f.finish();
});

it.each(['model_error', 'no_model'])('shows %s as a failure with its reason while the owner remains alive', async reason => {
  const f = fixture(); await f.start();
  const initial = f.snapshot();
  f.emit({ ...initial, revision: 2, turns: [...initial.turns, { requestId: 'failed-follow-up', conversationId: 1,
    prompt: 'Continue', mode: 'followUp', status: 'unanswered', epoch: 0, entryId: 3, reason, detail: 'Model connection lost after 10 retries', items: [] }] });
  expect(f.controller.current.messages.at(-1)).toMatchObject({ status: 'failed', error: 'Model connection lost after 10 retries', recovering: false });
  expect(f.controller.current.activeRunId).toBeTruthy();
  await f.finish();
});

it.each([false, true])('keeps an unfinished durable follow-up running throughout host recovery (fork=%s)', async fork => {
  const f = fixture(); await f.start();
  const initial = f.snapshot(), conversationId = fork ? 2 : 1;
  const frame: AgentSessionSnapshot = { ...initial, revision: 2, foreground: !fork,
    conversations: [...initial.conversations, ...(fork ? [{ id: 2, title: 'Fork', background: false }] : [])],
    turns: [...initial.turns, { requestId: 'follow-up', conversationId, prompt: 'Continue', mode: 'followUp', status: 'placed', epoch: 0, entryId: 3,
      items: [{ id: 'partial', title: 'Output', content: 'Still working', contentType: 'markdown' }] }] };
  f.emit(frame);
  const sessionId = fork ? await f.controller.openAgentConversation(f.controller.current.id, 2) : f.controller.current.id;
  const saved = JSON.parse(JSON.stringify({ sessions: f.controller.sessions, activeId: sessionId, selectionVersion: 1 }));
  await f.finish();
  const restored = new ConversationController(f.controller.project, f.runtime, saved, { save: f.save, changed: vi.fn(), log: vi.fn() });
  controllers.push(restored);
  const answer = restored.current.messages.at(-1)!;
  expect(answer.runId).toBeUndefined(); expect(answer.args).toBeUndefined();
  expect(answer).toMatchObject({ status: 'running', recovering: true, content: 'Still working' });
  expect(answer.error).toBeUndefined(); expect(messageSettled(answer)).toBe(false);
  restored.recover();
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0]).toMatchObject({ resumeAgent: true, runId: f.controller.sessions[0].messages[1].runId });
  expect(answer.status).toBe('running'); expect(answer.error).toBeUndefined();
  f.emit({ ...frame, ownerId: 'reconnected', revision: 1 });
  expect(answer).toMatchObject({ status: 'running', recovering: false, content: 'Still working' });
  f.runs.at(-1)!.finish({ status: 'success' }); await restored.idle();
});

it('keeps the owner alive after its inline answer and confirms a lost IPC receipt from the durable snapshot', async () => {
  const f = fixture(); await f.start();
  expect(f.controller.running).toBe(false); expect(f.controller.hasRuns).toBe(true);
  expect(f.controller.current.activeRunId).toBeTruthy(); expect(messageSettled(f.controller.current.messages[1])).toBe(true);
  vi.mocked(f.runtime.agentControl!).mockImplementation(() => new Promise(() => {}));
  const pending = f.controller.agentCommand(f.controller.current.id, { type: 'plan', requestId: 'plan', expectedVersion: 0, items: [] });
  await vi.waitFor(() => expect(f.runtime.agentControl).toHaveBeenCalledOnce());
  const receipt = { requestId: 'plan', conversationId: 1, status: 'accepted' as const };
  f.emit({ ...f.snapshot(), revision: 2, receipts: [receipt] });
  expect(await pending).toEqual(receipt);
  expect(f.controller.current.agentCommands).toEqual([]);
  f.runs[0].emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'native-copy', content: 'Duplicate', contentType: 'markdown' } } });
  expect(f.controller.current.messages[1].content).toBe('First answer');
  await f.finish();
});

it('reconnects an admitted owner instead of replaying the latest rejected bootstrap', async () => {
  const f = fixture(); await f.start(); await f.finish();
  const owner = f.controller.current, original = owner.messages[1];
  owner.messages.push({ role: 'assistant', id: 'rejected', runId: 'rejected', args: ['--model', 'one', '--message', 'Rejected input'], content: '', status: 'failed', error: 'Conversation 1 is busy' });
  const control = f.controller.agentCommand(owner.id, { type: 'snapshot', requestId: 'reconnect' });
  void control.catch(() => undefined);
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0]).toMatchObject({ resumeAgent: true, runId: original.runId, args: ['--model', 'one', '--message', 'First'] });
  f.emit({ ...f.snapshot(), revision: 2, receipts: [{ requestId: 'reconnect', conversationId: 1, status: 'accepted' }] });
  await control; await f.finish();
});

it('changes settings by reattaching the owner and then submitting the new message once', async () => {
  const f = fixture(); await f.start();
  const owner = f.controller.current, original = owner.messages[1];
  const sending = f.controller.send({ text: 'Next message', params: { model: 'two' }, attachments: [] }, owner, true, 'next-model');
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0]).toMatchObject({ resumeAgent: true, runId: original.runId, args: ['--model', 'two', '--message', 'First'],
    agentCommands: [{ command: { type: 'submit', prompt: 'Next message', requestId: 'next-model' }, scopeId: owner.id, attachments: [] }] });
  f.emit({ ...f.snapshot(), revision: 2, receipts: [{ requestId: 'next-model', conversationId: 1, status: 'accepted' }] });
  await sending;
  expect(f.runtime.agentControl).not.toHaveBeenCalled();
  expect(owner.messages).toHaveLength(2);
  await f.finish();
});

it('captures configured model names for durable follow-ups without relabeling completed turns', async () => {
  const f = fixture();
  f.controller.project.fields[0].options = [{ value: 'one', label: 'First model' }];
  await f.start();
  const initial = f.snapshot();
  const turn: AgentSessionTurn = { requestId: 'follow-up-name', conversationId: 1, prompt: 'Next', mode: 'followUp',
    status: 'placed', epoch: 0, entryId: 3, items: [] };
  const frame = { ...initial, revision: 2, turns: [...initial.turns, turn] };
  vi.mocked(f.runtime.agentControl!).mockImplementationOnce(async (_runId, command) => {
    const receipt: AgentSessionReceipt = { requestId: command.requestId, conversationId: 1, status: 'accepted' };
    f.emit({ ...frame, receipts: [receipt] }); return receipt;
  });
  await f.controller.send({ text: 'Next', params: { model: 'one' }, attachments: [],
    states: { model: { resolvedOptions: [{ value: 'one', label: 'Follow-up model' }] } } }, f.controller.current, false, turn.requestId);
  expect(f.controller.current.messages.filter(message => message.role === 'assistant').map(message => message.model)).toEqual(['First model', 'Follow-up model']);
  f.emit({ ...frame, revision: 3, configuration: { ...initial.configuration, model: 'another-model' },
    turns: [...initial.turns, { ...turn, status: 'done', answerId: 4 }] });
  expect(f.controller.current.messages.filter(message => message.role === 'assistant').map(message => message.model)).toEqual(['First model', 'Follow-up model']);
  await f.finish();
});

it('starts a newly enabled Plan workflow with the new input and its approval lifecycle', async () => {
  const f = fixture(); await f.start();
  f.controller.project.fields.push({ name: 'plan', flag: '--plan', type: 'string' });
  await f.controller.send({ text: 'Plan the new task', params: { model: 'two', plan: 'true' }, attachments: [] });
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0]).toMatchObject({ resumeAgent: false, args: ['--model', 'two', '--plan', 'true', '--message', 'Plan the new task'] });
  expect(f.controller.current.messages.at(-2)?.content).toBe('Plan the new task');
  expect(f.runtime.agentControl).not.toHaveBeenCalled();
  await f.finish();
});

it('keeps per-turn usage authoritative over owner totals, other forks and final workflow reports', async () => {
  const f = fixture(); await f.start();
  const usage = { inputTokens: 3642, outputTokens: 113, totalTokens: 3755, reasoningTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, calls: 1 };
  const frame = f.snapshot(); frame.turns[0].usage = usage;
  frame.turns.push({ ...frame.turns[0], requestId: 'fork-turn', conversationId: 2, usage: { ...usage, totalTokens: 66216, calls: 7 } });
  f.emit({ ...frame, revision: 2 });
  const answer = f.controller.current.messages[1];
  expect(answer.tokenUsage?.run).toEqual(usage);
  f.runs[0].emit({ type: 'token_usage_updated', usage: { ...usage, totalTokens: 69971, calls: 8 } });
  expect(answer.tokenUsage?.run).toEqual(usage);
  f.runs[0].finish({ status: 'success', tokenUsage: { enabled: true, display: true, run: { ...usage, totalTokens: 69971, calls: 8 } } });
  await f.controller.idle();
  expect(answer.tokenUsage?.run).toEqual(usage);
  expect(answer.content).toBe('First answer');
});

it('retains plan revisions and execution in one answer through durable snapshots and replay', async () => {
  const f = fixture(); await f.start();
  const frame = f.snapshot(), answer = f.controller.current.messages[1];
  const plan: AgentSessionTurn = { ...frame.turns[0], items: [{ id: 'plan-7', title: 'Output', content: 'Seven-day plan', contentType: 'markdown' }],
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, reasoningTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, calls: 1, updatedAt: '2026-10-16T00:00:00Z' } };
  const revised: AgentSessionTurn = { ...plan, requestId: `${answer.runId}:agent:plan:revise`, prompt: 'Revise the previous plan', entryId: 3, answerId: 4,
    items: [{ id: 'plan-30', title: 'Output', content: 'Thirty-day plan', contentType: 'markdown' }] };
  const built: AgentSessionTurn = { ...plan, requestId: `${answer.runId}:agent:plan:approve`, prompt: 'Execute the plan', entryId: 5, answerId: 6,
    items: [{ id: 'built', title: 'Output', content: 'Plan executed', contentType: 'markdown' }] };
  f.emit({ ...frame, revision: 2, turns: [plan, revised] });
  expect(answer.items?.map(item => item.id)).toEqual(['plan-7', 'plan-30']);
  f.emit({ ...frame, revision: 3, turns: [plan, revised, { ...built, status: 'placed', answerId: undefined, items: [] }] });
  expect(answer.items?.map(item => item.id)).toEqual(['plan-7', 'plan-30']);
  expect(answer.status).toBe('running');
  f.emit({ ...frame, revision: 4, turns: [plan, revised, built] });
  f.emit({ ...frame, revision: 5, turns: [plan, revised, built] });
  expect(f.controller.current.messages).toHaveLength(2);
  expect(answer.items?.map(item => item.id)).toEqual(['plan-7', 'plan-30', 'built']);
  expect(answer.tokenUsage?.run).toMatchObject({ totalTokens: 330, calls: 3, updatedAt: '2026-10-16T00:00:00Z' });
  expect(answer.sessionRequestId).toBe(built.requestId);
  expect(answer.entryId).toBe(6);
  await f.finish();
  const saved = JSON.parse(JSON.stringify({ sessions: f.controller.sessions, activeId: f.controller.activeId }));
  saved.sessions[0].messages[1].items = built.items;
  saved.sessions[0].messages[1].content = 'Plan executed';
  const reopened = new ConversationController(f.controller.project, f.runtime, saved, { save: f.save, changed: vi.fn(), log: vi.fn() });
  controllers.push(reopened);
  expect(reopened.current.messages[1].items?.map(item => item.id)).toEqual(['plan-7', 'plan-30', 'built']);
  expect(f.runtime.run).toHaveBeenCalledOnce();
});

it.each([false, true])('keeps a terminal owner failure visible and does not resume it on reopen (primary done=%s)', async done => {
  const f = fixture(); await f.start();
  const initial = f.snapshot();
  f.emit({ ...initial, revision: 2, foreground: true,
    tasks: [{ id: 42, conversationId: 1, kind: 'pi.generation', label: 'Model', status: 'running', background: false, stopping: false, blockedOn: [] }],
    turns: [{ ...initial.turns[0], status: done ? 'done' : 'placed' }] });
  expect(f.controller.running).toBe(true);
  f.emit({ ...initial, revision: 3, turns: [{ ...initial.turns[0], status: done ? 'done' : 'unanswered', reason: done ? undefined : 'aborted' }] });
  f.runs[0].finish({ status: 'failed', result: { error: { message: 'projection unavailable' } } });
  await f.controller.idle();
  expect(f.controller.current.messages[1]).toMatchObject({ status: 'failed', error: 'projection unavailable', recovering: false });
  expect(f.controller.current.agent?.tasks).toEqual([]);
  expect(f.controller.running).toBe(false); expect(f.controller.hasRuns).toBe(false);
  const saved = JSON.parse(JSON.stringify({ sessions: f.controller.sessions, activeId: f.controller.activeId }));
  f.controller.dispose();
  const restored = new ConversationController(f.controller.project, f.runtime, saved, { save: f.save, changed: vi.fn(), log: vi.fn() });
  controllers.push(restored); restored.recover(); await restored.idle();
  expect(f.runtime.run).toHaveBeenCalledOnce();
  expect(restored.current.messages[1]).toMatchObject({ status: 'failed', error: 'projection unavailable' });
  const command = restored.agentCommand(restored.current.id, { type: 'snapshot', requestId: 'inspect-failure' });
  void command.catch(() => undefined);
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(restored.current.messages[1]).toMatchObject({ status: 'failed', error: 'projection unavailable' });
  f.runs[1].emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'agent-session', metadata: { kind: 'agent-session' },
    content: { ...initial, ownerId: 'reopened', revision: 1,
      turns: [{ ...initial.turns[0], status: done ? 'done' : 'unanswered', reason: done ? undefined : 'aborted' }],
      receipts: [{ requestId: 'inspect-failure', conversationId: 1, status: 'accepted' }] } } } });
  await command;
  expect(restored.current.messages[1]).toMatchObject({ status: 'failed', error: 'projection unavailable' });
  f.runs[1].finish({ status: 'failed', result: { error: { message: 'projection unavailable' } } });
  await restored.idle();
});

it('projects follow ups once, preserves the initial answer, and restores reset boundaries', async () => {
  const f = fixture(); await f.start();
  vi.mocked(f.runtime.agentControl!).mockImplementation(async (_runId, command) => {
    const receipt = { requestId: command.requestId, conversationId: 1, status: 'accepted' as const };
    f.emit({ ...f.snapshot(), revision: 2, receipts: [receipt], epoch: 1, turns: [...f.snapshot().turns,
      { requestId: 'second', conversationId: 1, prompt: 'Second', mode: 'followUp', status: 'done', epoch: 1, entryId: 4, answerId: 5,
        items: [{ id: 'second-answer', title: 'Output', content: 'Second answer', contentType: 'markdown', collapsed: false }] }] });
    return receipt;
  });
  const input = { text: 'Second', params: { model: 'one' }, attachments: [] };
  await f.controller.send(input, f.controller.current, false, 'second');
  await f.controller.send(input, f.controller.current, false, 'second');
  expect(f.controller.current.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['First answer', 'Second answer']);
  expect(f.controller.current.messages.at(-1)?.contextEpoch).toBe(1);
  expect(f.runtime.run).toHaveBeenCalledOnce();
  await f.finish();
});

it('retains extension resources and timer checkpoints without changing inline answers', async () => {
  const f = fixture(); await f.start();
  const resources: NonNullable<AgentSessionSnapshot['resources']> = { codeMode: true, storage: 'Custom',
    catalogs: [{ id: 'studio', state: 'ready', tools: ['studio_state'], loaded: ['studio_state'] }],
    environment: { id: 'remote-one', label: 'Remote workspace', remote: true, state: 'ready' },
    extensions: [{ name: 'app', tools: [], tasks: [{ name: 'app.timer', version: 2 }] }],
  };
  const task = { id: 42, conversationId: 1, kind: 'app.timer', label: 'app.timer', status: 'running', background: true, stopping: false, blockedOn: [],
    definitionVersion: 2, wakeAt: Date.now() + 1000, checkpoint: { phase: 'sleep' } };
  f.emit({ ...f.snapshot(), revision: 2, resources, tasks: [task], backgroundCount: 1 });
  expect(f.controller.current.agent!.resources).toEqual(resources);
  expect(f.controller.current.agent!.tasks).toEqual([task]);
  expect(f.controller.current.messages[1]).toMatchObject({ content: 'First answer', status: 'success' });
  expect(f.controller.current.messages[1].items?.some(item => item.metadata?.kind === 'agent-session')).toBeFalsy();
  const command = { type: 'task' as const, requestId: 'timer', name: 'app.timer', input: { wakeAt: task.wakeAt }, background: true };
  vi.mocked(f.runtime.agentControl!).mockResolvedValue({ requestId: 'timer', conversationId: 1, status: 'accepted', taskId: 43 });
  expect((await f.controller.agentCommand(f.controller.current.id, command)).taskId).toBe(43);
  expect(f.runtime.agentControl).toHaveBeenCalledWith(expect.any(String), { ...command, targetId: 1 }, f.controller.current.id, undefined);
  await f.finish();
});

it('replays an unconfirmed command on an idle owner and releases its waiter on shutdown', async () => {
  const f = fixture(); await f.start(); await f.finish();
  const pending = f.controller.agentCommand(f.controller.current.id, { type: 'snapshot', requestId: 'pending' });
  const rejected = expect(pending).rejects.toThrow('closed');
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0].agentCommands).toEqual([expect.objectContaining({ command: { type: 'snapshot', requestId: 'pending', targetId: 1 } })]);
  f.controller.dispose(); await rejected;
  expect(f.controller.current.agentCommands).toHaveLength(1);
  await f.finish();
});

it('rebuilds idle workflow settings and refuses to change them while tasks run', async () => {
  const f = fixture(); await f.start();
  const busy = { ...f.snapshot(), revision: 2, tasks: [{ id: 1, conversationId: 1, kind: 'pi.generation', label: 'Model', status: 'running', background: true, stopping: false, blockedOn: [] }] };
  f.emit(busy);
  await expect(f.controller.send({ text: 'New model', params: { model: 'two' }, attachments: [] })).rejects.toThrow(/active tasks|活动任务/);
  f.emit({ ...f.snapshot(), revision: 3 });
  const sending = f.controller.send({ text: 'New model', params: { model: 'two' }, attachments: [] }, f.controller.current, false, 'new-model');
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  f.emit({ ...f.snapshot(), revision: 4, receipts: [{ requestId: 'new-model', conversationId: 1, status: 'accepted' }] });
  await sending;
  expect(f.runtime.cancel).toHaveBeenCalledOnce();
  expect(vi.mocked(f.runtime.run).mock.calls[1][0].args).toEqual(['--model', 'two', '--message', 'First']);
  expect(f.controller.current.messages[1].status).toBe('success');
  await f.finish();
});

it('deletes a root together with its dependent views after joining the worker', async () => {
  const f = fixture(); await f.start();
  const owner = f.controller.current;
  owner.agent!.conversations.push({ id: 2, parentId: 1, forkEntryId: 2, title: 'Fork', background: false });
  const forkId = await f.controller.openAgentConversation(owner.id, 2);
  vi.mocked(f.runtime.agentControl!).mockImplementation(async (_runId, command) => ({ requestId: command.requestId, conversationId: 1, status: 'accepted' }));
  await f.controller.remove(owner.id);
  expect(f.controller.sessions.some(session => session.id === forkId || session.agentOwnerId === owner.id)).toBe(false);
  expect(f.runtime.cancel).toHaveBeenCalledOnce();
  expect(f.runtime.deleteConversation).toHaveBeenCalledWith(f.controller.project, forkId);
  expect(f.runtime.deleteConversation).toHaveBeenCalledWith(f.controller.project, owner.id);
});

it('joins the owner and clears parked work when its durable stop command fails', async () => {
  const f = fixture(); await f.start();
  vi.mocked(f.runtime.agentControl!).mockRejectedValue(new Error('Control transport failed'));
  await expect(f.controller.stop()).rejects.toThrow('Control transport failed');
  expect(f.runtime.cancel).toHaveBeenCalledOnce();
  expect(f.runtime.cancelConversation).toHaveBeenCalledWith(f.controller.project, f.controller.current.id);
  expect(f.controller.hasRuns).toBe(false);
  expect(f.controller.current.activeRunId).toBeUndefined();
});

it('deletes owned child views with their fork while retaining independent forks', async () => {
  const f = fixture(); await f.start();
  const owner = f.controller.current;
  owner.agent!.conversations.push(
    { id: 2, parentId: 1, forkEntryId: 2, title: 'Fork', background: false },
    { id: 3, parentId: 2, title: 'Owned child', background: true },
    { id: 4, parentId: 2, forkEntryId: 3, title: 'Independent fork', background: false },
  );
  const fork = await f.controller.openAgentConversation(owner.id, 2);
  const child = await f.controller.openAgentConversation(owner.id, 3);
  const independent = await f.controller.openAgentConversation(owner.id, 4);
  await f.controller.select(child);
  vi.mocked(f.runtime.agentControl!).mockImplementation(async (_runId, command) => ({ requestId: command.requestId, conversationId: 2, status: 'accepted' }));
  await f.controller.remove(fork);
  expect(f.controller.sessions.map(session => session.id)).toEqual([owner.id, independent]);
  expect(f.controller.activeId).toBe(owner.id);
  expect(f.runtime.deleteConversation).toHaveBeenCalledWith(f.controller.project, fork);
  expect(f.runtime.deleteConversation).toHaveBeenCalledWith(f.controller.project, child);
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  await f.finish();
});

it('submits file and folder references to a running Core Agent and retains their presentation after consumption', async () => {
  const f = fixture(); await f.start();
  const references = [{ path: '/workspace/folder', name: 'folder', kind: 'directory' as const }, { path: '/tmp/notes.txt', name: 'notes.txt', kind: 'file' as const }];
  vi.mocked(f.runtime.agentControl!).mockImplementation(async (_runId, command) => ({ requestId: command.requestId, conversationId: 1, status: 'accepted' }));
  await f.controller.send({ text: 'Inspect these', params: { model: 'one' }, attachments: [], references }, f.controller.current, false, 'paths-input');
  expect(f.runtime.agentControl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'submit', prompt: conversationPrompt('Inspect these', references), requestId: 'paths-input' }), f.controller.current.id, []);
  const first = f.snapshot();
  f.emit({ ...first, revision: 2, turns: [...first.turns, { requestId: 'paths-input', conversationId: 1, prompt: conversationPrompt('Inspect these', references), mode: 'followUp', status: 'done', epoch: 0, entryId: 3, answerId: 4, items: [] }] });
  expect(f.controller.current.messages.find(message => message.role === 'user' && message.content === 'Inspect these')).toMatchObject({ references });
  expect(f.controller.current.draft?.references).toBeUndefined(); await f.finish();
});

it('retains queued image metadata after acknowledgement and projects it when Harness consumes the input', async () => {
  const f = fixture(); await f.start();
  vi.mocked(f.runtime.agentControl!).mockImplementation(async (_runId, command) => ({ requestId: command.requestId, conversationId: 1, status: 'accepted' }));
  const attachments = [{ id: 'image', name: 'diagram.png', mimeType: 'image/png', size: 3, kind: 'image' as const, storage: 'local' as const, createdAt: '2026-10-15T00:00:00Z' }];
  await f.controller.send({ text: 'Inspect image', params: { model: 'one' }, attachments }, f.controller.current, false, 'image-input');
  expect(vi.mocked(f.runtime.agentControl!).mock.calls.at(-1)?.[1]).toMatchObject({ type: 'submit', mode: 'followUp' });
  expect(f.controller.current.agentCommands).toEqual([]);
  const turn = { requestId: 'image-input', conversationId: 1, prompt: 'Inspect image', mode: 'followUp' as const, status: 'queued' as const, epoch: 0, items: [] };
  f.emit({ ...f.snapshot(), revision: 2, turns: [...f.snapshot().turns, turn] });
  expect(f.controller.current.queuedInputs?.[0].attachments).toEqual(attachments);
  f.emit({ ...f.snapshot(), revision: 3, turns: [...f.snapshot().turns, { ...turn, status: 'done', entryId: 4, answerId: 5 }] });
  expect(f.controller.current.messages.find(message => message.role === 'user' && message.content === 'Inspect image')?.attachments).toEqual(attachments);
  expect(f.controller.current.agentInputs).toEqual({});
  await f.finish();
});

it.each([false, true])('promotes a durable queued input without restarting its owner or changing the draft (foreground=%s)', async foreground => {
  const f = fixture(); await f.start();
  const attachments = [{ id: 'image', name: 'diagram.png', mimeType: 'image/png', size: 3, kind: 'image' as const, storage: 'local' as const, createdAt: '2026-10-15T00:00:00Z' }];
  vi.mocked(f.runtime.agentControl!).mockImplementation(async (_runId, command) => ({ requestId: command.requestId, conversationId: 1, status: 'accepted' }));
  await f.controller.send({ text: 'Queued image', params: { model: 'one' }, attachments }, f.controller.current, false, 'queued-image');
  const turn = { requestId: 'queued-image', conversationId: 1, prompt: 'Queued image', mode: 'followUp' as const, status: 'queued' as const, epoch: 0, items: [] };
  f.emit({ ...f.snapshot(), revision: 2, foreground, turns: [...f.snapshot().turns, turn] });
  await f.controller.updateDraft(f.controller.current.id, 'Keep this draft', attachments);
  await f.controller.promoteQueued('queued-image');
  expect(vi.mocked(f.runtime.agentControl!).mock.calls.at(-1)?.[1]).toMatchObject({ type: 'promote', inputId: 'queued-image', targetId: 1 });
  expect(f.controller.current.queuedInputs?.[0].attachments).toEqual(attachments);
  expect(f.controller.current.draft).toMatchObject({ text: 'Keep this draft', attachments });
  expect(f.runtime.cancel).not.toHaveBeenCalled(); expect(f.runtime.run).toHaveBeenCalledOnce();
  f.emit({ ...f.snapshot(), revision: 3, foreground, turns: [...f.snapshot().turns, { ...turn, mode: 'steer', status: 'placed', entryId: 4 }] });
  expect(f.controller.current.queuedInputs).toEqual([]);
  expect(f.controller.current.messages.find(message => message.status === 'steer')).toMatchObject({ content: 'Queued image', attachments });
  expect(f.controller.current.draft?.text).toBe('Keep this draft');
  await f.finish();
});

it.each(['removeQueued', 'promoteQueued'] as const)('waits for a durable %s receipt using the supplied request identity without changing the draft or owner', async method => {
  const f = fixture(); await f.start();
  const initial = f.snapshot();
  f.emit({ ...initial, revision: 2, turns: [...initial.turns,
    { requestId: 'queued', conversationId: 1, prompt: 'Keep my input', mode: 'followUp', status: 'queued', epoch: 0, items: [] }] });
  await f.controller.updateDraft(f.controller.current.id, 'Next draft', []);
  let accept!: (receipt: AgentSessionReceipt) => void;
  vi.mocked(f.runtime.agentControl!).mockImplementation(() => new Promise(resolve => { accept = resolve; }));
  const pending = f.controller[method]('queued', f.controller.current, 'queue-action');
  await vi.waitFor(() => expect(f.runtime.agentControl).toHaveBeenCalledOnce());
  expect(vi.mocked(f.runtime.agentControl!).mock.calls[0][1]).toMatchObject({
    type: method === 'removeQueued' ? 'withdraw' : 'promote', requestId: 'queue-action', inputId: 'queued', targetId: 1,
  });
  expect(f.controller.current.queuedInputs?.[0].text).toBe('Keep my input');
  expect(f.controller.current.draft?.text).toBe('Next draft');
  expect(f.runtime.cancel).not.toHaveBeenCalled(); expect(f.runtime.run).toHaveBeenCalledOnce();
  accept({ requestId: 'queue-action', conversationId: 1, status: 'accepted' }); await pending;
  expect(f.controller.current.agentCommands).toEqual([]); expect(f.controller.current.draft?.text).toBe('Next draft');
  await f.finish();
});

it('never starts Harness queued inputs through the old host queue when its owner exits', async () => {
  const f = fixture(); await f.start();
  f.emit({ ...f.snapshot(), revision: 2, turns: [...f.snapshot().turns,
    { requestId: 'still-queued', conversationId: 1, prompt: 'Next', mode: 'followUp', status: 'queued', epoch: 0, items: [] }] });
  await f.finish();
  expect(f.controller.current.queuedInputs).toHaveLength(1);
  expect(f.runtime.run).toHaveBeenCalledOnce();
  expect(f.controller.hasRuns).toBe(false);
});

it('keeps only the latest session snapshot instead of persisting every streaming frame in trace history', async () => {
  const f = fixture(); await f.start();
  for (let revision = 2; revision <= 50; revision++) {
    f.emit({ ...f.snapshot(), revision });
    f.runs[0].emit({ type: 'node_chunk', chunk: { type: 'output_item_end', itemId: 'agent-session' } });
  }
  f.runs[0].emit({ type: 'node_started', nodeName: 'agent' });
  expect(f.controller.current.agent?.revision).toBe(50);
  expect(f.controller.current.messages[1].events).toEqual([{ type: 'node_started', nodeName: 'agent' }]);
  await f.finish();
});

it('reopens a saved Harness queue even when no task or command was recorded in the last snapshot', async () => {
  const f = fixture(); await f.start();
  f.emit({ ...f.snapshot(), revision: 2, turns: [...f.snapshot().turns,
    { requestId: 'waiting', conversationId: 1, prompt: 'Continue', mode: 'followUp', status: 'queued', epoch: 0, items: [] }] });
  await f.finish();
  const saved = JSON.parse(JSON.stringify({ sessions: f.controller.sessions, activeId: f.controller.activeId }));
  f.controller.dispose();
  const restored = new ConversationController(f.controller.project, f.runtime, saved, { save: f.save, changed: vi.fn(), log: vi.fn() });
  controllers.push(restored); restored.recover();
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0].args).toEqual(['--model', 'one', '--message', 'First']);
  f.runs[1].finish({ status: 'success' }); await restored.idle();
});

it('restores fork history and its source when the fork receipt was lost before creating a host view', async () => {
  const f = fixture(); await f.start();
  const owner = f.controller.current;
  f.emit({ ...f.snapshot(), revision: 2, conversations: [...f.snapshot().conversations,
    { id: 2, parentId: 1, forkEntryId: 2, title: 'Recovered fork', background: false }] });
  const id = await f.controller.openAgentConversation(owner.id, 2);
  const fork = f.controller.sessions.find(session => session.id === id)!;
  expect(fork.messages.map(message => message.content)).toEqual(['First', 'First answer']);
  expect(fork.forkSource).toEqual({ sessionId: owner.id, entryId: 2 });
  await f.controller.openAgentConversation(owner.id, 2);
  expect(fork.messages).toHaveLength(2);
  await f.finish();
});

it.each(['fork', 'owner'])('isolates equal command identities across a second %s', async scope => {
  const f = fixture(); await f.start();
  const first = f.controller.current;
  let secondId: string;
  if (scope === 'fork') {
    f.emit({ ...f.snapshot(), revision: 2, conversations: [...f.snapshot().conversations,
      { id: 2, parentId: 1, forkEntryId: 2, title: 'Fork', background: false }] });
    secondId = await f.controller.openAgentConversation(first.id, 2);
  } else {
    await f.controller.create();
    await f.controller.send({ text: 'First', params: { model: 'one' }, attachments: [] });
    await vi.waitFor(() => expect(f.runs).toHaveLength(2)); f.emit(f.snapshot());
    secondId = f.controller.current.id;
  }
  const accepted: { resolve(value: AgentSessionReceipt): void; command: AgentSessionCommand }[] = [];
  vi.mocked(f.runtime.agentControl!).mockImplementation((_run, command) => new Promise(resolve => accepted.push({ resolve, command })));
  const command = { type: 'plan' as const, requestId: 'same-id', expectedVersion: 0, items: [] };
  const one = f.controller.agentCommand(first.id, command);
  const duplicate = f.controller.agentCommand(first.id, { items: [], expectedVersion: 0, requestId: 'same-id', type: 'plan' });
  void duplicate.catch(() => undefined);
  const two = f.controller.agentCommand(secondId, command);
  try {
    await vi.waitFor(() => expect(accepted).toHaveLength(2));
    await expect(f.controller.agentCommand(first.id, { ...command, expectedVersion: 1 })).rejects.toThrow('another command');
    accepted[0].resolve({ requestId: 'same-id', conversationId: 1, status: 'accepted', taskId: 11 });
    expect((await one).taskId).toBe(11);
    expect((await duplicate).taskId).toBe(11);
    expect(f.controller.sessions.find(session => session.id === secondId)?.agentCommands).toHaveLength(1);
    accepted[1].resolve({ requestId: 'same-id', conversationId: scope === 'fork' ? 2 : 1, status: 'accepted', taskId: 22 });
    expect((await two).taskId).toBe(22);
  } finally {
    for (const pending of accepted) pending.resolve({ requestId: 'same-id', conversationId: pending.command.targetId!, status: 'accepted' });
    await Promise.allSettled([one, two, duplicate]);
    for (const run of f.runs) run.finish({ status: 'success' });
    await f.controller.idle();
  }
});

it('retains interrupted commands and does not reject another target with the same request identity', async () => {
  const f = fixture(); await f.start();
  const owner = f.controller.current;
  f.emit({ ...f.snapshot(), revision: 2, conversations: [...f.snapshot().conversations,
    { id: 2, parentId: 1, forkEntryId: 2, title: 'Fork', background: false }] });
  const forkId = await f.controller.openAgentConversation(owner.id, 2);
  vi.mocked(f.runtime.agentControl!).mockImplementation(() => new Promise(() => {}));
  const command = { type: 'plan' as const, requestId: 'same-id', expectedVersion: 0, items: [] };
  const one = f.controller.agentCommand(owner.id, command);
  const rejected = expect(one).rejects.toMatchObject({ code: 'STEAMHARNESS_WORKER_INTERRUPTED' });
  const two = f.controller.agentCommand(forkId, command);
  await vi.waitFor(() => expect(f.runtime.agentControl).toHaveBeenCalledTimes(2));
  f.runs[0].emit({ type: 'agent_command_failed', requestId: 'same-id', targetId: 1, message: 'Interrupted', code: 'STEAMHARNESS_WORKER_INTERRUPTED' });
  await rejected;
  expect(owner.agentCommands).toHaveLength(1);
  const receipt = { requestId: 'same-id', conversationId: 2, status: 'accepted' as const };
  f.emit({ ...f.snapshot(), revision: 3, receipts: [receipt] });
  expect(await two).toEqual(receipt);
  expect(owner.agentCommands).toHaveLength(1);
  expect(f.controller.sessions.find(session => session.id === forkId)?.agentCommands).toEqual([]);
  await f.finish();
});

it('queues a settings change during owner startup until the first safe snapshot', async () => {
  let settings: import('steamharness').UserSettings = { agent: { permissionPolicy: 'auto' } };
  const f = fixture(undefined, () => settings);
  await f.controller.send({ text: 'First', params: { model: 'one' }, attachments: [] });
  const owner = f.controller.current;
  settings = { agent: { permissionPolicy: 'workspace' } };
  f.controller.configurationChanged();
  await f.controller.send({ text: 'After startup', params: { model: 'one' }, attachments: [] }, owner, true, 'startup-next');
  expect(owner.queuedInputs).toMatchObject([{ id: 'startup-next', configurationPending: true }]);
  expect(f.runtime.agentControl).not.toHaveBeenCalled();
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  f.emit(f.snapshot());
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0].userSettings).toEqual(settings);
  f.emit({ ...f.snapshot(), ownerId: 'started', receipts: [{ requestId: 'startup-next', conversationId: 1, status: 'accepted' }] });
  await vi.waitFor(() => expect(owner.agentCommands).toEqual([]));
  expect(owner.queuedInputs).toEqual([]);
  await f.finish();
});

it('restores unfinished work with its saved user snapshot before adopting a newer setting', async () => {
  const original: import('steamharness').UserSettings = { agent: { permissionPolicy: 'auto' } };
  const latest: import('steamharness').UserSettings = { agent: { permissionPolicy: 'read-only' } };
  const f = fixture(undefined, () => original); await f.start();
  const busy: AgentSessionSnapshot = { ...f.snapshot(), revision: 2, tasks: [{ id: 42, conversationId: 1, kind: 'pi.generation', label: 'Child', status: 'running', background: true, stopping: false, blockedOn: [] }] };
  f.emit(busy);
  const saved = JSON.parse(JSON.stringify({ sessions: f.controller.sessions, activeId: f.controller.activeId, selectionVersion: 1 }));
  await f.finish();
  const restored = new ConversationController(f.controller.project, f.runtime, saved, { save: f.save, changed: vi.fn(), log: vi.fn(), userSettings: () => latest });
  controllers.push(restored); restored.recover();
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0].userSettings).toEqual(original);
  f.emit({ ...busy, ownerId: 'restored' });
  restored.configurationChanged();
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  await restored.send({ text: 'After recovered work', params: { model: 'one' }, attachments: [] }, restored.current, true, 'after-recovery');
  expect(restored.current.queuedInputs).toMatchObject([{ id: 'after-recovery', configurationPending: true }]);
  f.emit({ ...f.snapshot(), ownerId: 'restored', revision: 3 });
  await vi.waitFor(() => expect(f.runs).toHaveLength(3));
  expect(vi.mocked(f.runtime.run).mock.calls[2][0].userSettings).toEqual(latest);
  f.emit({ ...f.snapshot(), ownerId: 'latest', receipts: [{ requestId: 'after-recovery', conversationId: 1, status: 'accepted' }] });
  await vi.waitFor(() => expect(restored.current.queuedInputs).toEqual([]));
  f.runs.at(-1)!.finish({ status: 'success' }); await restored.idle();
});

it.each(['permission', 'models'])('adopts user %s at an idle boundary while preserving active work, history and pending input IDs', async kind => {
  const model = { id: 'one', name: 'User model', model: 'actual', source: 'third-party' as const, apiKind: 'openai-responses' as const, baseUrl: 'https://example.test/v1', apiKey: 'test-original-key' };
  let settings: import('steamharness').UserSettings = { agent: { permissionPolicy: 'auto', ...(kind === 'models' ? { models: [model] } : {}) } };
  const f = fixture(undefined, () => settings); await f.start();
  const owner = f.controller.current, originalRun = owner.activeRunId, initial = f.snapshot();
  const active: AgentSessionSnapshot = { ...initial, revision: 2, tasks: [{ id: 42, conversationId: 1, kind: 'pi.generation', label: 'Model', status: 'running', background: true, stopping: false, blockedOn: [] }] };
  f.emit(active);
  settings = kind === 'models' ? { agent: { permissionPolicy: 'auto', models: [{ ...model, apiKey: 'test-new-key' }] } } : { agent: { permissionPolicy: 'read-only' } }; f.controller.configurationChanged();
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  await f.controller.send({ text: 'Use new permissions', params: { model: 'one' }, attachments: [] }, owner, true, 'next-permissions');
  expect(owner.queuedInputs).toMatchObject([{ id: 'next-permissions', configurationPending: true }]);
  expect(f.runtime.agentControl).not.toHaveBeenCalled();
  expect(vi.mocked(f.runtime.run).mock.calls[0][0].userSettings?.agent.permissionPolicy).toBe('auto');
  f.emit({ ...initial, revision: 3 });
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0]).toMatchObject({ runId: originalRun, resumeAgent: true, userSettings: settings });
  f.emit({ ...initial, ownerId: 'new-permissions', receipts: [{ requestId: 'next-permissions', conversationId: 1, status: 'accepted' }] });
  await vi.waitFor(() => expect(owner.agentCommands).toEqual([]));
  expect(owner.messages[1].content).toBe('First answer');
  expect(owner.queuedInputs).toEqual([]);
  expect(f.runtime.deleteConversation).not.toHaveBeenCalled();
  await f.finish();
});

it('reloads configuration only at an idle boundary and retains history and queued inputs', async () => {
  let revision=0;
  const f=fixture(()=>revision);await f.start();
  const owner=f.controller.current, originalRun=owner.activeRunId, history=owner.messages[1].content;
  const active=f.snapshot();active.turns[0].status='placed';f.emit({...active,revision:2});
  revision=1;f.controller.configurationChanged();
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  await f.controller.send({text:'Next configuration',params:{model:'one'},attachments:[]},owner,true,'next-config');
  expect(owner.queuedInputs).toHaveLength(1);expect(f.runtime.agentControl).not.toHaveBeenCalled();
  f.emit({...f.snapshot(),revision:3});
  await vi.waitFor(()=>expect(f.runs).toHaveLength(2));
  expect(f.runtime.agentControl).not.toHaveBeenCalled();
  f.emit({...f.snapshot(),ownerId:'reloaded',receipts:[{requestId:'next-config',conversationId:1,status:'accepted'}]});
  await vi.waitFor(()=>expect(owner.agentCommands).toEqual([]));
  expect(f.runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({runId:originalRun,conversationId:owner.id,configurationRunId:`${originalRun}:configuration:1`}),expect.any(Function));
  expect(owner.messages[1].content).toBe(history);expect(owner.queuedInputs).toHaveLength(0);
  expect(f.runtime.deleteConversation).not.toHaveBeenCalled();
  await f.finish();
});
it('waits for an in-flight configuration reload before accepting another input', async () => {
  let revision=0;const f=fixture(()=>revision);await f.start();
  let release!:()=>void;
  vi.mocked(f.runtime.cancel).mockImplementation(()=>{release=()=>f.runs[0].finish({status:'aborted'});});
  revision=1;f.controller.configurationChanged();
  await vi.waitFor(()=>expect(release).toBeDefined());
  const sending=f.controller.send({text:'After reload',params:{model:'one'},attachments:[]},f.controller.current,true,'after-reload');
  await Promise.resolve();expect(f.runtime.agentControl).not.toHaveBeenCalled();
  release();
  await vi.waitFor(()=>expect(f.runs).toHaveLength(2));
  expect(f.runtime.agentControl).not.toHaveBeenCalled();
  f.emit({...f.snapshot(),ownerId:'reloaded',receipts:[{requestId:'after-reload',conversationId:1,status:'accepted'}]});
  await sending;
  await f.finish();
});

it('defers configuration reattachment until the next input supplies the new model', async () => {
  let revision = 0;
  const f = fixture(() => revision); await f.start();
  const owner = f.controller.current, original = owner.messages[1], initial = f.snapshot();
  revision = 1; f.controller.configurationChanged(); await f.controller.idle();
  expect(f.runs).toHaveLength(1); expect(owner.activeRunId).toBeUndefined();
  expect(original).toMatchObject({ status: 'success', content: 'First answer', model: 'one' });
  const sending = f.controller.send({ text: 'Use the replacement model', params: { model: 'two' }, attachments: [] }, owner, true, 'replacement');
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  expect(vi.mocked(f.runtime.run).mock.calls[1][0]).toMatchObject({ resumeAgent: true, runId: original.runId,
    configurationRunId: `${original.runId}:configuration:1`, args: ['--model', 'two', '--message', 'First'] });
  f.emit({ ...initial, ownerId: 'new-owner', revision: 1, receipts: [{ requestId: 'replacement', conversationId: 1, status: 'accepted' }], turns: [...initial.turns,
    { requestId: 'replacement', conversationId: 1, prompt: 'Use the replacement model', mode: 'followUp', status: 'done', epoch: 0, entryId: 3, answerId: 4,
      items: [{ id: 'replacement-answer', title: 'Output', content: 'Second answer', contentType: 'markdown', collapsed: false }] }] });
  await sending;
  expect(owner.messages.filter(message => message.role === 'assistant').map(message => [message.status, message.model, message.content]))
    .toEqual([['success', 'one', 'First answer'], ['success', 'two', 'Second answer']]);
  await f.finish();
  expect(original).toMatchObject({ status: 'success', content: 'First answer', model: 'one' });
});

it.each(['report', 'exception'])('keeps completed replies intact when model reattachment fails via %s', async failure => {
  const f = fixture(); await f.start();
  f.runs[0].finish({ status: 'success', durationMs: 123 }); await f.controller.idle();
  const original = structuredClone(f.controller.current.messages[1]);
  const sending = f.controller.send({ text: 'New input', params: { model: 'two' }, attachments: [] }, f.controller.current, true, 'failed-reconnect');
  const rejected = expect(sending).rejects.toThrow('Fixture model unavailable');
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  if (failure === 'report') f.runs[1].finish({ status: 'failed', durationMs: 1, result: { error: { message: 'Fixture model unavailable' } } });
  else f.runs[1].fail(new Error('Fixture model unavailable'));
  await rejected; await f.controller.idle();
  expect(f.controller.current.messages[1]).toEqual(original);
  expect(f.controller.current.agentCommands).toEqual([]);
});

it.each(['report', 'exception'])('reports a reattached worker failure on the unfinished turn via %s', async failure => {
  const f = fixture(); await f.start(); await f.finish();
  const original = structuredClone(f.controller.current.messages[1]), initial = f.snapshot();
  const sending = f.controller.send({ text: 'Next', params: { model: 'two' }, attachments: [] }, f.controller.current, true, 'unfinished');
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  f.emit({ ...initial, ownerId: 'new-owner', revision: 1, foreground: true, receipts: [{ requestId: 'unfinished', conversationId: 1, status: 'accepted' }],
    turns: [...initial.turns, { requestId: 'unfinished', conversationId: 1, prompt: 'Next', mode: 'followUp', status: 'placed', epoch: 0, entryId: 3, items: [] }] });
  await sending;
  if (failure === 'report') f.runs[1].finish({ status: 'failed', result: { error: { message: 'New model connection failed' } } });
  else f.runs[1].fail(new Error('New model connection failed'));
  await f.controller.idle();
  expect(f.controller.current.messages[1]).toEqual(original);
  expect(f.controller.current.messages.at(-1)).toMatchObject({ status: 'failed', error: 'New model connection failed', model: 'two' });
});

it('bounds interrupted owner reconnects without changing a completed reply or replaying its input', async () => {
  const f = fixture(); await f.start(); await f.finish();
  const owner = f.controller.current, original = owner.messages[1];
  const control = f.controller.agentCommand(owner.id, { type: 'snapshot', requestId: 'bounded-reconnect' });
  const rejected = expect(control).rejects.toMatchObject({ code: 'STEAMHARNESS_WORKER_INTERRUPTED' });
  for (let count = 2; count <= 5; count++) {
    await vi.waitFor(() => expect(f.runs).toHaveLength(count));
    f.runs.at(-1)!.fail(Object.assign(new Error('Interrupted'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }));
  }
  await rejected; await f.controller.idle();
  expect(f.runs).toHaveLength(5);
  expect(original).toMatchObject({ status: 'success', content: 'First answer', model: 'one' });
  expect(vi.mocked(f.runtime.run).mock.calls.slice(1).every(([request]) => request.resumeAgent && request.runId === original.runId)).toBe(true);
  expect(owner.agentCommands).toHaveLength(1);
});

it('allows retrying an interrupted follow-up after the reattached worker exhausts its recovery attempts', async () => {
  const f = fixture(); await f.start(); await f.finish();
  const owner = f.controller.current, initial = f.snapshot();
  const sending = f.controller.send({ text: 'Next', params: { model: 'two' }, attachments: [] }, owner, true, 'retry-followup');
  await vi.waitFor(() => expect(f.runs).toHaveLength(2));
  f.emit({ ...initial, ownerId: 'new-owner', revision: 1, foreground: true, receipts: [{ requestId: 'retry-followup', conversationId: 1, status: 'accepted' }],
    turns: [...initial.turns, { requestId: 'retry-followup', conversationId: 1, prompt: 'Next', mode: 'followUp', status: 'placed', epoch: 0, entryId: 3, items: [] }] });
  await sending;
  for (let count = 2; count <= 5; count++) {
    await vi.waitFor(() => expect(f.runs).toHaveLength(count));
    f.runs.at(-1)!.fail(Object.assign(new Error('Interrupted'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }));
  }
  await f.controller.idle();
  const answer = owner.messages.at(-1)!;
  expect(answer).toMatchObject({ status: 'failed', recovering: true });
  await f.controller.retry(answer.id!);
  await vi.waitFor(() => expect(f.runs).toHaveLength(6));
  expect(owner.messages[1].recoveryAttempts).toBe(0);
  expect(owner.messages[1]).toMatchObject({ status: 'success', content: 'First answer' });
  expect(vi.mocked(f.runtime.run).mock.calls[5][0]).toMatchObject({ resumeAgent: true, runId: owner.messages[1].runId });
  await f.finish();
});

it.each([
  'The selected AI model is no longer configured. Select a model again.',
  'Add a model in Project configurations before running the Agent.',
  'This system AI model is unavailable. Check your subscription in Project configurations.',
])('repairs a completed reply previously overwritten by configuration startup error: %s', async error => {
  const f = fixture(); await f.start(); await f.finish();
  const saved = structuredClone({ sessions: f.controller.sessions, activeId: f.controller.activeId });
  Object.assign(saved.sessions[0].messages[1], { status: 'failed', error, report: { status: 'failed', result: { error: { message: error } } }, durationMs: 1 });
  const restored = new ConversationController(f.controller.project, f.runtime, saved, { save: f.save, changed: vi.fn(), log: vi.fn() });
  controllers.push(restored);
  expect(restored.current.messages[1]).toMatchObject({ status: 'success', content: 'First answer', model: 'one' });
  expect(restored.current.messages[1].error).toBeUndefined(); expect(restored.current.messages[1].report).toBeUndefined();
  restored.recover(); expect(f.runtime.run).toHaveBeenCalledOnce();
});
