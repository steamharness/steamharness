import { SettingsModels } from './settings-models';
import { t, locale } from './localization';
import { createMemoryPanel } from '../../../../shared/account-memory/panel';
import '../../../../shared/account-memory/styles.css';
import { renderAccountSections } from './account-sections';
import { SettingsDropdown } from './settings-dropdown';
import { bindAvatar } from './avatar';
import type { AccountState } from '../src/workflow-auth-client';
import type { AccountSectionState } from '../src/account-section-types';
import type { SettingState, SettingsState, SettingsTarget, SettingsViewState } from '../src/settings-types';
import './settings.css';

interface WebviewApi {
  postMessage(message: unknown): void;
  getState?(): SettingsViewState | undefined;
  setState?(state: SettingsViewState): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) { node.textContent = text; }
  return node;
}

function icon(name: string): HTMLElement {
  const node = element('span', `codicon codicon-${/^[a-z-]+$/.test(name) ? name : 'settings-gear'}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function createSettingsView(root: HTMLElement, vscode: WebviewApi): { accountRoot: HTMLElement; setAccount(state: AccountState): void } {
  root.classList.add('settings-root');
  root.innerHTML = `
    <div class="settings-layout">
      <aside class="settings-sidebar">
        <button id="settings-identity" type="button" class="settings-identity" aria-label="${t('Account')}">
          <span class="settings-avatar"><span class="codicon codicon-account" aria-hidden="true"></span><img id="settings-avatar-image" alt="" hidden></span>
          <span class="settings-identity-text"><strong id="settings-account-name">SteamHarness</strong><span id="settings-account-label" class="muted">${t('Signed Out')}</span></span>
        </button>
        <div class="settings-search"><span class="codicon codicon-search" aria-hidden="true"></span><input id="settings-search" type="search" placeholder="${t('Search settings')}" aria-label="${t('Search settings')}" maxlength="512"></div>
        <nav id="settings-navigation" aria-label="${t('Settings categories')}"></nav>
        <div class="settings-sidebar-footer">SteamHarness Studio</div>
      </aside>
      <section id="settings-main" class="settings-main" aria-label="${t('Settings')}">
        <header class="settings-page-header"><div><p class="settings-eyebrow">SteamHarness Studio</p><h1 id="settings-title">${t('General')}</h1></div><span id="settings-save-status" class="muted" role="status" aria-live="polite"></span></header>
        <div id="settings-scope" class="settings-scope" hidden><label for="settings-target">${t('Settings scope')}</label><button id="settings-target" type="button" aria-label="${t('Settings scope')}"></button></div>
        <div id="settings-error" class="settings-error" role="alert" hidden></div>
        <section id="settings-general" class="settings-panel" aria-label="${t('General')}"></section>
        <section id="settings-editor" class="settings-panel" aria-label="${t('Editor')}" hidden></section>
        <section id="settings-permissions" class="settings-panel" aria-label="${t('Permissions')}" hidden></section>
        <section id="settings-models" class="settings-panel" aria-label="${t('Models')}" hidden></section>
        <section id="settings-memory" class="settings-panel" hidden></section>
        <section id="settings-account" class="settings-panel" aria-label="${t('Account')}" hidden></section>
        <section id="settings-provider" class="settings-panel" hidden><div id="settings-sign-in" class="settings-card settings-empty" hidden><p>${t('Sign in to view this information.')}</p><button type="button" class="secondary" id="settings-provider-sign-in">${t('Sign In')}</button></div><div id="account-sections" hidden></div></section>
        <section id="settings-about" class="settings-panel" aria-label="${t('About')}" hidden><div class="settings-card settings-about"><span class="settings-product-icon codicon codicon-terminal" aria-hidden="true"></span><h2>SteamHarness Studio</h2><p class="muted">${t('Your workspace for building and running SteamHarness projects.')}</p><dl><dt>${t('Studio version')}</dt><dd id="settings-studio-version"></dd><dt>${t('VS Code version')}</dt><dd id="settings-vscode-version"></dd></dl><button type="button" class="secondary" data-settings-action="documentation">${t('Documentation')}</button></div></section>
        <div id="settings-no-results" class="settings-empty" hidden><p>${t('No matching settings')}</p><p class="muted">${t('Other editor and extension settings are available in settings JSON.')}</p><button type="button" class="secondary" data-settings-action="json-current">${t('Open settings JSON')}</button></div>
      </section>
    </div>`;
  const find = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const navigation = find<HTMLElement>('settings-navigation');
  const search = find<HTMLInputElement>('settings-search');
  const target = find<HTMLButtonElement>('settings-target');
  const main = find<HTMLElement>('settings-main');
  const sections = find<HTMLElement>('account-sections');
  const saveStatus = find<HTMLElement>('settings-save-status');
  const models = new SettingsModels(find('settings-models'), message => vscode.postMessage(message), () => filter());
  const updateAvatar = bindAvatar(find<HTMLImageElement>('settings-avatar-image'), root.querySelector<HTMLElement>('.settings-avatar > .codicon')!);
  const edits = new Map<string, { value: string | number | boolean; saving: boolean; error?: string }>();
  const rows = new Map<string, HTMLElement>();
  const groups = new Map<string, HTMLElement>();
  const dropdowns = new Map<string, SettingsDropdown>();
  let snapshot: SettingsState | undefined;
  let account: AccountState | undefined;
  let providers: AccountSectionState[] = [];
  let memoryPanel:ReturnType<typeof createMemoryPanel>|undefined;
  let memoryAccount='';
  const memoryPending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const memoryClient={call:(action:string,input?:Record<string,unknown>)=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();const timer=setTimeout(()=>{memoryPending.delete(requestId);reject(new Error('Memory request timed out.'));},12000);memoryPending.set(requestId,{resolve,reject,timer});vscode.postMessage({type:'settings-memory',requestId,action,input});})};
  function clearMemory(){memoryPanel?.dispose();memoryPanel=undefined;for(const p of memoryPending.values()){clearTimeout(p.timer);p.reject(new Error('Account changed.'));}memoryPending.clear();find('settings-memory').replaceChildren();}
  function showMemory(){if(view.section==='memory'&&!memoryPanel){memoryPanel=createMemoryPanel({client:memoryClient,locale:locale(),account:true,onAuthorize:()=>vscode.postMessage({type:'open-login'})});find('settings-memory').append(memoryPanel.element);}}

  let view: SettingsViewState = { section: 'general', query: '', target: 'user', ...vscode.getState?.() };
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let restoredScroll: number | undefined;
  let languageSaving = false;
  let languageRestarting = false;
  let languageError = '';
  let languageDropdown: SettingsDropdown | undefined;
  const targetDropdown = new SettingsDropdown(target, () => {
    view.target = target.value === 'workspace' ? 'workspace' : 'user';
    persist(); vscode.postMessage({ type: 'settings-target', target: view.target });
  });
  const languageOptions = [
    { value: 'system', label: t('Follow system') }, { value: 'zh-cn', label: '简体中文' }, { value: 'en', label: 'English' },
  ];

  function closeDropdowns(): void {
    for (const dropdown of dropdowns.values()) { dropdown.close(); }
    targetDropdown.close(); languageDropdown?.close(); models.closeDropdowns();
  }

  function persist(): void {
    const state: SettingsViewState = { section: view.section, query: search.value, target: view.target, scroll: restoredScroll ?? main.scrollTop };
    vscode.setState?.(state);
    vscode.postMessage({ type: 'settings-view-state', state });
  }

  function categories(): { id: string; label: string; icon: string }[] {
    return [
      { id: 'account', label: t('Account'), icon: 'account' },
      { id: 'general', label: t('General'), icon: 'settings-gear' },
      { id: 'editor', label: t('Editor'), icon: 'code' },
      { id: 'models', label: t('Models'), icon: 'sparkle' },
      { id: 'permissions', label: t('Permissions'), icon: 'shield' },
      { id:'memory',label:t('Memory'),icon:'book' },
      ...(snapshot?.providers ?? []).map(provider => ({ id: `provider:${provider.id}`, label: provider.title, icon: provider.icon ?? 'extensions' })),
      { id: 'about', label: t('About'), icon: 'info' },
    ];
  }

  function navigate(section: string, query = '', scroll = 0): void {
    closeDropdowns();
    models.closeEditor();
    restoredScroll = scroll > 0 ? scroll : undefined;
    view.section = section;
    view.query = query;
    search.value = query;
    if (restoredScroll === undefined) { main.scrollTop = 0; }
    filter();
    persist();
  }

  function restorePosition(): void {
    if (restoredScroll === undefined || !snapshot) { return; }
    if (view.section?.startsWith('provider:')) {
      const id = view.section.slice('provider:'.length);
      const provider = providers.find(provider => provider.id === id);
      if (!snapshot.providers.some(provider => provider.id === id) || !provider || provider.loading ||
        !provider.sections.length && !provider.updatedAt && !provider.failed) { return; }
    }
    main.scrollTop = restoredScroll;
    restoredScroll = undefined;
  }

  function renderNavigation(): void {
    const choices = categories();
    for (const child of [...navigation.children] as HTMLElement[]) {
      if (!choices.some(choice => choice.id === child.dataset.section)) { child.remove(); }
    }
    for (const [index, choice] of choices.entries()) {
      let button = [...navigation.children].find(node => (node as HTMLElement).dataset.section === choice.id) as HTMLButtonElement | undefined;
      if (!button) {
        button = element('button', 'settings-nav-item'); button.type = 'button'; button.dataset.section = choice.id;
        button.addEventListener('click', () => navigate(choice.id));
      }
      if (button.dataset.label !== choice.label || button.dataset.icon !== choice.icon) {
        button.replaceChildren(icon(choice.icon), element('span', '', choice.label));
        button.dataset.label = choice.label; button.dataset.icon = choice.icon;
      }
      if (navigation.children[index] !== button) { navigation.insertBefore(button, navigation.children[index] ?? null); }
    }
    filter();
  }

  function settingTarget(item: SettingState): SettingsTarget { return item.section === 'editor' ? snapshot?.target ?? 'user' : 'user'; }
  function editId(key: string, target: SettingsTarget): string { return `${target}:${key}`; }

  function save(key: string, reset = false): void {
    const item = snapshot?.items.find(item => item.key === key);
    const row = rows.get(key);
    if (!item || !row) { return; }
    const input = row.querySelector<HTMLInputElement | HTMLButtonElement>('[data-setting-input]')!;
    const destination = settingTarget(item);
    const id = editId(key, destination);
    if (edits.get(id)?.saving) { return; }
    let value: string | number | boolean = input.value;
    if (input instanceof HTMLInputElement) {
      if (!reset && !input.reportValidity()) { return; }
      value = item.type === 'boolean' ? input.checked : item.type === 'number' ? input.valueAsNumber : input.value;
    }
    if (!reset && value === item.value) { edits.delete(id); updateRow(item); return; }
    edits.set(id, { value, saving: true });
    saveStatus.textContent = t('Saving...');
    vscode.postMessage({ type: 'settings-update', key, value, reset, target: destination });
    updateRow(item);
  }

  function updateRow(item: SettingState): void {
    const row = rows.get(item.key)!;
    const input = row.querySelector<HTMLInputElement | HTMLButtonElement>('[data-setting-input]')!;
    const destination = settingTarget(item);
    const edit = edits.get(editId(item.key, destination));
    const saving = edit?.saving ?? false;
    const value = edit?.value ?? item.value;
    const dropdown = dropdowns.get(item.key);
    if (dropdown) { dropdown.update(item.options ?? [], String(value), saving); }
    if (input.dataset.target !== destination || input.disabled || document.activeElement !== input) {
      if (input instanceof HTMLInputElement && item.type === 'boolean') { input.checked = value === true; }
      else { input.value = String(value); }
    }
    input.dataset.target = destination;
    input.disabled = saving;
    for (const radio of row.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      radio.checked = radio.value === String(value);
      radio.disabled = saving;
      radio.setAttribute('aria-invalid', String(!!edit?.error));
    }
    row.querySelector<HTMLButtonElement>('[data-reset]')!.disabled = !item.configured || saving;
    row.querySelector<HTMLElement>('.setting-source')!.textContent = item.overridden ? t('Overridden by workspace settings') : '';
    const error = row.querySelector<HTMLElement>('.setting-error')!;
    error.textContent = edit?.error ?? ''; error.hidden = !error.textContent;
    input.setAttribute('aria-invalid', String(!!error.textContent));
    row.setAttribute('aria-busy', String(saving));
  }

  function renderSettings(): void {
    if (!snapshot) { return; }
    for (const item of snapshot.items) {
      const groupKey = `${item.section}:${item.group}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = element('section', 'settings-group'); group.append(element('h2', '', item.group), element('div', 'settings-card'));
        find<HTMLElement>(`settings-${item.section}`).append(group);
        groups.set(groupKey, group);
      }
      if (!rows.has(item.key)) {
        const row = element('div', 'setting-row'); row.dataset.setting = item.key;
        const label = element('label', 'setting-label', item.label); label.htmlFor = `setting-${item.key}`;
        const copy = element('div', 'setting-copy'); copy.append(label, element('p', 'muted setting-description', item.description), element('p', 'setting-source'));
        const controls = element('div', 'setting-controls');
        const input = item.type === 'select' ? element('button') : element('input');
        input.id = label.htmlFor; input.dataset.settingInput = item.key; input.setAttribute('aria-label', item.label);
        if (input instanceof HTMLInputElement) {
          input.type = item.type === 'radio' ? 'hidden' : item.type === 'boolean' ? 'checkbox' : item.type === 'number' ? 'number' : 'text';
          if (item.type === 'boolean') { input.setAttribute('role', 'switch'); }
          if (item.minimum !== undefined) { input.min = String(item.minimum); }
          if (item.maximum !== undefined) { input.max = String(item.maximum); }
          if (item.type === 'number') { input.step = item.integer ? '1' : 'any'; }
          if (item.type === 'string') { input.maxLength = 4096; input.spellcheck = false; }
          if (item.key === 'studio.terminal.name') { input.required = true; }
        }
        const reset = element('button', 'icon-button setting-reset'); reset.type = 'button'; reset.dataset.reset = item.key;
        reset.title = t('Restore default'); reset.setAttribute('aria-label', t('Restore default for {0}', item.label)); reset.append(icon('discard'));
        // Keep the input focused until the reset click, so blur cannot save a draft first.
        reset.addEventListener('pointerdown', event => event.preventDefault());
        reset.addEventListener('click', () => save(item.key, true));
        const commit = () => save(item.key);
        if (item.type === 'radio') {
          row.classList.add('setting-radio-row');
          const choices = element('div', 'settings-radio-group'); choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', item.label);
          for (const option of item.options ?? []) {
            const choice = element('label', 'settings-radio-choice');
            const radio = element('input'); radio.type = 'radio'; radio.name = item.key; radio.value = option.value;
            const text = element('span', 'settings-radio-copy'); text.append(element('strong', '', option.label));
            if (option.description) { text.append(element('span', 'muted', option.description)); }
            radio.addEventListener('change', () => { if (radio.checked) { input.value = radio.value; commit(); } });
            choice.append(radio, text); choices.append(choice);
          }
          controls.append(choices);
        }
        if (input instanceof HTMLButtonElement) { dropdowns.set(item.key, new SettingsDropdown(input, commit)); }
        else if (item.type === 'boolean') { input.addEventListener('change', commit); }
        else if (item.type !== 'radio') {
          input.addEventListener('blur', commit);
          input.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') { input.blur(); } });
        }
        controls.append(input, reset);
        const error = element('p', 'setting-error'); error.id = `error-${item.key}`; error.setAttribute('role', 'alert'); error.hidden = true;
        input.setAttribute('aria-describedby', error.id);
        row.append(copy, controls, error); group.lastElementChild!.append(row); rows.set(item.key, row);
      }
      updateRow(item);
    }
    const runtimeRow = rows.get('studio.project.nodeSource');
    if (runtimeRow && snapshot.nodeRuntime) {
      let status = runtimeRow.querySelector<HTMLElement>('.runtime-status');
      if (!status) { status = element('p', 'runtime-status muted'); runtimeRow.querySelector('.setting-copy')!.append(status); }
      const runtime = snapshot.nodeRuntime;
      const sources = { bundled: t('Bundled Node.js'), local: t('Local Node.js'), host: t('Studio runtime') };
      status.textContent = runtime.error || [runtime.source ? sources[runtime.source] : '', runtime.version, runtime.path].filter(Boolean).join(' · ');
      status.style.overflowWrap = 'anywhere';
    }
    const appearance = [...groups.values()][0]?.lastElementChild;
    if (appearance && !root.querySelector('#settings-language')) {
      const row = element('div', 'setting-row'); row.id = 'settings-language';
      const label = element('label', 'setting-label', t('Display language')); label.htmlFor = 'settings-language-choice';
      const description = element('p', 'muted setting-description'); description.id = 'settings-language-current';
      const copy = element('div', 'setting-copy'); copy.append(label, description);
      const controls = element('div', 'setting-controls');
      const button = element('button'); button.id = label.htmlFor; button.setAttribute('aria-label', t('Display language'));
      const reset = element('button', 'icon-button setting-reset'); reset.type = 'button'; reset.dataset.languageReset = '';
      reset.title = t('Restore default'); reset.setAttribute('aria-label', t('Restore default for {0}', t('Display language'))); reset.append(icon('discard'));
      const error = element('p', 'setting-error'); error.id = 'settings-language-error'; error.setAttribute('role', 'alert'); error.hidden = true;
      button.setAttribute('aria-describedby', `${description.id} settings-language-pending ${error.id}`);
      const chooseLanguage = (value: string): void => {
        if (languageSaving) { return; }
        languageSaving = true; languageError = ''; saveStatus.textContent = t('Saving...');
        languageDropdown!.update(languageOptions, value, true); reset.disabled = true;
        find('settings-language-pending').hidden = true;
        find<HTMLButtonElement>('settings-language-restart').disabled = true;
        error.textContent = ''; error.hidden = true; button.setAttribute('aria-invalid', 'false');
        vscode.postMessage({ type: 'settings-language', value });
      };
      languageDropdown = new SettingsDropdown(button, () => chooseLanguage(button.value), true);
      reset.addEventListener('click', () => chooseLanguage('system'));
      const pending = element('div', 'setting-language-pending'); pending.id = 'settings-language-pending'; pending.hidden = true;
      pending.setAttribute('role', 'status'); pending.setAttribute('aria-live', 'polite');
      const restart = element('button', 'secondary', t('Restart to apply')); restart.id = 'settings-language-restart'; restart.type = 'button';
      restart.addEventListener('click', () => { if (snapshot && !languageSaving) { languageRestarting = true; chooseLanguage(snapshot.languagePreference); } });
      pending.append(element('p', 'muted'), restart);
      controls.append(button, reset); row.append(copy, controls, pending, error); appearance.append(row);
    }
    const language = root.querySelector<HTMLButtonElement>('#settings-language-choice');
    if (language && languageDropdown) {
      languageDropdown.update(languageOptions, languageSaving ? language.value : snapshot.languagePreference, languageSaving);
      find('settings-language').querySelector<HTMLButtonElement>('[data-language-reset]')!.disabled = languageSaving || snapshot.languagePreference === 'system';
      const active = snapshot.language.toLowerCase();
      const activeLabel = languageOptions.find(option => option.value === active)?.label ?? snapshot.language;
      find('settings-language-current').textContent = t('Current display language: {0}. Changes take effect after restarting Studio.', activeLabel);
      const pending = find('settings-language-pending');
      const preference = snapshot.languagePreference;
      const selected = languageOptions.find(option => option.value === preference);
      pending.hidden = languageSaving || !selected || selected.value === 'system' || selected.value === active;
      pending.querySelector('p')!.textContent = selected ? t('Restart Studio to apply {0}.', selected.label) : '';
      find<HTMLButtonElement>('settings-language-restart').disabled = languageSaving;
      language.setAttribute('aria-invalid', String(!!languageError));
      const error = find('settings-language-error'); error.textContent = languageError; error.hidden = !languageError;
    }
    if (!root.querySelector('#settings-editor-actions')) {
      const group = element('section', 'settings-group'); group.id = 'settings-editor-actions';
      group.append(element('h2', '', t('Advanced configuration')));
      const card = element('div', 'settings-card settings-action-card');
      const note = element('p', 'muted', t('Other editor and extension settings are available in settings JSON.'));
      for (const [action, label] of [['json-current', t('Open settings JSON')], ['keybindings', t('Keyboard shortcuts')]]) {
        const button = element('button', 'secondary', label); button.type = 'button'; button.dataset.settingsAction = action; card.append(button);
      }
      card.prepend(note); group.append(card); find<HTMLElement>('settings-editor').append(group);
    }
    targetDropdown.update([{ value: 'user', label: t('User') }, { value: 'workspace', label: t('Workspace'), disabled: !snapshot.workspaceAvailable }], snapshot.target);
    find('settings-studio-version').textContent = snapshot.studioVersion;
    find('settings-vscode-version').textContent = snapshot.vscodeVersion;
    filter();
  }

  function filter(): void {
    const query = search.value.trim().toLocaleLowerCase().replace(/^@id:/, '');
    const searching = !!query;
    const selected = categories().find(category => category.id === view.section) ?? categories().find(category => category.id === 'general')!;
    const activeSection = selected.id;
    let matches = 0;
    showMemory();
    for (const section of ['general', 'editor', 'permissions', 'models', 'memory', 'account', 'provider', 'about']) {
      const pane = find<HTMLElement>(`settings-${section}`);
      let visible = searching ? false : section === (activeSection.startsWith('provider:') ? 'provider' : activeSection);
      if (section === 'general' || section === 'editor' || section === 'permissions') {
        for (const item of snapshot?.items.filter(item => item.section === section) ?? []) {
          const row = rows.get(item.key);
          const matched = !query || `${item.key} ${item.label} ${item.description} ${item.group} ${(item.options ?? []).map(option => `${option.label} ${option.description ?? ''}`).join(' ')}`.toLocaleLowerCase().includes(query);
          if (row) { row.hidden = !matched; }
          if (searching && matched) { visible = true; ++matches; }
        }
        for (const [id, group] of groups) {
          if (id.startsWith(`${section}:`)) { group.hidden = ![...group.querySelectorAll<HTMLElement>('.setting-row')].some(row => !row.hidden); }
        }
        const language = root.querySelector<HTMLElement>('#settings-language');
        if (section === 'general' && language) {
          language.hidden = searching && !`${t('Display language')} ${languageOptions.map(option => option.label).join(' ')} language locale`.toLocaleLowerCase().includes(query);
          if (searching && !language.hidden) { visible = true; ++matches; }
          if (!language.hidden) { language.closest<HTMLElement>('.settings-group')!.hidden = false; }
        }
        const actions = root.querySelector<HTMLElement>('#settings-editor-actions');
        if (section === 'editor' && actions) {
          actions.hidden = searching && !actions.textContent?.toLocaleLowerCase().includes(query);
          if (searching && !actions.hidden) { visible = true; ++matches; }
        }
      } else if (section === 'models' && searching) {
        visible = models.matches(query) || `${t('Models')} ${pane.textContent} model api`.toLocaleLowerCase().includes(query);
        if (visible) ++matches;
      } else if (searching) {
        const matching = categories().filter(category => (section === 'provider' ? category.id.startsWith('provider:') : category.id === section) && category.label.toLocaleLowerCase().includes(query));
        visible = matching.length > 0;
        matches += matching.length;
      }
      pane.hidden = !visible;
    }
    for (const node of [...sections.children] as HTMLElement[]) {
      node.hidden = searching ? !(snapshot?.providers.find(provider => provider.id === node.dataset.provider)?.title.toLocaleLowerCase().includes(query)) : `provider:${node.dataset.provider}` !== activeSection;
    }
    const signedIn = !!account?.user && ['authenticated', 'checking', 'error'].includes(account.status);
    const hasProvider = signedIn && [...sections.children].some(node => !(node as HTMLElement).hidden);
    find('settings-sign-in').hidden = hasProvider || !snapshot?.providers.length;
    find('settings-sign-in').querySelector('p')!.textContent = account?.status === 'checking' || signedIn && account?.status !== 'error'
      ? t('Loading...') : signedIn ? t('Account verification failed.') : t('Sign in to view this information.');
    find('settings-provider-sign-in').textContent = signedIn || account?.status === 'checking' ? t('Account') : t('Sign In');
    sections.hidden = !hasProvider;
    find('settings-title').textContent = searching ? t('Search results') : selected?.label ?? t('General');
    find('settings-no-results').hidden = !searching || matches > 0;
    find('settings-scope').hidden = !searching && activeSection !== 'editor';
    for (const button of [...navigation.children] as HTMLElement[]) {
      if (!searching && button.dataset.section === activeSection) { button.setAttribute('aria-current', 'page'); }
      else { button.removeAttribute('aria-current'); }
    }
    restorePosition();
  }

  search.value = view.query ?? '';
  search.addEventListener('input', () => { closeDropdowns(); restoredScroll = undefined; filter(); main.scrollTop = 0; persist(); });
  search.addEventListener('keydown', event => { if (event.key === 'Escape') { search.value = ''; filter(); persist(); } });
  navigation.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { return; }
    const buttons = [...navigation.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
  });
  root.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); search.select(); } });
  main.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(persist, 100); }, { passive: true });
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    main.addEventListener(event, () => { restoredScroll = undefined; }, { passive: true });
  }
  root.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-settings-action]');
    if (button) {
      const action = button.dataset.settingsAction === 'json-current' ? snapshot?.target === 'workspace' ? 'json-workspace' : 'json-user' : button.dataset.settingsAction;
      vscode.postMessage({ type: 'settings-action', action });
    }
  });
  const openAccount = (): void => {
    if (account?.user && ['authenticated', 'checking', 'error'].includes(account.status)) { navigate('account'); }
    else { vscode.postMessage({ type: 'open-login' }); }
  };
  find('settings-identity').addEventListener('click', openAccount);
  find('settings-provider-sign-in').addEventListener('click', openAccount);
  window.addEventListener('message', event => {
    const message = event.data;
    if(message.type==='settings-memory-result'){const p=memoryPending.get(message.requestId);if(p){memoryPending.delete(message.requestId);clearTimeout(p.timer);message.error?p.reject(Object.assign(new Error(message.error),{status:message.status})):p.resolve(message.data);}return;}
    if (models.handle(message)) { return; }
    if (message.type === 'settings') {
      snapshot = message.state;
      view.target = snapshot?.target;
      renderSettings(); renderNavigation();
    } else if (message.type === 'settings-navigate') {
      const next = message.state as SettingsViewState;
      navigate(next.section ?? 'general', next.query?.replace(/^@ext:studio\.studio-workstation\s*/, '') ?? '', next.scroll ?? 0);
    } else if (message.type === 'account-sections') {
      providers = message.states;
      renderAccountSections(sections, providers, message => vscode.postMessage(message));
      filter();
    } else if (message.type === 'settings-language-result') {
      languageSaving = false; languageError = message.message ?? '';
      if (snapshot) { snapshot.languagePreference = message.value; }
      saveStatus.textContent = [...edits.values()].some(edit => edit.saving) ? t('Saving...') : languageError ? t('Unable to save setting.') : '';
      renderSettings();
      if (languageRestarting) {
        languageRestarting = false;
        find<HTMLButtonElement>(find('settings-language-pending').hidden ? 'settings-language-choice' : 'settings-language-restart').focus();
      }
    } else if (message.type === 'settings-saved' || message.type === 'settings-error') {
      const id = editId(message.key, message.target);
      const edit = edits.get(id);
      if (message.key && !edit?.saving) { return; }
      if (message.key) {
        if (message.type === 'settings-error') { edits.set(id, { ...edit!, saving: false, error: message.message }); }
        else { edits.delete(id); }
      }
      if (message.state) { snapshot = message.state; view.target = snapshot?.target; }
      const error = find('settings-error');
      error.textContent = !message.key && message.type === 'settings-error' ? message.message : ''; error.hidden = !error.textContent;
      saveStatus.textContent = languageSaving || [...edits.values()].some(edit => edit.saving) ? t('Saving...') : message.type === 'settings-saved' ? t('Saved') : t('Unable to save setting.');
      renderSettings();
    }
  });
  renderNavigation();
  return {
    accountRoot: find('settings-account'),
    setAccount(state) {
      const identity=state.status==='authenticated'?`${state.serverUrl}:${state.user?.userId}:${state.revision}`:'';
      if(identity!==memoryAccount){memoryAccount=identity;clearMemory();}
      account = state;
      const name = find('settings-account-name'), label = find('settings-account-label');
      name.textContent = state.user?.displayName || state.user?.email || 'SteamHarness'; name.title = name.textContent;
      label.textContent = state.user ? state.user.email : t('Signed Out'); label.title = label.textContent;
      updateAvatar(state.user?.avatarUrl);
      if (!state.user || !['authenticated', 'checking', 'error'].includes(state.status)) { providers = []; sections.replaceChildren(); }
      filter();
    },
  };
}
