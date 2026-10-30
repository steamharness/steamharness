// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Attachment, ConversationMessage, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
const update = vi.hoisted(() => vi.fn());
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-output', () => ({ ConversationOutput: class { update = update; updateSubagents() {} moveSubagentsTo() {} dispose() {} tick() {} } }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide')); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

it('collects attachments once per refresh and shares the latest list across historical answers', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/performance',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'performance', uri: 'file:///performance', folderPath: '/performance', name: 'Performance', projectType: 'conversation', fields: [], entrypoints: [] };
  let reads = 0;
  const files: Attachment[] = [{ id: 'file', name: 'image.png', path: '/image.png', size: 1, previewUrl: '/old.png', mimeType: 'image/png', kind: 'image', storage: 'local', createdAt: '2026-10-22T00:00:00Z' }];
  const messages: ConversationMessage[] = Array.from({ length: 100 }, (_, index) => ({ id: `answer-${index}`, role: 'assistant', content: 'Finished answer', status: 'success',
    get files() { reads++; return index ? [] : files; } }));
  const receive = () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', project, activeId: 'session', running: false,
      sessions: [{ id: 'session', title: 'History', messages }] } }));
    for (const callback of frames.splice(0)) callback(0);
  };
  receive();
  expect(reads).toBe(100); expect(update).toHaveBeenCalledTimes(100);
  const shared = update.mock.calls[0][4];
  expect(shared[0].previewUrl).toBe('/old.png');
  expect(update.mock.calls.every(call => call[4] === shared)).toBe(true);
  reads = 0; update.mockClear(); files[0] = { ...files[0], previewUrl: '/new.png' }; receive();
  expect(reads).toBe(100); expect(update.mock.calls[0][4][0].previewUrl).toBe('/new.png');
  expect(update.mock.calls[0][4]).not.toBe(shared);
});
