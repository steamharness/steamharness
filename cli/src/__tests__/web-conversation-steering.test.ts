import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionSnapshot, AgentSessionTurn } from 'steamharness/agent';
import { ConversationController } from '../web/conversation-controller';
import { EntryConversations, conversationProjection } from '../web/entry-conversations';
import { ConversationSubmissions } from '../web/ui/conversation-submissions';
import type { ConversationSession, Project, Runtime } from '../web/workflow-types';

const controllers: ConversationController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });

function fixture(options: { fork?: boolean; legacy?: boolean; reordered?: boolean } = {}) {
  const project: Project = { id: 'steering', entryId: 'main', aggregateName: 'Test', defaultEntry: 'main', entryRoot: '/fixture', folderPath: '/fixture', uri: 'project', name: 'Test', databases: [], fields: [], entrypoints: [],
    entries: [{ entryId: 'main', name: 'Main', type: 'bot', root: '.', entry: 'index.ts', databases: [] }], projectType: 'bot',
    conversation: { durable: { enabled: true }, recovery: { enabled: true }, inputQueue: { enabled: true } } };
  const root: AgentSessionTurn = { requestId: 'worker:agent:build', conversationId: 1, prompt: 'Original task', mode: 'followUp', status: 'done', epoch: 0, entryId: 1,
    answerId: 6, startedAt: 10, endedAt: 60, items: [{ id: 'output', title: 'Output', content: 'Answer', contentType: 'markdown' }] };
  const turns: AgentSessionTurn[] = [root, { requestId: 'correction', conversationId: 1, prompt: 'Queued correction', mode: 'steer', status: 'done', epoch: 0, entryId: 3, answerId: 6, startedAt: 20, endedAt: 60, items: [] }];
  if (options.reordered) turns.push(
    { requestId: 'older', conversationId: 1, prompt: 'Older queued input', mode: 'followUp', status: 'done', epoch: 0, entryId: 9, answerId: 10, items: [] },
    { requestId: 'promoted', conversationId: 1, prompt: 'Promoted input', mode: 'followUp', status: 'done', epoch: 0, entryId: 7, answerId: 8, items: [] });
  const agent: AgentSessionSnapshot = { version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: false, backgroundCount: 0, epoch: 0,
    configuration: { version: 0, provider: 'fixture', model: 'fixture', effort: 'off' }, prompt: { hash: 'test', version: 1 }, plan: { version: 0, items: [] },
    tasks: [], history: [], receipts: [], records: [], usage: [], contexts: [], turns,
    conversations: [{ id: 1, title: 'Main', background: false }, ...(options.fork ? [{ id: 2, parentId: 1, forkEntryId: 6, title: 'Fork', background: false }] : [])] };
  const session: ConversationSession = { id: 'chat', title: 'Test', createdAt: 10, updatedAt: 60, agent, messages: [
    { id: 'input', role: 'user', content: 'Original task', createdAt: 10, input: { requestId: 'worker', text: 'Original task', params: {}, attachments: [] } },
    { id: 'worker', role: 'assistant', content: 'Answer', status: 'success', runId: 'worker', args: ['--message', 'Original task'], createdAt: 10, entryId: 6 },
    ...(options.legacy ? [{ id: 'steer:correction', role: 'user' as const, content: 'Queued correction', status: 'steer', createdAt: 20 }] : []),
  ] };
  const runtime = { isolateAgentConversation: vi.fn(async () => ({ replacements: [], files: [] })) } as unknown as Runtime;
  const controller = new ConversationController(project, runtime, { sessions: [session], activeId: session.id, selectionVersion: 1 }, { save: vi.fn(async () => {}), changed() {}, log() {} });
  controllers.push(controller);
  return controller;
}

it.each([false, true])('clears accepted and restored Send now previews after consumption (legacy=%s)', legacy => {
  const controller = fixture({ legacy });
  const pending = new ConversationSubmissions();
  pending.add({ projectUri: 'project', sessionId: 'chat', queued: false, mode: 'steer', phase: 'sending',
    input: { id: 'correction', text: 'Queued correction', params: {}, attachments: [], createdAt: 20 } });
  pending.accept('correction');
  const restored = new ConversationSubmissions(JSON.parse(JSON.stringify(pending.list())), 'Delivery unconfirmed');
  for (const submissions of [pending, restored]) {
    const displayed = submissions.project('project', controller.current, true);
    expect(displayed.messages).toEqual(controller.current.messages);
    expect(displayed.messages.filter(message => message.content === 'Queued correction')).toHaveLength(1);
    expect(submissions.busy('project', 'chat')).toBe(false);
    expect(submissions.list()).toEqual([]);
  }
  expect(conversationProjection('main', controller.current, 'owner', 1).messages.find(message => message.id === 'steer:correction')?.requestId).toBe('correction');
});

it('deduplicates consumed steered input and validates cross-entry replays against its saved identity', async () => {
  const controller = fixture({ legacy: true });
  const command = vi.spyOn(controller, 'agentCommand').mockResolvedValue({ requestId: 'correction', conversationId: 1, status: 'accepted' });
  await controller.send({ text: 'Queued correction', params: {}, attachments: [] }, controller.current, true, 'correction', 'steer');
  const api = new EntryConversations(controller, session => conversationProjection('main', session, 'owner', 1));
  const input = { conversationId: 'chat', requestId: 'correction', text: 'Queued correction', params: {} };
  await api.invoke('submit', input);
  const reopened = new EntryConversations(controller, session => conversationProjection('main', session, 'owner', 1));
  await expect(reopened.invoke('submit', { ...input, text: 'Different content' })).rejects.toThrow(/requestId/);
  expect(command).not.toHaveBeenCalled();
});

it('retains the original retry input when independently forking an answer with a correction', async () => {
  const controller = fixture({ fork: true });
  const id = await controller.openAgentConversation('chat', 2);
  const fork = controller.sessions.find(session => session.id === id)!;
  expect(fork.messages.find(message => message.content === 'Queued correction')?.status).toBe('steer');
  expect(fork.messages.every(message => !message.runId && !message.sessionRequestId && !message.input)).toBe(true);
  const send = vi.spyOn(controller, 'send').mockResolvedValue();
  await controller.retry(fork.messages.at(-1)!.id!, fork);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Original task' }), fork, true);
});

it('rebuilds turns by execution position when an idle promotion runs before an older queued input', () => {
  const controller = fixture({ reordered: true });
  const expected = ['Original task', 'Queued correction', 'Promoted input', 'Older queued input'];
  expect(controller.current.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(expected);
  controller.restoreAgentState();
  expect(controller.current.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(expected);
});
