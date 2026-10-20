// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationMessage, OutputItem, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren();
});

function card(id: string, kind: 'knowledge' | 'kv'): OutputItem {
  return { id, metadata: { kind: 'agent-part', partType: 'tool' }, content: {
    tool: 'db_status', status: 'success', output: { details: { resourceCard: { kind,
      title: id, target: { source: 'local', projectId: 'scroll-test', ...(kind === 'kv' ? { key: id } : { documentId: id }) },
    } } },
  } };
}

it('keeps batched resource cards and asynchronous layout changes visible until the reader scrolls up', async () => {
  vi.useFakeTimers();
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal('ResizeObserver', class {
    private readonly state;
    constructor(callback: ResizeObserverCallback) { this.state = { callback, targets: new Set<Element>() }; observers.push(this.state); }
    observe(target: Element) { this.state.targets.add(target); }
    disconnect() { this.state.targets.clear(); }
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? false : matches.call(this, selector);
  });
  const pendingFrames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { pendingFrames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pendingFrames.delete(id));
  const frame = () => { const callbacks = [...pendingFrames.values()]; pendingFrames.clear(); for (const callback of callbacks) callback(0); };
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const transcript = document.querySelector<HTMLElement>('#transcript')!;
  const content = document.querySelector<HTMLElement>('#transcript-content')!;
  const latest = document.querySelector<HTMLButtonElement>('#latest')!;
  // jsdom has no layout. Model native scroll clamping while cards are regrouped
  // and deliver the resulting scroll event after the next state has rendered.
  let height = 1000, viewport = 400, top = 0;
  const clamp = () => { top = Math.max(0, Math.min(top, height - viewport)); };
  Object.defineProperties(transcript, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => viewport },
    scrollTop: { get: () => top, set: value => { top = value; clamp(); } },
  });
  const resize = () => { for (const observer of observers) if (observer.targets.has(content) || observer.targets.has(transcript)) observer.callback([], {} as ResizeObserver); };
  const project: Project = { id: 'scroll-test', uri: 'file:///scroll-test', folderPath: '/scroll-test', name: 'Scroll Test', projectType: 'conversation', fields: [], entrypoints: [] };
  const message: ConversationMessage = { id: 'answer', role: 'assistant', content: '', status: 'running', items: [] };
  const emit = (activeId = 'session') => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'state', project, activeId, running: true,
      sessions: [{ id: activeId, title: 'Conversation', messages: [message], createdAt: 1, updatedAt: 1 }],
    } }));
    frame(); // State rendering and layout following run in separate frames.
  };
  emit(); frame();
  expect(top).toBe(600);
  height = 700; clamp();
  height = 1600;
  message.items = [card('document', 'knowledge'), card('index', 'kv')];
  emit();
  transcript.dispatchEvent(new Event('scroll'));
  resize(); frame();
  expect(content.querySelectorAll('.resource-card')).toHaveLength(2);
  expect(top).toBe(1200);
  expect(latest.hidden).toBe(true);

  height = 900; clamp(); height = 2100;
  transcript.dispatchEvent(new Event('scroll'));
  resize(); frame();
  expect(top).toBe(1700);

  // A reader can interrupt a pending follow even while another card is added.
  height = 2400; resize();
  transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  transcript.scrollTop = 1400;
  transcript.dispatchEvent(new Event('scroll'));
  frame();
  height = 2700; resize(); frame();
  expect(top).toBe(1400);
  expect(latest.hidden).toBe(false);
  latest.click(); frame();
  expect(top).toBe(2300);
  expect(latest.hidden).toBe(true);

  const touch = (type: string, y: number) => {
    const event = new Event(type);
    Object.defineProperty(event, 'touches', { value: [{ clientY: y }] });
    transcript.dispatchEvent(event);
  };
  for (const [name, begin, end] of [
    ['keyboard', () => transcript.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' })), () => {}],
    ['touch', () => { touch('touchstart', 100); touch('touchmove', 180); }, () => {}],
    ['scrollbar', () => transcript.dispatchEvent(new Event('pointerdown')), () => window.dispatchEvent(new Event('pointerup'))],
  ] as const) {
    height += 300; resize(); begin();
    transcript.scrollTop = height - viewport - 500;
    transcript.dispatchEvent(new Event('scroll')); end(); frame();
    expect(top, `${name} scrolling takes priority over pending layout`).toBe(height - viewport - 500);
    latest.click(); frame();
    expect(top).toBe(height - viewport);
  }
  // A quick scrollbar drag can end before its coalesced scroll event arrives.
  height += 300; resize();
  transcript.dispatchEvent(new Event('pointerdown'));
  transcript.scrollTop = height - viewport - 500;
  window.dispatchEvent(new Event('pointerup')); frame();
  transcript.dispatchEvent(new Event('scroll'));
  expect(top).toBe(height - viewport - 500);
  latest.click(); frame();
  height = 2700; resize(); frame();

  // Navigation keys inside a tool's input must not pause transcript following.
  const input = document.createElement('input'); content.append(input);
  height = 2800; resize();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); frame();
  expect(top).toBe(2400);
  input.remove(); height = 2700; resize(); frame();

  // Even a small upward gesture must win over pending preview growth.
  height += 20; resize();
  transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
  transcript.scrollTop = 2280; transcript.dispatchEvent(new Event('scroll')); frame();
  expect(top).toBe(2280);
  transcript.scrollTop = height - viewport; transcript.dispatchEvent(new Event('scroll'));
  height = 2700; resize(); frame();
  expect(top).toBe(2300);

  // Composer growth and narrow viewports also change the available height.
  viewport = 260; resize(); frame();
  expect(top).toBe(2440);
  transcript.scrollTop = 1600; transcript.dispatchEvent(new Event('scroll'));
  height = 3000; resize(); frame();
  expect(top).toBe(1600);
  emit('another-session'); frame();
  expect(top).toBe(2740);

  height = 3300; resize();
  window.dispatchEvent(new Event('pagehide')); frame();
  expect(top).toBe(2740);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); frame();
  expect(top).toBe(3040);
});
