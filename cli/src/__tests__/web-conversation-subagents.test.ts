// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import type { AgentSessionSnapshot, AgentSessionTask } from 'steamharness/agent';
import { conversationSubagents } from '../web/ui/conversation-subagents';
import { ConversationOutput } from '../web/ui/conversation-output';

const task = (id: number, values: Partial<AgentSessionTask> = {}): AgentSessionTask => ({
  id, conversationId: 1, kind: 'project.delegation', label: `Video ${id}`, status: 'waiting', phase: 'wait',
  background: true, stopping: false, blockedOn: [], ...values,
});
const snapshot = (): AgentSessionSnapshot => ({
  ownerId: 'owner', conversationId: 1,
  conversations: [{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 1, forkEntryId: 6 }],
  tasks: [task(10, { childConversationId: 2, agent: { taskId: 10, workId: 'video', agentId: 'researcher', label: 'Research video',
    status: 'waiting', attempt: 2, childConversationId: 2, progress: { completed: 2, total: 3, phase: 'evidence' } } }),
  task(11, { status: 'running', phase: 'create' }), task(20, { conversationId: 2, kind: 'pi.tool', toolName: 'read', label: 'Read evidence' }),
  task(21, { kind: 'pi.tool', toolName: 'subagent' }), task(30, { conversationId: 3 })],
  history: [task(12, { status: 'completed', details: { status: 'completed', result: 'Saved evidence' }, childConversationId: 2 }),
    task(13, { status: 'faulted', details: { status: 'faulted', error: { message: 'Provider unavailable' } } })],
} as AgentSessionSnapshot);

const outputs: ConversationOutput[] = [];
afterEach(() => { for (const output of outputs.splice(0)) output.dispose(); document.body.replaceChildren(); initI18n({ preference: 'en' }); });
function mount() {
  const root = document.createElement('div'), open = vi.fn(); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {}, subagent: open }); outputs.push(output);
  const render = (frame: AgentSessionSnapshot | undefined, status = 'running', connected = true, scope?: number) => {
    output.update({ role: 'assistant', content: 'Coordinator update', status }, 'project', 'entry', 'session', []);
    output.updateSubagents(conversationSubagents(frame, scope, connected));
  };
  return { root, open, output, render };
}

it('counts actual delegations once, resolves anonymous children and isolates conversations and independent forks', () => {
  const frame = snapshot(); frame.history.push(task(10, { status: 'failed' }));
  const model = conversationSubagents(frame, undefined, true)!;
  expect(model.tasks.map(task => task.id)).toEqual([10, 11, 12, 13]);
  expect(model.tasks.map(task => task.status)).toEqual(['running', 'queued', 'completed', 'failed']);
  expect(model.tasks[0]).toMatchObject({ role: 'researcher', childId: 2, activity: 'Read evidence', attempt: 2, progress: { completed: 2, total: 3 } });
  expect(model.tasks[2]).toMatchObject({ childId: 2, result: 'Saved evidence' });
  expect(model.tasks[3].error).toBe('Provider unavailable');
  expect(conversationSubagents(frame, 2, true)).toBeUndefined();
  expect(conversationSubagents(frame, 3, true)!.tasks.map(task => task.id)).toEqual([30]);
  expect(conversationSubagents(undefined, undefined, true)).toBeUndefined();
  frame.conversations = frame.conversations.filter(conversation => conversation.id !== 2);
  expect(conversationSubagents(frame, 1, true)!.tasks[2].childId).toBeUndefined();
});

it('keeps the response label, discloses real progress and preserves row identity, focus and expansion through completion', () => {
  const { root, open, render } = mount(), frame = snapshot(); render(frame);
  const button = root.querySelector<HTMLButtonElement>('.subagents-button')!, panel = root.querySelector<HTMLElement>('.subagents-panel')!;
  expect(root.querySelector('.pending-label')!.textContent).toBe('Responding...');
  expect(button.parentElement).toBe(root.querySelector('.pending'));
  expect(button.textContent).toContain('1 Running'); expect(button.textContent).toContain('1 Queued'); expect(button.textContent).toContain('1 Failed');
  expect(panel.hidden).toBe(true); expect(panel.querySelectorAll('.subagent-task')).toHaveLength(0);
  button.click(); expect(panel.hidden).toBe(false); expect(button.getAttribute('aria-expanded')).toBe('true');
  const row = panel.querySelector<HTMLDetailsElement>('[data-task-id="10"]')!; row.open = true;
  expect(row.textContent).toContain('Role: researcher'); expect(row.textContent).toContain('Read evidence'); expect(row.textContent).toContain('2/3 completed');
  const link = row.querySelector<HTMLButtonElement>('.subagent-open')!; link.focus(); link.click(); expect(open).toHaveBeenLastCalledWith(2, 'owner');
  const list = panel.querySelector('.subagents-list')!; list.scrollTop = 120;
  frame.tasks[0].agent!.progress!.completed = 3; render(frame);
  expect(root.querySelector('[data-task-id="10"]')).toBe(row); expect(row.open).toBe(true); expect(document.activeElement).toBe(link); expect(list.scrollTop).toBe(120);
  expect(row.textContent).toContain('3/3 completed');
  render(frame, 'success'); expect(root.querySelector('.pending')).toBeNull(); expect(button.isConnected).toBe(true); expect(row.open).toBe(true);
  expect(root.querySelector('.subagents-summary')!.contains(button)).toBe(true);
  expect(root.querySelector('[data-task-id="13"]')!.textContent).toContain('Provider unavailable');
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(panel.hidden).toBe(true); expect(document.activeElement).toBe(button);
});

it('retains last known state offline, disables navigation, and uses the current owner after reconnect', () => {
  const { root, open, render } = mount(), frame = snapshot(); render(frame); root.querySelector<HTMLButtonElement>('.subagents-button')!.click();
  const row = root.querySelector<HTMLDetailsElement>('[data-task-id="10"]')!; row.open = true;
  render(frame, 'success', false);
  const link = row.querySelector<HTMLButtonElement>('.subagent-open')!; expect(link.disabled).toBe(true); link.click(); expect(open).not.toHaveBeenCalled();
  expect(root.querySelector<HTMLElement>('.subagents-connection')!.hidden).toBe(false);
  frame.ownerId = 'replacement'; render(frame, 'success'); expect(row.open).toBe(true); expect(link.disabled).toBe(false);
  link.click(); expect(open).toHaveBeenLastCalledWith(2, 'replacement');
  render(frame, 'success', true, 3); expect(root.querySelector<HTMLElement>('.subagents-panel')!.hidden).toBe(true);
  root.querySelector<HTMLButtonElement>('.subagents-button')!.click(); expect(root.querySelector('[data-task-id="10"]')).toBeNull();
  render(undefined); expect(root.querySelector('.subagents-button')).toBeNull(); expect(root.querySelector('.subagents-panel')).toBeNull();
});

it.each(['en', 'zh-CN'] as const)('renders localized labels in %s and preserves literal user content', language => {
  initI18n({ preference: language });
  const { root, render } = mount(), frame = snapshot(); frame.tasks[0].label = '<img src=x onerror=alert(1)>';
  frame.tasks[0].agent!.label = frame.tasks[0].label; render(frame); root.querySelector<HTMLButtonElement>('.subagents-button')!.click();
  expect(root.querySelector('.subagents-button')!.textContent).toContain(language === 'en' ? 'Subagents' : '子 Agent');
  expect(root.querySelector('.subagent-meta')!.textContent).toContain(language === 'en' ? 'Role: researcher' : '角色：researcher');
  expect(root.querySelector('.subagent-title')!.textContent).toBe(frame.tasks[0].label); expect(root.querySelector('img')).toBeNull();
});

it('marks interrupted outstanding work without changing successful history', () => {
  const model = conversationSubagents(snapshot(), undefined, true, true)!;
  expect(model.tasks.map(task => task.status)).toEqual(['interrupted', 'interrupted', 'completed', 'failed']);
});

it('distinguishes a stop request from a settled cancellation and blocked or queued work', () => {
  const frame = snapshot(); frame.tasks[0].stopping = true; frame.tasks[1].status = 'blocked'; frame.tasks[1].phase = 'wait';
  frame.history[0].status = 'aborted';
  expect(conversationSubagents(frame, undefined, true)!.tasks.map(task => task.status)).toEqual(['stopping', 'waiting', 'stopped', 'failed']);
});

it('keeps newly active work above history and preserves focused details when a task moves after settlement', () => {
  const { root, render } = mount(), frame = snapshot(); frame.tasks.push(task(99, { childConversationId: 2 })); render(frame);
  root.querySelector<HTMLButtonElement>('.subagents-button')!.click();
  expect(Array.from(root.querySelectorAll('.subagent-task'), row => row.getAttribute('data-task-id'))).toEqual(['10', '11', '99', '12', '13']);
  const row = root.querySelector<HTMLDetailsElement>('[data-task-id="10"]')!; row.open = true;
  const link = row.querySelector<HTMLButtonElement>('.subagent-open')!; link.focus(); frame.tasks[0].status = 'completed'; render(frame);
  expect(Array.from(root.querySelectorAll('.subagent-task'), row => row.getAttribute('data-task-id'))).toEqual(['11', '99', '10', '12', '13']);
  expect(document.activeElement).toBe(link); expect(row.open).toBe(true);
});
