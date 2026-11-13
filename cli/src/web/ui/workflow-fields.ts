import { t } from '../localization';
import {
  projectParamValue, projectParamEffectiveValue, type Field, type Parameters, type ParamState, type ParamValues, type ParamValue,
} from '../workflow-types';
import { ParameterActions } from './parameter-actions';
import { iconButton } from './ui';
import { rangeField, updateRangeField } from './range-field';

interface Options {
  values(): ParamValues;
  states(): Record<string, ParamState>;
  disabled(): boolean;
  loading(): boolean;
  change(name: string, value: ParamValue): void;
  file(name: string): void;
  pasteFile?(name: string): void;
  fileUrl?(id: string): string;
  image?(src: string, title: string): void;
  downloadFile?(id: string): void;
  modelConfigurationRequired?(): boolean;
  configureModel?(): void;
  openUserSetting?(key: string): void;
}
interface FieldView { field: Field; root: HTMLElement; controls: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[]; signature?: string }

export class Fields {
  private parameters: Parameters = { fields: [] };
  private readonly fields = new Map<string, FieldView>();
  private readonly actions: ParameterActions;
  constructor(private readonly root: HTMLElement, actions: HTMLElement, private readonly options: Options) {
    this.actions = new ParameterActions(actions, {
      current: () => ({ values: options.values(), states: options.states(), disabled: options.disabled(), loading: options.loading(), modelConfigurationRequired: options.modelConfigurationRequired?.() }),
      fieldRoot: name => this.fields.get(name)!.root,
      onChange: (name, value) => options.change(name, value),
      onConfigureModel: options.configureModel,
      onOpenUserSetting: options.openUserSetting,
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
    if (field.userSetting?.mode === 'fixed') {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'user-setting-field';
      button.id = `workflow-param-${field.name}`; label.htmlFor = button.id;
      button.textContent = field.options?.find(option => option.value === projectParamEffectiveValue(field))?.label ?? String(projectParamEffectiveValue(field));
      button.title = t('Change in user settings');
      button.addEventListener('click', () => this.options.openUserSetting?.(field.userSetting!.key)); root.append(button);
    } else if (field.control === 'radio' || field.control === 'checkboxes') {
      const choices = document.createElement('div'); choices.className = 'field-choices'; root.append(choices);
    } else if (field.type === 'file' || field.control === 'audio') {
      const summary = document.createElement('span'); summary.className = 'param-file-summary';
      const actions = document.createElement('div'); actions.className = 'param-file-actions';
      const button = iconButton('attach', t("Choose files"), () => this.options.file(field.name)); button.classList.add('param-file-button'); actions.append(button);
      if (this.options.pasteFile && field.control !== 'audio' && (!field.accept?.length || field.accept.some(type => /^image\//i.test(type) || /^\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(type)))) {
        const paste = iconButton('clippy', t('Paste image from clipboard'), () => this.options.pasteFile!(field.name)); paste.classList.add('param-file-paste'); actions.append(paste);
      }
      root.append(summary, actions);
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
      view.controls.push(control); root.append(control instanceof HTMLInputElement && field.control === 'range' && field.range ? rangeField(control, field) : control);
    }
    if (field.description) { const description = document.createElement('small'); description.textContent = field.description; description.className = 'option-description'; root.append(description); }
    return view;
  }
  update(): void {
    const values = this.options.values(), states = this.options.states();
    for (const [name, view] of this.fields) {
      const state = states[name], field = view.field;
      view.root.hidden = state?.visible === false;
      if (field.userSetting?.mode === 'fixed') { continue; }
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
      const value = projectParamEffectiveValue(field, values[name]);
      for (const control of view.controls) {
        if (control instanceof HTMLInputElement && control.type === 'checkbox') { control.checked = field.control === 'checkboxes' ? Array.isArray(value) && value.includes(control.value) : value === 'true'; }
        else if (control instanceof HTMLInputElement && control.type === 'radio') { control.checked = control.value === value; }
        else if (control instanceof HTMLSelectElement && control.multiple) { for (const option of Array.from(control.options)) { option.selected = Array.isArray(value) && value.includes(option.value); } }
        else if (control instanceof HTMLInputElement && control.type === 'range') { updateRangeField(control, value); }
        else { const next = typeof value === 'string' ? value : ''; if (control.value !== next) { control.value = next; } }
        control.disabled = this.options.disabled() || !!state?.disabled || (['radio', 'checkboxes'].includes(field.control ?? '') && !!state?.options?.[control.value]?.disabled);
      }
      if (field.type === 'file' || field.control === 'audio') {
        try {
          const files: unknown = JSON.parse(String(value || '[]'));
          const list = Array.isArray(files) ? files : [files];
          const summary = view.root.querySelector('.param-file-summary')!;
          const signature = JSON.stringify([value, list.map(file => file?.id && this.options.fileUrl?.(file.id))]);
          if (summary.getAttribute('data-value') !== signature) {
            summary.setAttribute('data-value', signature);
            summary.replaceChildren();
            for (const file of list.filter(file => file && typeof file.id === 'string')) {
              const row = document.createElement('span'); row.className = 'param-file-row';
              const remove = iconButton('close', t('Remove file'), () => this.options.change(field.name, field.multiple ? JSON.stringify(list.filter(item => item !== file)) : ''));
              remove.classList.add('param-file-remove');
              const src = this.options.fileUrl?.(file.id) ?? file.previewUrl;
              if (this.options.image && src && (file.kind === 'image' || /^image\//i.test(file.mimeType ?? '') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name ?? ''))) {
                const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'param-file-preview';
                preview.title = preview.ariaLabel = t('Preview {0}', file.name);
                const image = document.createElement('img'); image.src = src; image.alt = file.name; preview.append(image);
                preview.addEventListener('click', () => this.options.image!(src, file.name));
                const thumbnail = document.createElement('span'); thumbnail.className = 'param-file-thumbnail'; thumbnail.append(preview, remove); row.append(thumbnail);
              } else { row.append(remove); }
              const name = document.createElement('span'); name.textContent = file.name; row.append(name);
              if (this.options.downloadFile) {
                const download = iconButton('cloud-download', t("Download file"), () => this.options.downloadFile!(file.id));
                download.classList.add('param-file-download'); row.append(download);
              }
              summary.append(row);
            }
          }
          for (const button of summary.querySelectorAll<HTMLButtonElement>('.param-file-download, .param-file-remove')) { button.disabled = this.options.disabled() || button.classList.contains('param-file-remove') && (this.options.loading() || !!state?.disabled); }
        } catch { view.root.querySelector('.param-file-summary')!.textContent = ''; }
        for (const button of view.root.querySelectorAll<HTMLButtonElement>('.param-file-actions button')) { button.disabled = this.options.disabled() || this.options.loading() || !!state?.disabled; }
      }
    }
    this.root.hidden = !Array.from(this.root.children).some(root => !(root as HTMLElement).hidden);
    this.actions.update();
  }
}
