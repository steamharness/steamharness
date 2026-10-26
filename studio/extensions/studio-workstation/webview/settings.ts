import { t, locale } from './localization';
import { renderAccountSections } from './account-sections';
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
        <div id="settings-scope" class="settings-scope" hidden><label for="settings-target">${t('Settings scope')}</label><select id="settings-target"><option value="user">${t('User')}</option><option value="workspace">${t('Workspace')}</option></select></div>
        <div id="settings-error" class="settings-error" role="alert" hidden></div>
        <section id="settings-general" class="settings-panel" aria-label="${t('General')}"></section>
        <section id="settings-editor" class="settings-panel" aria-label="${t('Editor')}" hidden></section>
        <section id="settings-account" class="settings-panel" aria-label="${t('Account')}" hidden></section>
        <section id="settings-provider" class="settings-panel" hidden><div id="settings-sign-in" class="settings-card settings-empty" hidden><p>${t('Sign in to view this information.')}</p><button type="button" class="secondary" id="settings-provider-sign-in">${t('Sign In')}</button></div><div id="account-sections" hidden></div></section>
        <section id="settings-about" class="settings-panel" aria-label="${t('About')}" hidden><div class="settings-card settings-about"><span class="settings-product-icon codicon codicon-terminal" aria-hidden="true"></span><h2>SteamHarness Studio</h2><p class="muted">${t('Your workspace for building and running SteamHarness projects.')}</p><dl><dt>${t('Studio version')}</dt><dd id="settings-studio-version"></dd><dt>${t('VS Code version')}</dt><dd id="settings-vscode-version"></dd></dl><button type="button" class="secondary" data-settings-action="documentation">${t('Documentation')}</button></div></section>
        <div id="settings-no-results" class="settings-empty" hidden><p>${t('No matching settings')}</p><p class="muted">${t('Other editor and extension settings are available in settings JSON.')}</p><button type="button" class="secondary" data-settings-action="json-user">${t('Open settings JSON')}</button></div>
      </section>
    </div>`;
  const find = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const navigation = find<HTMLElement>('settings-navigation');
  const search = find<HTMLInputElement>('settings-search');
  const target = find<HTMLSelectElement>('settings-target');
  const main = find<HTMLElement>('settings-main');
  const sections = find<HTMLElement>('account-sections');
  const saveStatus = find<HTMLElement>('settings-save-status');
  const errors = new Map<string, string>();
  const pending = new Set<string>();
  const rows = new Map<string, HTMLElement>();
  const groups = new Map<string, HTMLElement>();
  let snapshot: SettingsState | undefined;
  let account: AccountState | undefined;
  let providers: AccountSectionState[] = [];
  let view: SettingsViewState = { section: 'general', query: '', target: 'user', ...vscode.getState?.() };
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;

  function persist(): void {
    const state: SettingsViewState = { section: view.section, query: search.value, target: view.target, scroll: main.scrollTop };
    vscode.setState?.(state);
    vscode.postMessage({ type: 'settings-view-state', state });
  }

  function categories(): { id: string; label: string; icon: string }[] {
    return [
      { id: 'account', label: t('Account'), icon: 'account' },
      { id: 'general', label: t('General'), icon: 'settings-gear' },
      { id: 'editor', label: t('Editor'), icon: 'code' },
      ...(snapshot?.providers ?? []).map(provider => ({ id: `provider:${provider.id}`, label: provider.title, icon: provider.icon ?? 'extensions' })),
      { id: 'about', label: t('About'), icon: 'info' },
    ];
  }

  function navigate(section: string, query = '', scroll = 0): void {
    view.section = section;
    view.query = query;
    search.value = query;
    filter();
    main.scrollTop = scroll;
    persist();
  }

  function renderNavigation(): void {
    const choices = categories();
    for (const child of [...navigation.children] as HTMLElement[]) {
      if (!choices.some(choice => choice.id === child.dataset.section)) { child.remove(); }
    }
    for (const choice of choices) {
      let button = [...navigation.children].find(node => (node as HTMLElement).dataset.section === choice.id) as HTMLButtonElement | undefined;
      if (!button) {
        button = element('button', 'settings-nav-item'); button.type = 'button'; button.dataset.section = choice.id;
        button.addEventListener('click', () => navigate(choice.id));
        navigation.append(button);
      }
      if (button.dataset.label !== choice.label || button.dataset.icon !== choice.icon) {
        button.replaceChildren(icon(choice.icon), element('span', '', choice.label));
        button.dataset.label = choice.label; button.dataset.icon = choice.icon;
      }
      navigation.append(button);
    }
    filter();
  }

  function settingTarget(item: SettingState): SettingsTarget { return item.section === 'editor' ? snapshot?.target ?? 'user' : 'user'; }
  function pendingId(key: string, target: SettingsTarget): string { return `${target}:${key}`; }

  function save(key: string, reset = false): void {
    const item = snapshot?.items.find(item => item.key === key);
    const row = rows.get(key);
    if (!item || !row) { return; }
    const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('[data-setting-input]')!;
    const destination = settingTarget(item);
    if (pending.has(pendingId(key, destination))) { return; }
    let value: string | number | boolean = input.value;
    if (input instanceof HTMLInputElement) {
      if (!reset && !input.reportValidity()) { return; }
      value = item.type === 'boolean' ? input.checked : item.type === 'number' ? input.valueAsNumber : input.value;
    }
    if (!reset && value === item.value) { return; }
    errors.delete(key);
    pending.add(pendingId(key, destination));
    saveStatus.textContent = t('Saving...');
    vscode.postMessage({ type: 'settings-update', key, value, reset, target: destination });
    updateRow(item);
  }

  function updateRow(item: SettingState): void {
    const row = rows.get(item.key)!;
    const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('[data-setting-input]')!;
    if (input instanceof HTMLSelectElement && JSON.stringify(item.options) !== input.dataset.options) {
      input.replaceChildren(...(item.options ?? []).map(option => { const node = element('option', '', option.label); node.value = option.value; return node; }));
      input.dataset.options = JSON.stringify(item.options);
    }
    const saving = pending.has(pendingId(item.key, settingTarget(item)));
    if (document.activeElement !== input && !saving && !errors.has(item.key)) {
      if (input instanceof HTMLInputElement && item.type === 'boolean') { input.checked = item.value === true; }
      else { input.value = String(item.value); }
    }
    input.disabled = saving;
    row.querySelector<HTMLButtonElement>('[data-reset]')!.disabled = !item.configured || saving;
    row.querySelector<HTMLElement>('.setting-source')!.textContent = item.overridden ? t('Overridden by workspace settings') : '';
    const error = row.querySelector<HTMLElement>('.setting-error')!;
    error.textContent = errors.get(item.key) ?? ''; error.hidden = !error.textContent;
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
        const input = item.type === 'select' ? element('select') : element('input');
        input.id = label.htmlFor; input.dataset.settingInput = item.key; input.setAttribute('aria-label', item.label);
        if (input instanceof HTMLInputElement) {
          input.type = item.type === 'boolean' ? 'checkbox' : item.type === 'number' ? 'number' : 'text';
          if (item.type === 'boolean') { input.setAttribute('role', 'switch'); }
          if (item.minimum !== undefined) { input.min = String(item.minimum); }
          if (item.maximum !== undefined) { input.max = String(item.maximum); }
          if (item.type === 'number') { input.step = item.integer ? '1' : 'any'; }
          if (item.type === 'string') { input.maxLength = 4096; input.spellcheck = false; }
          if (item.key === 'studio.terminal.name') { input.required = true; }
        }
        const reset = element('button', 'icon-button setting-reset'); reset.type = 'button'; reset.dataset.reset = item.key;
        reset.title = t('Restore default'); reset.setAttribute('aria-label', t('Restore default for {0}', item.label)); reset.append(icon('discard'));
        reset.addEventListener('click', () => save(item.key, true));
        const commit = () => save(item.key);
        if (item.type === 'boolean' || item.type === 'select') { input.addEventListener('change', commit); }
        else {
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
    const appearance = [...groups.values()][0]?.lastElementChild;
    if (appearance && !root.querySelector('#settings-language')) {
      const row = element('div', 'setting-row'); row.id = 'settings-language';
      const copy = element('div', 'setting-copy'); copy.append(element('span', 'setting-label', t('Display language')), element('p', 'muted setting-description', t('Choose the application language. A restart may be required.')));
      const button = element('button', 'secondary'); button.type = 'button'; button.dataset.settingsAction = 'language';
      row.append(copy, button); appearance.append(row);
    }
    const language = root.querySelector<HTMLButtonElement>('#settings-language button');
    if (language) { language.textContent = `${new Intl.DisplayNames([locale()], { type: 'language' }).of(snapshot.language) ?? snapshot.language} · ${t('Change language')}`; }
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
    target.value = snapshot.target;
    target.options[1].disabled = !snapshot.workspaceAvailable;
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
    for (const section of ['general', 'editor', 'account', 'provider', 'about']) {
      const pane = find<HTMLElement>(`settings-${section}`);
      let visible = searching ? false : section === (activeSection.startsWith('provider:') ? 'provider' : activeSection);
      if (section === 'general' || section === 'editor') {
        for (const item of snapshot?.items.filter(item => item.section === section) ?? []) {
          const row = rows.get(item.key);
          const matched = !query || `${item.key} ${item.label} ${item.description} ${item.group}`.toLocaleLowerCase().includes(query);
          if (row) { row.hidden = !matched; }
          if (searching && matched) { visible = true; ++matches; }
        }
        for (const [id, group] of groups) {
          if (id.startsWith(`${section}:`)) { group.hidden = ![...group.querySelectorAll<HTMLElement>('.setting-row')].some(row => !row.hidden); }
        }
        const language = root.querySelector<HTMLElement>('#settings-language');
        if (section === 'general' && language) {
          language.hidden = searching && !`${t('Display language')} ${t('Change language')}`.toLocaleLowerCase().includes(query);
          if (searching && !language.hidden) { visible = true; ++matches; }
          if (!language.hidden) { language.closest<HTMLElement>('.settings-group')!.hidden = false; }
        }
        const actions = root.querySelector<HTMLElement>('#settings-editor-actions');
        if (section === 'editor' && actions) {
          actions.hidden = searching && !actions.textContent?.toLocaleLowerCase().includes(query);
          if (searching && !actions.hidden) { visible = true; ++matches; }
        }
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
    find('settings-sign-in').hidden = signedIn || !snapshot?.providers.length;
    sections.hidden = !signedIn || !sections.childElementCount;
    find('settings-title').textContent = searching ? t('Search results') : selected?.label ?? t('General');
    find('settings-no-results').hidden = !searching || matches > 0;
    find('settings-scope').hidden = !searching && activeSection !== 'editor';
    for (const button of [...navigation.children] as HTMLElement[]) {
      if (!searching && button.dataset.section === activeSection) { button.setAttribute('aria-current', 'page'); }
      else { button.removeAttribute('aria-current'); }
    }
  }

  search.value = view.query ?? '';
  search.addEventListener('input', () => { filter(); main.scrollTop = 0; persist(); });
  search.addEventListener('keydown', event => { if (event.key === 'Escape') { search.value = ''; filter(); persist(); } });
  navigation.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { return; }
    const buttons = [...navigation.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
  });
  root.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); search.select(); } });
  target.addEventListener('change', () => { errors.clear(); view.target = target.value === 'workspace' ? 'workspace' : 'user'; persist(); vscode.postMessage({ type: 'settings-target', target: view.target }); });
  main.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(persist, 100); }, { passive: true });
  root.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-settings-action]');
    if (button) {
      const action = button.dataset.settingsAction === 'json-current' ? snapshot?.target === 'workspace' ? 'json-workspace' : 'json-user' : button.dataset.settingsAction;
      vscode.postMessage({ type: 'settings-action', action });
    }
  });
  find('settings-identity').addEventListener('click', () => navigate('account'));
  find('settings-provider-sign-in').addEventListener('click', () => navigate('account'));
  find<HTMLImageElement>('settings-avatar-image').addEventListener('error', event => { (event.target as HTMLElement).hidden = true; });
  window.addEventListener('message', event => {
    const message = event.data;
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
    } else if (message.type === 'settings-saved' || message.type === 'settings-error') {
      if (message.key && !pending.delete(pendingId(message.key, message.target))) { return; }
      if (message.key) {
        const item = snapshot?.items.find(item => item.key === message.key);
        if (message.type === 'settings-error' && item && settingTarget(item) === message.target) { errors.set(message.key, message.message); }
        else { errors.delete(message.key); }
      }
      const error = find('settings-error');
      error.textContent = !message.key && message.type === 'settings-error' ? message.message : ''; error.hidden = !error.textContent;
      saveStatus.textContent = pending.size ? t('Saving...') : message.type === 'settings-saved' ? t('Saved') : t('Unable to save setting.');
      renderSettings();
    }
  });
  renderNavigation();
  return {
    accountRoot: find('settings-account'),
    setAccount(state) {
      account = state;
      find('settings-account-name').textContent = state.user?.displayName || state.user?.email || 'SteamHarness';
      find('settings-account-label').textContent = state.user ? state.user.email : t('Signed Out');
      const image = find<HTMLImageElement>('settings-avatar-image');
      if (state.user?.avatarUrl) { if (image.getAttribute('src') !== state.user.avatarUrl) { image.src = state.user.avatarUrl; image.hidden = false; } }
      else { image.removeAttribute('src'); image.hidden = true; }
      if (!state.user || !['authenticated', 'checking', 'error'].includes(state.status)) { providers = []; sections.replaceChildren(); }
      filter();
    },
  };
}
