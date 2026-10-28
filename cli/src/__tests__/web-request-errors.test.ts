// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { renderRequestError } from '../web/ui/request-error';
import type { ConversationMessage, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
const page = '<html>\n<head><title>404 Not Found</title></head>\n<body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body>\n</html>';
const failure = `configured-example API error (404): 404 ${page}`;

beforeEach(() => { initI18n({ preference: 'en' }); });
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren();
});

it.each([
  ['en', 'Request failed (HTTP 404).', 'Check the API URL, API type and model name in your model settings.', 'Technical details'],
  ['zh-CN', '请求失败（HTTP 404）。', '请检查模型设置中的 API 地址、接口类型和模型名称。', '技术详情'],
] as const)('summarizes a proxy error page in %s and keeps its original text collapsed', (language, summary, hint, label) => {
  initI18n({ preference: language });
  const root = document.createElement('div'); document.body.append(root);
  renderRequestError(root, failure);
  expect(root.hidden).toBe(false);
  expect(root.querySelector('.request-error-summary')!.textContent).toBe(summary);
  expect(root.querySelector('.request-error-hint')!.textContent).toBe(hint);
  const details = root.querySelector('details')!;
  expect(details.open).toBe(false); expect(details.querySelector('summary')!.textContent).toBe(label);
  expect(details.querySelector('pre')!.textContent).toBe(failure);
  expect(root.querySelector('html, head, body, h1')).toBeNull();
});

it.each([
  [401, 'API key'], [403, 'API key'], [405, 'API URL'], [408, 'timed out'],
  [429, 'quota'], [500, 'temporarily unavailable'], [502, 'temporarily unavailable'],
  [503, 'temporarily unavailable'], [504, 'timed out'], [422, 'service URL'],
])('uses HTTP %i from the response prefix rather than status-looking text inside the page', (status, hint) => {
  const root = document.createElement('div');
  renderRequestError(root, `HTTP ${status}: ${page}`);
  expect(root.querySelector('.request-error-summary')!.textContent).toBe(`Request failed (HTTP ${status}).`);
  expect(root.querySelector('.request-error-hint')!.textContent).toContain(hint);
});

it('handles a bare error page and a page without an HTTP status without inventing a status', () => {
  const root = document.createElement('div');
  renderRequestError(root, page);
  expect(root.querySelector('.request-error-summary')!.textContent).toBe('Request failed (HTTP 404).');
  renderRequestError(root, '<!doctype html><html><body>Sign in to continue</body></html>');
  expect(root.querySelector('.request-error-summary')!.textContent).toBe('The service returned an unexpected page.');
  expect(root.querySelector('.request-error-hint')!.textContent).toContain('service URL');
});

it('keeps untrusted HTML inert and bounds diagnostic text from large gateway pages', () => {
  const root = document.createElement('div');
  const error = `API error (502): <html><body><script>window.injected = true</script><img src="https://example.invalid/track" onerror="alert(1)">${'x'.repeat(30_000)}</body></html>`;
  renderRequestError(root, error);
  expect(root.querySelector('script, img, iframe')).toBeNull();
  expect(root.querySelector('details')!.open).toBe(false);
  expect(root.querySelector('pre')!.textContent).toContain('<script>');
  expect(root.querySelector('pre')!.textContent!.length).toBeLessThan(16_100);
  expect(root.querySelector('pre')!.textContent).toContain('The response was shortened.');
});

it('preserves expanded diagnostics through updates, clears them on retry, and keeps ordinary errors readable', () => {
  const root = document.createElement('div');
  renderRequestError(root, failure);
  const details = root.querySelector('details')!; details.open = true;
  renderRequestError(root, failure);
  expect(root.querySelector('details')).toBe(details); expect(details.open).toBe(true);
  renderRequestError(root);
  expect(root.hidden).toBe(true); expect(root.textContent).toBe('');
  renderRequestError(root, failure);
  expect(root.querySelector('details')!.open).toBe(false);
  for (const error of ['Run failure', 'API error (401): Invalid API key', 'Please enter <model>.', 'Expected an <html> element.']) {
    renderRequestError(root, error);
    expect(root.textContent).toBe(error); expect(root.querySelector('details')).toBeNull();
    expect(root.classList.contains('request-error')).toBe(false);
  }
});

it('formats saved Conversation failures, retry errors and request alerts without changing history', async () => {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset();
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
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  document.documentElement.lang = 'en'; document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = { id: 'errors', uri: 'file:///errors', folderPath: '/errors', name: 'Errors', projectType: 'conversation',
    entryId: 'main', aggregateName: 'Errors', defaultEntry: 'main', entryRoot: '/errors', databases: [],
    entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }], fields: [], entrypoints: [] };
  const answer: ConversationMessage = { id: 'answer', role: 'assistant', content: '', status: 'failed', error: failure, model: 'My model' };
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const render = async (status = answer.status) => {
    emit({ type: 'state', project, sessions: [{ id: 'session', title: 'Error', messages: [{ ...answer, status }] }], activeId: 'session', running: status === 'running' });
    await vi.advanceTimersByTimeAsync(1);
  };
  await render();
  const error = document.querySelector<HTMLElement>('.message-error')!;
  expect(error.querySelector('.request-error-summary')!.textContent).toBe('Request failed (HTTP 404).');
  expect(document.querySelector('.message-metadata')!.textContent).toContain('My model');
  const details = error.querySelector('details')!; details.open = true;
  await render(); expect(error.querySelector('details')).toBe(details); expect(details.open).toBe(true);
  await render('running'); expect(error.hidden).toBe(true); expect(error.textContent).toBe('');
  await render(); expect(error.querySelector('details')!.open).toBe(false);
  const gatewayError = `API error (502): ${page}`;
  emit({ type: 'error', requestType: 'retry', sessionId: 'session', messageId: 'answer', message: gatewayError });
  expect(error.querySelector('.request-error-summary')!.textContent).toBe('Request failed (HTTP 502).');
  emit({ type: 'error', requestType: 'attach', message: gatewayError });
  const alert = document.querySelector<HTMLElement>('#error')!;
  expect(alert.hidden).toBe(false); expect(alert.querySelector('.request-error-summary')!.textContent).toBe('Request failed (HTTP 502).');
  expect(answer.error).toBe(failure);
});
