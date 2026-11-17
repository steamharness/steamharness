// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectServerState } from '../web/project-server-state';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
});
async function fixture(kind: 'workflow' | 'bot', language: 'en' | 'zh-CN') {
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
  const project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/project',entries:[{entryId:"main",name:"Main",type:kind,root:".",entry:"index.ts"}], id: 'server-project', uri: 'file:///server-project', folderPath: '/project', name: 'Server project', projectType: kind,
    requiresLogin: true, fields: [{ name: 'subject', type: 'string', flag: '--subject' }], entrypoints: [], conversation: { inputQueue: { enabled: true } } };
  const messages = [{ id: 'saved-answer', role: 'assistant', content: 'Previous result', status: 'success' }];
  let revision = 0;
  const render = async (serverData?: ProjectServerState, running = false) => {
    const next = { type: 'state', project, aggregate: { name: project.aggregateName, entries: project.entries.map(entry => ({ ...entry, status: 'idle', href: `/entries/${entry.entryId}/` })) }, serverData, stateRevision: ++revision, serverInstanceId: 'process', authenticationRevision: 1,
      account: { status: 'error', revision: 1, serverUrl: 'https://server.test' },
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

it.each([
  ['bot', 'en'], ['bot', 'zh-CN'], ['workflow', 'en'], ['workflow', 'zh-CN'],
] as const)('runs %s without Server guidance or login gates (%s)', async (kind, language) => {
  const f = await fixture(kind, language);
  for (const serverData of [undefined, { checking: true },
    ...(['project-unavailable', 'connection-unavailable', 'sign-in-required', 'access-denied', 'setup-required'] as const)
      .map(kind => ({ checking: false, blocking: true, issue: { kind } })),
  ]) {
    await f.render(serverData);
    expect(document.getElementById('server-guidance')).toBeNull();
    expect(document.querySelector('.project-server-blocked')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#run' : '#send')!.disabled).toBe(false);
    if (kind === 'bot') {
      expect(document.querySelector<HTMLTextAreaElement>('#message')!.value).toBe('Original draft');
      expect(document.getElementById('transcript')!.textContent).toContain('Previous result');
    }
  }
  expect(host.postMessage.mock.calls.some(([message]) => message.type === 'project-server-check')).toBe(false);
  document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#run' : '#send')!.click();
  await vi.advanceTimersByTimeAsync(1);
  expect(host.postMessage.mock.calls.some(([message]) => message.type === (kind === 'workflow' ? 'workflow-run' : 'send'))).toBe(true);
});

it.each(['workflow', 'bot'] as const)('keeps %s usable when a replacement or a child sends old check state', async kind => {
  const f = await fixture(kind, 'en');
  const old = await f.render();
  f.emit({ ...old, serverInstanceId: 'replacement', stateRevision: 1,
    serverData: { checking: false, blocking: true, issue: { kind: 'project-unavailable' } } });
  f.emit({ ...old, serverData: { checking: true } });
  const frame = document.createElement('iframe'); document.body.append(frame);
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { ...old, serverData: { checking: true } } }));
  await vi.advanceTimersByTimeAsync(1);
  expect(document.getElementById('server-guidance')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#run' : '#send')!.disabled).toBe(false);
});
