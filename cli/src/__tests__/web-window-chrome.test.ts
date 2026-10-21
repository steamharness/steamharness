import { afterEach, expect, it, vi } from 'vitest';
import { ProjectWindowChrome } from '../web/ui/window-chrome';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let menuOpen = false, changed = () => {};
  const style = new Map<string, string>();
  const menu = { prepend: vi.fn((slot: { parentElement: object }) => { slot.parentElement = menu; }) };
  const title = { prepend: vi.fn((slot: { parentElement: object }) => { slot.parentElement = title; }) };
  const slot = { className: '', parentElement: undefined as object | undefined, setAttribute: vi.fn(), remove: vi.fn(() => { slot.parentElement = undefined; }) };
  const app = { classList: { contains: () => menuOpen }, toggleAttribute: vi.fn(), style: { setProperty: (key: string, value: string) => style.set(key, value) },
    querySelector: (selector: string) => selector === '#project-menu' ? menu : title };
  const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const disconnect = vi.fn();
  vi.stubGlobal('document', { createElement: () => slot, querySelector: () => app });
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { changed = callback; } observe() {} disconnect = disconnect; });
  const chrome = new ProjectWindowChrome();
  return { chrome, slot, app, title, menu, media, style, disconnect, changed: () => changed(), menuOpen: () => { menuOpen = true; changed(); } };
}

it('moves the native controls reservation between the project title and expanded menu without remounting content', () => {
  const f = fixture();
  f.chrome.update({ active: true, height: 52, left: 228, right: 0 });
  expect(f.slot.parentElement).toBe(f.title);
  f.menuOpen();
  expect(f.slot.parentElement).toBe(f.menu);
  f.media.matches = true; f.changed();
  expect(f.slot.parentElement).toBe(f.title);
  expect(f.style.get('--studio-window-chrome-left')).toBe('228px');
});

it('reserves the hidden tool bar actions and removes the reservation when returning to IDE', () => {
  const f = fixture();
  f.chrome.update({ active: true, height: 52, left: 150, right: 104 });
  expect(f.style.get('--studio-window-chrome-right')).toBe('104px');
  f.chrome.update({ active: false, height: 52, left: 0, right: 0 });
  f.menuOpen();
  expect(f.slot.parentElement).toBeUndefined();
  expect(f.app.toggleAttribute).toHaveBeenLastCalledWith('data-studio-window-chrome', false);
  f.chrome.dispose();
  expect(f.disconnect).toHaveBeenCalledOnce();
});

it.each([NaN, Infinity, -1, 1001])('ignores invalid native geometry (%s)', left => {
  const f = fixture();
  f.chrome.update({ active: true, height: 52, left, right: 0 });
  expect(f.app.toggleAttribute).not.toHaveBeenCalled();
});
