export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A select-only combobox. The popover stays above scrolling settings cards. */
export class SettingsDropdown {
  private readonly menu = document.createElement('div');
  private readonly label = document.createElement('span');
  private options: DropdownOption[] = [];
  private active = -1;
  private prefix = '';
  private typedAt = 0;
  private restoreFocus = false;

  constructor(readonly button: HTMLButtonElement, private readonly changed: () => void, private readonly acceptCurrent = false, menuHost: HTMLElement = document.body) {
    button.type = 'button';
    button.classList.add('settings-dropdown');
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    this.label.className = 'settings-dropdown-label';
    const chevron = document.createElement('span');
    chevron.className = 'codicon codicon-chevron-down';
    chevron.setAttribute('aria-hidden', 'true');
    button.append(this.label, chevron);
    this.menu.className = 'settings-dropdown-menu';
    this.menu.id = `${button.id}-options`;
    this.menu.popover = 'auto';
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('aria-label', button.getAttribute('aria-label') ?? '');
    button.setAttribute('aria-controls', this.menu.id);
    menuHost.append(this.menu);
    button.addEventListener('click', () => this.opened ? this.close() : this.open());
    button.addEventListener('keydown', event => this.keydown(event));
    button.addEventListener('blur', () => this.close());
    this.menu.addEventListener('pointerdown', event => event.preventDefault());
    this.menu.addEventListener('pointermove', event => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (option && option.getAttribute('aria-disabled') !== 'true') { this.activate(Number(option.dataset.index), false); }
    });
    this.menu.addEventListener('click', event => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (option) { this.choose(Number(option.dataset.index)); }
    });
    this.menu.addEventListener('toggle', () => {
      button.setAttribute('aria-expanded', String(this.opened));
      if (!this.opened) { button.removeAttribute('aria-activedescendant'); }
    });
    window.addEventListener('resize', () => this.close());
    document.addEventListener('scroll', event => {
      if (event.target !== this.menu && !this.menu.contains(event.target as Node)) { this.close(); }
    }, true);
  }

  private get opened(): boolean { return this.menu.matches(':popover-open'); }

  update(options: DropdownOption[], value: string, disabled = false): void {
    const reenabled = this.button.disabled && !disabled;
    if (disabled && !this.button.disabled) { this.restoreFocus = document.activeElement === this.button; }
    if (JSON.stringify(options) !== JSON.stringify(this.options)) {
      this.close();
      this.options = options;
      this.menu.replaceChildren(...options.map((option, index) => {
        const node = document.createElement('div');
        node.className = 'settings-dropdown-option';
        node.id = `${this.menu.id}-${index}`;
        node.dataset.index = String(index);
        node.dataset.value = option.value;
        node.setAttribute('role', 'option');
        node.setAttribute('aria-disabled', String(!!option.disabled));
        const check = document.createElement('span');
        check.className = 'codicon codicon-check';
        check.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = option.label;
        node.append(check, label);
        return node;
      }));
    }
    this.button.value = value;
    this.button.disabled = disabled;
    this.label.textContent = options.find(option => option.value === value)?.label ?? value;
    this.button.title = this.label.textContent;
    for (const [index, node] of [...this.menu.children].entries()) {
      node.setAttribute('aria-selected', String(options[index].value === value));
    }
    if (disabled) { this.close(); }
    if (reenabled) {
      if (this.restoreFocus && document.activeElement === document.body && this.button.getClientRects().length) { this.button.focus({ preventScroll: true }); }
      this.restoreFocus = false;
    }
  }

  close(): void {
    if (this.opened) { this.menu.hidePopover(); }
    this.button.setAttribute('aria-expanded', 'false');
    this.button.removeAttribute('aria-activedescendant');
    this.prefix = '';
  }

  private open(last = false): void {
    if (this.button.disabled || !this.options.some(option => !option.disabled)) { return; }
    this.menu.showPopover();
    const rect = this.button.getBoundingClientRect();
    const gap = 4, margin = 8;
    this.menu.style.width = `${Math.min(Math.max(rect.width, 220), innerWidth - margin * 2)}px`;
    const below = innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const upwards = below < Math.min(this.menu.scrollHeight, 240) && above > below;
    this.menu.style.maxHeight = `${Math.max(0, Math.min(320, upwards ? above : below))}px`;
    this.menu.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - this.menu.offsetWidth - margin))}px`;
    this.menu.style.top = `${upwards ? Math.max(margin, rect.top - gap - this.menu.offsetHeight) : rect.bottom + gap}px`;
    this.button.setAttribute('aria-expanded', 'true');
    const selected = this.options.findIndex(option => option.value === this.button.value && !option.disabled);
    this.activate(selected >= 0 ? selected : last ? this.lastEnabled() : this.options.findIndex(option => !option.disabled));
  }

  private lastEnabled(): number {
    for (let index = this.options.length - 1; index >= 0; index--) { if (!this.options[index].disabled) { return index; } }
    return -1;
  }

  private activate(index: number, scroll = true): void {
    this.active = index;
    for (const [i, node] of [...this.menu.children].entries()) { node.classList.toggle('active', i === index); }
    const node = this.menu.children[index];
    if (node) {
      this.button.setAttribute('aria-activedescendant', node.id);
      if (scroll) { node.scrollIntoView({ block: 'nearest' }); }
    }
  }

  private choose(index: number): void {
    const option = this.options[index];
    if (!option || option.disabled) { return; }
    this.close();
    if (option.value !== this.button.value || this.acceptCurrent) {
      this.update(this.options, option.value);
      this.changed();
    }
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' || event.key === 'Escape') {
      if (this.opened && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      this.close(); return;
    }
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!this.opened) { this.open(event.key === 'ArrowUp' || event.key === 'End'); return; }
      if (event.key === 'Enter' || event.key === ' ') { this.choose(this.active); return; }
      const enabled = this.options.flatMap((option, index) => option.disabled ? [] : [index]);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : (enabled.indexOf(this.active) + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      this.activate(enabled[index]);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!this.opened) { this.open(); }
      this.prefix = Date.now() - this.typedAt > 700 ? event.key : this.prefix + event.key;
      this.typedAt = Date.now();
      const index = this.options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(this.prefix.toLocaleLowerCase()));
      if (index >= 0) { this.activate(index); }
    }
  }
}
