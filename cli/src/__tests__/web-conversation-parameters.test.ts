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

async function fixture({ dynamic = true, resolveOnInput = false, running = false, requiredModel = false, savedState }: {
  dynamic?: boolean; resolveOnInput?: boolean; running?: boolean; requiredModel?: boolean; savedState?: object;
} = {}) {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset(); host.getState.mockReturnValue(savedState); host.setState.mockReset();
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
      { name: 'model', type: 'string', control: 'select', panel: 'auxiliary', resolveOnInput, required: requiredModel,
        options: requiredModel ? [] : [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }], defaultValue: requiredModel ? undefined : 'alpha' },
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

it('keeps pending parameter edits when switching conversations and applies newer accepted effects on return', async () => {
  const f = await fixture(); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { note: 'saved' } } };
  f.receive({ sessions: [...f.sessions] }); f.reply();
  f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  note.value = 'unsaved draft'; note.dispatchEvent(new Event('input'));
  f.receive({ activeId: 'second' }); f.reply();
  f.receive({ activeId: 'first' });
  expect(f.requests().at(-1)!.params.note).toBe('unsaved draft');
  f.reply(); f.action('advanced').click();
  expect(document.querySelector<HTMLInputElement>('#param-note')!.value).toBe('unsaved draft');
  f.receive({ activeId: 'second' }); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': {} }, parameterRevisions: { '': { note: 'accepted-clear' } } };
  f.receive({ sessions: [...f.sessions], activeId: 'first' });
  expect(f.requests().at(-1)!.params.note).toBe('');
});

it('restores saved parameter edits without replacing them with server values after reopening', async () => {
  const key = 'file:///parameters:first:';
  const f = await fixture({ savedState: { params: { [key]: { model: 'beta', note: 'restored draft' } }, parameterEdits: { [key]: { model: null, note: null } } } });
  expect(f.requests()[0].params).toMatchObject({ model: 'beta', note: 'restored draft' }); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'alpha', note: 'older server value' } } };
  f.receive({ sessions: [...f.sessions] });
  f.action('advanced').click();
  expect(document.querySelector<HTMLInputElement>('#param-note')!.value).toBe('restored draft');
  expect(f.action('ai').textContent).toContain('Beta');
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'alpha' } }, parameterRevisions: { '': { note: 'new-effect' } } };
  f.receive({ sessions: [...f.sessions] });
  expect(document.querySelector<HTMLInputElement>('#param-note')!.value).toBe('');
  expect(f.requests().at(-1)!.params.model).toBe('beta');
});

it('clears a removed server value', async () => {
  const f = await fixture(); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { note: 'saved' } } };
  f.receive({ sessions: [...f.sessions] }); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': {} } };
  f.receive({ sessions: [...f.sessions] });
  expect(f.requests().at(-1)!.params.note).toBe('');
});

it('protects a parameter reset from an older server value while other fields refresh', async () => {
  const f = await fixture(); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'beta', note: 'saved' } } };
  f.receive({ sessions: [...f.sessions] }); f.reply();
  f.action('ai').click(); document.querySelector<HTMLButtonElement>('.quick-reset')!.click();
  expect(f.action('ai').textContent).toContain('Alpha');
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'beta', note: 'remote update' } } };
  f.receive({ sessions: [...f.sessions] });
  expect(f.action('ai').textContent).toContain('Alpha');
});

it('releases obsolete background loading immediately when an edit returns to its cached value', async () => {
  const f = await fixture(); f.reply(); f.action('mode').click();
  const obsolete = f.requests().at(-1)!;
  f.action('mode').click();
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-params')!;
  expect(f.requests()).toHaveLength(2); expect(refresh.disabled).toBe(false);
  f.reply({ mode: { value: 'plan' } }, obsolete);
  expect(f.action('mode').textContent).toContain('build');
  refresh.click(); expect(f.requests()).toHaveLength(3);
});

it.each(['pending', 'failed'])('validates required dynamic defaults on send while initial loading is %s', async phase => {
  const f = await fixture({ requiredModel: true });
  const request = f.requests()[0];
  if (phase === 'failed') f.emit({ ...request, type: 'params', error: 'Catalogue unavailable' });
  f.type('resolve defaults when sending');
  document.querySelector<HTMLButtonElement>('#send')!.click();
  const send = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send');
  expect(send?.text).toBe('resolve defaults when sending');
  expect(f.loading()).toBe(false);
  f.reply({ model: { value: 'obsolete' } }, request);
  f.type('next draft');
  expect(f.input.value).toBe('next draft');
});

it('rebuilds changed parameter definitions after a service restart at the same project URI', async () => {
  const f = await fixture(); f.reply();
  const fields: Project['fields'] = [{ name: 'temperature', type: 'number', panel: 'auxiliary', defaultValue: '0.5' }];
  f.receive({ serverInstanceId: 'replacement', project: { ...f.project, fields, paramResolver: undefined,
    paramLayout: { actions: [{ kind: 'auxiliary', id: 'new-options', label: 'New options', params: ['temperature'] }] } } });
  expect(f.action('advanced')).toBeNull();
  f.action('new-options').click();
  expect(document.querySelector<HTMLInputElement>('#param-temperature')!.value).toBe('0.5');
  expect(f.requests()).toHaveLength(1); expect(f.loading()).toBe(false);
});

it('changes the parameter cache scope when an entrypoint is replaced with an identical definition', async () => {
  const f = await fixture(); f.reply();
  const parameters = { fields: f.project.fields, paramResolver: f.project.paramResolver, paramLayout: f.project.paramLayout };
  f.receive({ project: { ...f.project, projectType: 'workflow', entrypoints: [{ ...parameters, id: 'replacement' }] } });
  expect(f.requests()).toHaveLength(2); expect(f.requests().at(-1)!.entrypointId).toBe('replacement');
  f.reply();
  expect(host.setState.mock.calls.at(-1)![0].params['file:///parameters:first:replacement']).toBeDefined();
});

it('resumes a debounced parameter edit after a user-input prompt hides and restores the composer', async () => {
  const f = await fixture(); f.reply(); f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  note.value = 'pending edit'; note.dispatchEvent(new Event('input'));
  f.sessions[0] = { ...f.sessions[0], messages: [{ id: 'approval', role: 'assistant', content: '', status: 'waiting',
    pendingInput: { requestId: 'approval-input', nodeName: 'approval', title: 'Approval', params: [] } }] };
  f.receive({ sessions: [...f.sessions] });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.requests()).toHaveLength(1);
  f.sessions[0] = { ...f.sessions[0], messages: [] }; f.receive({ sessions: [...f.sessions] });
  expect(f.requests()).toHaveLength(2); expect(f.requests().at(-1)!.params.note).toBe('pending edit');
});
