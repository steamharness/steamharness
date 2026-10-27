// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren();
});

it('retains a multiline draft and its selection during resizing and sends it from the composer controls', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? false : matches.call(this, selector);
  });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const frame = () => { for (const callback of frames.splice(0)) callback(0); };
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/resize',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'resize', uri: 'file:///resize', folderPath: '/resize', name: 'Resize', projectType: 'conversation', fields: [], entrypoints: [] };
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', project, activeId: 'session', running: false,
    sessions: [{ id: 'session', title: 'Draft', messages: [], createdAt: 1, updatedAt: 1 }] } }));
  frame(); frame();
  const input = document.querySelector<HTMLTextAreaElement>('#message')!;
  const text = Array.from({ length: 30 }, (_, index) => `Draft line ${index}`).join('\n');
  input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus(); input.setSelectionRange(5, 18);
  for (const height of [200, 600, 320, 800]) {
    vi.stubGlobal('innerHeight', height);
    window.dispatchEvent(new Event('resize')); frame();
    expect({ value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input })
      .toEqual({ value: text, start: 5, end: 18, focused: true });
  }
  document.querySelector<HTMLButtonElement>('#send')!.click();
  expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', text }));
});
