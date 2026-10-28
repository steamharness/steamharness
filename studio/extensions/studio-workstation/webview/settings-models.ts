import { t } from './localization';
import { SettingsDropdown } from './settings-dropdown';
import { modelIcon } from './model-icons';
import type { UserModelEntry, UserModelsState } from '../src/user-model-types';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function icon(name: string): HTMLElement {
  const result = node('span', undefined, `codicon codicon-${name}`); result.setAttribute('aria-hidden', 'true'); return result;
}

const protocols = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

/** The page receives model references only. Secrets live solely in a transient password input. */
export class SettingsModels {
  private state: UserModelsState = { revision: 0, entries: [], systemAvailable: false };
  private readonly list = node('div', undefined, 'settings-model-list');
  private readonly status = node('p', '', 'muted settings-model-status');
  private readonly error = node('p', '', 'setting-error');
  private readonly add = node('button', undefined, 'primary settings-model-add');
  private readonly dialog = node('dialog', undefined, 'settings-model-dialog');
  private readonly form = node('form', undefined, 'settings-model-form');
  private readonly fields = node('div', undefined, 'settings-model-fields');
  private readonly title = node('h2');
  private readonly description = node('p', '', 'muted');
  private readonly formError = node('p', '', 'settings-model-form-error');
  private readonly formStatus = node('span', '', 'muted');
  private readonly close = node('button', undefined, 'icon-button');
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly selects = new Map<string, { button: HTMLButtonElement; dropdown: SettingsDropdown; row: HTMLElement }>();
  private readonly save = node('button', t('Save'), 'primary');
  private readonly cancel = node('button', t('Cancel'), 'secondary');
  private readonly refresh = node('button', undefined, 'secondary');
  private readonly catalogueStatus = node('p', '', 'muted');
  private readonly account = node('button', t('Manage AI account'), 'secondary');
  private readonly collapsed = new Set<string>();
  private catalogRequest?: string;
  private pending?: { id: string; action: string };
  private editing?: { id: string; revision: number };
  private confirmation?: string;
  private returnFocus?: HTMLElement;
  private returnModelId?: string;
  constructor(private readonly root: HTMLElement, private readonly post: (message: unknown) => void, private readonly changed: () => void) {
    const header = node('div', undefined, 'settings-model-header');
    const copy = node('div');
    copy.append(node('h2', t('Your models')), node('p', t('Models are shared across your projects. The first available model is the default.'), 'muted'));
    this.add.append(icon('add'), node('span', t('Add model')));
    this.add.type = 'button'; this.add.addEventListener('click', () => this.edit(undefined, this.add));
    this.refresh.type = this.account.type = 'button'; this.refresh.append(icon('refresh'), node('span', t('Refresh built-in models')));
    this.refresh.addEventListener('click', () => this.loadCatalog());
    this.account.addEventListener('click', () => this.post({ type: 'settings-models-account' }));
    const headerActions = node('div', undefined, 'settings-model-actions'); headerActions.append(this.refresh, this.add);
    header.append(copy, headerActions);
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.error.setAttribute('role', 'alert'); this.error.hidden = true;
    this.title.id = 'user-model-dialog-title'; this.description.id = 'user-model-dialog-description';
    this.dialog.setAttribute('aria-labelledby', this.title.id); this.dialog.setAttribute('aria-describedby', this.description.id);
    const heading = node('div'); heading.append(this.title, this.description);
    const dialogHeader = node('header', undefined, 'settings-model-dialog-header');
    this.close.type = 'button'; this.close.setAttribute('aria-label', t('Close')); this.close.title = t('Close'); this.close.append(icon('close'));
    this.close.addEventListener('click', () => { if (!this.pending) this.dismiss(); });
    dialogHeader.append(heading, this.close);
    this.input('name', t('Name'));
    const catalogActions = node('div', undefined, 'settings-model-catalog');
    this.catalogueStatus.setAttribute('role', 'status');
    catalogActions.append(this.catalogueStatus, this.account);
    this.select('apiKind', t('API protocol'), () => undefined);
    this.input('baseUrl', t('Base URL'), 'url');
    this.input('model', t('Model ID'));
    const key = this.input('apiKey', t('API key'), 'password'); key.required = false; key.autocomplete = 'new-password';
    const note = node('p', t('API keys are saved securely. Leave the key empty when editing to keep the saved key.'), 'muted');
    note.id = 'user-model-key-note'; key.setAttribute('aria-describedby', note.id);
    key.parentElement!.append(note);
    this.save.type = 'submit'; this.cancel.type = 'button';
    this.cancel.addEventListener('click', () => this.dismiss());
    this.formError.setAttribute('role', 'alert'); this.formError.hidden = true;
    this.formStatus.setAttribute('role', 'status'); this.formStatus.setAttribute('aria-live', 'polite');
    const actions = node('div', undefined, 'settings-model-actions'); actions.append(this.cancel, this.save);
    const footer = node('footer', undefined, 'settings-model-dialog-footer'); footer.append(this.formError, this.formStatus, actions);
    this.form.append(dialogHeader, this.fields, footer); this.dialog.append(this.form);
    this.form.addEventListener('submit', event => { event.preventDefault(); this.submit(); });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); if (!this.pending) this.dismiss(); });
    root.append(header, this.status, this.error, catalogActions, this.list, this.dialog);
    this.render();
  }
  private input(key: string, label: string, type = 'text'): HTMLInputElement {
    const row = node('div', undefined, `settings-model-field settings-model-field-${key}`); const caption = node('label', label);
    const input = node('input'); input.type = type; input.id = `user-model-${key}`; caption.htmlFor = input.id;
    input.required = true; input.maxLength = key === 'apiKey' ? 16384 : key === 'baseUrl' ? 2048 : 200;
    input.spellcheck = false; input.autocomplete = 'off'; row.append(caption, input); this.fields.append(row); this.inputs.set(key, input);
    if (key === 'name') input.placeholder = t('e.g. My coding model');
    if (key === 'baseUrl') input.placeholder = 'https://api.example.com/v1';
    if (key === 'model') input.placeholder = t('Model identifier from your provider');
    return input;
  }
  private select(key: string, label: string, change: () => void): void {
    const row = node('div', undefined, `settings-model-field settings-model-field-${key}`); const caption = node('label', label);
    const button = node('button'); button.id = `user-model-${key}`; caption.htmlFor = button.id; button.setAttribute('aria-label', label);
    const dropdown = new SettingsDropdown(button, change, false, this.dialog); row.append(caption, button); this.fields.append(row);
    this.selects.set(key, { button, dropdown, row });
  }
  private value(key: string): string {
    return this.selects.get(key)!.button.value;
  }
  closeDropdowns(): void { for (const { dropdown } of this.selects.values()) dropdown.close(); }
  closeEditor(): void { this.dismiss(false); }
  matches(query: string): boolean {
    return this.state.entries.some(entry => [entry.name, entry.model,
      entry.source === 'system' ? this.state.providerNames?.[entry.id] : `${entry.apiKind} ${entry.baseUrl}`]
      .join(' ').toLocaleLowerCase().includes(query));
  }
  private dismiss(restoreFocus = true): void {
    this.closeDropdowns(); this.editing = undefined;
    for (const input of this.inputs.values()) input.value = '';
    if (this.dialog.open) this.dialog.close();
    if (restoreFocus) {
      const edit = this.returnModelId ? this.list.querySelector<HTMLButtonElement>(`[data-model-id="${CSS.escape(this.returnModelId)}"] [aria-label="${t('Edit')}"]`) : undefined;
      (this.returnFocus?.isConnected ? this.returnFocus : edit ?? this.add).focus({ preventScroll: true });
    }
    this.returnFocus = undefined; this.returnModelId = undefined;
  }
  private edit(entry?: UserModelEntry, trigger?: HTMLElement): void {
    if (this.pending || entry?.source === 'system') return;
    this.editing = { id: entry?.id ?? crypto.randomUUID(), revision: this.state.revision };
    this.returnFocus = trigger; this.returnModelId = entry?.id; this.error.hidden = this.formError.hidden = true; this.formStatus.textContent = ''; this.confirmation = undefined;
    this.title.textContent = entry ? t('Edit model') : t('Add model');
    for (const [key, input] of this.inputs) input.value = key === 'apiKey' ? '' : String(entry && key in entry ? entry[key as keyof UserModelEntry] : '');
    this.selects.get('apiKind')!.dropdown.update(protocols, entry?.source === 'third-party' ? entry.apiKind : 'openai-responses');
    this.description.textContent = t('Connect your provider to use this model across your projects.');
    this.busy(); this.dialog.showModal(); this.fields.scrollTop = 0; this.inputs.get('name')!.focus({ preventScroll: true });
  }
  private loadCatalog(): void {
    if (this.catalogRequest) return;
    this.catalogRequest = crypto.randomUUID(); this.catalogueStatus.textContent = t('Loading...'); this.refresh.disabled = true;
    this.post({ type: 'settings-models', action: 'catalog', requestId: this.catalogRequest });
  }
  private submit(): void {
    if (!this.editing || this.pending || !this.form.reportValidity()) return;
    const model = { id: this.editing.id, name: this.inputs.get('name')!.value.trim(), source: 'third-party',
      apiKind: this.value('apiKind'), baseUrl: this.inputs.get('baseUrl')!.value.trim(), model: this.inputs.get('model')!.value.trim(), apiKey: this.inputs.get('apiKey')!.value };
    this.request('save', { model, revision: this.editing.revision });
    this.inputs.get('apiKey')!.value = '';
  }
  private fail(message: string): void {
    const error = this.dialog.open ? this.formError : this.error; error.textContent = message; error.hidden = false;
  }
  private request(action: string, data: object): void {
    const requestId = crypto.randomUUID(); this.pending = { id: requestId, action }; this.status.textContent = t('Saving...'); this.formStatus.textContent = t('Saving...'); this.error.hidden = this.formError.hidden = true;
    this.closeDropdowns();
    this.post({ type: 'settings-models', action, requestId, revision: this.state.revision, ...data }); this.busy();
  }
  private busy(): void {
    this.add.disabled = !!this.pending;
    for (const control of this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = !!this.pending || !!control.closest('[hidden]');
    this.refresh.disabled = !!this.pending || !!this.catalogRequest || !!this.state.catalogLoading;
    this.form.setAttribute('aria-busy', String(!!this.pending));
    for (const button of this.list.querySelectorAll('button')) button.disabled = !!this.pending;
    this.root.setAttribute('aria-busy', String(!!this.pending));
  }
  private render(): void {
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.modelFocus : undefined;
    const previousScroll = this.list.querySelector('.settings-model-table-viewport')?.scrollLeft ?? 0;
    this.refresh.hidden = !this.state.systemAvailable;
    this.catalogueStatus.parentElement!.hidden = !this.state.systemAvailable;
    this.catalogueStatus.textContent = this.state.catalogError ?? (this.state.catalogLoading ? t('Loading...') : this.state.entries.some(entry => entry.source === 'system') ? '' : t('No system AI models available. Sign in and check your AI account.'));
    this.catalogueStatus.classList.toggle('setting-error', !!this.state.catalogError);
    this.account.hidden = this.state.entries.some(entry => entry.source === 'system');
    this.list.replaceChildren();
    if (!this.state.entries.length && !this.state.systemAvailable) {
      const empty = node('div', undefined, 'settings-card settings-model-empty');
      empty.append(icon('server'), node('h3', t('No models yet')), node('p', t('No models configured. Add a model to start using the Agent.'), 'muted'));
      this.list.append(empty);
      this.busy(); return;
    }
    const viewport = node('div', undefined, 'settings-card settings-model-table-viewport'); viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', t('Your models'));
    const table = node('table', undefined, 'settings-model-table'); table.setAttribute('aria-label', t('Your models'));
    const head = node('thead'), headings = node('tr');
    for (const label of [t('Model'), t('Provider'), t('Actions')]) { const cell = node('th', label); cell.scope = 'col'; headings.append(cell); }
    head.append(headings); table.append(head); viewport.append(table); this.list.append(viewport);
    const defaultId = this.state.entries[0]?.id;
    for (const sourceKind of this.state.systemAvailable ? ['system', 'third-party'] : ['third-party']) {
      const body = node('tbody'); body.dataset.modelGroup = sourceKind;
      const group = node('tr', undefined, 'settings-model-group'); const heading = node('th'); heading.colSpan = 3; heading.scope = 'rowgroup';
      const label = sourceKind === 'system' ? t('Built-in models') : t('Custom models');
      const entries = this.state.entries.filter(entry => entry.source === sourceKind);
      const toggle = node('button'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(!this.collapsed.has(sourceKind)));
      toggle.dataset.modelFocus = `group:${sourceKind}`;
      toggle.append(icon(this.collapsed.has(sourceKind) ? 'chevron-right' : 'chevron-down'), node('span', label), node('small', String(entries.length), 'muted'));
      toggle.addEventListener('click', () => {
        if (this.collapsed.has(sourceKind)) this.collapsed.delete(sourceKind); else this.collapsed.add(sourceKind);
        this.render(); this.list.querySelector<HTMLButtonElement>(`[data-model-group="${sourceKind}"] .settings-model-group button`)?.focus({ preventScroll: true });
      });
      heading.append(toggle); group.append(heading); body.append(group); table.append(body);
      if (this.collapsed.has(sourceKind)) continue;
      if (!entries.length) {
        const row = node('tr'); const empty = node('td', this.state.catalogLoading && sourceKind === 'system' ? t('Loading...') : sourceKind === 'system' ? t('No system AI models available. Sign in and check your AI account.') : t('No custom models configured.'), 'muted');
        empty.colSpan = 3; row.append(empty); body.append(row);
      }
      for (const entry of entries) {
        const row = node('tr', undefined, 'settings-model-row'); row.dataset.modelId = entry.id;
        const name = node('th'); name.scope = 'row';
        const identity = node('div', undefined, 'settings-model-identity');
        const copy = node('div', undefined, 'settings-model-copy');
        const title = node('div', undefined, 'settings-model-name');
        const label = node('strong', entry.name); label.title = entry.name; title.append(label);
        if (entry.id === defaultId) { const badge = node('span', undefined, 'settings-model-default'); badge.append(icon('check'), node('span', t('Default model'))); title.append(badge); }
        if (entry.name !== entry.model) { const id = node('code', entry.model, 'muted'); id.title = entry.model; title.append(id); }
        copy.append(title);
        identity.append(modelIcon(entry.model, entry.source === 'system' ? 'sparkle' : 'plug'), copy); name.append(identity);
        const source = node('td'); const provider = node('div', undefined, 'settings-model-provider');
        if (entry.source === 'system') {
          const label = this.state.providerNames?.[entry.id] ?? t('System AI');
          const name = node('span', label, 'settings-model-source-badge'); name.title = label; provider.append(name);
        } else {
          const protocol = node('span', protocols.find(protocol => protocol.value === entry.apiKind)?.label, 'settings-model-source-badge');
          const endpoint = node('small', entry.baseUrl, 'muted'); endpoint.title = entry.baseUrl;
          provider.append(protocol, endpoint);
        }
        source.append(provider);
        const controls = node('td');
        const actions = node('div', undefined, 'settings-model-actions');
        const button = (label: string, glyph: string, action: (button: HTMLButtonElement) => void, danger = false) => {
          const result = node('button', undefined, `icon-button${danger ? ' settings-model-delete' : ''}`); result.type = 'button'; result.title = label; result.setAttribute('aria-label', label); result.append(icon(glyph));
          result.dataset.modelFocus = `${entry.id}:${glyph}`;
          result.addEventListener('click', () => action(result)); actions.append(result); return result;
        };
        if (entry.id !== defaultId) button(t('Set as default'), 'star-empty', () => this.request('default', { id: entry.id }));
        if (entry.source === 'third-party') {
          button(t('Edit'), 'edit', trigger => this.edit(entry, trigger));
          const deletion = button(this.confirmation === entry.id ? t('Confirm delete') : t('Delete'), 'trash', () => {
            if (this.confirmation === entry.id) this.request('delete', { id: entry.id });
            else { this.confirmation = entry.id; this.render(); this.list.querySelector<HTMLButtonElement>(`[data-model-id="${CSS.escape(entry.id)}"] .settings-model-delete`)?.focus(); }
          }, true);
          if (this.confirmation === entry.id) { deletion.append(node('span', t('Confirm delete'))); deletion.classList.add('settings-model-confirm'); }
        }
        controls.append(actions); row.append(name, source, controls); body.append(row);
      }
    }
    viewport.scrollLeft = previousScroll;
    this.busy();
    if (focused) Array.from(this.list.querySelectorAll<HTMLButtonElement>('[data-model-focus]:not(:disabled)'))
      .find(button => button.dataset.modelFocus === focused)?.focus({ preventScroll: true });
  }
  handle(message: any): boolean {
    if (message.type === 'settings-models') {
      this.state = message.state; this.render();
      if (this.state.error) this.fail(this.state.error);
      this.changed(); return true;
    }
    if (message.type === 'settings-models-result' && message.requestId === this.pending?.id) {
      const action = this.pending!.action; this.pending = undefined;
      if (message.state) this.state = message.state;
      this.render();
      if (message.message) { this.fail(message.message); this.status.textContent = this.formStatus.textContent = t('Unable to save model.'); }
      else { this.status.textContent = t('Saved'); if (action === 'save' || action === 'delete') this.dismiss(); }
      this.changed(); return true;
    }
    if (message.type === 'settings-model-catalog' && message.requestId === this.catalogRequest) {
      this.catalogRequest = undefined;
      if (message.state) this.state = message.state;
      this.render();
      if (message.message) this.catalogueStatus.textContent = message.message;
      this.changed();
      return true;
    }
    return false;
  }
}
