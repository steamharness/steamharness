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
    const next = { type: 'state', project, serverData, stateRevision: ++revision, serverInstanceId: 'process', authenticationRevision: 1,
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

it.each(['en','zh-CN'] as const)('shows a database recovery action for the affected assistant entry (%s)',async language=>{
  const f=await fixture('conversation',language);
  Object.assign(f.project,{assistant:{workdir:'/project',roots:[]}});
  await f.render({checking:false,blocking:true,issue:{kind:'setup-required',database:'memory'},checks:[{id:'database:memory',projectId:f.project.id,entryId:'main',database:'memory',stage:'database',status:'action-required'}]});
  expect(document.getElementById('server-guidance')!.hidden).toBe(false);
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
  expect(document.getElementById('server-checks-list')!.textContent).toContain('memory');
  expect(document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
  await f.render({checking:false,blocking:false,checks:[]});
  expect(document.getElementById('server-guidance')!.hidden).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(false);
});

it.each(['workflow', 'conversation'] as const)('keeps Stop available in %s and only offers rechecking for access or Server compatibility problems', async kind => {
  const f = await fixture(kind, 'en');
  await f.render({ checking: false, blocking:true, issue: { kind: 'access-denied', serverUrl: 'https://server.test' } }, true);
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
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
