// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectServerState } from '../web/project-server-state';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
});
async function fixture(kind: 'workflow' | 'conversation', language: 'en' | 'zh-CN') {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset(); host.getState.mockReset(); host.setState.mockReset();
  document.body.innerHTML = '<div id="app"></div>';
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    add(type, listener, options); cleanup.push(() => remove(type, listener, options));
  });
  vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  cleanup.push(() => {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  cleanup.push(() => { delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  (await import('@steamharness/i18n')).initI18n({ preference: language });
  await (kind === 'workflow' ? import('../web/ui/workflow-main') : import('../web/ui/main'));
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/project',databases:[],entries:[{entryId:"main",name:"Main",type:kind,root:".",entry:"index.ts",databases:[]}], id: 'server-project', uri: 'file:///server-project', folderPath: '/project', name: 'Server project', projectType: kind,
    fields: [{ name: 'subject', type: 'string', flag: '--subject' }], entrypoints: [], conversation: { inputQueue: { enabled: true } } };
  const messages = [{ id: 'saved-answer', role: 'assistant', content: 'Previous result', status: 'success' }];
  let revision = 0;
  const render = async (serverData?: ProjectServerState, running = false) => {
    const next = { type: 'state', project, aggregate: { name: project.aggregateName, entries: project.entries.map(entry => ({ ...entry, status: 'idle', href: `/entries/${entry.entryId}/` })) }, serverData, stateRevision: ++revision, serverInstanceId: 'process', authenticationRevision: 1,
      account: { status: 'authenticated', revision: 1, serverUrl: 'https://server.test' },
      ...(kind === 'workflow' ? { runs: [], drafts: { '': { scopeId: 'draft', values: { subject: 'Original' }, rawArgs: '[]', inputMode: 'form', policies: {} } }, history: { total: 0 }, running }
        : { sessions: [{ id: 'session', title: 'History', ...(running ? { activeRunId: 'active-run' } : {}), messages: messages.map(message => ({ ...message, status: running ? 'running' : message.status })), draft: { text: 'Original draft', attachments: [] },
          queuedInputs: [{ id: 'queued', text: 'Keep queued', params: {}, attachments: [], createdAt: 1 }] }], activeId: 'session', running }),
    };
    emit(next);
    await vi.advanceTimersByTimeAsync(1);
    const resolve = host.postMessage.mock.calls.map(([value]) => value).filter(value => value.type === 'resolve').at(-1);
    if (resolve) emit({ type: 'params', requestId: resolve.requestId, sessionId: 'session', entrypointId: resolve.entrypointId, params: {} });
    return next;
  };
  emit({ type: 'connection', status: 'connected' }); emit({ type: 'project-setup-available', upload: true });
  return { emit, render, project };
}

it.each(['workflow', 'conversation'] as const)('keeps %s startup guidance after replacement and ignores states from the retired service', async kind => {
  const f = await fixture(kind, 'en');
  const old = await f.render({ checking: false });
  f.emit({ ...old, serverInstanceId: 'replacement', stateRevision: 1,
    serverData: { checking: false, blocking:true, issue: { kind: 'project-unavailable' } } });
  await vi.advanceTimersByTimeAsync(1);
  const run = document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#run' : '#send')!;
  expect(run.disabled).toBe(true);
  f.emit({ ...old, stateRevision: 100 });
  await vi.advanceTimersByTimeAsync(1);
  expect(run.disabled).toBe(true);
  expect(document.getElementById('server-guidance')!.hidden).toBe(false);
});

it.each(['workflow', 'conversation'] as const)('keeps %s guidance when a child frame posts an application state', async kind => {
  const f = await fixture(kind, 'en');
  const current = await f.render({ checking: false, blocking:true, issue: { kind: 'project-unavailable' } });
  const child = document.createElement('iframe'); document.body.append(child);
  window.dispatchEvent(new MessageEvent('message', { source: child.contentWindow, data: { ...current, stateRevision: 100, serverData: { checking: false } } }));
  await vi.advanceTimersByTimeAsync(1);
  expect(document.getElementById('server-guidance')!.hidden).toBe(false);
  window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { ...current, stateRevision: 2, serverData: { checking: false } } }));
  await vi.advanceTimersByTimeAsync(1);
  expect(document.getElementById('server-guidance')!.hidden).toBe(true);
});

it.each([
  ['conversation', 'en'], ['conversation', 'zh-CN'], ['workflow', 'en'], ['workflow', 'zh-CN'],
] as const)('opens database management from %s guidance and completes an explicit request, approval and binding (%s)',async (kind, language)=>{
  const f=await fixture(kind,language);
  if (kind === 'conversation') Object.assign(f.project,{assistant:{workdir:'/project',roots:[]}});
  await f.render({checking:false,blocking:true,issue:{kind:'setup-required',database:'memory'},checks:[{id:'database:memory',projectId:f.project.id,entryId:'main',database:'memory',stage:'database',status:'action-required'}]});
  expect(document.getElementById('server-guidance')!.hidden).toBe(false);
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
  expect(document.getElementById('server-checks-list')!.textContent).toBe(`memory · ${language === 'en' ? 'Action required' : '需要处理'}`);
  const execute = document.querySelector<HTMLButtonElement>(kind === 'conversation' ? '#send' : '#run')!;
  expect(execute.disabled).toBe(true);
  const action = document.querySelector<HTMLButtonElement>('#server-guidance-databases')!;
  expect(action.hidden).toBe(false); expect(action.disabled).toBe(false);
  expect(action.textContent).toBe(language === 'en' ? 'Open database management' : '打开数据库管理');
  const requests = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'databases');
  expect(requests()).toEqual([]);
  action.click();
  const dialog = document.querySelector<HTMLDialogElement>('.database-dialog')!;
  expect(dialog.open).toBe(true); expect(requests()).toHaveLength(1);
  expect(requests()[0].action).toBe('get');
  const permissions = { kv: { read: { mode: 'all' }, write: { mode: 'all' } }, knowledge: { read: { mode: 'all' }, write: { mode: 'all' } } };
  const databaseId = '00000000-0000-4000-8000-000000000001';
  const requirement = { alias: 'memory', databaseId, status: 'invalid' };
  const catalog = { spaces: [] as any[], requests: [] as any[], bindings: [] as any[], grants: [] as any[] };
  const respond = (requirements: object[] = [requirement], environmentOverrides: string[] = []) => f.emit({ type: 'databases-result', requestId: requests().at(-1)!.requestId, value: { projectId: f.project.id, entryId: f.project.entryId, requirements, environmentOverrides, local: catalog } });
  const click = (en: string, zh: string) => {
    const control = [...dialog.querySelectorAll('button')].find(button => button.textContent === (language === 'en' ? en : zh))!;
    expect(control.disabled).toBe(false); control.click();
    return requests().at(-1)!;
  };
  respond();
  const name = dialog.querySelector<HTMLInputElement>(`input[aria-label="${language === 'en' ? 'New space name' : '新空间名称'}"]`)!;
  const requestAlias = [...dialog.querySelectorAll<HTMLInputElement>('input')].find(input => input.value === 'data')!; requestAlias.value = 'memory';
  expect(name.value).toBe('Test aggregate / Server project');
  name.value = 'Assistant memory';
  expect(click('Request new space', '申请新空间')).toMatchObject({ action: 'request', host: 'local', alias: 'memory', target: { kind: 'create', name: 'Assistant memory' } });
  catalog.requests.push({ requestId: 'request', projectId: f.project.id, entryId: f.project.entryId, alias: 'memory', target: { kind: 'create', name: name.value }, status: 'pending', permissions });
  respond();
  expect(dialog.textContent).toContain(language === 'en' ? 'Pending approval' : '待审批');
  expect(requests().map(message => message.action)).toEqual(['get', 'request']);
  const review = click('Approve', '批准');
  expect(review).toMatchObject({ action: 'review', host: 'local', databaseRequestId: 'request', approve: true, permissions });
  expect(review.requestId).not.toBe(review.databaseRequestId);
  catalog.requests[0].status = 'approved'; catalog.requests[0].databaseId = databaseId;
  catalog.bindings.push({ projectId: f.project.id, entryId: f.project.entryId, alias: 'memory', bindingRef: 'approved-binding', grantId: 'grant' });
  respond();
  expect(dialog.textContent).toContain(databaseId);
  expect(click('Save database reference', '保存数据库引用')).toMatchObject({ action: 'bind', alias: 'memory', databaseId });
  respond([{ ...requirement, status: 'bound', space: { name: name.value, host: 'local' } }]);
  await f.render({checking:false,blocking:false,checks:[]});
  expect(document.getElementById('server-guidance')!.hidden).toBe(true);
  expect(execute.disabled).toBe(false);
  expect(requests().map(message => message.action)).toEqual(['get', 'request', 'review', 'bind']);
  dialog.querySelector<HTMLButtonElement>('header button')!.click();
  expect(dialog.open).toBe(false);
  [...document.querySelectorAll<HTMLButtonElement>('.aggregate-navigation button')].find(button => button.textContent === (language === 'en' ? 'Databases' : '数据库'))!.click();
  expect(dialog.open).toBe(true); expect(document.querySelectorAll('.database-dialog')).toHaveLength(1);
  expect(requests().at(-1)!.action).toBe('get');
  respond([requirement], ['memory']);
  expect(dialog.textContent).toContain(language === 'en' ? 'Changing an alias updates every entry that uses it.' : '修改别名映射会影响所有引用它的入口。');
  expect(dialog.textContent).toContain(language === 'en' ? 'This database ID is set by the environment.' : '此数据库 ID 由环境变量指定');
  expect(dialog.querySelector<HTMLInputElement>('input[aria-label="' + (language === 'en' ? 'Database ID' : '数据库 ID') + '"]')!.disabled).toBe(true);
  expect([...dialog.querySelectorAll('button')].find(button => button.textContent === (language === 'en' ? 'Save database reference' : '保存数据库引用'))!.disabled).toBe(true);
});

it('keeps the database recovery action disabled while disconnected and allows retrying a failed management request', async () => {
  const f = await fixture('conversation', 'en');
  await f.render({ checking: false, blocking: true, issue: { kind: 'setup-required', database: 'memory' } });
  const action = document.querySelector<HTMLButtonElement>('#server-guidance-databases')!;
  f.emit({ type: 'connection', status: 'disconnected' });
  expect(action.disabled).toBe(true); action.click();
  expect(host.postMessage.mock.calls.some(([message]) => message.type === 'databases')).toBe(false);
  f.emit({ type: 'connection', status: 'connected' });
  action.click();
  const request = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'databases')!;
  f.emit({ type: 'error', requestId: request.requestId, message: 'Database host unavailable' });
  expect(document.querySelector('.database-error')!.textContent).toBe('Database host unavailable');
  expect(document.querySelector('.database-dialog')!.hasAttribute('aria-busy')).toBe(false);
  document.querySelector<HTMLButtonElement>('.database-refresh')!.click();
  const requests = host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'databases');
  expect(requests).toHaveLength(2); expect(requests[1].action).toBe('get');
  expect(requests[1].requestId).not.toBe(request.requestId);
});

it.each(['local', 'server'] as const)('shows invalid %s bindings and finishes an explicit rejection without losing the response', async databaseHost => {
  const f = await fixture('conversation', 'en');
  await f.render({ checking: false, blocking: true, issue: { kind: 'setup-required', database: 'memory' } });
  document.querySelector<HTMLButtonElement>('#server-guidance-databases')!.click();
  const requests = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'databases');
  const catalog = { requests: [{ requestId: 'pending-request', projectId: f.project.id, entryId: f.project.entryId, alias: 'memory', status: 'pending', permissions: {}, target: { kind: 'access', spaceId: 'shared-space' } }], grants: [], bindings: [], spaces: [] };
  const respond = () => f.emit({ type: 'databases-result', requestId: requests().at(-1)!.requestId, value: { projectId: f.project.id, entryId: f.project.entryId, requirements: [{ alias: 'memory', databaseId: '00000000-0000-4000-8000-000000000001', status: 'invalid', error: 'Grant revoked' }], [databaseHost]: catalog } });
  respond();
  const dialog = document.querySelector<HTMLDialogElement>('.database-dialog')!;
  expect(dialog.textContent).toContain('Grant revoked');
  const reject = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Reject')!;
  reject.click();
  expect(requests().at(-1)).toMatchObject({ action: 'review', host: databaseHost, databaseRequestId: 'pending-request', approve: false });
  expect(requests().at(-1)!.requestId).not.toBe('pending-request');
  catalog.requests[0].status = 'rejected';
  respond();
  expect(dialog.hasAttribute('aria-busy')).toBe(false);
  expect([...dialog.querySelectorAll('button')].some(button => button.textContent === 'Request shared access')).toBe(true);
  expect(requests().map(message => message.action)).toEqual(['get', 'review']);
});

it.each(['workflow', 'conversation'] as const)('keeps Stop available in %s and only offers rechecking for access or Server compatibility problems', async kind => {
  const f = await fixture(kind, 'en');
  await f.render({ checking: false, blocking:true, issue: { kind: 'access-denied', serverUrl: 'https://server.test' } }, true);
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
  expect(document.getElementById('server-guidance-databases')!.hidden).toBe(true);
  const stop = document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#stop-active' : '#send')!;
  expect(stop.disabled).toBe(false);
  await f.render({ checking: false, blocking:true, issue: { kind: 'setup-required', serverUrl: 'https://server.test' } });
  expect(document.getElementById('server-guidance-description')!.textContent).toContain('Check again');
  if (kind === 'conversation') {
    expect(document.querySelector<HTMLButtonElement>('.queue-heading button')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.queued-input-actions button:nth-child(3)')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.queued-input-actions button:nth-child(4)')!.disabled).toBe(false);
  }
});
