import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const native = new URL('../upstream/vscode/src/vs/workbench/', import.meta.url);
const ConfigurationTarget = { USER_LOCAL: 3, USER_REMOTE: 4, WORKSPACE: 5, WORKSPACE_FOLDER: 6 };

// Execute the actual service methods with boundary services replaced; no Electron window is needed.
async function loadClass(file, name, globals = {}) {
  const source = await readFile(new URL(file, native), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
  const members = declaration.members.filter(node => !ts.isConstructorDeclaration(node) && !ts.isPropertyDeclaration(node));
  const text = `class ${name} { ${members.map(node => node.getText(ast)).join('\n')} }`;
  const javascript = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  runInNewContext(`${javascript}\nmodule.exports = ${name};`, { module, ConfigurationTarget, ...globals });
  return module.exports;
}

const Service = await loadClass('services/preferences/browser/preferencesService.ts', 'PreferencesService');

function fixture() {
  const calls = [], service = new Service();
  service.userDataProfileService = { currentProfile: { settingsResource: 'user-settings' } };
  service.commandService = { executeCommand: async (id, options) => { calls.push({ id, options }); } };
  service.openSettingsJson = async (resource, options) => { calls.push({ resource, options }); return 'json-pane'; };
  service.getEditableSettingsURI = async (target, folderUri) => `${target}:${folderUri ?? ''}`;
  return { service, calls };
}

test('native settings commands and preference dialogs use the Studio tab, including query navigation', async () => {
  const { service, calls } = fixture();
  await service.openSettings({ query: 'editor.fontSize' });
  assert.equal(calls[0].id, 'studio.openSettings'); assert.equal(calls[0].options.query, 'editor.fontSize');
  assert.equal(calls[0].options.section, 'general'); assert.equal(calls[0].options.target, 'user');
  await service.openPreferences(); assert.equal(calls[1].id, 'studio.openSettings');
  await service.openSettings2({ target: ConfigurationTarget.WORKSPACE });
  assert.equal(calls[2].options.section, 'editor'); assert.equal(calls[2].options.target, 'workspace');
});

test('explicit JSON commands remain JSON and folder/remote settings retain their resources', async () => {
  const { service, calls } = fixture();
  assert.equal(await service.openSettings({ jsonEditor: true }), 'json-pane'); assert.equal(calls[0].resource, 'user-settings');
  await service.openSettings2({ target: ConfigurationTarget.WORKSPACE_FOLDER, folderUri: 'folder' });
  assert.equal(calls[1].resource, `${ConfigurationTarget.WORKSPACE_FOLDER}:folder`);
  await service.openSettings2({ target: ConfigurationTarget.USER_REMOTE });
  assert.equal(calls[2].resource, `${ConfigurationTarget.USER_REMOTE}:`);
  assert.ok(calls.every(call => !call.id));
});

for (const name of ['PreferencesEditorInputSerializer', 'SettingsEditor2InputSerializer']) {
  test(`${name} restores the Studio tab instead of reviving the native settings UI`, async () => {
    const calls = [], IPreferencesService = Symbol('preferences');
    const Serializer = await loadClass('contrib/preferences/browser/preferences.contribution.ts', name, { IPreferencesService, onUnexpectedError: error => { throw error; } });
    const serializer = new Serializer();
    assert.equal(serializer.canSerialize({}), false);
    const result = serializer.deserialize({ invokeFunction: callback => callback({ get: id => {
      assert.equal(id, IPreferencesService);
      return { openSettings: async options => { calls.push(options); } };
    } }) });
    assert.equal(result, undefined); assert.equal(calls[0].jsonEditor, false);
  });
}
