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
  const project = { id: 'server-project', uri: 'file:///server-project', folderPath: '/project', name: 'Server project', projectType: kind,
    fields: [{ name: 'subject', type: 'string', flag: '--subject' }], entrypoints: [], conversation: { inputQueue: { enabled: true } } };
  const messages = [{ id: 'saved-answer', role: 'assistant', content: 'Previous result', status: 'success' }];
  let revision = 0;
  const render = async (serverData?: ProjectServerState, running = false) => {
    emit({ type: 'state', project, serverData, stateRevision: ++revision, serverInstanceId: 'process', authenticationRevision: 1,
      account: { status: 'authenticated', revision: 1, serverUrl: 'https://server.test' },
      ...(kind === 'workflow' ? { runs: [], drafts: { '': { scopeId: 'draft', values: { subject: 'Original' }, rawArgs: '[]', inputMode: 'form', policies: {} } }, history: { total: 0 }, running }
        : { sessions: [{ id: 'session', title: 'History', ...(running ? { activeRunId: 'active-run' } : {}), messages: messages.map(message => ({ ...message, status: running ? 'running' : message.status })), draft: { text: 'Original draft', attachments: [] },
          queuedInputs: [{ id: 'queued', text: 'Keep queued', params: {}, attachments: [], createdAt: 1 }] }], activeId: 'session', running }),
    });
    await vi.advanceTimersByTimeAsync(1);
    const resolve = host.postMessage.mock.calls.map(([value]) => value).filter(value => value.type === 'resolve').at(-1);
    if (resolve) emit({ type: 'params', requestId: resolve.requestId, sessionId: 'session', entrypointId: resolve.entrypointId, params: {} });
  };
  emit({ type: 'connection', status: 'connected' }); emit({ type: 'project-setup-available', upload: true });
  return { emit, render };
}

it.each([['workflow', 'en'], ['workflow', 'zh-CN'], ['conversation', 'en'], ['conversation', 'zh-CN']] as const)(
  'guides %s setup in %s without discarding edits or submitting a run on recheck', async (kind, language) => {
    const f = await fixture(kind, language);
    const issue = { checking: false, issue: { kind: 'project-unavailable' as const, serverUrl: 'https://server.test' } };
    await f.render(issue);
    const guidance = document.getElementById('server-guidance')!;
    expect(guidance.hidden).toBe(false); expect(guidance.textContent).toContain('https://server.test');
    expect(guidance.textContent).toContain(language === 'en' ? 'Project unavailable on this Server' : '当前服务器上的项目不可用');
    const run = document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#run' : '#send')!;
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind === 'workflow' ? '#main-fields input' : '#message')!;
    expect(run.disabled).toBe(true); expect(input.disabled).toBe(false);
    if (kind === 'conversation') expect(document.getElementById('transcript-content')!.textContent).toContain('Previous result');
    input.value = 'Keep my new edit'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
    if (kind === 'workflow') expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'workflow-draft', params: { subject: 'Keep my new edit' } }));
    document.getElementById('server-guidance-account')!.click();
    expect(host.postMessage).toHaveBeenCalledWith({ type: 'open-account' });
    document.getElementById('server-guidance-upload')!.click();
    expect(host.postMessage).toHaveBeenCalledWith({ type: 'open-project-upload' });
    document.getElementById('server-guidance-retry')!.click();
    expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'project-server-check' }));
    expect(document.querySelector<HTMLButtonElement>('#server-guidance-retry')!.disabled).toBe(true);
    await f.render({ checking: true, issue: issue.issue });
    expect(input.value).toBe('Keep my new edit');
    await f.render({ checking: false }); f.emit({ type: 'project-server-checked' });
    expect(guidance.hidden).toBe(true); expect(input.value).toBe('Keep my new edit'); expect(run.disabled).toBe(false);
    expect(host.postMessage.mock.calls.some(([value]) => ['send', 'workflow-run', 'workflow-rerun', 'resume'].includes(value.type))).toBe(false);
  },
);

it.each(['workflow', 'conversation'] as const)('keeps Stop available in %s and hides upload for access or Server compatibility problems', async kind => {
  const f = await fixture(kind, 'en');
  await f.render({ checking: false, issue: { kind: 'access-denied', serverUrl: 'https://server.test' } }, true);
  expect(document.getElementById('server-guidance-upload')!.hidden).toBe(true);
  const stop = document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#stop-active' : '#send')!;
  expect(stop.disabled).toBe(false);
  await f.render({ checking: false, issue: { kind: 'setup-required', serverUrl: 'https://server.test' } });
  expect(document.getElementById('server-guidance-upload')!.hidden).toBe(true);
  expect(document.getElementById('server-guidance-steps')!.textContent).toContain('Server version');
  if (kind === 'conversation') {
    expect(document.querySelector<HTMLButtonElement>('.queue-heading button')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.queued-input-actions button:nth-child(3)')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.queued-input-actions button:nth-child(4)')!.disabled).toBe(false);
  }
});
