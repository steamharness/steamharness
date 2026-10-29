import { expect, it, vi } from 'vitest';
import { ConversationController } from '../web/conversation-controller';
import type { ConversationSession, Project, Report, Runtime } from '../web/workflow-types';

function fixture(saved: { sessions?: ConversationSession[] } = {}) {
  const project = { projectType: 'conversation', fields: [], entrypoints: [], conversation: { recovery: { enabled: true }, inputQueue: { enabled: true } } } as unknown as Project;
  const runtime = { run: vi.fn(), cancel: vi.fn(), cancelConversation: vi.fn(async () => {}) } as unknown as Runtime;
  const save = vi.fn(async () => {});
  const controller = new ConversationController(project, runtime, saved, { save, changed: vi.fn(), log: vi.fn() });
  return { controller, runtime, save };
}

it.each(['failed', 'aborted', 'timed_out', 'throw'] as const)('pauses the queue after %s and advances it only after a successful explicit input', async status => {
  const { controller, runtime } = fixture();
  let finish!: (report: Report) => void, fail!: (error: Error) => void;
  vi.mocked(runtime.run).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }))
    .mockResolvedValue({ status: 'success' });
  await controller.send({ text: 'First', params: {}, attachments: [] });
  await controller.send({ text: 'Queued one', params: {}, attachments: [] });
  await controller.send({ text: 'Queued two', params: {}, attachments: [] });
  if (status === 'throw') fail(new Error('Tool initialization failed'));
  else finish({ status });
  await controller.idle();
  expect(runtime.run).toHaveBeenCalledOnce();
  expect(controller.current.queuedInputs?.map(input => input.text)).toEqual(['Queued one', 'Queued two']);
  await controller.editQueued(controller.current.queuedInputs![0].id); await controller.cancelQueueEdit();
  await controller.reorderQueued(controller.current.queuedInputs!.map(input => input.id).reverse());
  expect(runtime.run).toHaveBeenCalledOnce();
  await controller.send({ text: 'Explicit new input', params: {}, attachments: [] }); await controller.idle();
  expect(vi.mocked(runtime.run).mock.calls.map(([run]) => run.args?.at(-1))).toEqual(['First', 'Explicit new input', 'Queued two', 'Queued one']);
  expect(controller.current.queuedInputs).toEqual([]);
  controller.dispose();
});

it('keeps a restored queue paused after recovery fails and retains it across another restart', async () => {
  const initial = fixture();
  const saved = initial.controller.current;
  saved.messages.push({ id: 'old', runId: 'old', role: 'assistant', content: 'Partial', status: 'running', args: ['--message', 'Original'] });
  saved.queuedInputs = [{ id: 'queued', text: 'Keep me', params: {}, attachments: [], createdAt: 1 }];
  const { controller, runtime } = fixture({ sessions: structuredClone([saved]) });
  vi.mocked(runtime.run).mockResolvedValue({ status: 'failed' });
  controller.recover(); await controller.idle();
  expect(runtime.run).toHaveBeenCalledOnce();
  expect(controller.current.queuedInputs?.map(input => input.id)).toEqual(['queued']);
  const reopened = fixture({ sessions: structuredClone(controller.sessions) });
  reopened.controller.recover(); await reopened.controller.idle();
  await reopened.controller.removeQueued('missing'); await reopened.controller.cancelQueueEdit();
  expect(reopened.runtime.run).not.toHaveBeenCalled();
  expect(reopened.controller.current.queuedInputs?.map(input => input.id)).toEqual(['queued']);
  vi.mocked(reopened.runtime.run).mockResolvedValue({ status: 'success' });
  await reopened.controller.runQueued(); await reopened.controller.idle();
  expect(reopened.runtime.run).toHaveBeenCalledOnce();
  initial.controller.dispose(); controller.dispose(); reopened.controller.dispose();
});

it('requires a new successful run before automatically sending a restored idle queue', async () => {
  const initial = fixture();
  initial.controller.current.messages.push({ role: 'assistant', content: 'Earlier success', status: 'success' });
  initial.controller.current.queuedInputs = [{ id: 'queued', text: 'Waiting before shutdown', params: {}, attachments: [], createdAt: 1 }];
  const { controller, runtime } = fixture({ sessions: structuredClone(initial.controller.sessions) });
  controller.recover(); await controller.cancelQueueEdit(); await controller.removeQueued('unknown');
  expect(runtime.run).not.toHaveBeenCalled(); expect(controller.current.queuePaused).toBe(true);
  vi.mocked(runtime.run).mockResolvedValue({ status: 'success' });
  await controller.send({ text: 'Run after restart', params: {}, attachments: [] }); await controller.idle();
  expect(vi.mocked(runtime.run).mock.calls.map(([run]) => run.args?.at(-1))).toEqual(['Run after restart', 'Waiting before shutdown']);
  expect(controller.current.queuePaused).toBeUndefined();
  initial.controller.dispose(); controller.dispose();
});
