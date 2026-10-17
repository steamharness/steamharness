import { validateWorkflowValues, workflowFormValue, type WorkflowInputRequest, type WorkflowParamValues, type WorkflowField } from '../src/workflow-types';
import { iconButton } from './ui';

interface PromptOptions {
  submit(values: WorkflowParamValues): void;
  stop(): void;
  files?(name: string): void;
}

export class InputPrompt {
  readonly root = document.createElement('section');
  private readonly form = document.createElement('form');
  private readonly values: WorkflowParamValues = {};
  private readonly touched = new Set<string>();
  private readonly steps: number[];
  private index = 0;
  private busy = false;
  private error = '';

  constructor(readonly request: WorkflowInputRequest, private readonly options: PromptOptions) {
    this.steps = [...new Set(request.params.map((field) => field.step ?? 1))].sort((a, b) => a - b);
    for (const field of request.params) {
      const value = request.defaultValues?.[field.name] ?? field.defaultValue ?? '';
      this.values[field.name] = workflowFormValue(field, value);
    }
    this.root.className = 'input-prompt';
    const title = document.createElement('h2'); title.textContent = request.title;
    const header = document.createElement('header'); header.append(title, iconButton('close', '\u7ed3\u675f\u8fd0\u884c', this.options.stop)); this.root.append(header);
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
    try { validateWorkflowValues(this.request.params, values); this.busy = true; this.error = ''; this.render(); this.options.submit(values); }
    catch (error) { this.error = String(error instanceof Error ? error.message : error); this.render(); }
  }

  private renderPlan(): void {
    const instructions = document.createElement('textarea');
    instructions.placeholder = '\u4fee\u6539\u8981\u6c42'; instructions.ariaLabel = '\u4fee\u6539\u8981\u6c42'; instructions.rows = 3;
    instructions.value = String(this.values.instructions ?? ''); instructions.disabled = this.busy;
    const modify = this.button('\u4fee\u6539\u8ba1\u5212', () => {
      if (!String(this.values.instructions ?? '').trim()) { instructions.focus(); return; }
      this.submit({ decision: 'decline', instructions: this.values.instructions });
    });
    instructions.addEventListener('input', () => { this.values.instructions = instructions.value; modify.disabled = this.busy || !instructions.value.trim(); });
    modify.disabled = this.busy || !instructions.value.trim();
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '\u4fee\u6539\u8981\u6c42';
    details.open = !!this.values.instructions; details.append(summary, instructions, modify);
    details.addEventListener('toggle', () => { if (details.open) { instructions.focus(); } });
    this.form.append(this.button('\u6309\u8ba1\u5212\u6267\u884c', () => this.submit({ decision: 'approve', instructions: this.values.instructions ?? '' }), 'plan-approve'), details);
  }

  private field(field: WorkflowField): HTMLElement {
    const root = document.createElement('div'); root.className = 'prompt-field';
    const label = document.createElement('label'); label.textContent = `${field.label || field.name}${field.required ? ' *' : ''}`;
    root.append(label);
    if (field.description) { const description = document.createElement('p'); description.textContent = field.description; root.append(description); }
    const value = this.values[field.name];
    if (field.type === 'file' || field.control === 'audio') {
      let names = '';
      try { names = (JSON.parse(String(value || '[]')) as { name: string }[]).map((file) => file.name).join(', '); } catch { /* An empty field has no file selection. */ }
      const selected = document.createElement('span'); selected.textContent = names;
      root.append(selected, this.button('\u9009\u62e9\u6587\u4ef6', () => this.options.files?.(field.name)));
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
      if (this.request.metadata.toolArguments !== undefined) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '\u5de5\u5177\u53c2\u6570'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(this.request.metadata.toolArguments, null, 2); details.append(summary, pre); this.form.append(details); }
      const actions = document.createElement('div'); actions.className = 'prompt-navigation';
      actions.append(this.button('\u6279\u51c6\u6267\u884c', () => this.submit({ approved: 'true' })), this.button('\u62d2\u7edd', () => this.submit({ approved: 'false' }))); this.form.append(actions);
    }
    else {
      for (const field of this.request.params.filter((field) => (field.step ?? 1) === this.steps[this.index])) { this.form.append(this.field(field)); }
      const navigation = document.createElement('div'); navigation.className = 'prompt-navigation';
      if (this.steps.length > 1) {
        const previous = this.button('\u2039', () => { this.index--; this.render(); }); previous.disabled = this.busy || this.index === 0; previous.ariaLabel = '\u4e0a\u4e00\u95ee';
        const count = document.createElement('span'); count.textContent = `${this.index + 1} / ${this.steps.length}`;
        const next = this.button('\u203a', () => { this.index++; this.render(); }); next.disabled = this.busy || this.index === this.steps.length - 1; next.ariaLabel = '\u4e0b\u4e00\u95ee';
        navigation.append(previous, count, next);
      }
      if (this.index === this.steps.length - 1) {
        navigation.append(this.button('\u7ee7\u7eed\u8fd0\u884c', () => {
          const unconfirmed = this.request.params.find((field) => field.options?.length && field.required && !this.touched.has(field.name));
          if (unconfirmed) { this.error = `\u8bf7\u786e\u8ba4 ${unconfirmed.label || unconfirmed.name}`; this.index = this.steps.indexOf(unconfirmed.step ?? 1); this.render(); return; }
          this.submit();
        }), this.button('\u7ed3\u675f\u8fd0\u884c', this.options.stop));
      }
      this.form.append(navigation);
    }
    if (this.error) { const error = document.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert'); error.textContent = this.error; this.form.append(error); }
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('header > button'))) { button.disabled = this.busy; }
    if (focusName) { Array.from(this.form.querySelectorAll<HTMLElement>('[id]')).find((element) => element.id === focusName)?.focus(); }
  }
}
