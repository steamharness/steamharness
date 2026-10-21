import { afterEach, expect, it, vi } from 'vitest';
import { emptyHeaderRegions, ProjectWindowDragRegions } from '../web/ui/window-drag';

afterEach(() => vi.unstubAllGlobals());

it('keeps every control and selectable title out of the draggable header, including clipped and overlapping rectangles', () => {
  const header = { x: 40, y: 0, width: 760, height: 52 };
  const exclusions = [{ x: 0, y: 8, width: 80, height: 28 }, { x: 64, y: 10, width: 180, height: 20 }, { x: 680, y: 4, width: 140, height: 44 }];
  const regions = emptyHeaderRegions(header, exclusions);
  const contains = (rect: typeof header, x: number, y: number) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  for (let y = 0; y < 52; y++) {
    for (let x = 40; x < 800; x++) {
      expect(regions.filter(rect => contains(rect, x, y)).length).toBe(exclusions.some(rect => contains(rect, x, y)) ? 0 : 1);
    }
  }
});

function fixture() {
  let mutation: MutationCallback, popup = false;
  const frames = new Map<number, FrameRequestCallback>(), sent: Parameters<ConstructorParameters<typeof ProjectWindowDragRegions>[1]>[0][] = [];
  const events = new Map<string, () => void>();
  let sequence = 0;
  class Element {
    header = false;
    parentElement: Element | null = null;
    closest(): Element | null { return this.header ? this : this.parentElement?.header ? this.parentElement : null; }
  }
  const button = Object.assign(new Element(), { getBoundingClientRect: () => ({ x: 12, y: 12, width: 28, height: 28 }) });
  const toolbar = Object.assign(new Element(), {
    header: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 52 }), querySelectorAll: () => [button],
  });
  button.parentElement = toolbar;
  const app = Object.assign(new Element(), { querySelector: () => toolbar });
  const resizeDisconnect = vi.fn(), mutationDisconnect = vi.fn();
  vi.stubGlobal('Element', Element);
  vi.stubGlobal('document', { body: new Element(), querySelector: () => popup ? {} : null,
    addEventListener: (type: string, callback: () => void) => events.set(type, callback), removeEventListener: (type: string) => events.delete(type) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = resizeDisconnect; });
  vi.stubGlobal('MutationObserver', class { constructor(callback: MutationCallback) { mutation = callback; } observe() {} disconnect = mutationDisconnect; });
  vi.stubGlobal('innerWidth', 800); vi.stubGlobal('innerHeight', 600);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('addEventListener', (type: string, callback: () => void) => events.set(type, callback));
  vi.stubGlobal('removeEventListener', (type: string) => events.delete(type));
  const drag = new ProjectWindowDragRegions(app as unknown as HTMLElement, message => sent.push(message));
  return { drag, sent, frames, events, resizeDisconnect, mutationDisconnect,
    mutation: (header = true) => mutation([{ type: 'attributes', target: header ? button : new Element() } as unknown as MutationRecord], {} as MutationObserver),
    popup: (value: boolean) => { popup = value; events.get('toggle')?.(); },
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); } };
}

it('coalesces header updates, ignores transcript mutations and clears native regions while popovers are open', () => {
  const f = fixture();
  f.drag.update(true); f.mutation(); f.mutation();
  expect(f.frames.size).toBe(1);
  f.flush(); expect(f.sent).toHaveLength(1); expect(f.sent[0].regions.length).toBeGreaterThan(0);
  f.mutation(false); expect(f.frames.size).toBe(0);
  f.mutation(); f.flush(); expect(f.sent).toHaveLength(1);
  f.popup(true); f.flush(); expect(f.sent.at(-1)?.regions).toEqual([]);
  f.popup(false); f.flush(); expect(f.sent.at(-1)?.regions.length).toBeGreaterThan(0);
  f.drag.dispose();
});

it('removes regions immediately on leaving Steam and cancels delayed work on disposal', () => {
  const f = fixture();
  f.drag.update(true); f.flush(); f.mutation();
  f.drag.update(false);
  expect(f.frames.size).toBe(0); expect(f.sent.at(-1)?.regions).toEqual([]);
  f.mutation(); expect(f.frames.size).toBe(0);
  f.drag.update(true); f.flush();
  expect(f.sent.at(-1)?.regions.length).toBeGreaterThan(0);
  f.mutation(); f.drag.dispose(); f.flush();
  expect(f.sent.at(-1)?.regions).toEqual([]); expect(f.events.size).toBe(0);
  expect(f.resizeDisconnect).toHaveBeenCalled(); expect(f.mutationDisconnect).toHaveBeenCalled();
});
