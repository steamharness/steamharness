import './window-chrome.css';

interface WindowChrome { active: boolean; height: number; left: number; right: number }

/** Reserve space for native controls without duplicating them inside the project iframe. */
export class ProjectWindowChrome {
  private readonly slot = document.createElement('div');
  private readonly narrow = matchMedia('(max-width: 680px)');
  private readonly observer: MutationObserver;
  private readonly app = document.querySelector<HTMLElement>('#app')!;
  private active = false;

  constructor() {
    this.slot.className = 'studio-window-controls-slot';
    this.slot.setAttribute('aria-hidden', 'true');
    this.observer = new MutationObserver(() => this.layout());
    this.observer.observe(this.app, { attributes: true, attributeFilter: ['class'] });
    this.narrow.addEventListener('change', this.layout);
  }

  update(value: WindowChrome): void {
    // Only finite host measurements may become CSS lengths.
    if (!value || typeof value.active !== 'boolean' || ![value.height, value.left, value.right].every(n => Number.isFinite(n) && n >= 0 && n <= 1000)) { return; }
    this.active = value.active;
    this.app.toggleAttribute('data-studio-window-chrome', this.active);
    this.app.style.setProperty('--studio-window-chrome-height', `${value.height}px`);
    this.app.style.setProperty('--studio-window-chrome-left', `${value.left}px`);
    this.app.style.setProperty('--studio-window-chrome-right', `${value.right}px`);
    this.layout();
  }

  private readonly layout = (): void => {
    if (!this.active) { this.slot.remove(); return; }
    const menu = !this.narrow.matches && this.app.classList.contains('menu-open') ? this.app.querySelector('#project-menu') : null;
    const parent = menu ?? this.app.querySelector('.toolbar > .project-title');
    if (parent && this.slot.parentElement !== parent) { parent.prepend(this.slot); }
  };

  dispose(): void {
    this.observer.disconnect(); this.narrow.removeEventListener('change', this.layout); this.slot.remove();
  }
}
