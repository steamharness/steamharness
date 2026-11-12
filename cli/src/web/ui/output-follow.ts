/** Follow streamed output while preserving a reader's deliberate scroll position. */
export class OutputFollow {
  private following = true;
  private enabled = true;
  private scope = '';
  private frame?: number;
  private top: number;
  private height: number;
  private viewport: number;
  private readonly mutations: MutationObserver;
  private readonly resize?: ResizeObserver;
  private readonly onWheel = (event: WheelEvent) => { if (event.deltaY < 0) this.pause(); };
  private readonly onKey = (event: KeyboardEvent) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) this.pause(); };
  private readonly onPointer = () => this.pause();
  private readonly onScroll = () => {
    const changed = this.height !== this.container.scrollHeight || this.viewport !== this.container.clientHeight;
    if (!changed && this.container.scrollTop < this.top - 1) this.following = false;
    else if (!changed && this.atBottom()) this.following = true;
    this.measure(); this.controls(); if (changed) this.schedule();
  };
  constructor(private readonly container: HTMLElement, private readonly content: HTMLElement, private readonly latest: HTMLButtonElement) {
    this.top = container.scrollTop; this.height = container.scrollHeight; this.viewport = container.clientHeight;
    container.addEventListener('scroll', this.onScroll, { passive: true });
    container.addEventListener('wheel', this.onWheel, { passive: true });
    container.addEventListener('keydown', this.onKey);
    container.addEventListener('pointerdown', this.onPointer, { passive: true });
    latest.onclick = () => this.resume();
    this.mutations = new MutationObserver(() => this.schedule());
    this.mutations.observe(content, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'src'] });
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.schedule()); this.resize.observe(content); this.resize.observe(container);
    }
  }
  setScope(scope: string, enabled: boolean): void {
    if (scope !== this.scope) { this.scope = scope; this.following = true; }
    this.enabled = enabled && !!scope; this.controls(); this.schedule();
  }
  pause(): void { this.following = false; this.controls(); }
  resume(): void { this.following = true; this.controls(); this.schedule(); }
  private atBottom(): boolean { return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight <= 24; }
  private measure(): void { this.top = this.container.scrollTop; this.height = this.container.scrollHeight; this.viewport = this.container.clientHeight; }
  private controls(): void { this.latest.hidden = !this.enabled || this.following; }
  private schedule(): void {
    if (this.frame !== undefined || !this.enabled || !this.following) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      if (!this.enabled || !this.following) return;
      this.container.scrollTop = this.container.scrollHeight;
      this.measure(); this.controls();
    });
  }
  dispose(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.mutations.disconnect(); this.resize?.disconnect();
    this.container.removeEventListener('scroll', this.onScroll); this.container.removeEventListener('wheel', this.onWheel);
    this.container.removeEventListener('keydown', this.onKey); this.container.removeEventListener('pointerdown', this.onPointer);
  }
}
