// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren();
  for (const method of ['showModal', 'close']) Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

async function fixture() {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset(); host.getState.mockReturnValue(undefined); host.setState.mockReset();
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener, options }); add(type, listener, options);
    });
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); };
  document.body.innerHTML = '<div id="app"></div>'; await import('../web/ui/main');
  const project: Project = { id: 'fork-ui', uri: 'file:///fork-ui', folderPath: '/fork-ui', entryId: 'main', aggregateName: 'Fork', defaultEntry: 'main', entryRoot: '/fork-ui',
    databases: [], entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }], name: 'Fork', projectType: 'conversation', fields: [], entrypoints: [], conversation: { durable: { enabled: true } } };
  const sessions: ConversationSession[] = [
    { id: 'source', title: 'Source', messages: [{ id: 'answer', role: 'assistant', content: 'Selected answer', entryId: 42, status: 'success' }] },
    { id: 'fork', title: 'Fork', agentOwnerId: 'source', agentConversationId: 17, forkSource: { sessionId: 'source', entryId: 42 }, messages: [] },
  ];
  const emit = (message: object) => { window.dispatchEvent(new MessageEvent('message', { data: message })); frame(); };
  emit({ type: 'state', project, sessions, activeId: 'source', running: false, serverInstanceId: 'instance' });
  document.querySelector<HTMLButtonElement>('.fork-message')!.click();
  document.querySelector<HTMLFormElement>('.action-dialog form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const request = host.postMessage.mock.calls.map(([message]) => message).find(message => message.command?.type === 'fork');
  const dialog = () => document.querySelector<HTMLDialogElement>('.conversation-fork-dialog');
  const navigations = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigate');
  return { project, sessions, emit, request, dialog, navigations };
}

it('shows creation progress immediately, opens the successful branch and closes after navigation is confirmed', async () => {
  const f = await fixture();
  expect(f.request.requestId).toBe(f.request.command.requestId);
  expect(f.dialog()?.open).toBe(true); expect(f.dialog()?.getAttribute('aria-busy')).toBe('true');
  expect(f.dialog()?.textContent).toContain('Copying the history'); expect(f.dialog()?.querySelector('progress')?.hidden).toBe(false);
  f.emit({ type: 'agent-receipt', projectUri: f.project.uri, sessionId: 'source', requestId: 'another-request', forkSessionId: 'fork' });
  expect(f.navigations()).toHaveLength(0);
  f.emit({ type: 'agent-receipt', projectUri: f.project.uri, sessionId: 'source', requestId: f.request.requestId, forkSessionId: 'fork' });
  expect(f.dialog()?.textContent).toContain('Conversation fork created');
  expect(f.navigations().at(-1)).toMatchObject({ id: 'fork' });
  f.emit({ type: 'agent-receipt', projectUri: f.project.uri, sessionId: 'source', requestId: f.request.requestId, forkSessionId: 'fork' });
  f.emit({ ...f.request, type: 'error', message: 'Late creation error' });
  expect(f.navigations()).toHaveLength(1); expect(f.dialog()?.textContent).toContain('Conversation fork created');
  f.emit({ type: 'navigated', requestId: f.navigations().at(-1).requestId, activeId: 'fork' });
  expect(f.dialog()).toBeNull();
});

it('keeps a failed creation in the dialog with its reason and ignores unrelated errors', async () => {
  const f = await fixture();
  f.emit({ ...f.request, type: 'error', requestId: 'other-request', message: 'Unrelated failure' });
  expect(f.dialog()?.dataset.status).toBe('pending');
  f.emit({ ...f.request, type: 'error', requestType: 'agent-command', message: 'The selected history entry no longer exists.' });
  expect(f.dialog()?.dataset.status).toBe('failed'); expect(f.dialog()?.textContent).toContain('The selected history entry no longer exists.');
  expect(f.dialog()?.querySelector('progress')?.hidden).toBe(true); expect(f.navigations()).toHaveLength(0);
  f.dialog()!.querySelector<HTMLButtonElement>('button')!.click(); expect(f.dialog()).toBeNull();
});

it('distinguishes a saved fork from a navigation failure and bounds unconfirmed creation', async () => {
  const f = await fixture();
  await vi.advanceTimersByTimeAsync(35_000);
  expect(f.dialog()?.dataset.status).toBe('failed'); expect(f.dialog()?.textContent).toContain('Fork creation was not confirmed');
  f.emit({ type: 'agent-receipt', projectUri: f.project.uri, sessionId: 'source', requestId: f.request.requestId, forkSessionId: 'fork' });
  const navigation = f.navigations().at(-1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.dialog()?.textContent).toContain('Conversation created; could not open it');
  expect(f.dialog()?.textContent).toContain('opening it was not confirmed');
  f.emit({ type: 'error', requestType: 'navigate', requestId: navigation.requestId, projectUri: f.project.uri, sessionId: 'fork', message: 'Connection interrupted.' });
  expect(f.dialog()?.textContent).toContain('Conversation created; could not open it');
  expect(f.dialog()?.textContent).toContain('Connection interrupted.');
});

it('reports that the fork was saved if the new conversation is missing from page state', async () => {
  const f = await fixture();
  f.emit({ type: 'state', project: f.project, sessions: f.sessions.filter(session => session.id === 'source'), activeId: 'source', running: false, serverInstanceId: 'instance' });
  f.emit({ type: 'agent-receipt', projectUri: f.project.uri, sessionId: 'source', requestId: f.request.requestId, forkSessionId: 'fork' });
  expect(f.dialog()?.dataset.status).toBe('failed');
  expect(f.dialog()?.textContent).toContain('Conversation created; could not open it');
  expect(f.navigations()).toHaveLength(0);
});

it('blocks Escape while creating and ignores a late result after failed feedback is dismissed', async () => {
  const f = await fixture();
  const cancel = new Event('cancel', { cancelable: true });
  f.dialog()!.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true); expect(f.dialog()).not.toBeNull();
  await vi.advanceTimersByTimeAsync(35_000);
  expect(f.dialog()?.dataset.status).toBe('failed');
  f.dialog()!.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(f.dialog()).toBeNull();
  f.emit({ type: 'agent-receipt', projectUri: f.project.uri, sessionId: 'source', requestId: f.request.requestId, forkSessionId: 'fork' });
  expect(f.navigations()).toHaveLength(0);
});
