// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { KANBAN_PREVIEW_READY_MESSAGE, KANBAN_BRIDGE_REQUEST_MESSAGE, KANBAN_BRIDGE_RESPONSE_MESSAGE } from '@steamharness/kanban-project';
import type { ResourcePreviewData } from '../web/resource-preview';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));

const reference = { sessionId: 'original-conversation', messageId: 'answer', cardId: 'map' };
let listeners: Map<string, (event: any) => void>;
afterEach(() => {
  listeners?.get('pagehide')?.({});
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
});

async function fixture() {
  vi.resetModules(); host.postMessage.mockClear(); vi.useFakeTimers(); listeners = new Map();
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    // jsdom does not implement the iframe sandbox token list.
    if (tag === 'iframe' && !('sandbox' in element)) {
      Object.defineProperty(element, 'sandbox', { value: { add: (...tokens: string[]) => element.setAttribute('sandbox', tokens.join(' ')) } });
    }
    return element;
  });
  vi.stubGlobal('addEventListener', (type: string, listener: (event: any) => void) => listeners.set(type, listener));
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  history.replaceState(null, '', `/resource/original?resourceRef=${encodeURIComponent(JSON.stringify(reference))}&resourcePresentation=card`);
  document.body.innerHTML = '<div id="app"></div>';
  (await import('@steamharness/i18n')).initI18n({ preference: 'en' });
  await import('../web/ui/resource-preview');
  const receive = (data: Record<string, unknown>) => listeners.get('message')!({ source: null, data });
  const last = () => host.postMessage.mock.lastCall![0];
  const reply = async (data: Record<string, unknown>) => {
    receive({ requestId: last().requestId, ...data }); await Promise.resolve(); await Promise.resolve();
  };
  receive({ type: 'connection', status: 'connected' });
  const refresh = document.querySelector<HTMLButtonElement>('header button')!;
  return { receive, last, reply, refresh };
}

it('retries a failed map refresh with its saved card reference and replaces the iframe', async () => {
  const f = await fixture();
  const data: ResourcePreviewData = { card: { id: 'map', kind: 'project', title: 'Map', target: { source: 'local' } }, format: 'kanban',
    kanban: { url: '/kanban/first/index.html', nonce: 'first', configuration: { id: 'map', name: 'Map', params: {} } } };
  expect(f.last()).toMatchObject({ type: 'resource-data', id: 'original', reference });
  await f.reply({ type: 'resource-data', data });
  const first = document.querySelector('iframe')!;
  expect(first, document.querySelector('[role=alert]')?.textContent ?? '').not.toBeNull();
  f.refresh.click();
  expect(f.last()).toMatchObject({ type: 'resource-refresh', id: 'original', reference });
  expect(f.refresh.disabled).toBe(true); expect(first.isConnected).toBe(false);
  await f.reply({ type: 'error', message: 'Access denied' });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Access denied');
  expect(f.refresh.disabled).toBe(false);
  f.refresh.click();
  await f.reply({ type: 'resource-data', id: 'renewed', data: { ...data, kanban: { ...data.kanban, url: '/kanban/second/index.html', nonce: 'second' } } });
  expect(document.querySelector('iframe')?.src).toContain('/kanban/second/index.html');
  listeners.get('message')!({ source: document.querySelector('iframe')!.contentWindow, data: { type: KANBAN_PREVIEW_READY_MESSAGE, nonce: 'second' } });
  expect(document.querySelector('.resource-preview-status')?.hasAttribute('hidden')).toBe(true);
  f.refresh.click(); expect(f.last()).toMatchObject({ id: 'renewed', reference });
});

it('recovers after resource revisions without losing the selected knowledge document', async () => {
  const f = await fixture();
  const card = { id: 'map', kind: 'knowledge', title: 'Documents', target: { source: 'local', projectId: 'project' } };
  await f.reply({ type: 'resource-data', data: { card, format: 'json', content: { documents: [{ id: 'doc', title: 'Selected document' }] } } });
  document.querySelector<HTMLButtonElement>('.resource-preview-list button')!.click();
  expect(f.last()).toMatchObject({ type: 'resource-select', selection: { documentId: 'doc' }, reference });
  await f.reply({ type: 'resource-data', id: 'selected', data: { card: { ...card, target: { ...card.target, documentId: 'doc' } }, format: 'markdown', content: { markdown: '# Selected document' } } });
  f.receive({ type: 'state', authenticationRevision: 1, resourceRevision: 1 });
  f.receive({ type: 'state', authenticationRevision: 1, resourceRevision: 2 });
  expect(f.last()).toMatchObject({ type: 'resource-data', id: 'selected', reference, selection: { documentId: 'doc' } });
  expect(document.querySelector('article')).toBeNull();
  await f.reply({ type: 'resource-data', id: 'recovered', data: { card, format: 'markdown', content: { markdown: '# Updated document' } } });
  expect(document.querySelector('article')?.textContent).toContain('Updated document');
  expect(f.refresh.disabled).toBe(false);
});

it('renders file images and recovers from loading errors without stale image events changing the preview', async () => {
  const f = await fixture();
  const data: ResourcePreviewData = { card: { id: 'image', kind: 'file', title: 'Factory boundary', target: { source: 'local', filePath: 'map.png' } },
    format: 'image', content: '/resource-assets/first/image' };
  await f.reply({ type: 'resource-data', data });
  const first = document.querySelector('img')!;
  expect(first.getAttribute('src')).toBe('/resource-assets/first/image');
  expect(first.alt).toBe('Factory boundary'); expect(document.querySelector('pre')).toBeNull();
  first.dispatchEvent(new Event('error'));
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Unable to load this preview. Retry or open it separately.');
  f.refresh.click();
  expect(f.last()).toMatchObject({ type: 'resource-refresh', reference });
  expect(first.isConnected).toBe(false);
  await f.reply({ type: 'resource-data', id: 'renewed', data: { ...data, content: '/resource-assets/second/image' } });
  const second = document.querySelector('img')!;
  first.dispatchEvent(new Event('error')); first.dispatchEvent(new Event('load'));
  expect(document.querySelector('.resource-preview-status')?.textContent).toBe('Loading...');
  expect(document.querySelector('.resource-preview-status')?.hasAttribute('hidden')).toBe(false);
  second.dispatchEvent(new Event('load'));
  expect(document.querySelector('.resource-preview-status')?.hasAttribute('hidden')).toBe(true);
  f.receive({ type: 'state', authenticationRevision: 1, resourceRevision: 1 });
  f.receive({ type: 'state', authenticationRevision: 2, resourceRevision: 2 });
  expect(document.querySelector('img')).toBeNull();
  expect(f.last()).toMatchObject({ type: 'resource-data', id: 'renewed', reference });
});

it('registers card page methods by polling, routes diagnostic replies, and revokes the old page on refresh', async () => {
  const f = await fixture();
  const data: ResourcePreviewData = { card: { id: 'map', kind: 'kanban', title: 'Map', target: { source: 'local' } }, format: 'kanban',
    kanban: { url: '/entries/main/kanban/first/index.html', nonce: 'first', configuration: { id: 'map', name: 'Map', params: {} } } };
  await f.reply({ type: 'resource-data', data });
  const frame = document.querySelector('iframe')!, post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const page = (message: Record<string, unknown>) => listeners.get('message')!({ source: frame.contentWindow, data: { nonce: 'first', ...message } });
  page({ type: KANBAN_PREVIEW_READY_MESSAGE, documentId: 'document' });
  page({ type: 'steamharness:kanban-method-catalog', documentId: 'document', configurationId: 'map', revision: 1,
    methods: [{ name: 'map.getInfo', description: 'Image state', inputSchema: { type: 'object' }, readOnly: true }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.last()).toMatchObject({ type: 'resource-method-state', id: 'original', configurationId: 'map', ready: true,
    presentation: { mode: 'card' }, methods: [{ name: 'map.getInfo', readOnly: true }] });
  const instanceId = f.last().instanceId;
  await f.reply({ type: 'resource-method-state', messages: [{ type: 'kanban-method-invoke', requestId: 'diagnostic-call', instanceId,
    configurationId: 'map', method: 'map.getInfo', args: {} }] });
  const invocation = post.mock.calls.find(([message]) => message.type === 'steamharness:kanban-method-invoke')![0];
  page({ type: 'steamharness:kanban-method-result', requestId: invocation.requestId, documentId: 'document', configurationId: 'map', revision: 1, ok: true, value: { imageReady: true } });
  await Promise.resolve(); await Promise.resolve();
  expect(f.last()).toMatchObject({ type: 'resource-method-reply', id: 'original', requestId: 'diagnostic-call', ok: true, value: { imageReady: true } });
  f.refresh.click();
  expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-method-close', id: 'original', nonce: 'first' }));
  await f.reply({ type: 'error', message: 'Refresh failed' });
  host.postMessage.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(host.postMessage).not.toHaveBeenCalled();
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Refresh failed');
});

it('lets slow file reads finish after 30 seconds and keeps their original bridge response', async () => {
  const f = await fixture();
  await f.reply({ type: 'resource-data', data: { card: { id: 'map', kind: 'kanban', title: 'Map', target: { source: 'local' } }, format: 'kanban',
    kanban: { url: '/entries/main/kanban/first/index.html', nonce: 'first', configuration: { id: 'map', name: 'Map', params: {} } } } });
  const frame = document.querySelector('iframe')!, post = vi.spyOn(frame.contentWindow!, 'postMessage');
  listeners.get('message')!({ source: frame.contentWindow, data: { type: KANBAN_BRIDGE_REQUEST_MESSAGE, nonce: 'first', requestId: 'file-read',
    operation: 'files.readFile', input: { database: 'data', fileId: 'wf_ab12' } } });
  const requestId = f.last().requestId;
  await vi.advanceTimersByTimeAsync(31_000);
  expect(post.mock.calls.some(([message]) => message.requestId === 'file-read')).toBe(false);
  f.receive({ type: 'resource-bridge', requestId, value: { base64: 'original-image' } });
  await Promise.resolve(); await Promise.resolve();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: KANBAN_BRIDGE_RESPONSE_MESSAGE, requestId: 'file-read', ok: true, value: { base64: 'original-image' } }), '*');
});
