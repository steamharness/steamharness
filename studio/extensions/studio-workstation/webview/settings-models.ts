import { t } from './localization';
import { SettingsDropdown } from './settings-dropdown';
import type { UserModelEntry, UserModelsState, UserModelCatalog } from '../src/user-model-types';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

/** The page receives model references only. Secrets live solely in a transient password input. */
export class SettingsModels {
  private state: UserModelsState = { revision: 0, entries: [], systemAvailable: false };
  private readonly list = node('div', undefined, 'settings-model-list');
  private readonly status = node('p', '', 'muted');
  private readonly error = node('p', '', 'setting-error');
  private readonly add = node('button', t('Add model'));
  private readonly form = node('form', undefined, 'settings-card settings-model-form');
  private readonly title = node('h2');
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly selects = new Map<string, { button: HTMLButtonElement; dropdown: SettingsDropdown; row: HTMLElement }>();
  private readonly save = node('button', t('Save'));
  private readonly cancel = node('button', t('Cancel'), 'secondary');
  private readonly refresh = node('button', t('Refresh models'), 'secondary');
  private readonly catalogueStatus = node('p', '', 'muted');
  private readonly account = node('button', t('Manage AI account'), 'secondary');
  private catalogue: UserModelCatalog = { entries: [] };
  private catalogRequest?: string;
  private pending?: { id: string; action: string };
  private editing?: { id: string; revision: number };
  private confirmation?: string;
  constructor(private readonly root: HTMLElement, private readonly post: (message: unknown) => void, private readonly changed: () => void) {
    const header = node('div', undefined, 'settings-model-header');
    const copy = node('div');
    copy.append(node('h2', t('Your models')), node('p', t('Models are shared across your projects. The first available model is the default.'), 'muted'));
    this.add.type = 'button'; this.add.addEventListener('click', () => this.edit());
    header.append(copy, this.add);
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.error.setAttribute('role', 'alert'); this.error.hidden = true;
    this.form.hidden = true; this.form.append(this.title);
    this.select('source', t('Model source'), () => this.sourceChanged());
    this.input('name', t('Name'));
    this.select('system', t('System AI model'), () => {
      if (!this.inputs.get('name')!.value) this.inputs.get('name')!.value = this.selectedSystem()?.model.name ?? '';
    });
    this.refresh.type = this.account.type = 'button';
    this.refresh.addEventListener('click', () => this.loadCatalog());
    this.account.addEventListener('click', () => this.post({ type: 'settings-models-account' }));
    const catalogActions = node('div', undefined, 'settings-model-catalog');
    catalogActions.append(this.catalogueStatus, this.refresh, this.account); this.form.append(catalogActions);
    this.select('apiKind', t('API protocol'), () => undefined);
    this.input('baseUrl', t('Base URL'), 'url');
    this.input('model', t('Model ID'));
    const key = this.input('apiKey', t('API key'), 'password'); key.required = false; key.autocomplete = 'new-password';
    const note = node('p', t('API keys are saved securely. Leave the key empty when editing to keep the saved key.'), 'muted');
    key.parentElement!.append(note);
    this.save.type = 'submit'; this.cancel.type = 'button';
    this.cancel.addEventListener('click', () => this.dismiss());
    const actions = node('div', undefined, 'settings-model-actions'); actions.append(this.save, this.cancel); this.form.append(actions);
    this.form.addEventListener('submit', event => { event.preventDefault(); this.submit(); });
    this.form.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.pending) { event.preventDefault(); this.dismiss(); } });
    root.append(header, this.status, this.error, this.list, this.form);
    this.render();
  }
  private input(key: string, label: string, type = 'text'): HTMLInputElement {
    const row = node('div', undefined, 'settings-model-field'); const caption = node('label', label);
    const input = node('input'); input.type = type; input.id = `user-model-${key}`; caption.htmlFor = input.id;
    input.required = true; input.maxLength = key === 'apiKey' ? 16384 : key === 'baseUrl' ? 2048 : 200;
    input.spellcheck = false; input.autocomplete = 'off'; row.append(caption, input); this.form.append(row); this.inputs.set(key, input);
    return input;
  }
  private select(key: string, label: string, change: () => void): void {
    const row = node('div', undefined, 'settings-model-field'); const caption = node('label', label);
    const button = node('button'); button.id = `user-model-${key}`; caption.htmlFor = button.id; button.setAttribute('aria-label', label);
    const dropdown = new SettingsDropdown(button, change); row.append(caption, button); this.form.append(row);
    this.selects.set(key, { button, dropdown, row });
  }
  private value(key: string): string { return this.selects.get(key)!.button.value; }
  closeDropdowns(): void { for (const { dropdown } of this.selects.values()) dropdown.close(); }
  private dismiss(): void {
    this.closeDropdowns(); this.editing = undefined; this.form.hidden = true; this.catalogRequest = undefined;
    for (const input of this.inputs.values()) input.value = '';
    this.add.focus();
  }
  private edit(entry?: UserModelEntry): void {
    if (this.pending) return;
    this.catalogRequest = undefined;
    this.editing = { id: entry?.id ?? crypto.randomUUID(), revision: this.state.revision };
    this.error.hidden = true; this.form.hidden = false; this.confirmation = undefined;
    this.title.textContent = entry ? t('Edit model') : t('Add model');
    for (const [key, input] of this.inputs) input.value = key === 'apiKey' ? '' : String(entry && key in entry ? entry[key as keyof UserModelEntry] : '');
    this.selects.get('source')!.row.hidden = !this.state.systemAvailable;
    const source = entry?.source ?? (this.state.systemAvailable ? 'system' : 'third-party');
    this.selects.get('source')!.dropdown.update(this.state.systemAvailable
      ? [{ value: 'system', label: t('System AI') }, { value: 'third-party', label: t('Third-party') }]
      : [{ value: 'third-party', label: t('Third-party') }], source, !!entry);
    this.selects.get('apiKind')!.dropdown.update([
      { value: 'openai-responses', label: 'OpenAI Responses' }, { value: 'openai-completions', label: 'OpenAI Chat Completions' },
      { value: 'anthropic-messages', label: 'Anthropic Messages' },
    ], entry?.source === 'third-party' ? entry.apiKind : 'openai-responses');
    this.selects.get('system')!.button.value = entry?.source === 'system' ? JSON.stringify([entry.credentialId, entry.model]) : '';
    this.sourceChanged(); this.inputs.get('name')!.focus();
  }
  private sourceChanged(): void {
    const system = this.value('source') === 'system';
    this.selects.get('system')!.row.hidden = !system; this.selects.get('apiKind')!.row.hidden = system;
    this.refresh.parentElement!.hidden = !system;
    for (const key of ['baseUrl', 'model', 'apiKey']) {
      const input = this.inputs.get(key)!; input.parentElement!.hidden = system; input.disabled = system;
    }
    if (system) this.loadCatalog();
  }
  private loadCatalog(): void {
    if (this.catalogRequest) return;
    this.catalogRequest = crypto.randomUUID(); this.catalogueStatus.textContent = t('Loading...'); this.refresh.disabled = true;
    this.post({ type: 'settings-models', action: 'catalog', requestId: this.catalogRequest });
  }
  private selectedSystem() {
    for (const credential of this.catalogue.entries) for (const model of credential.models) {
      if (JSON.stringify([credential.id, model.id]) === this.value('system')) return { credential, model };
    }
    return undefined;
  }
  private submit(): void {
    if (!this.editing || this.pending || !this.form.reportValidity()) return;
    const system = this.value('source') === 'system'; const selected = this.selectedSystem();
    if (system && !selected) { this.fail(t('Select an available system AI model.')); return; }
    const model = { id: this.editing.id, name: this.inputs.get('name')!.value.trim(), source: system ? 'system' : 'third-party',
      ...(system ? { credentialId: selected!.credential.id, model: selected!.model.id } : {
        apiKind: this.value('apiKind'), baseUrl: this.inputs.get('baseUrl')!.value.trim(), model: this.inputs.get('model')!.value.trim(), apiKey: this.inputs.get('apiKey')!.value,
      }) };
    this.request('save', { model, revision: this.editing.revision });
    this.inputs.get('apiKey')!.value = '';
  }
  private fail(message: string): void { this.error.textContent = message; this.error.hidden = false; }
  private request(action: string, data: object): void {
    const requestId = crypto.randomUUID(); this.pending = { id: requestId, action }; this.status.textContent = t('Saving...'); this.error.hidden = true;
    this.post({ type: 'settings-models', action, requestId, revision: this.state.revision, ...data }); this.busy();
  }
  private busy(): void {
    this.add.disabled = !!this.pending;
    for (const control of this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = !!this.pending || control.closest<HTMLElement>('.settings-model-field')?.hidden === true;
    if (this.editing && this.state.entries.some(entry => entry.id === this.editing!.id)) this.selects.get('source')!.button.disabled = true;
    for (const button of this.list.querySelectorAll('button')) button.disabled = !!this.pending;
    this.root.setAttribute('aria-busy', String(!!this.pending));
  }
  private render(): void {
    this.list.replaceChildren();
    if (!this.state.entries.length) this.list.append(node('div', t('No models configured. Add a model to start using the Agent.'), 'settings-card settings-empty'));
    for (const [index, entry] of this.state.entries.entries()) {
      const row = node('div', undefined, 'settings-card settings-model-row'); row.dataset.modelId = entry.id;
      const copy = node('div', undefined, 'settings-model-copy'); copy.append(node('strong', entry.name), node('span', `${entry.source === 'system' ? t('System AI') : t('Third-party')} · ${entry.model}`, 'muted'));
      if (index === 0) copy.append(node('small', t('Default model'), 'muted'));
      const actions = node('div', undefined, 'settings-model-actions');
      const button = (text: string, action: () => void) => { const result = node('button', text, 'secondary'); result.type = 'button'; result.addEventListener('click', action); actions.append(result); };
      if (index > 0) button(t('Set as default'), () => this.request('default', { id: entry.id }));
      button(t('Edit'), () => this.edit(entry));
      button(this.confirmation === entry.id ? t('Confirm delete') : t('Delete'), () => {
        if (this.confirmation === entry.id) this.request('delete', { id: entry.id });
        else { this.confirmation = entry.id; this.render(); }
      });
      row.append(copy, actions); this.list.append(row);
    }
    this.busy();
  }
  handle(message: any): boolean {
    if (message.type === 'settings-models') {
      this.state = message.state; this.render();
      if (this.state.error) this.fail(this.state.error);
      if (!this.state.systemAvailable && this.editing && this.value('source') === 'system') this.dismiss();
      this.changed(); return true;
    }
    if (message.type === 'settings-models-result' && message.requestId === this.pending?.id) {
      const action = this.pending!.action; this.pending = undefined;
      if (message.state) this.state = message.state;
      if (message.message) { this.fail(message.message); this.status.textContent = t('Unable to save model.'); }
      else { this.status.textContent = t('Saved'); if (action === 'save' || action === 'delete') this.dismiss(); }
      this.render(); this.changed(); return true;
    }
    if (message.type === 'settings-model-catalog' && message.requestId === this.catalogRequest) {
      this.catalogRequest = undefined; this.refresh.disabled = false;
      this.catalogue = message.catalog ?? { entries: [] };
      const options = this.catalogue.entries.flatMap(credential => credential.models.map(model => ({ value: JSON.stringify([credential.id, model.id]), label: `${model.name} · ${credential.name}` })));
      const selected = this.value('system'); this.selects.get('system')!.dropdown.update(options, options.some(option => option.value === selected) ? selected : options[0]?.value ?? '');
      this.catalogueStatus.textContent = message.message ?? (options.length ? '' : t('No system AI models available. Sign in and check your AI account.'));
      if (!this.inputs.get('name')!.value) this.inputs.get('name')!.value = this.selectedSystem()?.model.name ?? '';
      return true;
    }
    return false;
  }
}
