import type { WorkflowField, WorkflowParamLayout, WorkflowParameters, WorkflowParamState, WorkflowParamValues, WorkflowParamValue } from '../src/workflow-types';

type Action = WorkflowParamLayout['actions'][number];
type GroupAction = Extract<Action, { kind: 'quick' | 'auxiliary' }>;
interface ActionView { action: Action; button: HTMLButtonElement; label: HTMLSpanElement; count?: HTMLElement }
interface ParameterActionOptions {
  current(): { values: WorkflowParamValues; states: Record<string, WorkflowParamState>; disabled: boolean; loading: boolean };
  fieldRoot(name: string): HTMLElement;
  onChange(name: string, value: WorkflowParamValue): void;
  onReset(names: string[]): void;
}

const icon = (name: string): HTMLSpanElement => {
  const element = document.createElement('span');
  element.className = `codicon codicon-${name}`;
  element.ariaHidden = 'true';
  return element;
};

export function parameterSelectionLabel(field: WorkflowField, value: WorkflowParamValue | undefined, state?: WorkflowParamState): string {
  const options = state?.resolvedOptions ?? field.options ?? [];
  if (!options.length) { return '\u6682\u65e0\u9009\u9879'; }
  if (Array.isArray(value)) {
    if (value.length > 1) { return `\u5df2\u9009 ${value.length} \u9879`; }
    value = value[0];
  }
  return options.find((option) => option.value === value)?.label || value || '\u672a\u9009\u62e9';
}

export class ParameterActions {
  private parameters: WorkflowParameters = { fields: [] };
  private readonly views: ActionView[] = [];
  private readonly popup: HTMLDivElement;
  private active?: ActionView & { action: GroupAction };
  private activeParam?: string;

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
    window.addEventListener('resize', () => this.position());
    window.addEventListener('scroll', () => this.position(), true);
    new ResizeObserver(() => this.position()).observe(document.querySelector('main')!);
  }

  render(parameters: WorkflowParameters): void {
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
      if (action.kind === 'auxiliary') {
        button.append(icon('settings'));
        view.count = document.createElement('small');
      }
      button.append(label);
      if (view.count) { button.append(view.count); }
      if (action.kind !== 'mode') {
        button.append(icon('chevron-up'));
        button.setAttribute('aria-haspopup', action.kind === 'quick' ? 'menu' : 'dialog');
        button.setAttribute('aria-controls', this.popup.id);
        button.setAttribute('aria-expanded', 'false');
      }
      button.addEventListener('click', () => {
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

  private field(name: string): WorkflowField | undefined { return this.parameters.fields.find((field) => field.name === name); }
  private visibleOptions(field: WorkflowField) {
    const state = this.options.current().states[field.name];
    return (state?.resolvedOptions ?? field.options ?? []).filter((option) => state?.options?.[option.value]?.visible !== false);
  }
  private groupFields(action: GroupAction): WorkflowField[] {
    return action.params.map((name) => this.field(name)).filter((field): field is WorkflowField =>
      !!field && this.options.current().states[field.name]?.visible !== false);
  }

  update(): void {
    const { values, states, disabled, loading } = this.options.current();
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
        view.button.hidden = fields.length === 0;
        view.button.disabled = disabled || (action.kind === 'auxiliary' ? loading : fields.every((field) =>
          states[field.name]?.disabled === true || this.visibleOptions(field).length === 0));
        const summaries = action.summary?.map((name) => fields.find((field) => field.name === name))
          .filter((field): field is WorkflowField => !!field && !!values[field.name]?.length)
          .map((field) => parameterSelectionLabel(field, values[field.name], states[field.name])) ?? [];
        view.label.textContent = action.kind === 'quick' && summaries.length ? `${action.label}: ${summaries.join(' \u00b7 ')}` : action.label;
        if (view.count) { view.count.textContent = String(fields.length); }
        view.button.setAttribute('aria-busy', String(loading));
      }
      view.button.title = view.label.textContent || '';
      view.button.ariaLabel = view.label.textContent || '';
    }
    if (this.active) {
      if (disabled || this.active.button.hidden) { this.close(); }
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

  openForField(name: string): boolean {
    const view = this.views.find((view) => (view.action.kind === 'quick' || view.action.kind === 'auxiliary') && view.action.params.includes(name));
    if (!view || view.action.kind === 'mode' || view.action.kind === 'slash') { return false; }
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
      close.title = close.ariaLabel = '\u5173\u95ed\u53c2\u6570';
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
    else { this.popup.querySelector<HTMLButtonElement>('[role=option][aria-selected=true], [role=menuitem]:not(:disabled), button:not(:disabled)')?.focus(); }
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
    const { values, states, disabled, loading } = this.options.current();
    const focused = this.popup.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    const previousScroll = this.popup.querySelector<HTMLElement>('.quick-options-list')?.scrollTop ?? 0;
    const menu = document.createElement('div');
    menu.className = 'quick-panel quick-menu';
    const title = document.createElement('div');
    title.className = 'parameter-popover-heading'; title.textContent = action.label;
    menu.append(title);
    for (const field of fields) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'quick-param-row';
      row.setAttribute('role', 'menuitem'); row.setAttribute('aria-haspopup', 'listbox');
      row.dataset.param = field.name; row.dataset.focusKey = `field:${field.name}`;
      row.disabled = disabled || loading || states[field.name]?.disabled === true || this.visibleOptions(field).length === 0;
      row.setAttribute('aria-expanded', String(this.activeParam === field.name));
      const label = document.createElement('span'); label.textContent = field.label || field.name;
      const value = document.createElement('span'); value.className = 'quick-param-value';
      value.textContent = parameterSelectionLabel(field, values[field.name], states[field.name]);
      row.append(label, value, icon('chevron-right'));
      row.addEventListener('click', () => {
        this.activeParam = field.name; this.renderQuick(); this.position();
        this.popup.querySelector<HTMLButtonElement>('[role=option][aria-selected=true], [role=option]:not(:disabled)')?.focus();
      });
      menu.append(row);
    }
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'quick-reset'; reset.setAttribute('role', 'menuitem');
    reset.dataset.focusKey = 'reset'; reset.disabled = disabled || loading;
    reset.textContent = '\u91cd\u7f6e\u9009\u9879'; reset.append(icon('discard'));
    reset.addEventListener('click', () => { this.activeParam = undefined; this.options.onReset(fields.map((field) => field.name)); });
    menu.append(reset);
    const field = fields.find((field) => field.name === this.activeParam && states[field.name]?.disabled !== true);
    this.activeParam = field?.name;
    const panels: HTMLElement[] = [menu];
    if (field) {
      const detail = document.createElement('div'); detail.className = 'quick-panel quick-detail';
      const back = document.createElement('button'); back.type = 'button'; back.className = 'quick-detail-heading';
      back.title = back.ariaLabel = `\u8fd4\u56de ${action.label}`;
      back.append(icon('arrow-left'), document.createTextNode(field.label || field.name));
      back.addEventListener('click', () => {
        this.activeParam = undefined; this.renderQuick(); this.position();
        this.popup.querySelectorAll<HTMLButtonElement>('[data-param]').forEach((button) => { if (button.dataset.param === field.name) { button.focus(); } });
      });
      const list = document.createElement('div'); list.className = 'quick-options-list';
      list.setAttribute('role', 'listbox'); list.ariaLabel = field.label || field.name;
      const multiple = field.multiple || field.control === 'checkboxes';
      if (multiple) { list.setAttribute('aria-multiselectable', 'true'); }
      for (const option of this.visibleOptions(field)) {
        const selected = multiple ? Array.isArray(values[field.name]) && values[field.name].includes(option.value) : values[field.name] === option.value;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'quick-option-row';
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(selected));
        button.dataset.focusKey = `option:${option.value}`;
        button.disabled = disabled || loading || states[field.name]?.options?.[option.value]?.disabled === true;
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
          if (!multiple) { this.activeParam = undefined; }
          this.options.onChange(field.name, next);
          if (!multiple) {
            this.popup.querySelectorAll<HTMLButtonElement>('[data-param]').forEach((row) => { if (row.dataset.param === field.name) { row.focus(); } });
          }
        });
        list.append(button);
      }
      detail.append(back, list); panels.push(detail);
    }
    this.popup.replaceChildren(...panels);
    const list = this.popup.querySelector<HTMLElement>('.quick-options-list');
    if (list) { list.scrollTop = previousScroll; }
    if (focused) { this.popup.querySelectorAll<HTMLElement>('[data-focus-key]').forEach((element) => { if (element.dataset.focusKey === focused) { element.focus(); } }); }
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
