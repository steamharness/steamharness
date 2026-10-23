// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationMessageIndex, type IndexedUserMessage } from '../web/ui/conversation-message-index';
import type { ConversationMessage, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren();
});

function setup() {
  const area = document.createElement('div'), transcript = document.createElement('div');
  area.append(transcript); document.body.append(area);
  let height = 1400, viewport = 400, top = 0;
  Object.defineProperties(transcript, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => viewport },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, height - viewport)); } },
  });
  const jump = vi.fn(), index = new ConversationMessageIndex(transcript, jump);
  const entries: IndexedUserMessage[] = [];
  const add = (content: string, attachments?: ConversationMessage['attachments']) => {
    const position = entries.length * 300, root = document.createElement('article');
    transcript.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ top: position - top, bottom: position - top + 50, height: 50 }) as DOMRect);
    const entry = { root, message: { id: String(entries.length), role: 'user' as const, content, attachments } };
    entries.push(entry); return entry;
  };
  const render = () => { index.update(entries); index.syncLayout(); };
  const buttons = () => [...index.root.querySelectorAll<HTMLButtonElement>('button')];
  const preview = area.querySelector<HTMLElement>('[role="tooltip"]')!;
  return { area, transcript, index, jump, entries, add, render, buttons, preview,
    height: (value: number) => { height = value; }, viewport: (value: number) => { viewport = value; } };
}

it('only shows the index for overflowing conversations with several user messages and follows the reading position', () => {
  const view = setup();
  view.add('one'); view.add('two'); view.render();
  expect(view.index.root.hidden).toBe(true);
  view.add('three'); view.height(400); view.render();
  expect(view.index.root.hidden).toBe(true);
  view.height(1400); view.render();
  expect(view.index.root.hidden).toBe(false);
  expect(view.area.classList.contains('has-message-index')).toBe(true);
  expect(view.buttons()).toHaveLength(3);
  expect(view.index.root.getAttribute('aria-label')).toBe('User messages (3)');
  expect(view.buttons()[0].getAttribute('aria-current')).toBe('location');
  view.transcript.scrollTop = 350; view.index.syncLayout();
  expect(view.buttons()[1].getAttribute('aria-current')).toBe('location');
  expect(view.buttons().map(button => button.tabIndex)).toEqual([-1, 0, -1]);
  view.transcript.scrollTop = 1000; view.index.syncLayout();
  expect(view.buttons()[2].getAttribute('aria-current')).toBe('location');
  view.viewport(0); view.index.syncLayout(); expect(view.index.root.hidden).toBe(true);
  expect(view.area.classList.contains('has-message-index')).toBe(false);
});

it('previews literal user text and attachments, keeps markers stable, and closes removed previews', () => {
  const view = setup();
  const first = view.add('<img src=x onerror=alert(1)>\nA user request');
  view.add('', [{ id: 'file', name: 'design.png', kind: 'image', mimeType: 'image/png', size: 10, storage: 'local', createdAt: '' }]);
  view.add(''); view.render();
  const firstButton = view.buttons()[0]; firstButton.dispatchEvent(new Event('pointerenter'));
  expect(view.preview.hidden).toBe(false);
  expect(view.preview.textContent).toContain('User message 1 of 3');
  expect(view.preview.textContent).toContain(first.message.content);
  expect(view.preview.querySelector('img')).toBeNull();
  expect(firstButton.getAttribute('aria-describedby')).toBe(view.preview.id);
  first.message.content = 'Updated message'; view.render();
  expect(view.buttons()[0]).toBe(firstButton);
  expect(view.preview.textContent).toContain('Updated message');
  view.buttons()[1].dispatchEvent(new Event('pointerenter'));
  expect(view.preview.textContent).toContain('design.png');
  expect(firstButton.hasAttribute('aria-describedby')).toBe(false);
  view.buttons()[2].dispatchEvent(new Event('pointerenter'));
  expect(view.preview.textContent).toContain('Message without text');
  view.entries.pop(); view.render();
  expect(view.preview.hidden).toBe(true); expect(view.index.root.hidden).toBe(true);
  view.index.update([]); view.index.syncLayout(); expect(view.buttons()).toHaveLength(0);
});

it('supports keyboard previews and navigation without jumping until a marker is activated', () => {
  const view = setup();
  for (const text of ['first', 'second', 'third', 'last']) view.add(text);
  view.render(); view.buttons()[0].focus();
  expect(view.preview.textContent).toContain('first');
  view.buttons()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(view.buttons()[1]); expect(view.preview.textContent).toContain('second');
  view.buttons()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement).toBe(view.buttons()[3]); expect(view.jump).not.toHaveBeenCalled();
  view.buttons()[3].click(); expect(view.jump).toHaveBeenLastCalledWith(view.entries[3].root);
  expect(view.preview.hidden).toBe(true);
  view.buttons()[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(document.activeElement).toBe(view.buttons()[0]);
  view.buttons()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(view.preview.hidden).toBe(true);
});

it('keeps the preview open while the pointer crosses the gap and dismisses it after leaving', () => {
  vi.useFakeTimers();
  const view = setup();
  for (const text of ['first', 'second', 'third']) view.add(text);
  view.render(); view.buttons()[0].dispatchEvent(new Event('pointerenter'));
  view.index.root.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: view.transcript }));
  vi.advanceTimersByTime(50);
  view.preview.dispatchEvent(new Event('pointerenter'));
  vi.advanceTimersByTime(100); expect(view.preview.hidden).toBe(false);
  view.preview.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: view.transcript }));
  view.entries[0].message.content += ' updated while leaving'; view.render();
  vi.advanceTimersByTime(100); expect(view.preview.hidden).toBe(true);
});

it('keeps every marker in a long list accessible and confines the preview to the transcript area', () => {
  const view = setup();
  for (let number = 0; number < 100; number++) view.add(`message ${number}`);
  view.height(31000);
  const list = view.index.root.querySelector<HTMLElement>('.message-index-list')!;
  Object.defineProperty(list, 'clientHeight', { value: 160 });
  view.render();
  for (const [number, button] of view.buttons().entries()) Object.defineProperties(button, {
    offsetTop: { value: number * 16 }, offsetHeight: { value: 16 },
  });
  view.buttons()[0].focus();
  view.buttons()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(view.buttons()).toHaveLength(100);
  expect(document.activeElement).toBe(view.buttons()[99]); expect(list.scrollTop).toBe(1440);
  vi.spyOn(view.area, 'getBoundingClientRect').mockReturnValue({ top: 50, height: 200 } as DOMRect);
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 50, bottom: 250 } as DOMRect);
  vi.spyOn(view.buttons()[99], 'getBoundingClientRect').mockReturnValue({ top: 230, bottom: 246, height: 16 } as DOMRect);
  Object.defineProperty(view.preview, 'offsetHeight', { value: 100 });
  view.buttons()[99].dispatchEvent(new Event('pointerenter'));
  expect(view.preview.style.top).toBe('92px');
  vi.spyOn(view.buttons()[99], 'getBoundingClientRect').mockReturnValue({ top: 300, bottom: 316, height: 16 } as DOMRect);
  list.dispatchEvent(new Event('scroll')); expect(view.preview.hidden).toBe(true);
});

it('clears old conversation content even when message ids are reused and bounds very long previews', () => {
  const view = setup();
  for (const text of ['old content', 'second', 'third']) view.add(text);
  view.render(); view.buttons()[0].dispatchEvent(new Event('pointerenter'));
  expect(view.preview.hidden).toBe(false);
  view.entries.length = 0;
  for (let index = 0; index < 3; index++) view.add('new content '.repeat(300));
  view.render();
  expect(view.preview.hidden).toBe(true);
  view.buttons()[0].dispatchEvent(new Event('pointerenter'));
  expect(view.preview.textContent).not.toContain('old content');
  expect(view.preview.querySelector('.message-index-content')!.textContent!.length).toBe(2001);
});

it('indexes rendered user messages once and keeps a clicked historical message in place while new replies arrive', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? false : matches.call(this, selector);
  });
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); };
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const transcript = document.querySelector<HTMLElement>('#transcript')!;
  let height = 1600, top = 0;
  Object.defineProperties(transcript, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => 400 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, height - 400)); } },
  });
  const project: Project = { id: 'index-test', uri: 'file:///index-test', folderPath: '/index-test', name: 'Index Test', projectType: 'conversation', fields: [], entrypoints: [] };
  const messages: ConversationMessage[] = Array.from({ length: 4 }, (_, number) => [
    { id: `u${number}`, role: 'user' as const, content: `Request ${number}` },
    { id: `a${number}`, role: 'assistant' as const, content: `Reply ${number}`, status: 'success' },
  ]).flat();
  const emit = (activeId = 'session', entries = messages) => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'state', project, activeId, running: false,
      sessions: [{ id: activeId, title: 'Conversation', messages: entries, createdAt: 1, updatedAt: 1 }],
    } })); frame(); frame();
  };
  emit();
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.message-index-marker')];
  expect(buttons()).toHaveLength(4); expect(top).toBe(1200);
  for (const [number, root] of [...document.querySelectorAll<HTMLElement>('.message.user')].entries()) {
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ top: number * 300 - top }) as DOMRect);
  }
  buttons()[1].click(); frame(); transcript.dispatchEvent(new Event('scroll'));
  expect(top).toBe(282);
  height = 2200; messages[7].content += ' More streamed content'; emit();
  expect(top).toBe(282); expect(buttons()).toHaveLength(4);
  document.querySelector<HTMLButtonElement>('#latest')!.click(); frame(); expect(top).toBe(1800);
  buttons()[0].dispatchEvent(new Event('pointerenter'));
  const preview = document.querySelector<HTMLElement>('.message-index-preview')!;
  expect(preview.hidden).toBe(false);
  emit('another-session', messages.slice(0, 2));
  expect(document.querySelector<HTMLElement>('.conversation-message-index')!.hidden).toBe(true);
  expect(preview.hidden).toBe(true); expect(buttons()).toHaveLength(1);
});
