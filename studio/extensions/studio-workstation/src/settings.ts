import * as vscode from 'vscode';
import { t } from './localization';
import type { SettingItem, SettingsProvider, SettingsState, SettingsTarget, SettingsViewState } from './settings-types';

export const SYSTEM_THEME = '__system__';

/** Persist navigation only; never restore arbitrary webview data or account fields. */
export function settingsViewState(value: unknown): SettingsViewState {
  const state = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    section: typeof state.section === 'string' && /^(general|editor|account|about|provider:[\w.-]+)$/.test(state.section) ? state.section : 'general',
    query: typeof state.query === 'string' ? state.query.slice(0, 512) : '',
    target: state.target === 'workspace' ? 'workspace' : 'user',
    scroll: typeof state.scroll === 'number' && Number.isFinite(state.scroll) ? Math.min(500_000, Math.max(0, state.scroll)) : 0,
  };
}

/** Only these existing configuration keys may be written by the settings webview. */
export function settingsCatalog(): SettingItem[] {
  return [
    { key: 'workbench.colorTheme', section: 'general', group: t('Appearance'), label: t('Theme'), description: t('Choose an installed theme or follow your system appearance.'), type: 'select' },
    { key: 'studio.startPage.enabled', section: 'general', group: t('Workspace'), label: t('Show start page'), description: t('Show the Studio start page when no editor is open.'), type: 'boolean' },
    { key: 'studio.recentProjects.limit', section: 'general', group: t('Workspace'), label: t('Recent project limit'), description: t('Maximum number of projects in the recent projects list.'), type: 'number', integer: true, minimum: 1, maximum: 50 },
    { key: 'studio.terminal.name', section: 'general', group: t('Runtime'), label: t('Terminal name'), description: t('Name used when opening a new Studio terminal.'), type: 'string' },
    { key: 'studio.project.nodePath', section: 'general', group: t('Runtime'), label: t('Node.js executable'), description: t('Leave empty to use the automatically resolved Node.js runtime. Changes apply to new processes.'), type: 'string' },
    { key: 'editor.fontSize', section: 'editor', group: t('Text editor'), label: t('Font size'), description: t('Editor font size in pixels.'), type: 'number', minimum: 6, maximum: 100 },
    { key: 'editor.tabSize', section: 'editor', group: t('Text editor'), label: t('Indent size'), description: t('Number of spaces represented by a tab. File indentation detection can override this value.'), type: 'number', integer: true, minimum: 1 },
    { key: 'editor.insertSpaces', section: 'editor', group: t('Text editor'), label: t('Insert spaces'), description: t('Insert spaces when pressing Tab. File indentation detection can override this value.'), type: 'boolean' },
    { key: 'editor.wordWrap', section: 'editor', group: t('Text editor'), label: t('Word wrap'), description: t('Control how long lines wrap in the editor.'), type: 'select', options: [
      { value: 'off', label: t('Off') }, { value: 'on', label: t('On') },
      { value: 'wordWrapColumn', label: t('At word wrap column') }, { value: 'bounded', label: t('At viewport or word wrap column') },
    ] },
    { key: 'files.autoSave', section: 'editor', group: t('Files'), label: t('Auto save'), description: t('Choose when edited files are saved automatically.'), type: 'select', options: [
      { value: 'off', label: t('Off') }, { value: 'afterDelay', label: t('After delay') },
      { value: 'onFocusChange', label: t('On focus change') }, { value: 'onWindowChange', label: t('On window change') },
    ] },
  ];
}

export function themeOptions(): { value: string; label: string }[] {
  const themes = new Map<string, string>();
  for (const extension of vscode.extensions.all) {
    for (const theme of extension.packageJSON.contributes?.themes ?? []) {
      const value = theme.id ?? theme.label;
      if (typeof value === 'string' && typeof theme.label === 'string') { themes.set(value, theme.label); }
    }
  }
  const current = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (current && !themes.has(current)) { themes.set(current, current); }
  return [{ value: SYSTEM_THEME, label: t('Follow system') }, ...[...themes].map(([value, label]) => ({ value, label }))];
}

export function settingsState(studioVersion: string, target: SettingsTarget, providers: SettingsProvider[]): SettingsState {
  const configuration = vscode.workspace.getConfiguration();
  const workspaceAvailable = !!vscode.workspace.workspaceFolders?.length || !!vscode.workspace.workspaceFile;
  if (!workspaceAvailable) { target = 'user'; }
  const items = settingsCatalog().map(item => {
    const inspected = configuration.inspect<string | number | boolean>(item.key);
    const workspace = item.section === 'editor' && target === 'workspace';
    const inherited = inspected?.globalValue ?? inspected?.defaultValue ?? configuration.get<string | number | boolean>(item.key) ?? '';
    let value = workspace ? inspected?.workspaceValue ?? inherited : inherited;
    let configured = (workspace ? inspected?.workspaceValue : inspected?.globalValue) !== undefined;
    if (item.key === 'workbench.colorTheme') {
      const systemTheme = configuration.inspect<boolean>('window.autoDetectColorScheme');
      if (systemTheme?.globalValue ?? systemTheme?.defaultValue ?? configuration.get<boolean>('window.autoDetectColorScheme')) { value = SYSTEM_THEME; }
      configured ||= systemTheme?.globalValue !== undefined;
      return { ...item, options: themeOptions(), value, configured, overridden: false };
    }
    return { ...item, value, configured, overridden: !workspace && item.section === 'editor' && inspected?.workspaceValue !== undefined };
  });
  return { target, workspaceAvailable, items, language: vscode.env.language, studioVersion, vscodeVersion: vscode.version, providers };
}

export async function updateSetting(key: string, value: unknown, target: SettingsTarget, reset: boolean): Promise<void> {
  const item = settingsCatalog().find(item => item.key === key);
  if (!item || !['user', 'workspace'].includes(target)) { throw new Error(t('Unsupported setting.')); }
  if (target === 'workspace' && (item.section !== 'editor' || !vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile)) {
    throw new Error(t('This setting cannot be changed for this workspace.'));
  }
  const configuration = vscode.workspace.getConfiguration();
  const destination = target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  if (!reset) {
    const options = key === 'workbench.colorTheme' ? themeOptions() : item.options;
    const valid = item.type === 'boolean' ? typeof value === 'boolean'
      : item.type === 'number' ? typeof value === 'number' && Number.isFinite(value) && (!item.integer || Number.isInteger(value)) && (item.minimum === undefined || value >= item.minimum) && (item.maximum === undefined || value <= item.maximum)
      : item.type === 'select' ? typeof value === 'string' && options?.some(option => option.value === value)
      : typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && (key !== 'studio.terminal.name' || !!value.trim());
    if (!valid) { throw new Error(t('Enter a valid value for {0}.', item.label)); }
  }
  if (key === 'workbench.colorTheme') {
    if (reset || value !== SYSTEM_THEME) { await configuration.update(key, reset ? undefined : value, destination); }
    await configuration.update('window.autoDetectColorScheme', reset ? undefined : value === SYSTEM_THEME, destination);
  } else { await configuration.update(key, reset ? undefined : value, destination); }
}
