import { t } from '../localization';
import { validateProjectValues, projectFormValue, type InputRequest, type ParamValues, type Field } from '../workflow-types';
import { iconButton } from './ui';

interface PromptOptions {
  submit(values: ParamValues): void;
  stop(): void;
  files?(name: string): void;
}

export class InputPrompt {
  readonly root = document.createElement('section');
  private readonly form = document.createElement('form');
  private readonly values: ParamValues = {};
  private readonly touched = new Set<string>();
  private readonly steps: number[];
  private index = 0;
  private busy = false;
  private error = '';

  constructor(readonly request: InputRequest, private readonly options: PromptOptions) {
    this.steps = [...new Set(request.params.map((field) => field.step ?? 1))].sort((a, b) => a - b);
    for (const field of request.params) {
      const value = request.defaultValues?.[field.name] ?? field.defaultValue ?? '';
      this.values[field.name] = projectFormValue(field, value);
    }
    this.root.className = 'input-prompt';
    const title = document.createElement('h2'); title.textContent = request.title;
    const header = document.createElement('header'); header.append(title, iconButton('close', t("End run"), this.options.stop)); this.root.append(header);
    if (request.description) { const description = document.createElement('p'); description.textContent = request.description; this.root.append(description); }
    this.root.append(this.form);
    this.form.addEventListener('submit', (event) => { event.preventDefault(); });
    this.render();
  }

  setBusy(busy: boolean, error = ''): void { if (this.busy === busy && this.error === error) { return; } this.busy = busy; this.error = error; this.render(); }
  fileValue(name: string, value: string): void { this.values[name] = value; this.touched.add(name); this.render(); }

  private button(label: string, action: () => void, className = ''): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.className = `prompt-button ${className}`; button.disabled = this.busy;
    button.addEventListener('click', action); return button;
  }

  private submit(values = this.values): void {
    try { validateProjectValues(this.request.params, values); this.busy = true; this.error = ''; this.render(); this.options.submit(values); }
    catch (error) { this.error = String(error instanceof Error ? error.message : error); this.render(); }
  }

  private renderPlan(): void {
    const instructions = document.createElement('textarea');
    instructions.placeholder = t("Revise instructions"); instructions.ariaLabel = t("Revise instructions"); instructions.rows = 3;
    instructions.value = String(this.values.instructions ?? ''); instructions.disabled = this.busy;
    const modify = this.button(t("Revise plan"), () => {
      if (!String(this.values.instructions ?? '').trim()) { instructions.focus(); return; }
      this.submit({ decision: 'decline', instructions: this.values.instructions });
    });
    instructions.addEventListener('input', () => { this.values.instructions = instructions.value; modify.disabled = this.busy || !instructions.value.trim(); });
    modify.disabled = this.busy || !instructions.value.trim();
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = t("Revise instructions");
    details.open = !!this.values.instructions; details.append(summary, instructions, modify);
    details.addEventListener('toggle', () => { if (details.open) { instructions.focus(); } });
    this.form.append(this.button(t("Execute plan"), () => this.submit({ decision: 'approve', instructions: this.values.instructions ?? '' }), 'plan-approve'), details);
  }

  private field(field: Field): HTMLElement {
    const root = document.createElement('div'); root.className = 'prompt-field';
    const label = document.createElement('label'); label.textContent = `${field.label || field.name}${field.required ? ' *' : ''}`;
    root.append(label);
    if (field.description) { const description = document.createElement('p'); description.textContent = field.description; root.append(description); }
    const value = this.values[field.name];
    if (field.type === 'file' || field.control === 'audio') {
      let names = '';
      try {
        const files = JSON.parse(String(value || '[]'));
        names = (Array.isArray(files) ? files : [files]).map(file => file?.name ?? '').join(', ');
      } catch { /* An empty field has no file selection. */ }
      const selected = document.createElement('span'); selected.textContent = names;
      root.append(selected, this.button(t("Choose files"), () => this.options.files?.(field.name)));
    } else if (field.options?.length) {
      const multiple = field.multiple || field.control === 'checkboxes';
      for (const option of field.options) {
        const row = document.createElement('label'); row.className = 'prompt-choice';
        const input = document.createElement('input'); input.type = multiple ? 'checkbox' : 'radio';
        input.name = `${this.request.requestId}:${field.name}`; input.value = option.value; input.disabled = this.busy;
        input.checked = this.touched.has(field.name) && (Array.isArray(value) ? value.includes(option.value) : value === option.value);
        input.addEventListener('change', () => {
          this.touched.add(field.name);
          this.values[field.name] = multiple ? Array.from(root.querySelectorAll<HTMLInputElement>('input:checked')).map((control) => control.value) : option.value;
          if (!multiple && this.index < this.steps.length - 1 && this.request.params.filter((entry) => (entry.step ?? 1) === this.steps[this.index]).length === 1) { this.index++; this.render(); }
        });
        const text = document.createElement('span'); text.textContent = option.label || option.value;
        if (option.description) { const small = document.createElement('small'); small.textContent = option.description; text.append(small); }
        row.append(input, text); root.append(row);
      }
    } else {
      const control = field.control === 'textarea' ? document.createElement('textarea') : document.createElement('input');
      if (control instanceof HTMLInputElement) {
        control.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number'
          : field.control === 'datetime' ? 'datetime-local' : ['date', 'time'].includes(field.control ?? '') ? field.control! : 'text';
        if (control.type === 'number') { control.step = 'any'; }
        if (control.type === 'checkbox') { control.checked = value === 'true'; }
      }
      control.id = `prompt-${this.request.requestId}-${field.name}`; label.htmlFor = control.id;
      control.value = typeof value === 'string' ? value : JSON.stringify(value); control.disabled = this.busy;
      control.addEventListener('input', () => {
        this.touched.add(field.name);
        this.values[field.name] = control instanceof HTMLInputElement && control.type === 'checkbox' ? String(control.checked) : control.value;
      });
      root.append(control);
    }
    return root;
  }

  private render(): void {
    const active = document.activeElement;
    const focusName = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.id : '';
    this.form.replaceChildren();
    if (this.request.metadata?.type === 'agent-plan-approval') { this.renderPlan(); }
    else if (this.request.metadata?.type === 'tool-approval') {
      if (this.request.metadata.toolArguments !== undefined) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = t("Tool input"); const pre = document.createElement('pre'); pre.textContent = JSON.stringify(this.request.metadata.toolArguments, null, 2); details.append(summary, pre); this.form.append(details); }
      const actions = document.createElement('div'); actions.className = 'prompt-navigation';
      actions.append(this.button(t("Approve execution"), () => this.submit({ approved: 'true' })), this.button(t("Deny"), () => this.submit({ approved: 'false' }))); this.form.append(actions);
    }
    else {
      for (const field of this.request.params.filter((field) => (field.step ?? 1) === this.steps[this.index])) { this.form.append(this.field(field)); }
      const navigation = document.createElement('div'); navigation.className = 'prompt-navigation';
      if (this.steps.length > 1) {
        const previous = this.button('\u2039', () => { this.index--; this.render(); }); previous.disabled = this.busy || this.index === 0; previous.ariaLabel = t("Previous question");
        const count = document.createElement('span'); count.textContent = `${this.index + 1} / ${this.steps.length}`;
        const next = this.button('\u203a', () => { this.index++; this.render(); }); next.disabled = this.busy || this.index === this.steps.length - 1; next.ariaLabel = t("Next question");
        navigation.append(previous, count, next);
      }
      if (this.index === this.steps.length - 1) {
        navigation.append(this.button(t("Resume run"), () => {
          const unconfirmed = this.request.params.find((field) => field.options?.length && field.required && !this.touched.has(field.name));
          if (unconfirmed) { this.error = t("Please confirm {0}", unconfirmed.label || unconfirmed.name); this.index = this.steps.indexOf(unconfirmed.step ?? 1); this.render(); return; }
          this.submit();
        }), this.button(t("End run"), this.options.stop));
      }
      this.form.append(navigation);
    }
    if (this.error) { const error = document.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert'); error.textContent = this.error; this.form.append(error); }
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('header > button'))) { button.disabled = this.busy; }
    if (focusName) { Array.from(this.form.querySelectorAll<HTMLElement>('[id]')).find((element) => element.id === focusName)?.focus(); }
  }
}
