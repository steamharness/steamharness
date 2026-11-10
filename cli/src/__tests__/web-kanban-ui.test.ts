// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { KANBAN_PREVIEW_READY_MESSAGE } from '@steamharness/kanban-project';
import type { ProjectServerIssue, ProjectServerState } from '../web/project-server-state';

const cleanup: (() => void)[] = [];
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function fixture(language: 'en' | 'zh-CN') {
  vi.resetModules(); vi.useFakeTimers();
  history.replaceState(null, '', '/'); sessionStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  document.body.dataset.accountHost = 'true';
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    add(type, listener, options); cleanup.push(() => remove(type, listener, options));
  });
  vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  // jsdom does not implement the iframe sandbox token list or dialog methods.
  Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', { configurable: true, get(this: HTMLIFrameElement) {
    return { add: (...tokens: string[]) => this.setAttribute('sandbox', tokens.join(' ')) };
  } });
  cleanup.push(() => { delete (HTMLIFrameElement.prototype as Partial<HTMLIFrameElement>).sandbox; });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  cleanup.push(() => {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
    delete document.body.dataset.accountHost;
  });
  const fetcher = vi.fn(async (_url?: unknown, _options?: any) => ({ ok: true, status: 200, json: async () => ({ messages: [] as any[] }) }));
  vi.stubGlobal('fetch', fetcher);
  const sources: Source[] = [];
  class Source {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    close = vi.fn();
    addEventListener() {}
    constructor() { sources.push(this); }
  }
  vi.stubGlobal('EventSource', Source);
  (await import('@steamharness/i18n')).initI18n({ preference: language });
  await import('../web/ui/kanban-main');
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  const receive = (state: object) => sources.at(-1)!.onmessage!({ data: JSON.stringify(state) });
  const sendState = (revision: number, nonce = 'first', serverDataIssue?: ProjectServerIssue, serverData?: ProjectServerState, serverInstanceId = 'kanban-process') => receive({
    type: 'state', project: { id: 'map', entryId: 'board', aggregateName: 'Map aggregate', name: 'Map 2D', projectType: 'kanban', folderPath: '/map', uri: 'file:///map', fields: [], entrypoints: [], databases: [], entries: [{ entryId: 'board', type: 'kanban', name: 'Map 2D', databases: [] }] },
    account: { status: 'authenticated', serverUrl: 'https://server.test', revision,
      user: { userId: 'user', email: 'user@example.com', displayName: 'User' } },
    authenticationRevision: 1, stateRevision: revision, serverInstanceId,
    serverData,
    kanban: { revision, configuration: { id: 'profile', name: 'Default', params: {} },
      preview: { url: `/kanban/${nonce}/index.html`, nonce },
      databaseRevisions: [], serverDataIssue },
  });
  return { sources, sendState, receive, fetcher };
}

it.each(['en', 'zh-CN'] as const)('connects the real Kanban host without a sidebar and finishes loading (%s)', async language => {
  const { sources, sendState } = await fixture(language);
  const status = document.getElementById('preview-status')!;
  expect(status.dataset.error).toBe('false');
  expect(status.textContent).toContain(language === 'en' ? 'Loading Kanban' : '正在加载看板');
  expect(document.getElementById('project-menu')).toBeNull();
  const account = document.querySelector<HTMLButtonElement>('.toolbar-actions > #web-account')!;
  expect(account).not.toBeNull(); expect(account.hidden).toBe(true);
  sources[0].onopen!(); sendState(1);
  expect(account.hidden).toBe(false);
  expect(document.getElementById('connection-status')!.hidden).toBe(true);
  expect(document.getElementById('kanban-title')!.textContent).toBe('Map 2D');
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  expect(frame.src).toContain('/kanban/first/index.html');
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { type: KANBAN_PREVIEW_READY_MESSAGE, nonce: 'first' } }));
  expect(status.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(status.hidden).toBe(true); expect(status.dataset.error).toBe('false');
});

it('copies only current preview requests through the UI clipboard and delegates focused edits', async () => {
  const writeText = vi.fn(async () => {});
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  cleanup.push(() => { if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard); else delete (navigator as any).clipboard; });
  const { sources, sendState, fetcher } = await fixture('en');
  sources[0].onopen!(); sendState(1);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!, replies = vi.spyOn(frame.contentWindow!, 'postMessage');
  const copy = { type: 'steamharness:kanban-copy', version: 1, nonce: 'first', requestId: 'copy-1', text: '正文与引用\nconst n = 1;' };
  const send = (source: MessageEventSource | null, data: object) => window.dispatchEvent(new MessageEvent('message', { source, data }));
  send(null, copy); send(frame.contentWindow!, { ...copy, nonce: 'stale' });
  expect(writeText).not.toHaveBeenCalled();
  send(frame.contentWindow!, copy);
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(copy.text));
  expect(fetcher.mock.calls.some(([, options]) => String(options?.body ?? '').includes('copy-1'))).toBe(false);
  await vi.waitFor(() => expect(replies).toHaveBeenCalledWith({ type: 'steamharness:kanban-copy-result', version: 1, nonce: 'first', requestId: 'copy-1', ok: true }, '*'));
  frame.focus();
  const command = new CustomEvent('project-edit-command', { cancelable: true, detail: { command: 'copy', restoreFocus: false } });
  window.dispatchEvent(command); expect(command.defaultPrevented).toBe(true);
  expect(replies).toHaveBeenCalledWith(expect.objectContaining({ type: 'steamharness:kanban-edit-command', command: 'copy', nonce: 'first' }), '*');
  writeText.mockRejectedValueOnce(new Error('clipboard denied'));
  send(frame.contentWindow!, { ...copy, requestId: 'copy-2' });
  await vi.waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'copy-2', ok: false }), '*'));
});

it.each(['entries.runEntrypoint', 'conversations.viewMessage'])('keeps the Workflow receipt window through the Kanban page adapter (%s)', async operation => {
  const { sources, sendState, fetcher } = await fixture('en');
  sources[0]!.onopen!(); sendState(1);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  const posted = vi.spyOn(frame.contentWindow!, 'postMessage');
  let finish!: () => void;
  fetcher.mockImplementationOnce((_url, options) => new Promise(resolve => {
    const message = JSON.parse(options.body);
    finish = () => resolve({ ok: true, status: 200, json: async () => ({ messages: [{ type: 'kanban-bridge-result', requestId: message.requestId, ok: true, value: 'durable receipt' }] }) });
  }));
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: {
    type: 'steamharness:kanban-bridge-request', nonce: 'first', requestId: 'slow-receipt', operation,
    input: operation === 'entries.runEntrypoint' ? { entryId: 'api', entrypointId: 'send', args: [], requestId: 'submit' } : { viewId: 'view', message: { type: 'send' } },
  } }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(finish).toBeTypeOf('function');
  expect(posted.mock.calls.filter(([message]) => message.type === 'steamharness:kanban-bridge-response')).toHaveLength(0);
  finish(); await vi.advanceTimersByTimeAsync(1);
  expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'steamharness:kanban-bridge-response', requestId: 'slow-receipt', ok: true, value: 'durable receipt' }), '*');
});

it('preserves a transport interruption code when a pending native view request is cancelled', async () => {
  const { sendState, fetcher, sources } = await fixture('en');
  sendState(1);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  const posted = vi.spyOn(frame.contentWindow!, 'postMessage');
  fetcher.mockImplementationOnce(() => new Promise(() => {}));
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: {
    type: 'steamharness:kanban-bridge-request', nonce: 'first', requestId: 'interrupted-native',
    operation: 'conversations.viewMessage', input: { viewId: 'view', message: { type: 'navigate' } },
  } }));
  sources[0]!.onerror!();
  await vi.advanceTimersByTimeAsync(1);
  expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'steamharness:kanban-bridge-response',
    requestId: 'interrupted-native', ok: false, error: expect.objectContaining({ code: 'KANBAN_BRIDGE_UNAVAILABLE' }) }), '*');
});

it('offers retry when an iframe fails to become ready and recovers on a fresh preview', async () => {
  const { sendState } = await fixture('en'); sendState(1);
  const status = document.getElementById('preview-status')!;
  await vi.advanceTimersByTimeAsync(10_001);
  expect(status.dataset.error).toBe('true');
  expect(status.textContent).toContain('Failed to load Kanban');
  expect(document.getElementById('retry-preview')!.hidden).toBe(false);
  sendState(2, 'second');
  expect(status.dataset.error).toBe('false');
  expect(document.getElementById('retry-preview')!.hidden).toBe(true);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { type: KANBAN_PREVIEW_READY_MESSAGE, nonce: 'first' } }));
  expect(status.hidden).toBe(false);
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { type: KANBAN_PREVIEW_READY_MESSAGE, nonce: 'second' } }));
  expect(status.hidden).toBe(true);
});

it.each(['en', 'zh-CN'] as const)('keeps the map mounted and stabilizes connection feedback through repeated interruptions (%s)', async language => {
  const { sources, sendState } = await fixture(language);
  sendState(1);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!, preview = frame.src;
  const banner = document.getElementById('connection-status')!;
  sources[0].onerror!();
  await vi.advanceTimersByTimeAsync(500);
  expect(banner.hidden).toBe(true);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(sources).toHaveLength(2); sendState(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(banner.hidden).toBe(true); expect(frame.src).toBe(preview);

  sources[1].onerror!();
  await vi.advanceTimersByTimeAsync(750);
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain(language === 'en' ? 'Reconnecting...' : '正在重新连接...');
  await vi.advanceTimersByTimeAsync(1_250);
  expect(sources).toHaveLength(3); sendState(3);
  await vi.advanceTimersByTimeAsync(500);
  expect(banner.hidden).toBe(false);
  sources[2].onerror!();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(banner.hidden).toBe(false); expect(frame.src).toBe(preview);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sources).toHaveLength(4); sendState(4);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(banner.hidden).toBe(true); expect(frame.src).toBe(preview);
});

it('publishes one current method catalog for a burst of map registrations and stops publishing after page departure', async () => {
  const { sendState, fetcher } = await fixture('en'); sendState(1);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { nonce: 'first', ...data } }));
  send({ type: KANBAN_PREVIEW_READY_MESSAGE, documentId: 'map-document' });
  const methods = Array.from({ length: 11 }, (_, index) => ({ name: `map.query${index}`, description: 'Map query', inputSchema: { type: 'object' }, readOnly: true }));
  for (let revision = 1; revision <= methods.length; revision++) send({ type: 'steamharness:kanban-method-catalog', documentId: 'map-document', configurationId: 'profile', revision, methods: methods.slice(0, revision) });
  const publications = () => fetcher.mock.calls.filter(([, options]) => options?.body && JSON.parse(options.body).type === 'kanban-method-state');
  expect(publications()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(50);
  expect(publications()).toHaveLength(1);
  expect(JSON.parse(publications()[0]![1].body).methods).toEqual(methods);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(publications()).toHaveLength(2);
  send({ type: 'steamharness:kanban-method-catalog', documentId: 'map-document', configurationId: 'profile', revision: 12, methods: [] });
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(publications()).toHaveLength(2);
});

it('does not send unchanged configuration back on ready acknowledgements or state snapshots', async () => {
  const { sendState } = await fixture('en'); sendState(1);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const ready = () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { type: KANBAN_PREVIEW_READY_MESSAGE, nonce: 'first', documentId: 'map' } }));
  ready(); ready(); sendState(2); ready();
  const configurations = () => post.mock.calls.filter(([message]) => message.type === 'steamharness:kanban-configuration');
  expect(configurations()).toHaveLength(1);
  frame.dispatchEvent(new Event('load')); ready();
  expect(configurations()).toHaveLength(2);
});

it.each(['en', 'zh-CN'] as const)('checks startup silently before mounting Server previews and only shows failures (%s)', async language => {
  const { sendState, sources } = await fixture(language);
  const checks: NonNullable<ProjectServerState['checks']> = [{ id: 'project', projectId: 'map', stage: 'registration', status: 'checking' }];
  sendState(1, 'first', undefined, { checking: true, checks });
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  expect(frame.getAttribute('src')).toBeNull(); expect(document.getElementById('preview-stage')!.hidden).toBe(true);
  const overview = document.getElementById('server-checks-list')!;
  const guidance = document.getElementById('server-guidance')!;
  expect(overview.textContent).not.toBe('');
  expect(guidance.hidden).toBe(true);
  sendState(2, 'ready', undefined, { checking: false, checks: [{ ...checks[0], status: 'passed' }] });
  expect(guidance.hidden).toBe(true); expect(frame.src).toContain('/kanban/ready/index.html');
  expect(document.getElementById('preview-stage')!.hidden).toBe(false);
  sendState(1, 'stale', undefined, { checking: false, checks: [{ ...checks[0], status: 'action-required', issue: { kind: 'project-unavailable' } }], issue: { kind: 'project-unavailable' } });
  sources[0].onopen!();
  expect(guidance.hidden).toBe(true);
  expect(frame.src).toContain('/kanban/ready/index.html');
  sendState(3, 'local', undefined, { checking: false, blocking: false, issue: { kind: 'project-unavailable' },
    checks: [{ ...checks[0], status: 'action-required', issue: { kind: 'project-unavailable' } }] });
  expect(guidance.hidden).toBe(false); expect(overview.textContent).not.toBe(''); expect(document.getElementById('preview-stage')!.hidden).toBe(false);
  expect(frame.src).toContain('/kanban/local/index.html');
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(false);
});

it('rejects late Kanban states from a retired service after accepting its replacement', async () => {
  const { sendState } = await fixture('en');
  sendState(10, 'old');
  sendState(1, 'replacement', undefined, { checking: false }, 'replacement-process');
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  expect(frame.src).toContain('/kanban/replacement/index.html');
  sendState(11, 'retired');
  expect(frame.src).toContain('/kanban/replacement/index.html');
  sendState(1, 'duplicate', undefined, { checking: true }, 'replacement-process');
  expect(frame.src).toContain('/kanban/replacement/index.html');
});

it('does not restore a blocked Server preview from the page cache or keep its previous document running', async () => {
  const { sendState } = await fixture('en');
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  sendState(1, 'blocked', undefined, { checking: true });
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(frame.getAttribute('src')).toBeNull();
  sendState(2, 'ready', undefined, { checking: false });
  expect(frame.src).toContain('/kanban/ready/index.html');
  sendState(3, 'ready', undefined, { checking: true });
  expect(frame.getAttribute('src')).toBe('about:blank');
  expect(document.querySelector<HTMLButtonElement>('#methods')!.disabled).toBe(true);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(frame.getAttribute('src')).toBe('about:blank');
  sendState(4, 'ready', undefined, { checking: false });
  expect(frame.src).toContain('/kanban/ready/index.html');
});

it.each(['en', 'zh-CN'] as const)('offers recovery settings and explains project creation in Server guidance (%s)', async language => {
  const { sources, sendState, fetcher } = await fixture(language);
  const parent = { postMessage: vi.fn() };
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  sources[0].onopen!();
  window.dispatchEvent(new MessageEvent('message', { source: parent as unknown as Window, data: { type: 'workflow-host', projectSetupVersion: 1 } }));
  sendState(1, 'missing', { kind: 'project-unavailable', serverUrl: 'https://server.test' });
  const guidance = document.getElementById('server-guidance')!;
  expect(guidance.hidden).toBe(false);
  expect(guidance.textContent).toContain(language === 'en' ? 'new project ID' : '新的项目 ID');
  expect([...guidance.querySelectorAll('button')].filter(button => !button.hidden).map(button => button.id)).toEqual(['server-guidance-create', 'server-guidance-retry']);
  expect(document.getElementById('server-guidance-account')!.hidden).toBe(true);
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(false);
  expect(document.getElementById('server-guidance-create')!.textContent).toBe(language === 'en' ? 'Create cloud project' : '创建云端项目');
  expect(document.getElementById('preview-stage')!.hidden).toBe(true);
  expect(document.getElementById('database-warning')!.hidden).toBe(true);
  const frame = document.querySelector<HTMLIFrameElement>('#kanban-preview')!;
  expect(frame.getAttribute('src')).toBeNull();
  fetcher.mockImplementation(async (_url?: unknown, options?: any) => {
    const message = JSON.parse(options.body);
    expect(message.type).toBe('project-server-check');
    return { ok: true, status: 200, json: async () => ({ messages: [{ type: 'state', stateRevision: 2, serverInstanceId: 'kanban-process', project: { id: 'map', entryId: 'board', aggregateName: 'Map aggregate', name: 'Map 2D', projectType: 'kanban', folderPath: '/map', uri: 'file:///map', fields: [], entrypoints: [], databases: [], entries: [{ entryId: 'board', type: 'kanban', name: 'Map 2D', databases: [] }] }, account: { status: 'authenticated' }, authenticationRevision: 1, kanban: {
      revision: 2, configuration: { id: 'profile', name: 'Default', params: {} }, preview: { url: '/kanban/ready/index.html', nonce: 'ready' }, databaseRevisions: [],
    } }, { type: 'project-server-checked', requestId: message.requestId }] }) };
  });
  document.getElementById('server-guidance-retry')!.click();
  expect((document.getElementById('server-guidance-retry') as HTMLButtonElement).disabled).toBe(true);
  await vi.waitFor(() => expect(guidance.hidden).toBe(true));
  expect(document.getElementById('preview-stage')!.hidden).toBe(false);
  expect(frame.src).toContain('/kanban/ready/index.html');
});

it.each(['en', 'zh-CN'] as const)('opens database management directly from blocked Kanban guidance (%s)', async language => {
  const { sources, sendState, fetcher } = await fixture(language);
  sources[0].onopen!();
  sendState(1, 'blocked', { kind: 'setup-required', database: 'annotations' });
  const action = document.querySelector<HTMLButtonElement>('#server-guidance-databases')!;
  expect(action.hidden).toBe(false); expect(action.disabled).toBe(false);
  expect(action.textContent).toBe(language === 'en' ? 'Configure database' : '配置数据库');
  fetcher.mockImplementation(async (_url?: unknown, options?: any) => {
    const message = JSON.parse(options.body);
    expect(message).toMatchObject({ type: 'databases', action: 'get' });
    return { ok: true, status: 200, json: async () => ({ messages: [{ type: 'databases-result', requestId: message.requestId, value: { requirements: [] } }] }) };
  });
  action.click();
  const dialog = document.querySelector<HTMLDialogElement>('.project-information-dialog')!;
  expect(dialog.open).toBe(true);
  await vi.waitFor(() => expect(dialog.querySelector('.project-databases')!.getAttribute('aria-busy')).not.toBe('true'));
  expect(document.querySelector<HTMLIFrameElement>('#kanban-preview')!.getAttribute('src')).toBeNull();
  expect(document.getElementById('server-guidance')!.hidden).toBe(false);
});

it('offers project creation without host upload support and hides it when access is denied', async () => {
  const { sendState } = await fixture('en');
  sendState(1, 'missing', { kind: 'project-unavailable', serverUrl: 'https://server.test' });
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(false);
  expect(document.getElementById('server-guidance-upload')).toBeNull();
  expect(document.getElementById('server-guidance-account')!.hidden).toBe(true);
  sendState(2, 'denied', { kind: 'access-denied', serverUrl: 'https://server.test' });
  expect(document.getElementById('server-guidance-title')!.textContent).toBe('Project access is required');
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
});

it.each(['en', 'zh-CN'] as const)('keeps Kanban failure guidance stable while rechecking (%s)', async language => {
  const { sendState } = await fixture(language);
  const failed: ProjectServerState = { checking: false, issue: { kind: 'connection-unavailable', status: 500, serverUrl: 'https://server.test' },
    checks: [{ id: 'project', projectId: 'map', stage: 'registration', status: 'action-required' }] };
  sendState(1, 'blocked', undefined, failed);
  const guidance = document.getElementById('server-guidance')!;
  const row = guidance.querySelector('li');
  const title = document.getElementById('server-guidance-title')!.textContent;
  const information = document.getElementById('server-guidance-server')!; information.focus();
  sendState(2, 'blocked', undefined, { ...failed, checking: true });
  expect(guidance.hidden).toBe(false); expect(guidance.querySelector('li')).toBe(row);
  expect(document.getElementById('server-guidance-title')!.textContent).toBe(title);
  expect(document.activeElement).toBe(information);
  expect(document.getElementById('server-guidance-server')!.hidden).toBe(false);
  expect(document.getElementById('methods')!.hidden).toBe(true);
  expect(document.getElementById('server-guidance-description')!.textContent).toContain('HTTP 500');
  sendState(3, 'ready', undefined, { checking: false });
  expect(guidance.hidden).toBe(true); expect(document.getElementById('preview-stage')!.hidden).toBe(false);
});

it('opens the cloud project through the Studio host and shows navigation errors next to its action', async () => {
  const { sendState } = await fixture('en');
  const parent = { postMessage: vi.fn() }; vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  const popup = vi.spyOn(window, 'open');
  window.dispatchEvent(new MessageEvent('message', { source: parent as unknown as Window, data: { type: 'workflow-host', serverProjectVersion: 1 } }));
  sendState(1, 'failed', { kind: 'connection-unavailable', status: 500, serverUrl: 'https://server.test' });
  const button = document.querySelector<HTMLButtonElement>('#server-guidance-server')!; button.click();
  const request = parent.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'workflow-server-project');
  expect(request).toMatchObject({ version: 1, projectId: 'map' }); expect(button.disabled).toBe(true); expect(popup).not.toHaveBeenCalled();
  window.dispatchEvent(new MessageEvent('message', { source: parent as unknown as Window,
    data: { type: 'workflow-host', serverProjectOpened: { version: 1, requestId: request.requestId, error: 'Unable to open Server Web' } } }));
  await vi.waitFor(() => expect(document.getElementById('server-guidance-action-error')!.textContent).toBe('Unable to open Server Web'));
  expect(button.disabled).toBe(false);
});

it('opens a standalone Server project tab using the authenticated handoff returned by its host', async () => {
  const { sendState, fetcher } = await fixture('en');
  sendState(1, 'failed', { kind: 'connection-unavailable', status: 500, serverUrl: 'https://server.test' });
  const popup = { opener: window, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const url = `https://server.test/api/auth/browser-session?code=${'a'.repeat(43)}`;
  fetcher.mockImplementation(async (_url?: unknown, options?: any) => {
    expect(JSON.parse(options.body).type).toBe('project-server-open');
    return { ok: true, status: 200, json: async () => ({ messages: [{ type: 'project-server-open-url', url }] }) };
  });
  document.querySelector<HTMLButtonElement>('#server-guidance-server')!.click();
  await vi.waitFor(() => expect(popup.location.href).toBe(url));
  expect(popup.opener).toBeNull(); expect(popup.close).not.toHaveBeenCalled();
});
