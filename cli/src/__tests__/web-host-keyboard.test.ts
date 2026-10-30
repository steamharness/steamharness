import { afterEach, expect, it, vi } from 'vitest';
import { acquireHostKeyboard } from '../web/ui/host-keyboard';

afterEach(() => { vi.unstubAllGlobals(); });

it('relays only valid events after the Studio handshake and advertises capability changes', () => {
  const postMessage = vi.fn(), dispatchEvent = vi.fn(), listeners = new Map<string, EventListener>();
  vi.stubGlobal('window', { parent: { postMessage }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('addEventListener', (type: string, listener: EventListener) => listeners.set(type, listener));
  vi.stubGlobal('dispatchEvent', dispatchEvent);
  const keyboard = acquireHostKeyboard();
  const event = { type: 'keydown', key: 'p', code: 'KeyP', keyCode: 80, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false };
  keyboard.forward(event); expect(postMessage).not.toHaveBeenCalled();
  keyboard.enable(1); keyboard.enable(1);
  expect(keyboard.enabled).toBe(true); expect(dispatchEvent).toHaveBeenCalledTimes(1);
  keyboard.forward({ ...event, type: 'paste' }); expect(postMessage).not.toHaveBeenCalled();
  keyboard.forward(event); expect(postMessage).toHaveBeenCalledWith({ type: 'workflow-keyboard', version: 1, event }, '*');
  keyboard.enable(2); keyboard.forward(event); expect(postMessage).toHaveBeenCalledOnce(); expect(keyboard.enabled).toBe(false);
  listeners.get('pagehide')!(new Event('pagehide'));
});
