import { expect, it } from 'vitest';
import type { AgentSessionSnapshot, AgentSessionTurn } from 'steamharness/agent';
import { ConversationTimeline } from '../web/ui/conversation-timeline';
import type { ConversationMessage, ConversationSession, OutputItem } from '../web/workflow-types';

const text = (position: number, content: string): OutputItem => ({ id: `agent-session-task-${position}-0`, content, contentType: 'markdown' });
function fixture() {
  const turns: AgentSessionTurn[] = [
    { requestId: 'task', conversationId: 1, prompt: 'Task', mode: 'followUp', status: 'placed', entryId: 1, epoch: 0, items: [] },
    { requestId: 'correction', conversationId: 1, prompt: 'Correction', mode: 'steer', status: 'placed', entryId: 3, startedAt: 20, epoch: 0, items: [] },
  ];
  const agent: AgentSessionSnapshot = { version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: true, backgroundCount: 0, epoch: 0,
    configuration: { version: 0, provider: 'fixture', model: 'fixture', effort: 'off' }, prompt: { hash: 'test', version: 1 }, plan: { version: 0, items: [] },
    tasks: [], history: [], receipts: [], records: [], usage: [], contexts: [], turns, conversations: [{ id: 1, title: 'Main', background: false }] };
  const answer: ConversationMessage = { id: 'answer', role: 'assistant', content: 'Before\nAfter', createdAt: 10, status: 'running',
    sessionRequestId: 'task', items: [text(2, 'Before'), text(4, 'After')] };
  const correction: ConversationMessage = { id: 'steer:correction', role: 'user', status: 'steer', sessionRequestId: 'correction', content: 'Correction', createdAt: 20 };
  const session: ConversationSession = { id: 'chat', title: 'Chat', agent, messages: [{ id: 'input', role: 'user', content: 'Task', createdAt: 10 }, correction, answer] };
  return { session, answer, correction, turns };
}

it('splits a consumed correction at its ledger position during streaming and history replay', () => {
  const { session, answer } = fixture();
  const original = structuredClone(session);
  for (const status of ['running', 'success', 'failed', 'aborted']) {
    answer.status = status;
    const rows = new ConversationTimeline().project('project:chat', session);
    expect(rows.map(row => row.id)).toEqual(['input', 'answer', 'steer:correction', 'answer:after:correction']);
    expect(rows[1]).toMatchObject({ previous: true, message: { content: 'Before', status: 'interrupted', items: [text(2, 'Before')] } });
    expect(rows[3]).toMatchObject({ previous: false, message: { id: 'answer', content: 'After', status, items: [text(4, 'After')] } });
  }
  expect(session.messages.map(message => message.id)).toEqual(original.messages.map(message => message.id));
  expect(answer.items).toEqual(original.messages.at(-1)!.items);
});

it('shows Send now immediately and reconciles queued and consumed snapshots without moving its bubble', () => {
  const { session, answer, turns } = fixture();
  session.messages.splice(1, 1); turns.splice(1); answer.items = [text(2, 'Before')];
  const timeline = new ConversationTimeline();
  const promoted = { id: 'correction', text: 'Correction', createdAt: 20, params: {}, attachments: [] };
  const immediate = timeline.project('project:chat', session, [promoted]);
  expect(immediate.map(row => row.id)).toEqual(['input', 'answer', 'steer:correction', 'answer:after:correction']);
  expect(immediate[1].previous).toBe(true);
  turns.push({ requestId: 'correction', conversationId: 1, prompt: 'Correction', mode: 'steer', status: 'queued', epoch: 0, items: [] });
  session.queuedInputs = [promoted];
  expect(timeline.project('project:chat', structuredClone(session)).map(row => row.id)).toEqual(immediate.map(row => row.id));
  turns[1] = { ...turns[1], status: 'placed', entryId: 3, startedAt: 20 };
  session.queuedInputs = [];
  session.messages.splice(1, 0, { id: 'steer:correction', role: 'user', status: 'steer', sessionRequestId: 'correction', content: 'Correction', createdAt: 20 });
  answer.items.push(text(4, 'After'));
  const consumed = timeline.project('project:chat', session);
  expect(consumed.map(row => row.id)).toEqual(immediate.map(row => row.id));
  expect(consumed.at(-1)!.message.content).toBe('After');
  expect(new ConversationTimeline().project('project:chat', session)).toEqual(consumed);
});

it('keeps multiple corrections in separate sections and preserves ordinary and hidden follow-up replies', () => {
  const { session, answer, turns } = fixture();
  turns.push({ requestId: 'second', conversationId: 1, prompt: 'Second correction', mode: 'steer', status: 'done', entryId: 5, startedAt: 30, epoch: 0, items: [] });
  session.messages.splice(1, 0, { id: 'steer:second', role: 'user', status: 'steer', sessionRequestId: 'second', content: 'Second correction', createdAt: 30 });
  answer.items!.push(text(6, 'Last'));
  session.messages.push({ id: 'notification', role: 'assistant', content: 'Background result', createdAt: 40, status: 'success' });
  const rows = new ConversationTimeline().project('project:chat', session);
  expect(rows.map(row => row.id)).toEqual(['input', 'answer', 'steer:correction', 'answer:after:correction', 'steer:second', 'answer:after:second', 'notification']);
  expect(rows.filter(row => row.previous).map(row => row.message.content)).toEqual(['Before', 'After']);
  expect(rows.at(-2)?.message.content).toBe('Last');
  expect(rows.at(-1)?.message.content).toBe('Background result');
});

it('uses a live cut for unstructured output and restores the original reply after a failed promotion', () => {
  const { session, answer } = fixture();
  session.messages.splice(1, 1); session.agent = undefined; answer.items = undefined; answer.content = 'Before';
  const timeline = new ConversationTimeline();
  const input = { id: 'correction', text: 'Correction', createdAt: 20, params: {}, attachments: [] };
  timeline.project('project:chat', session, [input]);
  answer.content += ' After';
  const rows = timeline.project('project:chat', session, [input]);
  expect(rows[1].message.content).toBe('Before'); expect(rows.at(-1)?.message.content).toBe(' After');
  expect(timeline.project('project:chat', session).map(row => row.message)).toEqual(session.messages);
  expect(timeline.project('another:chat', session, [input])[1].message.content).toBe('Before After');
});
