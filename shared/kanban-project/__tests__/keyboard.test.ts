import { afterEach, expect, it, vi } from 'vitest';
import { createKanbanBridgeScript } from '../index';
import { installProjectKeyboardBridge, isProjectKeyboardEvent, type ProjectKeyboardEvent } from '../keyboard';

const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0)) close(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function fixture() {
  vi.useFakeTimers();
  document.body.innerHTML = '<input><button>Project</button>';
  const forwarded: ProjectKeyboardEvent[] = [];
  let enabled = true;
  dispose.push(installProjectKeyboardBridge(window, () => enabled, event => forwarded.push(event)));
  const send = (key: string, options: KeyboardEventInit = {}, type = 'keydown', target: EventTarget = document.querySelector('button')!) => {
    const event = new KeyboardEvent(type, { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event); return event;
  };
  return { forwarded, send, disable: () => { enabled = false; } };
}

it('forwards unhandled keys, repeats, keyup and the unmodified second key of a Studio chord', () => {
  const { forwarded, send } = fixture();
  expect(send('k', { ctrlKey: true }).defaultPrevented).toBe(true);
  send('k', { ctrlKey: true }, 'keyup');
  const input = document.querySelector('input')!;
  expect(send('m', {}, 'keydown', input).defaultPrevented).toBe(false);
  send('m', { repeat: true }, 'keydown', input); send('m', {}, 'keyup', input);
  expect(forwarded.map(event => [event.type, event.key, event.repeat])).toEqual([
    ['keydown', 'k', false], ['keyup', 'k', false], ['keydown', 'm', false], ['keydown', 'm', true], ['keyup', 'm', false],
  ]);
  expect(forwarded.every(isProjectKeyboardEvent)).toBe(true);
});

it('runs late project window handlers first and respects both cancellation and propagation stops', () => {
  const { forwarded, send } = fixture();
  const claim = (event: KeyboardEvent) => { if (event.key === 'b') event.preventDefault(); };
  window.addEventListener('keydown', claim); dispose.push(() => window.removeEventListener('keydown', claim));
  const button = document.querySelector('button')!;
  button.addEventListener('keydown', event => { if (event.key === 'p') event.stopPropagation(); });
  send('b', { metaKey: true }); send('b', {}, 'keyup'); send('p', { ctrlKey: true }); send('p', {}, 'keyup');
  vi.runOnlyPendingTimers();
  expect(forwarded).toEqual([]);
  send('p', { metaKey: true }, 'keydown', document.querySelector('input')!);
  expect(forwarded).toMatchObject([{ key: 'p', metaKey: true }]);
});

it('preserves native editing and IME while supporting function and modifier shortcuts in inputs', () => {
  const { forwarded, send } = fixture();
  const input = document.querySelector('input')!;
  for (const key of ['a', 'c', 'x', 'v', 'z', 'y']) expect(send(key, { ctrlKey: true }, 'keydown', input).defaultPrevented).toBe(false);
  send('z', { metaKey: true, shiftKey: true }, 'keydown', input);
  send('ArrowLeft', { altKey: true }, 'keydown', input); send('Tab', {}, 'keydown', input);
  send('Process', { isComposing: true }, 'keydown', input); send('a', { keyCode: 229 }, 'keydown', input);
  expect(send('é', { altKey: true }, 'keydown', input).defaultPrevented).toBe(false);
  expect(send('Dead', { altKey: true }, 'keydown', input).defaultPrevented).toBe(false);
  expect(forwarded).toMatchObject([{ key: 'Tab' }]);
  send('F1', { code: 'F1', keyCode: 112 }, 'keydown', input);
  send('p', { ctrlKey: true, shiftKey: true }, 'keydown', input);
  expect(forwarded.slice(1)).toMatchObject([{ key: 'F1' }, { key: 'p', ctrlKey: true, shiftKey: true }]);
});

it('does not consume keys without a host and disposes stopped-event fallbacks', () => {
  const { forwarded, send, disable } = fixture();
  const button = document.querySelector('button')!;
  button.addEventListener('keydown', event => event.stopImmediatePropagation());
  send('p', { ctrlKey: true }); expect(vi.getTimerCount()).toBe(1);
  dispose.pop()!(); expect(vi.getTimerCount()).toBe(0);
  disable(); expect(send('p', { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(forwarded).toEqual([]);
});

it('enables the injected Kanban bridge only through a nonce-bound parent handshake', () => {
  vi.useFakeTimers();
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const script = createKanbanBridgeScript({ id: 'board', name: 'Board', params: {} }, 'keyboard-nonce').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  new Function('window', 'document', script)(window, document);
  const key = () => { const event = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', keyCode: 80, ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event; };
  const handshake = (source: MessageEventSource | null, nonce = 'keyboard-nonce', enabled = true) => window.dispatchEvent(new MessageEvent('message', {
    source, data: { type: 'steamharness:kanban-keyboard-host', version: 1, nonce, enabled },
  }));
  post.mockClear(); expect(key().defaultPrevented).toBe(false); expect(post).not.toHaveBeenCalled();
  handshake(null); handshake(window, 'wrong'); expect(key().defaultPrevented).toBe(false); expect(post).not.toHaveBeenCalled();
  handshake(window); expect(key().defaultPrevented).toBe(true);
  expect(post).toHaveBeenCalledWith({ type: 'steamharness:kanban-keyboard', version: 1, nonce: 'keyboard-nonce', event: expect.objectContaining({ type: 'keydown', key: 'p', ctrlKey: true }) }, '*');
  handshake(window, 'keyboard-nonce', false); post.mockClear(); expect(key().defaultPrevented).toBe(false); expect(post).not.toHaveBeenCalled();
});

it('rejects malformed relayed events', () => {
  const event = { type: 'keydown', key: 'p', code: 'KeyP', keyCode: 80, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false };
  expect(isProjectKeyboardEvent(event)).toBe(true);
  for (const invalid of [null, {}, { ...event, type: 'keypress' }, { ...event, key: 'x'.repeat(65) }, { ...event, keyCode: -1 }, { ...event, keyCode: 1.5 }, { ...event, ctrlKey: 1 }]) expect(isProjectKeyboardEvent(invalid)).toBe(false);
});
