// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide')); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); document.body.replaceChildren();
});
async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? false : matches.call(this, selector);
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  document.documentElement.lang = 'en';
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
}

it('keeps internal recovery in the running presentation until success or a terminal failure', async () => {
  await mount();
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/assistant',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'assistant', uri: 'studio-assistant:recovery', folderPath: '/assistant', name: 'Assistant', projectType: 'conversation', fields: [], entrypoints: [] };
  const message = { id: 'answer', role: 'assistant' as const, content: 'Partial answer', status: 'running', recovering: true, error: 'Run interrupted',
    items: [{ id: 'internal', contentType: 'json', content: { type: 'retry', kind: 'recovery', attempt: 1, maxAttempts: 10 }, metadata: { kind: 'agent-part', partType: 'retry' } }] };
  const session: ConversationSession = { id: 'session', title: 'Recovery', activeRunId: 'run', messages: [message] };
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const render = async () => { emit({ type: 'state', project, sessions: [session], activeId: session.id, running: message.status === 'running' }); await vi.advanceTimersByTimeAsync(1); };
  await render();
  const error = document.querySelector<HTMLElement>('.message-error')!, actions = document.querySelector<HTMLElement>('.message-actions')!;
  expect(error.hidden).toBe(true); expect(error.textContent).toBe(''); expect(actions.hidden).toBe(true);
  expect(document.querySelector('.message-metadata')?.textContent).toContain('Responding');
  expect(document.querySelector('.message-output .pending')).not.toBeNull();
  expect(document.querySelector('[data-kind="retry"]')).toBeNull();
  emit({ type: 'connection', status: 'reconnecting' });
  expect(document.querySelector<HTMLElement>('.message-connection')!.hidden).toBe(false);
  expect(error.hidden).toBe(true); expect(actions.hidden).toBe(true);
  emit({ type: 'connection', status: 'connected' });
  expect(document.querySelector<HTMLElement>('.message-connection')!.hidden).toBe(true);
  message.status = 'failed'; message.error = 'Model connection lost after 10 retries';
  await render();
  expect(error.hidden).toBe(false); expect(error.textContent).toBe(message.error); expect(actions.hidden).toBe(false);
  expect(document.querySelector('.message-output .pending')).toBeNull();
  expect(document.querySelector('.message-metadata')?.textContent).toContain('Failed');
});
