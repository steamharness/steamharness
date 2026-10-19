import { t } from '../localization';
import {
  projectParamValue, type Field, type Parameters, type ParamState, type ParamValues, type ParamValue,
} from '../workflow-types';
import { ParameterActions } from './parameter-actions';
import { iconButton } from './ui';

interface Options {
  values(): ParamValues;
  states(): Record<string, ParamState>;
  disabled(): boolean;
  loading(): boolean;
  change(name: string, value: ParamValue): void;
  file(name: string): void;
  downloadFile?(id: string): void;
}
interface FieldView { field: Field; root: HTMLElement; controls: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[]; signature?: string }

export class Fields {
  private parameters: Parameters = { fields: [] };
  private readonly fields = new Map<string, FieldView>();
  private readonly actions: ParameterActions;
  constructor(private readonly root: HTMLElement, actions: HTMLElement, private readonly options: Options) {
    this.actions = new ParameterActions(actions, {
      current: () => ({ values: options.values(), states: options.states(), disabled: options.disabled(), loading: options.loading() }),
      fieldRoot: name => this.fields.get(name)!.root,
      onChange: (name, value) => options.change(name, value),
      onReset: names => { for (const name of names) { options.change(name, projectParamValue(this.fields.get(name)!.field)); } },
    });
  }
  close(): void { this.actions.close(); }
  render(parameters: Parameters): void {
    this.parameters = parameters; this.fields.clear(); this.root.replaceChildren();
    const inActions = new Set(parameters.paramLayout?.actions.flatMap(action => action.kind === 'mode' || action.kind === 'slash' ? [action.name] : action.params) ?? []);
    for (const field of parameters.fields) {
      const view = this.field(field); this.fields.set(field.name, view);
      if (!inActions.has(field.name) || field.panel === 'main') { this.root.append(view.root); }
    }
    this.actions.render(parameters); this.update();
  }
  private field(field: Field): FieldView {
    const root = document.createElement('div'); root.className = `param-field${field.type === 'boolean' ? ' boolean-field' : ''}`; root.dataset.param = field.name;
    const label = document.createElement('label'); label.className = 'field-label';
    label.textContent = `${field.label || field.name}${field.required ? ' *' : ''}`; label.title = field.description ?? ''; root.append(label);
    const view: FieldView = { field, root, controls: [] };
    if (field.control === 'radio' || field.control === 'checkboxes') {
      const choices = document.createElement('div'); choices.className = 'field-choices'; root.append(choices);
    } else if (field.type === 'file' || field.control === 'audio') {
      const summary = document.createElement('span'); summary.className = 'param-file-summary';
      const button = iconButton('attach', t("Choose files"), () => this.options.file(field.name)); button.classList.add('param-file-button'); root.append(summary, button);
    } else {
      const control = field.control === 'select' || field.options !== undefined ? document.createElement('select')
        : field.control === 'textarea' || field.format === 'json' ? document.createElement('textarea') : document.createElement('input');
      if (control instanceof HTMLInputElement) {
        control.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number'
          : field.control === 'datetime' ? 'datetime-local' : ['date', 'time'].includes(field.control ?? '') ? field.control!
          : /password|secret|token|key/i.test(field.name) ? 'password' : 'text';
        if (control.type === 'number') { control.step = 'any'; }
        if (control.type === 'checkbox') { control.setAttribute('role', 'switch'); }
      }
      if (control instanceof HTMLSelectElement) { control.multiple = !!field.multiple; }
      if (control instanceof HTMLTextAreaElement) { control.rows = 3; }
      control.id = `workflow-param-${field.name}`; label.htmlFor = control.id; control.className = 'field-control';
      control.required = !!field.required && field.type !== 'boolean'; control.addEventListener(control instanceof HTMLSelectElement || field.type === 'boolean' ? 'change' : 'input', () => {
        const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? String(control.checked)
          : control instanceof HTMLSelectElement && control.multiple ? Array.from(control.selectedOptions, option => option.value) : control.value;
        this.options.change(field.name, value);
      });
      view.controls.push(control); root.append(control);
    }
    if (field.description) { const description = document.createElement('small'); description.textContent = field.description; description.className = 'option-description'; root.append(description); }
    return view;
  }
  update(): void {
    const values = this.options.values(), states = this.options.states();
    for (const [name, view] of this.fields) {
      const state = states[name], field = view.field;
      view.root.hidden = state?.visible === false;
      const options = (state?.resolvedOptions ?? field.options ?? []).filter(option => state?.options?.[option.value]?.visible !== false);
      const signature = JSON.stringify([options, state?.options]);
      if (signature !== view.signature) {
        view.signature = signature;
        const control = view.controls[0];
        if (control instanceof HTMLSelectElement) {
          control.replaceChildren(); if (!control.multiple) { control.append(new Option(t("Select..."), '')); }
          for (const option of options) {
            const item = new Option(option.label || option.value, option.value); item.disabled = !!state?.options?.[option.value]?.disabled; item.title = option.description ?? ''; control.append(item);
          }
        } else if (field.control === 'radio' || field.control === 'checkboxes') {
          const choices = view.root.querySelector('.field-choices')!; choices.replaceChildren();
          view.controls = options.map(option => {
            const label = document.createElement('label'), control = document.createElement('input');
            control.type = field.control === 'checkboxes' ? 'checkbox' : 'radio'; control.name = `workflow-param-${name}`; control.value = option.value;
            control.addEventListener('change', () => this.options.change(name, field.control === 'checkboxes'
              ? view.controls.filter(item => item instanceof HTMLInputElement && item.checked).map(item => item.value) : option.value));
            label.append(control, document.createTextNode(option.label || option.value)); label.title = option.description ?? ''; choices.append(label); return control;
          });
        }
      }
      const value = values[name];
      for (const control of view.controls) {
        if (control instanceof HTMLInputElement && control.type === 'checkbox') { control.checked = field.control === 'checkboxes' ? Array.isArray(value) && value.includes(control.value) : value === 'true'; }
        else if (control instanceof HTMLInputElement && control.type === 'radio') { control.checked = control.value === value; }
        else if (control instanceof HTMLSelectElement && control.multiple) { for (const option of Array.from(control.options)) { option.selected = Array.isArray(value) && value.includes(option.value); } }
        else { const next = typeof value === 'string' ? value : ''; if (control.value !== next) { control.value = next; } }
        control.disabled = this.options.disabled() || !!state?.disabled || (['radio', 'checkboxes'].includes(field.control ?? '') && !!state?.options?.[control.value]?.disabled);
      }
      if (field.type === 'file' || field.control === 'audio') {
        try {
          const files: unknown = JSON.parse(String(value || '[]'));
          const list = Array.isArray(files) ? files : [files];
          const summary = view.root.querySelector('.param-file-summary')!;
          if (this.options.downloadFile && summary.getAttribute('data-value') !== String(value)) {
            summary.setAttribute('data-value', String(value));
            summary.replaceChildren();
            for (const file of list.filter(file => file && typeof file.id === 'string')) {
              const row = document.createElement('span'); row.className = 'param-file-row';
              const name = document.createElement('span'); name.textContent = file.name; row.append(name);
              const download = iconButton('cloud-download', t("Download file"), () => this.options.downloadFile!(file.id));
              const remove = iconButton('close', t("Remove file"), () => this.options.change(field.name, JSON.stringify(list.filter(item => item !== file))));
              download.classList.add('param-file-download'); remove.classList.add('param-file-remove');
              row.append(download, remove); summary.append(row);
            }
          } else if (!this.options.downloadFile) { summary.textContent = list.map(file => file?.name ?? '').join(', '); }
          for (const button of summary.querySelectorAll<HTMLButtonElement>('button')) { button.disabled = this.options.disabled() || button.classList.contains('param-file-remove') && this.options.loading(); }
        } catch { view.root.querySelector('.param-file-summary')!.textContent = ''; }
        view.root.querySelector<HTMLButtonElement>('.param-file-button')!.disabled = this.options.disabled() || this.options.loading() || !!state?.disabled;
      }
    }
    this.root.hidden = !Array.from(this.root.children).some(root => !(root as HTMLElement).hidden);
    this.actions.update();
  }
}
