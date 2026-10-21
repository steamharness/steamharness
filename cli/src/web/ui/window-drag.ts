interface Rectangle { x: number; y: number; width: number; height: number }
interface WindowDragMessage { type: 'workflow-window-drag'; version: 1; width: number; height: number; regions: Rectangle[] }

/** Subtract controls and selectable headings from the native header surface. */
export function emptyHeaderRegions(header: Rectangle, exclusions: readonly Rectangle[]): Rectangle[] {
  let regions = [header];
  for (const excluded of exclusions) {
    regions = regions.flatMap(region => {
      const left = Math.max(region.x, excluded.x), top = Math.max(region.y, excluded.y);
      const right = Math.min(region.x + region.width, excluded.x + excluded.width), bottom = Math.min(region.y + region.height, excluded.y + excluded.height);
      if (left >= right || top >= bottom) { return [region]; }
      return [
        { x: region.x, y: region.y, width: region.width, height: top - region.y },
        { x: region.x, y: bottom, width: region.width, height: region.y + region.height - bottom },
        { x: region.x, y: top, width: left - region.x, height: bottom - top },
        { x: right, y: top, width: region.x + region.width - right, height: bottom - top },
      ].filter(rect => rect.width > 0 && rect.height > 0);
    });
  }
  return regions;
}

/** Report only empty header rectangles; Electron must draw them above the nested project frames. */
export class ProjectWindowDragRegions {
  private active = false;
  private pending: number | undefined;
  private last = '';
  private readonly resize = new ResizeObserver(() => this.schedule());
  private readonly mutations = new MutationObserver(records => {
    if (records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return target === this.app || target?.closest('.toolbar, dialog, [popover]') || record.type === 'childList' && target === document.body;
    })) { this.schedule(); }
  });

  constructor(private readonly app: HTMLElement, private readonly send: (message: WindowDragMessage) => void) {
    addEventListener('resize', this.schedule);
    document.addEventListener('toggle', this.schedule, true);
  }

  update(active: boolean): void {
    if (active && !this.active) {
      this.resize.observe(this.app);
      this.mutations.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
    }
    this.active = active;
    if (active) { this.schedule(); }
    else {
      this.resize.disconnect(); this.mutations.disconnect();
      if (this.pending !== undefined) { cancelAnimationFrame(this.pending); this.pending = undefined; }
      this.publish();
    }
  }

  private readonly schedule = (): void => {
    if (!this.active || this.pending !== undefined) { return; }
    this.pending = requestAnimationFrame(() => { this.pending = undefined; this.publish(); });
  };

  private publish(): void {
    const toolbar = this.app.querySelector<HTMLElement>(':scope > .toolbar');
    let regions: Rectangle[] = [];
    if (this.active && toolbar && !document.querySelector('dialog[open], [popover]:popover-open')) {
      const rect = toolbar.getBoundingClientRect();
      const header = { x: Math.max(0, rect.left), y: Math.max(0, rect.top),
        width: Math.min(innerWidth, rect.right) - Math.max(0, rect.left), height: Math.min(innerHeight, 256, rect.bottom) - Math.max(0, rect.top) };
      // Keep text selection, input, menus and disabled controls out of the native drag surface.
      const exclusions = [...toolbar.querySelectorAll<HTMLElement>('button, a, input, textarea, select, summary, [role=button], [role=tab], [contenteditable], [tabindex], .project-heading, h1, .project-name, .running-count, .studio-window-controls-slot')]
        .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
      if (header.width > 0 && header.height > 0) { regions = emptyHeaderRegions(header, exclusions); }
    }
    const message: WindowDragMessage = { type: 'workflow-window-drag', version: 1, width: innerWidth, height: innerHeight, regions: regions.slice(0, 128) };
    const serialized = JSON.stringify(message);
    if (this.last !== serialized) { this.last = serialized; this.send(message); }
  }

  dispose(): void {
    this.update(false);
    removeEventListener('resize', this.schedule); document.removeEventListener('toggle', this.schedule, true);
  }
}
