import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const compiled = await build({ stdin: { contents: `export { settingsState } from './extensions/studio-workstation/src/settings'; export { configureLocalization } from './extensions/studio-workstation/src/localization';`,
  resolveDir: new URL('.', root).pathname, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
const chinese = JSON.parse(await readFile(new URL('extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', root), 'utf8'));

export function settingsFixture(language = 'en', providers = [], target = 'user') {
  const values = { 'workbench.colorTheme': 'Dark', 'window.autoDetectColorScheme': true, 'studio.startPage.enabled': true, 'studio.recentProjects.limit': 12,
    'studio.terminal.name': 'Studio', 'studio.project.nodePath': '', 'editor.fontSize': 14, 'editor.tabSize': 4, 'editor.insertSpaces': true, 'editor.wordWrap': 'off', 'files.autoSave': 'off' };
  const vscode = { env: { language }, version: '1.141.0',
    extensions: { all: [{ packageJSON: { contributes: { themes: [{ id: 'Dark', label: 'Dark' }, { id: 'Light', label: 'Light' }] } } }] },
    workspace: { workspaceFolders: [{}], getConfiguration: (prefix = '') => ({ get: key => values[prefix ? `${prefix}.${key}` : key], inspect: key => ({ defaultValue: values[key], globalValue: key === 'editor.fontSize' ? 14 : undefined }) }) } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id) });
  module.exports.configureLocalization(language === 'en' ? {} : chinese, language);
  return module.exports.settingsState('0.1.0', target, providers);
}

export function settingsThemeCss(theme) {
  const dark = theme !== 'light';
  const variables = {
    'editor-background': dark ? '#1f1f1f' : '#ffffff', 'editor-foreground': dark ? '#cccccc' : '#24292f', foreground: dark ? '#cccccc' : '#24292f',
    'sideBar-background': dark ? '#252526' : '#f6f7f9', descriptionForeground: dark ? '#a0a0a0' : '#616161',
    'font-family': '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', 'editor-font-family': 'Menlo,monospace',
    'panel-border': dark ? '#3a3a3a' : '#e5e7eb', 'widget-border': dark ? '#3a3a3a' : '#e5e7eb',
    'input-background': dark ? '#313131' : '#ffffff', 'input-foreground': dark ? '#cccccc' : '#333333', 'input-border': dark ? '#484848' : '#d5d9df',
    'input-placeholderForeground': dark ? '#999999' : '#767676', focusBorder: '#0078d4',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
    'button-secondaryBackground': dark ? '#353535' : '#e8ebef', 'button-secondaryForeground': dark ? '#cccccc' : '#333333', 'button-secondaryHoverBackground': dark ? '#414141' : '#dde1e7',
    'textLink-foreground': dark ? '#4daafc' : '#006ab1', 'testing-iconPassed': dark ? '#73c991' : '#238636', 'editorWarning-foreground': dark ? '#cca700' : '#8a6500',
    errorForeground: dark ? '#f48771' : '#a1260d', 'progressBar-background': '#0078d4', 'toolbar-hoverBackground': dark ? '#ffffff18' : '#0000000d',
    'list-hoverBackground': dark ? '#2a2d2e' : '#f0f1f3', 'list-inactiveSelectionBackground': dark ? '#353535' : '#e8ebef',
    'scrollbarSlider-background': '#79797966', 'scrollbarSlider-hoverBackground': '#646464b3',
  };
  if (theme === 'contrast') { variables.contrastActiveBorder = '#f38518'; variables['panel-border'] = '#ffffff'; variables['widget-border'] = '#ffffff'; }
  return `:root { color-scheme:${dark ? 'dark' : 'light'};${Object.entries(variables).map(([key, value]) => `--vscode-${key}:${value};`).join('')} }`;
}
