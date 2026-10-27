import { t } from '../localization';
import { projectParamEffectiveValue } from '../workflow-types';
import type { Field, ParamLayout, Parameters, ParamState, ParamValues, ParamValue } from '../workflow-types';

type Action = ParamLayout['actions'][number];
type GroupAction = Extract<Action, { kind: 'quick' | 'auxiliary' }>;
interface ActionView { action: Action; button: HTMLButtonElement; label: HTMLSpanElement; summary?: HTMLSpanElement; count?: HTMLElement }
interface ParameterActionOptions {
  current(): { values: ParamValues; states: Record<string, ParamState>; disabled: boolean; loading: boolean; modelConfigurationRequired?: boolean };
  fieldRoot(name: string): HTMLElement;
  onChange(name: string, value: ParamValue): void;
  onReset(names: string[]): void;
  onConfigureModel?(): void;
  onOpenUserSetting?(key: string): void;
}

const icon = (name: string): HTMLSpanElement => {
  const element = document.createElement('span');
  element.className = `codicon codicon-${name}`;
  element.ariaHidden = 'true';
  return element;
};

export function parameterSelectionLabel(field: Field, value: ParamValue | undefined, state?: ParamState): string {
  value = projectParamEffectiveValue(field, value);
  const options = state?.resolvedOptions ?? field.options ?? [];
  if (!options.length) { return field.userSetting ? String(value) : t("No options"); }
  if (Array.isArray(value)) {
    if (value.length > 1) { return t("{0} selected", value.length); }
    value = value[0];
  }
  return options.find((option) => option.value === value)?.label || value || t("Not selected");
}

export class ParameterActions {
  private parameters: Parameters = { fields: [] };
  private readonly views: ActionView[] = [];
  private readonly popup: HTMLDivElement;
  private active?: ActionView & { action: GroupAction };
  private activeParam?: string;
  private layoutFrame?: number;

  constructor(private readonly container: HTMLElement, private readonly options: ParameterActionOptions) {
    this.popup = document.createElement('div');
    this.popup.id = 'parameter-popover';
    this.popup.className = 'parameter-popover';
    this.popup.tabIndex = -1;
    this.popup.hidden = true;
    document.body.append(this.popup);
    document.addEventListener('pointerdown', (event) => {
      if (this.active && !this.popup.contains(event.target as Node) && !this.active.button.contains(event.target as Node)) { this.close(); }
    });
    document.addEventListener('focusin', (event) => {
      if (this.active && !this.popup.contains(event.target as Node) && !this.active.button.contains(event.target as Node)) { this.close(); }
    });
    this.popup.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || this.active?.action.kind !== 'quick') { return; }
      const buttons = Array.from(this.popup.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled), [role=option]:not(:disabled)'))
        .filter((button) => button.getClientRects().length > 0);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (!buttons.length) { return; }
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    });
    window.addEventListener('resize', () => this.scheduleLayout());
    window.addEventListener('scroll', () => this.position(), true);
    const resize = new ResizeObserver(() => this.scheduleLayout());
    resize.observe(this.container);
    resize.observe(document.querySelector('main')!);
    void document.fonts?.ready.then(() => this.scheduleLayout());
    document.fonts?.addEventListener('loadingdone', () => this.scheduleLayout());
  }

  render(parameters: Parameters): void {
    this.close();
    this.parameters = parameters;
    this.views.length = 0;
    this.container.replaceChildren();
    for (const action of parameters.paramLayout?.actions ?? []) {
      if (action.kind === 'slash') { continue; }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'param-action';
      button.dataset.paramAction = action.kind;
      button.dataset.actionId = action.kind === 'mode' ? action.name : action.id;
      const label = document.createElement('span');
      label.className = 'param-action-label';
      const view: ActionView = { action, button, label };
      if (action.kind === 'quick') { button.append(icon(action.icon ?? 'settings')); }
      if (action.kind === 'auxiliary') {
        button.append(icon('settings'));
        view.count = document.createElement('small');
      }
      button.append(label);
      if (action.kind === 'quick') {
        view.summary = document.createElement('span'); view.summary.className = 'param-action-summary'; button.append(view.summary);
      }
      if (view.count) { button.append(view.count); }
      if (action.kind !== 'mode') {
        if (action.kind !== 'quick') { button.append(icon('chevron-up')); }
        button.setAttribute('aria-haspopup', action.kind === 'quick' ? 'menu' : 'dialog');
        button.setAttribute('aria-controls', this.popup.id);
        button.setAttribute('aria-expanded', 'false');
      }
      button.addEventListener('click', () => {
        const fixed = action.kind === 'quick' ? this.groupFields(action).filter(field => field.userSetting?.mode === 'fixed') : [];
        if (fixed.length === 1 && this.groupFields(action as GroupAction).length === 1) {
          this.close(); this.options.onOpenUserSetting?.(fixed[0].userSetting!.key); return;
        }
        if (action.kind === 'quick' && this.groupFields(action).some(field => field.name === 'model') && this.options.current().modelConfigurationRequired && this.options.onConfigureModel) {
          this.close(); this.options.onConfigureModel(); return;
        }
        if (action.kind === 'mode') {
          const field = this.field(action.name);
          if (!field) { return; }
          const choices = this.visibleOptions(field).filter((option) => !this.options.current().states[field.name]?.options?.[option.value]?.disabled);
          const index = Math.max(0, choices.findIndex((option) => option.value === this.options.current().values[field.name]));
          if (choices.length > 1) { this.options.onChange(field.name, choices[(index + 1) % choices.length].value); }
        } else if (this.active === view) { this.close(true); }
        else { this.open(view as ActionView & { action: GroupAction }); }
      });
      this.container.append(button);
      this.views.push(view);
    }
    this.update();
  }

  private field(name: string): Field | undefined { return this.parameters.fields.find((field) => field.name === name); }
  private visibleOptions(field: Field) {
    const state = this.options.current().states[field.name];
    return (state?.resolvedOptions ?? field.options ?? []).filter((option) => state?.options?.[option.value]?.visible !== false);
  }
  private groupFields(action: GroupAction): Field[] {
    return action.params.map((name) => this.field(name)).filter((field): field is Field =>
      !!field && this.options.current().states[field.name]?.visible !== false);
  }

  update(): void {
    const { values, states, disabled, loading, modelConfigurationRequired } = this.options.current();
    for (const view of this.views) {
      const { action } = view;
      if (action.kind === 'mode') {
        const field = this.field(action.name);
        const choices = field ? this.visibleOptions(field) : [];
        view.button.hidden = !field || states[action.name]?.visible === false || choices.length < 2;
        view.button.disabled = disabled || loading || states[action.name]?.disabled === true;
        view.label.textContent = field ? `${field.label || field.name}: ${parameterSelectionLabel(field, values[field.name], states[field.name])}` : '';
      } else if (action.kind !== 'slash') {
        const fields = this.groupFields(action);
        const configureModel = action.kind === 'quick' && fields.some(field => field.name === 'model') && modelConfigurationRequired && !!this.options.onConfigureModel;
        const settingsShortcut = fields.length === 1 && fields[0].userSetting?.mode === 'fixed';
        view.button.hidden = fields.length === 0;
        view.button.disabled = !settingsShortcut && (disabled || !configureModel && (action.kind === 'auxiliary' ? loading : fields.every((field) =>
          states[field.name]?.disabled === true || this.visibleOptions(field).length === 0)));
        const summaries = action.summary?.map((name) => fields.find((field) => field.name === name))
          .filter((field): field is Field => !!field && !!projectParamEffectiveValue(field, values[field.name])?.length)
          .map((field) => parameterSelectionLabel(field, values[field.name], states[field.name])) ?? [];
        view.label.textContent = action.label;
        view.label.hidden = action.kind === 'quick';
        if (view.summary) { view.summary.textContent = configureModel ? t('Configure model') : summaries.join(' \u00b7 ') || t("Not selected"); }
        if (view.count) { view.count.textContent = String(fields.length); }
        view.button.dataset.configureModel = String(!!configureModel);
        view.button.setAttribute('aria-haspopup', configureModel ? 'dialog' : action.kind === 'quick' ? 'menu' : 'dialog');
        view.button.setAttribute('aria-controls', configureModel ? 'project-configurations-dialog' : this.popup.id);
        view.button.setAttribute('aria-busy', String(loading && !configureModel && !settingsShortcut));
      }
      const fixed = action.kind === 'quick' && this.groupFields(action).length === 1 && this.groupFields(action)[0].userSetting?.mode === 'fixed';
      if (fixed) { view.button.removeAttribute('aria-haspopup'); view.button.removeAttribute('aria-controls'); view.button.removeAttribute('aria-expanded'); }
      view.button.title = view.button.ariaLabel = [view.label.textContent, view.summary?.textContent, fixed ? t('Change in user settings') : undefined].filter(Boolean).join(': ');
    }
    this.scheduleLayout();
    if (this.active) {
      if (disabled || this.active.button.hidden || this.active.button.dataset.configureModel === 'true') { this.close(); }
      else if (this.active.action.kind === 'quick') { this.renderQuick(); }
      else {
        const body = this.popup.querySelector('.parameter-popover-fields')!;
        for (const field of this.groupFields(this.active.action)) {
          const root = this.options.fieldRoot(field.name);
          if (root.parentElement !== body) { body.append(root); }
        }
      }
      this.position();
    }
  }

  private scheduleLayout(): void {
    if (this.layoutFrame !== undefined) { return; }
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      this.fitActions();
      this.position();
    });
  }

  private fitActions(): void {
    const available = this.container.clientWidth;
    if (!available) { return; }
    const visible = this.views.filter(view => !view.button.hidden);
    const gap = Number.parseFloat(getComputedStyle(this.container).columnGap) || 0;
    for (const view of visible) { view.button.dataset.iconOnly = 'false'; }
    let width = Math.max(0, visible.length - 1) * gap + visible.reduce((sum, view) => sum + view.button.getBoundingClientRect().width, 0);
    // Measure the current labels so collapsing follows actual available space and declaration order.
    for (const view of [...visible].reverse()) {
      if (width <= available + 0.5) { break; }
      if (view.action.kind !== 'quick') { continue; }
      const expanded = view.button.getBoundingClientRect().width;
      view.button.dataset.iconOnly = 'true';
      width -= expanded - view.button.getBoundingClientRect().width;
    }
  }

  openForField(name: string): boolean {
    const view = this.views.find((view) => (view.action.kind === 'quick' || view.action.kind === 'auxiliary') && view.action.params.includes(name));
    if (!view || view.action.kind === 'mode' || view.action.kind === 'slash') { return false; }
    if (this.field(name)?.userSetting?.mode === 'fixed') { this.options.onOpenUserSetting?.(this.field(name)!.userSetting!.key); return true; }
    if (name === 'model' && this.options.current().modelConfigurationRequired && this.options.onConfigureModel) { view.button.focus(); return true; }
    this.open(view as ActionView & { action: GroupAction }, name);
    return true;
  }

  private open(view: ActionView & { action: GroupAction }, name?: string): void {
    this.close();
    this.active = view;
    this.activeParam = view.action.kind === 'quick' ? name : undefined;
    view.button.setAttribute('aria-expanded', 'true');
    this.popup.hidden = false;
    this.popup.dataset.kind = view.action.kind;
    this.popup.ariaLabel = view.action.label;
    this.popup.setAttribute('role', view.action.kind === 'quick' ? 'menu' : 'dialog');
    if (view.action.kind === 'quick') { this.renderQuick(); }
    else {
      const header = document.createElement('div');
      header.className = 'parameter-popover-heading';
      const title = document.createElement('strong');
      title.textContent = view.action.label;
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'icon-button';
      close.title = close.ariaLabel = t("Close parameters");
      close.append(icon('close'));
      close.addEventListener('click', () => this.close(true));
      header.append(title, close);
      const body = document.createElement('div');
      body.className = 'parameter-popover-fields';
      for (const field of this.groupFields(view.action)) { body.append(this.options.fieldRoot(field.name)); }
      this.popup.replaceChildren(header, body);
    }
    this.position();
    if (name && view.action.kind === 'auxiliary') { this.options.fieldRoot(name).querySelector<HTMLElement>('input, select, textarea')?.focus(); }
    else {
      (this.popup.querySelector<HTMLButtonElement>('[role=option][aria-selected=true]:not(:disabled)')
        ?? this.popup.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled), button:not(:disabled)'))?.focus();
    }
  }

  close(restoreFocus = false): void {
    const button = this.active?.button;
    button?.setAttribute('aria-expanded', 'false');
    this.active = undefined;
    this.activeParam = undefined;
    this.popup.hidden = true;
    if (restoreFocus) { button?.focus(); }
  }

  private renderQuick(): void {
    if (!this.active) { return; }
    const action = this.active.action;
    const fields = this.groupFields(action);
    const single = fields.length === 1;
    const { values, states, disabled, loading } = this.options.current();
    const focused = this.popup.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    const previousScroll = this.popup.querySelector<HTMLElement>('.quick-options-list')?.scrollTop ?? 0;
    const menu = document.createElement('div');
    menu.className = single ? 'quick-panel quick-menu quick-direct' : 'quick-panel quick-menu';
    const title = document.createElement('div');
    title.className = 'parameter-popover-heading'; title.textContent = action.label;
    menu.append(title);
    for (const field of single ? [] : fields) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'quick-param-row';
      row.setAttribute('role', 'menuitem'); row.setAttribute('aria-haspopup', 'listbox');
      row.dataset.param = field.name; row.dataset.focusKey = `field:${field.name}`;
      row.disabled = disabled || loading || states[field.name]?.disabled === true || this.visibleOptions(field).length === 0;
      row.setAttribute('aria-expanded', String(this.activeParam === field.name));
      if (field.userSetting?.mode === 'fixed') { row.removeAttribute('aria-haspopup'); row.removeAttribute('aria-expanded'); row.title = t('Change in user settings'); }
      const label = document.createElement('span'); label.textContent = field.label || field.name;
      const value = document.createElement('span'); value.className = 'quick-param-value';
      value.textContent = parameterSelectionLabel(field, values[field.name], states[field.name]);
      row.append(label, value, icon(field.userSetting?.mode === 'fixed' ? 'settings-gear' : 'chevron-right'));
      row.addEventListener('click', () => {
        if (field.userSetting?.mode === 'fixed') { this.close(); this.options.onOpenUserSetting?.(field.userSetting.key); return; }
        this.activeParam = field.name; this.renderQuick(); this.position();
        (this.popup.querySelector<HTMLButtonElement>('[role=option][aria-selected=true]:not(:disabled)')
          ?? this.popup.querySelector<HTMLButtonElement>('[role=option]:not(:disabled)'))?.focus();
      });
      menu.append(row);
    }
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'quick-reset'; reset.setAttribute('role', 'menuitem');
    reset.dataset.focusKey = 'reset'; reset.disabled = disabled || loading;
    reset.textContent = single && fields[0].userSetting ? t('Reset to user settings') : t("Reset options"); reset.append(icon('discard'));
    reset.addEventListener('click', () => { this.activeParam = undefined; this.options.onReset(fields.filter(field => field.userSetting?.mode !== 'fixed').map((field) => field.name)); });
    const field = single ? fields[0] : fields.find((field) => field.name === this.activeParam && states[field.name]?.disabled !== true);
    this.activeParam = single ? undefined : field?.name;
    const panels: HTMLElement[] = [menu];
    if (field) {
      const detail = single ? menu : document.createElement('div');
      if (!single) {
        detail.className = 'quick-panel quick-detail';
        const back = document.createElement('button'); back.type = 'button'; back.className = 'quick-detail-heading';
        back.title = back.ariaLabel = t("Back to {0}", action.label);
        back.append(icon('arrow-left'), document.createTextNode(field.label || field.name));
        back.addEventListener('click', () => {
          this.activeParam = undefined; this.renderQuick(); this.position();
          this.popup.querySelectorAll<HTMLButtonElement>('[data-param]').forEach((button) => { if (button.dataset.param === field.name) { button.focus(); } });
        });
        detail.append(back);
      }
      const list = document.createElement('div'); list.className = 'quick-options-list';
      list.setAttribute('role', 'listbox'); list.ariaLabel = field.label || field.name;
      const multiple = field.multiple || field.control === 'checkboxes';
      if (multiple) { list.setAttribute('aria-multiselectable', 'true'); }
      for (const option of this.visibleOptions(field)) {
        const selected = multiple ? Array.isArray(values[field.name]) && values[field.name].includes(option.value) : projectParamEffectiveValue(field, values[field.name]) === option.value;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'quick-option-row';
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(selected));
        button.dataset.focusKey = `option:${option.value}`;
        button.disabled = disabled || loading || states[field.name]?.disabled === true || states[field.name]?.options?.[option.value]?.disabled === true;
        const check = document.createElement('span'); check.className = 'quick-option-check';
        if (selected) { check.append(icon('check')); }
        const copy = document.createElement('span'); copy.className = 'quick-option-copy';
        const label = document.createElement('span'); label.textContent = option.label || option.value; copy.append(label);
        if (option.description) { const description = document.createElement('small'); description.textContent = option.description; copy.append(description); }
        button.append(check, copy);
        button.addEventListener('click', () => {
          const current = this.options.current().values[field.name];
          const next = multiple ? selected ? (Array.isArray(current) ? current : []).filter((value) => value !== option.value)
            : [...(Array.isArray(current) ? current : []), option.value] : option.value;
          if (!multiple) { if (single) { this.close(true); } else { this.activeParam = undefined; } }
          this.options.onChange(field.name, next);
          if (!multiple && !single) {
            this.popup.querySelectorAll<HTMLButtonElement>('[data-param]').forEach((row) => { if (row.dataset.param === field.name) { row.focus(); } });
          }
        });
        list.append(button);
      }
      detail.append(list);
      if (!single) { panels.push(detail); }
    }
    menu.append(reset);
    this.popup.replaceChildren(...panels);
    const list = this.popup.querySelector<HTMLElement>('.quick-options-list');
    if (list) { list.scrollTop = previousScroll; }
    if (focused) {
      const target = Array.from(this.popup.querySelectorAll<HTMLElement>('[data-focus-key]:not(:disabled)')).find((element) => element.dataset.focusKey === focused);
      (target ?? this.popup.querySelector<HTMLElement>('[role=option][aria-selected=true]:not(:disabled)')
        ?? this.popup.querySelector<HTMLElement>('[role=option]:not(:disabled), [role=menuitem]:not(:disabled)'))?.focus();
    }
  }

  private position(): void {
    if (!this.active) { return; }
    const anchor = this.active.button.getBoundingClientRect();
    const boundary = document.querySelector('main')!.getBoundingClientRect();
    const leftEdge = Math.max(12, boundary.left + 8);
    const rightEdge = Math.min(window.innerWidth - 12, boundary.right - 8);
    const available = Math.max(0, rightEdge - leftEdge);
    const quick = this.active.action.kind === 'quick';
    const width = Math.min(quick ? 292 : 336, available);
    let left = Math.min(Math.max(leftEdge, quick ? anchor.right - width : anchor.left), rightEdge - width);
    let total = width;
    let compact = false;
    this.popup.dataset.detailSide = '';
    if (quick && this.activeParam) {
      const detailWidth = Math.min(320, available);
      const placeLeft = left - leftEdge >= detailWidth + 8;
      const placeRight = rightEdge - (left + width) >= detailWidth + 8;
      compact = !placeLeft && !placeRight;
      if (!compact) { if (placeLeft) { left -= detailWidth + 8; } total += detailWidth + 8; }
      this.popup.dataset.detailSide = placeLeft ? 'left' : 'right';
    }
    this.popup.dataset.compact = String(compact);
    this.popup.style.left = `${left}px`;
    this.popup.style.bottom = `${window.innerHeight - anchor.top + 8}px`;
    this.popup.style.width = `${total}px`;
    this.popup.style.maxHeight = `${Math.max(40, Math.min(380, anchor.top - 20))}px`;
  }
}
