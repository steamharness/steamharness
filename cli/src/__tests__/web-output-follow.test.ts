import { afterEach, expect, it, vi } from 'vitest';
import { OutputFollow } from '../web/ui/output-follow';
const views: OutputFollow[] = [];
afterEach(() => { for (const view of views.splice(0)) view.dispose(); vi.unstubAllGlobals(); });
function fixture() {
  const frames: (() => void)[] = []; let changed!: () => void;
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { changed = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  class Element extends EventTarget {
    private position = 0; scrollHeight = 1000; clientHeight = 300;
    get scrollTop() { return this.position; }
    set scrollTop(value: number) { this.position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); } hidden = false; onclick?: () => void;
  }
  const container = new Element(), content = new Element(), latest = new Element();
  const view = new OutputFollow(container as unknown as HTMLElement, content as unknown as HTMLElement, latest as unknown as HTMLButtonElement); views.push(view);
  const flush = () => { for (const callback of frames.splice(0)) callback(); };
  return { view, container, content, latest, changed: () => changed(), flush };
}
it('follows streamed text and delayed image growth to the bottom', () => {
  const f = fixture(); f.view.setScope('run', true); f.flush(); expect(f.container.scrollTop).toBe(700);
  f.container.scrollHeight = 1600; f.changed(); f.flush(); expect(f.container.scrollTop).toBe(1300);
  expect(f.latest.hidden).toBe(true);
});
it('preserves a reader position and resumes explicitly or at the bottom', () => {
  const f = fixture(); f.view.setScope('run', true); f.flush();
  f.container.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: -100 }));
  f.container.scrollTop = 200; f.container.dispatchEvent(new Event('scroll'));
  f.container.scrollHeight = 1800; f.changed(); f.flush(); expect(f.container.scrollTop).toBe(200); expect(f.latest.hidden).toBe(false);
  f.latest.onclick!(); f.flush(); expect(f.container.scrollTop).toBe(1500);
  f.view.pause(); f.container.scrollTop = 1400; f.container.dispatchEvent(new Event('scroll')); f.container.scrollTop = 1500; f.container.dispatchEvent(new Event('scroll')); f.flush(); expect(f.latest.hidden).toBe(true);
});
it('does not follow old pages or hidden result tabs, and starts fresh on a new run', () => {
  const f = fixture(); f.view.setScope('run', true); f.flush(); f.view.setScope('run', false);
  f.container.scrollTop = 10; f.container.scrollHeight = 2500; f.changed(); f.flush(); expect(f.container.scrollTop).toBe(10);
  f.view.setScope('other', true); f.flush(); expect(f.container.scrollTop).toBe(2200);
});
