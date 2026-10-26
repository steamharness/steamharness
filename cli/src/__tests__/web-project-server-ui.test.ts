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
    expect([...guidance.querySelectorAll('button')].map(button => button.id)).toEqual(['server-guidance-create', 'server-guidance-retry']);
    expect(guidance.textContent).not.toMatch(/Account \/ Server|账号 \/ 服务器|switch.*Server|切换.*服务器|[Uu]pload|上传/);
    document.getElementById('server-guidance-create')!.click();
    expect(host.postMessage).toHaveBeenCalledWith({ type: 'open-project-create' });
    document.getElementById('server-guidance-retry')!.click();
    expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'project-server-check' }));
    expect(document.querySelector<HTMLButtonElement>('#server-guidance-retry')!.disabled).toBe(true);
    await f.render({ checking: true, issue: issue.issue });
    expect(input.value).toBe('Keep my new edit');
    await f.render({ checking: false }); f.emit({ type: 'project-server-checked' });
    expect(guidance.hidden).toBe(true); expect(input.value).toBe('Keep my new edit'); expect(run.disabled).toBe(false);
    expect(host.postMessage.mock.calls.some(([value]) => ['send', 'workflow-run', 'workflow-rerun', 'resume'].includes(value.type))).toBe(false);
    for (const kind of ['sign-in-required', 'access-denied', 'connection-unavailable', 'setup-required', 'related-setup-required'] as const) {
      await f.render({ checking: false, issue: { kind, serverUrl: 'https://server.test' } });
      expect(guidance.textContent).not.toMatch(/Account \/ Server|账号 \/ 服务器|switch.*Server|切换.*服务器|[Uu]pload|上传/);
      expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('#server-guidance-retry')!.disabled).toBe(false);
    }
  },
);

it.each(['workflow', 'conversation'] as const)('keeps Stop available in %s and only offers rechecking for access or Server compatibility problems', async kind => {
  const f = await fixture(kind, 'en');
  await f.render({ checking: false, issue: { kind: 'access-denied', serverUrl: 'https://server.test' } }, true);
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
  const stop = document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#stop-active' : '#send')!;
  expect(stop.disabled).toBe(false);
  await f.render({ checking: false, issue: { kind: 'setup-required', serverUrl: 'https://server.test' } });
  expect(document.getElementById('server-guidance-steps')!.textContent).toContain('Server version');
  if (kind === 'conversation') {
    expect(document.querySelector<HTMLButtonElement>('.queue-heading button')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.queued-input-actions button:nth-child(3)')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.queued-input-actions button:nth-child(4)')!.disabled).toBe(false);
  }
});

it.each(['workflow', 'conversation'] as const)('shows the affected related project in %s while preserving local execution', async kind => {
  const f = await fixture(kind, 'zh-CN');
  await f.render({ checking: false, blocking: false, issue: { kind: 'project-unavailable', serverUrl: 'https://server.test', projectId: 'related-database', relatedProjectAlias: 'database' } });
  expect(document.getElementById('server-guidance-project')!.textContent).toBe('related-database');
  expect(document.getElementById('server-guidance-alias')!.textContent).toBe('database');
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
  expect(document.getElementById('server-guidance-steps')!.textContent).toContain('打开对应的本地关联项目');
  expect(document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#run' : '#send')!.disabled).toBe(false);
  await f.render({ checking: false, blocking: false, issue: { kind: 'related-setup-required', projectId: 'related-database', relatedProjectAlias: 'database' } });
  expect(document.getElementById('server-guidance-title')!.textContent).toBe('请检查关联项目授权');
  expect(document.getElementById('server-guidance-create')!.hidden).toBe(true);
});

it.each([['workflow', 'en'], ['workflow', 'zh-CN'], ['conversation', 'en'], ['conversation', 'zh-CN']] as const)(
  'guides %s from import to authorization with distinct presentation (%s)', async (kind, language) => {
    const f = await fixture(kind, language);
    const issue = { kind: 'related-setup-required' as const, projectId: 'related-database', relatedProjectAlias: 'database', serverUrl: 'https://server.test' };
    const render = (imported: boolean) => f.render({ checking: false, blocking: false, issue: { ...issue, relatedProjectImported: imported } });
    await render(false);
    const guidance = document.getElementById('server-guidance')!;
    const details = document.querySelector<HTMLDetailsElement>('#server-guidance-details')!;
    const title = document.getElementById('server-guidance-title')!;
    expect(guidance.dataset.scope).toBe('related'); expect(guidance.dataset.stage).toBe('import');
    expect(title.textContent).toBe(language === 'en' ? 'Import the related project first' : '请先导入关联项目');
    expect(document.getElementById('server-guidance-steps')!.textContent).toContain(language === 'en' ? 'choose Import Project' : '选择“导入项目”');
    expect(guidance.textContent).toContain('database'); expect(details.open).toBe(false);
    expect([...guidance.querySelectorAll('button')].filter(button => !button.hidden).map(button => button.id)).toEqual(['server-guidance-retry']);
    expect(document.querySelector<HTMLButtonElement>(kind === 'workflow' ? '#run' : '#send')!.disabled).toBe(false);
    details.open = true;
    await render(true);
    expect(guidance.dataset.stage).toBe('authorization'); expect(details.open).toBe(true);
    expect(title.textContent).toBe(language === 'en' ? 'Check related project authorization' : '请检查关联项目授权');
    expect(document.getElementById('server-guidance-stage')!.textContent).toBe(language === 'en' ? 'Imported' : '已导入');
    expect(document.getElementById('server-guidance-steps')!.textContent).not.toContain(language === 'en' ? 'choose Import Project' : '选择“导入项目”');
    await f.render({ checking: false, blocking: false, issue: { ...issue, kind: 'access-denied', relatedProjectImported: true } });
    expect(title.textContent).toBe(language === 'en' ? 'Related project account access is required' : '需要关联项目的账号访问权限');
    await f.render({ checking: false, blocking: false, issue: { ...issue, kind: 'related-import-required', relatedProjectImported: false } });
    expect(title.textContent).toBe(language === 'en' ? 'Import the related project first' : '请先导入关联项目');
    expect(document.getElementById('server-guidance-server-label')!.hidden).toBe(true);
    expect(details.querySelector('summary')!.textContent).toBe(language === 'en' ? 'Project details' : '项目详情');
    await f.render({ checking: false, blocking: false, issue: { ...issue, kind: 'related-import-required', relatedProjectImported: true } });
    expect(title.textContent).toBe(language === 'en' ? 'Related project imported' : '关联项目已导入');
    expect(document.getElementById('server-guidance-steps')!.hidden).toBe(true);
    await f.render({ checking: false, issue: { kind: 'project-unavailable' } });
    expect(guidance.dataset.scope).toBe('project'); expect(details.open).toBe(true);
    expect(document.getElementById('server-guidance-context')!.hidden).toBe(true);
    expect(document.getElementById('server-guidance-server-label')!.hidden).toBe(false);
    expect(document.getElementById('server-guidance-create')!.hidden).toBe(false);
    await f.render(); expect(guidance.hidden).toBe(true);
  },
);
