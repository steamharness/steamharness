// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSession, ParamState, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

async function fixture({ dynamic = true, resolveOnInput = false, running = false } = {}) {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset(); host.getState.mockReturnValue(undefined); host.setState.mockReset();
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener, options });
      add(type, listener, options);
    });
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? false : matches.call(this, selector);
  });
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); };
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = { id: 'parameters', uri: 'file:///parameters', folderPath: '/parameters', name: 'Parameters', projectType: 'conversation',
    fields: [
      { name: 'model', type: 'string', control: 'select', panel: 'auxiliary', resolveOnInput, options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }], defaultValue: 'alpha' },
      { name: 'note', type: 'string', panel: 'auxiliary' },
      { name: 'mode', type: 'string', panel: 'mode', options: [{ value: 'build' }, { value: 'plan' }], defaultValue: 'build' },
    ],
    paramResolver: dynamic ? { enabled: true } : undefined,
    paramLayout: { actions: [
      { kind: 'quick', id: 'ai', label: 'Model', params: ['model'], summary: ['model'] },
      { kind: 'auxiliary', id: 'advanced', label: 'Advanced', params: ['note'] },
      { kind: 'mode', name: 'mode' }, { kind: 'slash', name: 'mode' },
    ] }, entrypoints: [], conversation: { inputQueue: { enabled: true } },
  };
  const sessions: ConversationSession[] = ['first', 'second'].map(id => ({ id, title: id, messages: [], createdAt: 1, updatedAt: 1 }));
  let state = { type: 'state', project, sessions, activeId: 'first', running, authenticationRevision: 1, parameterRevision: 1, serverInstanceId: 'instance' };
  const emit = (message: object) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  host.postMessage.mockImplementation(message => {
    if (message.type === 'navigate') queueMicrotask(() => emit({ ...message, type: 'navigated', activeId: message.id }));
  });
  const receive = (patch: Partial<typeof state> = {}) => {
    state = { ...state, ...patch };
    if (patch.running !== undefined || running) {
      const session = state.sessions.find(session => session.id === state.activeId)!;
      session.activeRunId = state.running ? 'run' : undefined;
      session.messages = state.running ? [{ id: 'run', role: 'assistant', content: 'Working', status: 'running' }]
        : session.messages.map(message => message.status === 'running' ? { ...message, status: 'success' } : message);
    }
    emit(state); frame();
  };
  const requests = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'resolve');
  const reply = (params: Record<string, ParamState> = {}, request = requests().at(-1)!) => emit({ ...request, type: 'params', params });
  const input = document.querySelector<HTMLTextAreaElement>('#message')!;
  const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const loading = () => !document.querySelector<HTMLElement>('#parameter-status')!.hidden;
  const action = (id: string) => document.querySelector<HTMLButtonElement>(`[data-action-id="${id}"]`)!;
  receive();
  return { project, sessions, emit, receive, requests, reply, input, type, loading, action };
}

it('renders static parameters without a worker or loading state while typing and receiving run updates', async () => {
  const f = await fixture({ dynamic: false });
  expect(f.requests()).toHaveLength(0); expect(f.loading()).toBe(false);
  f.type('hello'); await vi.advanceTimersByTimeAsync(1000);
  f.receive({ running: true }); f.type('next turn'); await vi.advanceTimersByTimeAsync(1000);
  f.receive({ running: false });
  expect(f.requests()).toHaveLength(0); expect(f.loading()).toBe(false);
  expect(f.input.value).toBe('next turn');
});

it('loads dynamic parameters once and reuses the per-conversation cache on navigation', async () => {
  const f = await fixture();
  expect(f.requests()).toHaveLength(1); expect(f.loading()).toBe(true);
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'Cached Alpha' }, { value: 'beta' }] } });
  expect(f.loading()).toBe(false); expect(f.action('ai').textContent).toContain('Cached Alpha');
  f.type('draft'); await vi.advanceTimersByTimeAsync(1000);
  for (let index = 0; index < 4; index++) f.receive({ running: index < 3 });
  expect(f.requests()).toHaveLength(1);
  f.receive({ activeId: 'second' }); expect(f.requests()).toHaveLength(2);
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'Second Alpha' }] } });
  f.receive({ activeId: 'first' });
  expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false);
  expect(f.action('ai').textContent).toContain('Cached Alpha'); expect(f.input.value).toBe('draft');
});

it('coalesces edits, ignores stale replies and keeps cached menus and Slash commands usable during refresh', async () => {
  const f = await fixture(); f.reply();
  f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  const edit = async (value: string) => { note.value = value; note.dispatchEvent(new Event('input')); await vi.advanceTimersByTimeAsync(200); };
  await edit('one'); const old = f.requests().at(-1)!;
  await edit('two'); await edit('three');
  expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false);
  expect(f.action('advanced').disabled).toBe(false); expect(f.action('mode').disabled).toBe(false);
  f.input.focus(); f.type('/plan'); f.input.setSelectionRange(5, 5); f.input.dispatchEvent(new Event('keyup'));
  expect(document.querySelector<HTMLElement>('#slash-menu')!.hidden).toBe(false);
  f.reply({ note: { value: 'obsolete' } }, old);
  expect(note.value).toBe('three'); expect(f.requests()).toHaveLength(3);
  expect(f.requests().at(-1)!.params.note).toBe('three');
  f.reply(); expect(f.loading()).toBe(false); expect(note.value).toBe('three');
});

it('only resolves opted-in input, debounces IME composition and pauses all background work during a run', async () => {
  const f = await fixture({ resolveOnInput: true }); f.reply();
  f.input.dispatchEvent(new CompositionEvent('compositionstart'));
  f.type('ni'); await vi.advanceTimersByTimeAsync(1000); expect(f.requests()).toHaveLength(1);
  f.input.dispatchEvent(new CompositionEvent('compositionend')); f.type('你好');
  await vi.advanceTimersByTimeAsync(349); expect(f.requests()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false);
  const old = f.requests().at(-1)!;
  f.receive({ running: true }); f.type('next draft'); await vi.advanceTimersByTimeAsync(1000);
  f.receive({ parameterRevision: 2 });
  expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false); expect(f.input.disabled).toBe(false);
  f.reply({ model: { value: 'beta' } }, old);
  f.receive({ running: false });
  expect(f.requests()).toHaveLength(3); expect(f.requests().at(-1)!.draftText).toBe('next draft');
  expect(f.requests().at(-1)!.params.model).toBe('alpha'); f.reply();
  expect(f.loading()).toBe(false); expect(f.input.value).toBe('next draft');
});

it('refreshes after configuration, identity, restart and reconnect changes without losing a parameter draft', async () => {
  const f = await fixture(); f.reply();
  f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  note.value = 'keep me'; note.dispatchEvent(new Event('input')); await vi.advanceTimersByTimeAsync(200); f.reply();
  for (const patch of [{ parameterRevision: 2 }, { authenticationRevision: 2 }, { serverInstanceId: 'replacement' }]) {
    const count = f.requests().length;
    f.receive(patch); expect(f.requests()).toHaveLength(count + 1); f.reply();
    expect(note.value).toBe('keep me'); expect(document.querySelector('#param-note')).toBe(note);
  }
  const count = f.requests().length;
  f.emit({ type: 'connection', status: 'reconnecting' }); f.emit({ type: 'connection', status: 'connected' });
  expect(f.requests()).toHaveLength(count + 1); f.reply(); expect(note.value).toBe('keep me');
});

it.each(['timeout', 'transport', 'host-rejection'])('ends %s failures, retains cached choices and supports explicit retry', async failure => {
  const f = await fixture(); f.reply();
  f.action('mode').click(); const request = f.requests().at(-1)!;
  if (failure === 'timeout') await vi.advanceTimersByTimeAsync(40_000);
  else if (failure === 'transport') f.emit({ type: 'error', requestType: 'resolve', requestId: request.requestId, sessionId: request.sessionId, message: 'Connection failed' });
  else {
    f.reply(); host.postMessage.mockImplementationOnce(() => Promise.reject(new Error('Host rejected')));
    f.action('mode').click(); await Promise.resolve();
  }
  expect(f.loading()).toBe(false); expect(document.querySelector<HTMLElement>('#parameter-error')!.hidden).toBe(false);
  expect(f.action('advanced').disabled).toBe(false);
  const count = f.requests().length;
  document.querySelector<HTMLButtonElement>('#refresh-params')!.click(); expect(f.requests()).toHaveLength(count + 1);
  f.reply(); expect(document.querySelector<HTMLElement>('#parameter-error')!.hidden).toBe(true);
});

it('stops obsolete work on send, keeps the next draft and does not reload parameters throughout the run', async () => {
  const f = await fixture(); f.reply(); f.type('first turn');
  document.querySelector<HTMLButtonElement>('#send')!.click();
  const send = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send')!;
  expect(send.text).toBe('first turn'); expect(send.params.model).toBe('alpha');
  f.emit({ ...send, type: 'sent' });
  f.sessions[0] = { ...f.sessions[0], messages: [{ id: send.requestId, role: 'assistant', content: 'Working', status: 'running' }] };
  f.receive({ sessions: [...f.sessions], running: true }); f.type('next turn'); await vi.advanceTimersByTimeAsync(1000);
  f.sessions[0].messages[0].status = 'success'; f.receive({ sessions: [...f.sessions], running: false });
  expect(f.requests()).toHaveLength(1); expect(f.loading()).toBe(false); expect(f.input.value).toBe('next turn');
});

it('retains a freshly validated model from the server until its options refresh after the run', async () => {
  const f = await fixture();
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'Old model' }] } });
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'beta' } } };
  f.receive({ sessions: [...f.sessions], running: true });
  expect(f.requests()).toHaveLength(1); expect(f.action('ai').textContent).toContain('beta');
  f.receive({ running: false }); expect(f.requests()).toHaveLength(2);
  expect(f.requests().at(-1)!.params.model).toBe('beta');
  f.reply({ model: { resolvedOptions: [{ value: 'beta', label: 'Current model' }] } });
  expect(f.action('ai').textContent).toContain('Current model'); expect(f.loading()).toBe(false);
});

it('offers a compact manual refresh that bypasses a valid cache without blocking parameter controls', async () => {
  const f = await fixture(); f.reply();
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-params')!;
  expect(refresh.closest('.run-options')).not.toBeNull(); expect(refresh.hidden).toBe(false);
  refresh.click(); expect(f.requests()).toHaveLength(2);
  expect(f.loading()).toBe(false); expect(f.action('advanced').disabled).toBe(false);
  expect(refresh.classList.contains('refreshing')).toBe(false);
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'New catalogue' }] } });
  expect(f.action('ai').textContent).toContain('New catalogue');
});
