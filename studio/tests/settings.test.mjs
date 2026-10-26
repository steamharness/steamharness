import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);

function fixture(workspace = true) {
  const defaults = { 'editor.fontSize': 14, 'editor.tabSize': 4, 'editor.insertSpaces': true, 'editor.wordWrap': 'off', 'files.autoSave': 'off',
    'studio.startPage.enabled': true, 'studio.recentProjects.limit': 12, 'studio.terminal.name': 'Studio', 'studio.project.nodePath': '', 'workbench.colorTheme': 'Dark', 'window.autoDetectColorScheme': true };
  const global = {}, local = {}, writes = [];
  const configuration = prefix => ({
    get: key => { key = prefix ? `${prefix}.${key}` : key; return local[key] ?? global[key] ?? defaults[key]; },
    inspect: key => ({ defaultValue: defaults[key], globalValue: global[key], workspaceValue: local[key] }),
    update: async (key, value, target) => {
      writes.push({ key, value, target });
      const values = target === 2 ? local : global;
      if (value === undefined) { delete values[key]; } else { values[key] = value; }
    },
  });
  const vscode = { ConfigurationTarget: { Global: 1, Workspace: 2 }, env: { language: 'en' }, version: '1.141.0',
    extensions: { all: [{ packageJSON: { contributes: { themes: [{ id: 'Dark', label: 'Dark' }, { id: 'Light', label: 'Light' }] } } }] },
    workspace: { workspaceFolders: workspace ? [{}] : [], getConfiguration: configuration } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id) });
  return { ...module.exports, global, local, writes, vscode };
}

test('settings read the selected scope and identify workspace overrides without changing configuration', () => {
  const f = fixture(); f.global['editor.fontSize'] = 16; f.local['editor.fontSize'] = 18;
  const snapshot = f.settingsState('0.1.0', 'user', [{ id: 'private-provider', title: 'Provider', icon: 'sparkle' }]);
  const font = snapshot.items.find(item => item.key === 'editor.fontSize');
  assert.equal(font.value, 16); assert.equal(font.overridden, true); assert.equal(font.configured, true);
  assert.equal(snapshot.providers[0].title, 'Provider'); assert.equal(snapshot.vscodeVersion, '1.141.0');
  const workspaceFont = f.settingsState('0.1.0', 'workspace', []).items.find(item => item.key === font.key);
  assert.equal(workspaceFont.overridden, false); assert.equal(workspaceFont.value, 18);
  assert.equal(fixture(false).settingsState('0.1.0', 'workspace', []).target, 'user');
  assert.equal(f.writes.length, 0);
});

test('editor writes and resets affect only the selected configuration scope', async () => {
  const f = fixture(); f.global['editor.fontSize'] = 16;
  await f.updateSetting('editor.fontSize', 18, 'workspace', false);
  assert.equal(f.global['editor.fontSize'], 16); assert.equal(f.local['editor.fontSize'], 18);
  await f.updateSetting('editor.fontSize', undefined, 'workspace', true);
  assert.equal(f.global['editor.fontSize'], 16); assert.equal(f.local['editor.fontSize'], undefined);
  assert.equal(f.settingsState('0.1.0', 'workspace', []).items.find(item => item.key === 'editor.fontSize').value, 16);
  await f.updateSetting('studio.terminal.name', 'Project', 'user', false);
  assert.equal(f.global['studio.terminal.name'], 'Project');
});

test('the host rejects unsupported keys, invalid values and invalid workspace writes', async () => {
  const f = fixture();
  for (const [key, value, target] of [
    ['untrusted.key', true, 'user'], ['studio.project.serverUrl', 'https://other.test', 'user'],
    ['studio.recentProjects.limit', 51, 'user'], ['studio.recentProjects.limit', 1.5, 'user'],
    ['editor.fontSize', NaN, 'user'], ['editor.fontSize', Infinity, 'user'], ['editor.fontSize', 0, 'user'],
    ['editor.insertSpaces', 'true', 'user'], ['files.autoSave', 'unknown', 'user'], ['studio.terminal.name', ' ', 'user'],
    ['studio.project.nodePath', 'a\0b', 'user'], ['studio.startPage.enabled', false, 'workspace'], ['editor.fontSize', 12, 'other'],
  ]) { await assert.rejects(f.updateSetting(key, value, target, false)); }
  await assert.rejects(fixture(false).updateSetting('editor.fontSize', 12, 'workspace', false));
  assert.equal(f.writes.length, 0);
});

test('theme selection follows system appearance, keeps installed themes and resets both theme overrides', async () => {
  const f = fixture();
  assert.equal(f.settingsState('0.1.0', 'user', []).items[0].value, f.SYSTEM_THEME);
  await f.updateSetting('workbench.colorTheme', 'Light', 'user', false);
  assert.equal(f.global['workbench.colorTheme'], 'Light'); assert.equal(f.global['window.autoDetectColorScheme'], false);
  await f.updateSetting('workbench.colorTheme', f.SYSTEM_THEME, 'user', false);
  assert.equal(f.global['workbench.colorTheme'], 'Light'); assert.equal(f.global['window.autoDetectColorScheme'], true);
  await assert.rejects(f.updateSetting('workbench.colorTheme', 'Missing', 'user', false));
  await f.updateSetting('workbench.colorTheme', undefined, 'user', true);
  assert.deepEqual(f.global, {});
});

test('restored webview state accepts navigation only and bounds untrusted values', () => {
  const f = fixture();
  const state = f.settingsViewState({ section: 'provider:custom', query: 'a'.repeat(1000), target: 'workspace', scroll: Infinity, accessToken: 'secret', password: 'secret' });
  assert.equal(state.section, 'provider:custom'); assert.equal(state.target, 'workspace'); assert.equal(state.query.length, 512); assert.equal(state.scroll, 0);
  assert.ok(!JSON.stringify(state).includes('secret'));
  assert.equal(f.settingsViewState({ section: '<script>', target: 'invalid', scroll: -1 }).section, 'general');
});
