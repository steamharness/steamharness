// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ContentSearch } from '../web/ui/content-search';
import { ConversationOutput } from '../web/ui/conversation-output';
import { collapseIntermediateDefault } from '../web/ui/conversation-presentation';
import type { ConversationMessage, OutputItem, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
const outputs: ConversationOutput[] = [];
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const output of outputs.splice(0)) output.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); document.body.replaceChildren();
});
const text = (id: string, content: string): OutputItem => ({ id, content, contentType: 'markdown', metadata: { kind: 'agent-part', partType: 'text' } });
const tool: OutputItem = { id: 'tool', content: { tool: 'bash', status: 'success', input: { command: 'pwd' }, output: '/workspace' },
  contentType: 'json', collapsed: true, metadata: { kind: 'agent-part', partType: 'tool' } };
const turn = (): ConversationMessage => ({ id: 'a', role: 'assistant', content: 'Checking files\nFinal reply', status: 'success', durationMs: 1056000,
  items: [text('progress', 'Checking files'), tool, text('final', 'Final reply')] });
function setup() {
  const root = document.createElement('div'); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
  const update = (message: ConversationMessage, enabled = true) => output.update(message, 'project', 'session', [], 'local', '[]', enabled);
  return { root, output, update, process: () => root.querySelector<HTMLDetailsElement>('.conversation-process')! };
}

it('collapses each completed turn independently, preserves final replies and retains expanded tool state through updates', () => {
  const first = setup(), second = setup();
  first.update(turn()); second.update({ ...turn(), id: 'b', items: [text('progress', 'Next steps'), tool, text('final', 'Second final')] });
  expect(first.process().open).toBe(false); expect(second.process().open).toBe(false);
  expect(first.process().querySelector('summary')!.textContent).toContain('Worked for 17m 36s');
  expect(first.process().textContent).toContain('Checking files'); expect(first.process().textContent).not.toContain('Final reply');
  expect(first.root.lastElementChild!.textContent?.trim()).toBe('Final reply');
  expect(second.root.lastElementChild!.textContent?.trim()).toBe('Second final');
  const process = first.process(), final = first.root.lastElementChild;
  process.open = true;
  const detail = process.querySelector<HTMLDetailsElement>('.agent-activity-item')!; detail.open = true; detail.dispatchEvent(new Event('toggle'));
  first.update(turn());
  expect(first.process()).toBe(process); expect(process.open).toBe(true); expect(detail.open).toBe(true);
  expect(first.root.lastElementChild).toBe(final); expect(detail.querySelector('pre')!.textContent).toContain('pwd');
  first.update(turn(), false); expect(first.process()).toBeNull();
  expect([...first.root.children].map(child => child.className)).toEqual(['message-content', 'activity-group single-activity', 'message-content']);
  expect(first.root.lastElementChild).toBe(final); expect(second.process().open).toBe(false);
  first.update(turn()); expect(first.process().open).toBe(false);
});

it.each(['running', 'sending', 'failed', 'aborted', 'waiting', undefined])('keeps %s output fully visible and folds when it succeeds', status => {
  const view = setup(); view.update({ ...turn(), status });
  expect(view.process()).toBeNull(); expect(view.root.firstElementChild!.textContent?.trim()).toBe('Checking files');
  view.update(turn()); expect(view.process().open).toBe(false);
});

it('does not hide unresolved input, errors, or a turn without a final result', () => {
  const view = setup();
  for (const patch of [
    { pendingInput: { requestId: 'review', fields: [] } }, { error: 'Run failed' },
    { items: [tool] }, { items: [text('only', 'Only final reply')] },
  ]) { view.update({ ...turn(), ...patch } as ConversationMessage); expect(view.process()).toBeNull(); }
  view.update({ ...turn(), items: [text('progress', 'Checking'), tool, text('empty', '  ')] });
  // Text before a trailing tool/empty part is progress, without a final result yet.
  expect(view.process()).toBeNull();
  expect(view.root.querySelector(':scope > .message-content')!.textContent?.trim()).toBe('Checking');
});

it('keeps a plan, trailing citations, usage and resource previews visible outside the process', () => {
  const view = setup();
  const card: OutputItem = { id: 'card', content: { tool: 'workflow-ui_present_card', status: 'success', input: {
    action: 'upsert', cardId: 'preview', kind: 'browser', title: 'Preview', target: { url: 'https://example.com' }, preview: true,
  } }, metadata: { kind: 'agent-part', partType: 'tool' } };
  const ring: OutputItem = { id: 'usage', display: { type: 'ring', placement: 'inline' }, content: { value: 4, total: 10 } };
  const citation: OutputItem = { id: 'sources', content: '- source', contentType: 'markdown', collapsed: true, metadata: { kind: 'agent-part', partType: 'sources' }, title: 'Sources' };
  const message = { ...turn(), items: [text('progress', 'Checking'), tool, card, text('more-progress', 'Checking again'), { ...tool, id: 'another-tool' }, text('final', 'Final reply'), citation, ring] };
  view.update(message);
  expect(view.process().querySelector('.resource-card')).toBeNull(); expect(view.process().querySelector('.output-detail')).toBeNull();
  const resource = view.root.querySelector<HTMLElement>(':scope > .resource-card')!; expect(resource).not.toBeNull();
  const frame = document.createElement('iframe'); resource.querySelector('.resource-inline')!.append(frame);
  const mount = vi.spyOn(view.root, 'insertBefore');
  view.update(message, false); view.update(message);
  expect(mount.mock.calls.some(([node]) => node === resource)).toBe(false);
  expect(view.root.querySelector('.resource-card')).toBe(resource); expect(frame.isConnected).toBe(true);
  expect(view.process().contains(frame)).toBe(false);
  view.update({ ...turn(), items: [text('progress', 'Planning'), tool, { id: 'plan', content: 'The final plan', contentType: 'markdown', collapsed: true, metadata: { kind: 'agent-notice', plan: true } }] });
  expect(view.root.querySelector(':scope > .plan-card')).not.toBeNull(); expect(view.process().textContent).toContain('Planning');
});

it('uses explicit defaults for ordinary projects and defaults Core Agent output to folding', () => {
  const project = { conversation: {} } as Project;
  expect(collapseIntermediateDefault(project, [])).toBe(false);
  expect(collapseIntermediateDefault(project, [turn()])).toBe(true);
  project.conversation!.collapseIntermediate = false; expect(collapseIntermediateDefault(project, [turn()])).toBe(false);
  project.conversation!.collapseIntermediate = true; expect(collapseIntermediateDefault(project, [])).toBe(true);
});

it('offers a persistent project preference, replays folded history, and clears expansion when switching conversations', async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const resizes: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizes.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  host.getState.mockReturnValue({ collapseIntermediate: { 'file:///other': false } });
  document.body.innerHTML = '<div id="app"></div>'; await import('../web/ui/main');
  const transcript = document.querySelector<HTMLElement>('#transcript')!;
  let height = 1000, top = 0;
  Object.defineProperties(transcript, { scrollHeight: { get: () => height }, clientHeight: { get: () => 400 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, height - 400)); } } });
  const project: Project = { id: 'project', uri: 'file:///project', folderPath: '/project', name: 'Agent', projectType: 'conversation', fields: [], entrypoints: [] };
  const emit = (id = 'one') => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', project, activeId: id, running: false,
      sessions: [{ id, title: 'Conversation', messages: [turn()], createdAt: 1, updatedAt: 1 }] } }));
    for (let i = 0; i < 2; i++) for (const frame of frames.splice(0)) frame(0);
  };
  emit(); const button = document.querySelector<HTMLButtonElement>('#collapse-intermediate')!;
  expect(button.hidden).toBe(false); expect(button.getAttribute('aria-pressed')).toBe('true');
  const process = document.querySelector<HTMLDetailsElement>('.conversation-process')!; process.open = true;
  emit(); expect(document.querySelector('.conversation-process')).toBe(process); expect(process.open).toBe(true);
  expect(top).toBe(600); process.open = false; process.querySelector('summary')!.click();
  height = 1600; for (const resize of resizes) resize();
  for (let i = 0; i < 2; i++) for (const frame of frames.splice(0)) frame(0);
  expect(top).toBe(600);
  button.click(); expect(button.getAttribute('aria-pressed')).toBe('false'); expect(document.querySelector('.conversation-process')).toBeNull();
  expect(host.setState.mock.lastCall?.[0].collapseIntermediate).toEqual({ 'file:///other': false, 'file:///project': false });
  emit('two'); expect(document.querySelector('.conversation-process')).toBeNull();
  button.click(); expect(document.querySelector<HTMLDetailsElement>('.conversation-process')!.open).toBe(false);
  document.querySelector<HTMLDetailsElement>('.conversation-process')!.open = true;
  emit('three'); expect(document.querySelector<HTMLDetailsElement>('.conversation-process')!.open).toBe(false);
  project.uri = 'file:///other'; emit('four'); expect(button.getAttribute('aria-pressed')).toBe('false');
});

it('reveals matching intermediate prose when searching a folded turn', () => {
  const view = setup(); view.update(turn());
  const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const navigate = vi.fn(); const search = new ContentSearch(view.root, navigate); search.open();
  const input = document.querySelector<HTMLInputElement>('.content-search input')!;
  input.value = 'Checking files'; input.dispatchEvent(new Event('input'));
  expect(view.process().open).toBe(true); expect(navigate).toHaveBeenCalledOnce(); expect(scroll).toHaveBeenCalledOnce();
  expect(view.process().querySelector('mark')!.textContent).toBe('Checking files');
  search.close(); expect(view.process().querySelector('mark')).toBeNull();
});
