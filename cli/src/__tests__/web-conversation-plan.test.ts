// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import type { AgentPlanItem } from 'steamharness/agent';
import type { ConversationMessage, OutputItem } from '../web/workflow-types';
import { conversationPlan } from '../web/ui/conversation-plan';
import { ConversationOutput } from '../web/ui/conversation-output';

const items = (): AgentPlanItem[] => [
  { id: 'audit', text: 'Audit existing evidence', status: 'completed' },
  { id: 'research', text: 'Research missing evidence', status: 'in_progress' },
  { id: 'save', text: 'Save verified results', status: 'pending' },
];
const update = (value: unknown = items(), status = 'success', id = 'plan'): OutputItem => ({
  id, content: { tool: 'update_plan', input: { items: value }, status }, contentType: 'json',
  metadata: { kind: 'agent-part', partType: 'tool', status },
});
const message = (patch: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'answer', role: 'assistant', status: 'running', content: '', items: [update()], ...patch,
});
const outputs: ConversationOutput[] = [];
afterEach(() => { for (const output of outputs.splice(0)) output.dispose(); document.body.replaceChildren(); initI18n({ preference: 'en' }); });
function mount() {
  const root = document.createElement('div'); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {}, subagent() {} }); outputs.push(output);
  const render = (value = message()) => output.update(value, 'project', 'entry', 'session', [], 'local', '[]', true);
  return { root, output, render, button: () => root.querySelector<HTMLButtonElement>('.plan-button')!,
    panel: () => root.querySelector<HTMLElement>('.plan-panel')! };
}

it('selects the last successful plan in this reply, ignoring pending, failed, foreign and malformed updates', () => {
  const latest = items(); latest[1].status = 'completed';
  const valid = update(latest, 'success', 'latest'); valid.content = JSON.stringify(valid.content);
  const foreign = update([]); foreign.metadata!.kind = 'opencode-part';
  const tools = [update(), valid, update([], 'running'), update([], 'failed'), foreign, update([{ id: 'broken' }])];
  expect(conversationPlan(message({ items: tools }))).toEqual({ items: latest, status: 'running' });
  expect(conversationPlan(message({ items: [...tools, update([])] }))).toBeUndefined();
  expect(conversationPlan(message({ items: [] }))).toBeUndefined();
  expect(conversationPlan(message({ role: 'user' }))).toBeUndefined();
  const result = conversationPlan(message())!; result.items[0].text = 'Client copy';
  expect(conversationPlan(message())!.items[0].text).toBe('Audit existing evidence');
});

it.each([
  null, {}, 'not an array', [{ id: 'a', text: 'Task', status: 'unknown' }],
  [{ id: 'a', text: 'Task', status: 'pending' }, { id: 'a', text: 'Duplicate', status: 'completed' }],
  [{ id: '', text: 'Task', status: 'pending' }], [{ id: 'a'.repeat(129), text: 'Task', status: 'pending' }],
  [{ id: 'a', text: 'x'.repeat(10_001), status: 'pending' }], Array.from({ length: 101 }, (_, id) => ({ id: String(id), text: 'Task', status: 'pending' })),
])('keeps the committed plan when a newer output has invalid input %#', invalid => {
  expect(conversationPlan(message({ items: [update(), update(invalid, 'success', 'bad')] }))!.items).toEqual(items());
});

it('requires a successful Core tool result and ignores broken serialized outputs', () => {
  const broken = update(); broken.content = '{';
  const other = update([]); (other.content as { tool: string }).tool = 'other_update_plan';
  const failed = update([]); failed.metadata!.status = 'failed';
  const nonTool = update([]); nonTool.metadata!.partType = 'text';
  expect(conversationPlan(message({ items: [update(), broken, other, failed, nonTool] }))!.items).toEqual(items());
  expect(conversationPlan(message({ items: [broken, other, failed, nonTool] }))).toBeUndefined();
});

it('shows a collapsed summary to the right of the response label and reveals ordered item states', () => {
  const view = mount(); view.render();
  expect(view.button().parentElement).toBe(view.root.querySelector('.pending'));
  expect(view.button().previousElementSibling?.className).toBe('pending-label');
  expect(view.button().textContent).toContain('Plan · 1/3'); expect(view.button().textContent).toContain('Research missing evidence');
  expect(view.panel().hidden).toBe(true); expect(view.button().getAttribute('aria-expanded')).toBe('false');
  expect(view.button().getAttribute('aria-controls')).toBe(view.panel().id);
  view.button().click(); expect(view.panel().hidden).toBe(false);
  expect([...view.root.querySelectorAll('.plan-item')].map(row => row.getAttribute('data-plan-id'))).toEqual(['audit', 'research', 'save']);
  expect([...view.root.querySelectorAll('.plan-item-status')].map(row => row.textContent)).toEqual(['Completed', 'In progress', 'Not started']);
  expect(view.root.querySelector<HTMLProgressElement>('.plan-header progress')!.value).toBe(1);
  const list = view.root.querySelector<HTMLElement>('.plan-list')!; list.focus();
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(view.panel().hidden).toBe(true); expect(document.activeElement).toBe(view.button());
});

it('preserves expansion, rows, selection, scroll and focus across revisions and confirmation pauses', () => {
  const view = mount(); view.render(); view.button().click();
  const list = view.root.querySelector<HTMLElement>('.plan-list')!, row = view.root.querySelector('[data-plan-id="research"]')!;
  list.scrollTop = 80; list.focus();
  const selection = window.getSelection()!, range = document.createRange(); range.selectNodeContents(row.querySelector('.plan-item-text')!);
  selection.removeAllRanges(); selection.addRange(range); expect(selection.toString()).toBe('Research missing evidence');
  const revised = items(); revised[0].text = 'Audit complete'; revised.push({ id: 'review', text: 'Review', status: 'pending' });
  view.render(message({ items: [update(), update(revised, 'success', 'revision')] }));
  expect(view.panel().hidden).toBe(false); expect(view.root.querySelector('[data-plan-id="research"]')).toBe(row);
  expect(list.scrollTop).toBe(80); expect(document.activeElement).toBe(list); expect(selection.toString()).toBe('Research missing evidence');
  view.button().focus(); view.render(message({ status: 'waiting_for_input' }));
  expect(document.activeElement).toBe(view.button()); expect(view.panel().dataset.state).toBe('waiting');
  expect(view.button().parentElement?.className).toContain('conversation-progress-summary');
  view.render(); expect(view.button().parentElement).toBe(view.root.querySelector('.pending')); expect(document.activeElement).toBe(view.button());
});

it('preserves backward text selection when fallback DOM moves reorder tasks or resume a confirmation pause', () => {
  const view = mount(); view.render(); view.button().click();
  const list = view.panel().querySelector<HTMLElement>('.plan-list')!;
  Object.defineProperty(list, 'moveBefore', { value: undefined });
  Object.defineProperty(view.root, 'moveBefore', { value: undefined });
  const text = view.panel().querySelector('[data-plan-id="research"] .plan-item-text')!.firstChild!;
  list.scrollTop = 80;
  const selected = window.getSelection()!; selected.setBaseAndExtent(text, text.textContent!.length, text, 0);
  const reordered = [items()[1], items()[0], items()[2]];
  const revised = message({ items: [update(), update(reordered, 'success', 'reordered')] });
  view.render(revised);
  expect(selected.toString()).toBe('Research missing evidence');
  expect(selected.anchorNode).toBe(text); expect(selected.anchorOffset).toBe(text.textContent!.length);
  view.render({ ...revised, status: 'waiting_for_input' }); view.render(revised);
  expect(selected.toString()).toBe('Research missing evidence');
  expect(selected.anchorNode).toBe(text); expect(selected.focusOffset).toBe(0);
  expect(list.scrollTop).toBe(80);
  view.render({ ...revised, status: 'success' }); expect(view.button()).toBeNull();
});

it('announces contextual progress outside the collapsed panel without competing status regions', () => {
  const view = mount(); view.render();
  const status = view.button().querySelector<HTMLElement>('[role="status"]')!;
  expect(status).not.toBeNull(); expect(status.getAttribute('aria-atomic')).toBe('true');
  expect(status.textContent).toBe('Plan · 1/3'); expect(view.panel().hidden).toBe(true);
  expect(view.panel().querySelector('[role="status"]')).toBeNull();
  const next = items(); next[1].status = 'completed';
  view.render(message({ items: [update(next)] }));
  expect(view.button().querySelector('[role="status"]')).toBe(status); expect(status.textContent).toBe('Plan · 2/3');
});

it('does not select replacement task text when a selected task is rewritten', () => {
  const view = mount(); view.render(); view.button().click();
  const text = view.panel().querySelector('[data-plan-id="research"] .plan-item-text')!;
  const selected = window.getSelection()!; selected.setBaseAndExtent(text, 0, text, 1);
  const revised = items(); revised[1].text = 'Revised research scope';
  expect(() => view.render(message({ items: [update(revised)] }))).not.toThrow();
  expect(selected.toString()).toBe('');
});

it('waits for successful response completion even at 100%, then removes both controls and restores focus', () => {
  const view = mount(); const complete = items().map(item => ({ ...item, status: 'completed' as const }));
  view.render(message({ items: [update(complete)] })); view.button().click(); view.button().focus();
  expect(view.button().textContent).toContain('3/3'); expect(view.panel().hidden).toBe(false);
  view.render(message({ status: 'success' }));
  expect(view.button()).toBeNull(); expect(view.panel()).toBeNull(); expect(document.activeElement).toBe(view.root);
  const restored = mount(); restored.render(message({ status: 'success' })); expect(restored.button()).toBeNull();
  view.render(message({ id: 'next', items: [] })); expect(view.button()).toBeNull();
});

it('clears empty plans, preserves keyed rows through reordering, and isolates replies with identical task ids', () => {
  const first = mount(), fork = mount(); first.render(); fork.render(message({ id: 'fork', items: [update([{ id: 'audit', text: 'Fork task', status: 'in_progress' }])] }));
  first.button().click(); fork.button().click();
  const audit = first.panel().querySelector('[data-plan-id="audit"]'), research = first.panel().querySelector('[data-plan-id="research"]');
  const reordered = [items()[1], items()[0]];
  first.render(message({ items: [update(), update(reordered, 'success', 'reordered')] }));
  expect([...first.panel().querySelectorAll('.plan-item')]).toEqual([research, audit]);
  expect(fork.panel().querySelector('.plan-item-text')!.textContent).toBe('Fork task');
  first.render(message({ items: [update(), update([], 'success', 'clear')] }));
  expect(first.button()).toBeNull(); expect(first.panel()).toBeNull(); expect(fork.panel().hidden).toBe(false);
});

it.each(['failed', 'timed_out', 'aborted'])('preserves %s progress outside collapsed intermediate steps and restores history', status => {
  const view = mount(); view.render(); view.button().click();
  view.render(message({ status, error: status === 'aborted' ? 'Stopped' : 'Provider failed' }));
  expect(view.button().textContent).toContain(status === 'aborted' ? 'Stopped' : 'Failed'); expect(view.panel().hidden).toBe(false);
  expect(view.panel().dataset.state).toBe(status === 'aborted' ? 'stopped' : 'failed');
  expect(view.panel().querySelector('[data-plan-id="research"] .plan-item-status')!.textContent).toBe('Incomplete');
  expect(view.panel().querySelector('.codicon-loading')).toBeNull();
  expect(view.panel().closest('.conversation-process')).toBeNull();
  const restored = mount(); restored.render(message({ status })); expect(restored.button()).not.toBeNull();
  view.render(); expect(view.panel().hidden).toBe(false); expect(view.panel().dataset.state).toBe('running');
});

it('keeps progress while confirming, recovering, stopping or disconnected and resumes without recreating rows', () => {
  const view = mount(); view.render(); view.button().click();
  const row = view.root.querySelector('[data-plan-id="research"]');
  view.output.setConnected(false); expect(view.panel().dataset.state).toBe('paused');
  expect(view.panel().querySelector<HTMLElement>('.plan-connection')!.hidden).toBe(false);
  expect(view.panel().querySelector('.codicon-loading')).toBeNull();
  view.output.setConnected(true); expect(view.panel().dataset.state).toBe('running');
  expect(view.root.querySelector('[data-plan-id="research"]')).toBe(row); expect(view.panel().hidden).toBe(false);
  for (const patch of [
    { status: 'success', pendingInput: { requestId: 'approve', nodeName: 'approval', title: 'Approve', params: [] } },
    { status: 'running', recovering: true }, { status: 'running', cancelRequested: true },
  ]) { view.render(message(patch)); expect(view.button()).not.toBeNull(); expect(view.panel().querySelector('.codicon-loading')).toBeNull(); }
});

it('keeps the plan and subagent panels independent, including completion and moving subagents to a new reply', () => {
  const first = mount(), second = mount(); first.render(); second.render(message({ id: 'second', items: [] }));
  first.output.updateSubagents({ ownerId: 'owner', conversationId: 1, connected: true, tasks: [{ id: 2, label: 'Child task', status: 'running' }] });
  const subagent = first.root.querySelector<HTMLButtonElement>('.subagents-button')!, subagentPanel = first.root.querySelector<HTMLElement>('.subagents-panel')!;
  expect([...first.root.querySelector('.pending')!.children].slice(-2)).toEqual([first.button(), subagent]);
  first.button().click(); subagent.click(); expect(first.panel().hidden).toBe(false); expect(subagentPanel.hidden).toBe(false);
  first.button().click(); expect(subagentPanel.hidden).toBe(false); first.button().click();
  first.render(message({ status: 'failed' })); first.output.moveSubagentsTo(second.output);
  expect(first.button().isConnected).toBe(true); expect(first.panel().hidden).toBe(false); expect(subagentPanel.parentElement).toBe(second.root);
  expect(second.button()).toBeNull();
  first.render(message({ status: 'success' })); expect(first.button()).toBeNull(); expect(subagentPanel.isConnected).toBe(true);
});

it.each(['en', 'zh-CN'] as const)('localizes status labels in %s and renders task text literally', language => {
  initI18n({ preference: language }); const view = mount(), plan = items(); plan[1].text = '<img src=x onerror=alert(1)>';
  view.render(message({ items: [update(plan)] })); view.button().click();
  expect(view.button().textContent).toContain(language === 'en' ? 'Plan · 1/3' : '计划 · 1/3');
  expect(view.panel().querySelector('[data-plan-id="save"]')!.textContent).toContain(language === 'en' ? 'Not started' : '待开始');
  expect(view.panel().querySelector('[data-plan-id="research"] .plan-item-text')!.textContent).toBe(plan[1].text);
  expect(view.panel().querySelector('img')).toBeNull();
  view.render(message({ items: [update(plan)], cancelRequested: true }));
  expect(view.button().textContent).toContain(language === 'en' ? 'Stopping...' : '正在停止...');
});
