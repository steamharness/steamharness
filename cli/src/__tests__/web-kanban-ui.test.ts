// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { KANBAN_PREVIEW_READY_MESSAGE } from '@steamharness/kanban-project';

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
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) }));
  vi.stubGlobal('fetch', fetcher);
  const sources: Source[] = [];
  class Source {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    close = vi.fn();
    addEventListener() {}
    constructor() { sources.push(this); }
  }
  vi.stubGlobal('EventSource', Source);
  (await import('@steamharness/i18n')).initI18n({ preference: language });
  await import('../web/ui/kanban-main');
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  const receive = (state: object) => sources[0].onmessage!({ data: JSON.stringify(state) });
  const sendState = (revision: number, nonce = 'first') => receive({
    type: 'state', project: { id: 'map', name: 'Map 2D', fields: [] },
    account: { status: 'authenticated', serverUrl: 'https://server.test', revision,
      user: { userId: 'user', email: 'user@example.com', displayName: 'User' } },
    authenticationRevision: 1,
    kanban: { revision, configuration: { id: 'profile', name: 'Default', params: {} },
      preview: { url: `/kanban/${nonce}/index.html`, nonce },
      relatedProjectRevisions: [], missingRelatedProjectAliases: [] },
  });
  return { sources, sendState };
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
