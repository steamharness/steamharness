import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const mocks = {
  'localization-host': '',
  'project-icons': 'export class ProjectIcons { onDidChange() { return { dispose() {} }; } get() {} getAvatarUrl() {} getVersion() {} dispose() {} }',
  workflow: 'export async function activateProject() { return {}; }',
  'workflow-auth': 'export async function activateProjectAccount() { return {}; }',
  'document-preview': 'export function activateDocumentPreviews() {}',
  'start-page': 'export class StudioStartController { dispose() {} }',
  'internal-layer': 'export async function activateInternalLayer() {}',
};
const compiled = await build({ stdin: { contents: `
  export { activate } from './extensions/studio-workstation/src/extension';
  export { openProjectFolder } from './extensions/studio-workstation/src/project-window';
  export { configureLocalization } from './extensions/studio-workstation/src/localization';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
  plugins: [{ name: 'unrelated-activation', setup(plugin) {
    plugin.onResolve({ filter: /^\.\// }, args => {
      const name = args.path.slice(2);
      if (args.importer.endsWith('/src/extension.ts') && Object.hasOwn(mocks, name)) { return { path: name, namespace: 'activation-mock' }; }
    });
    plugin.onLoad({ filter: /.*/, namespace: 'activation-mock' }, args => ({ contents: mocks[args.path], loader: 'ts' }));
  } }] });
const chinese = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));
const uri = value => ({ scheme: new URL(value).protocol.slice(0, -1), path: new URL(value).pathname, fsPath: new URL(value).pathname, toString: () => value });

async function fixture(t, language = 'en') {
  const callbacks = new Map(), storage = new Map(), disposable = { dispose() {} };
  const f = { choice: 'new', dialogs: [], opens: [], warnings: [], errors: [], folders: [uri('file:///projects/demo')] };
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    Uri: { parse: uri },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeWorkspaceFolders: () => disposable, onDidChangeConfiguration: () => disposable,
      fs: { stat: async () => { if (f.missing) { throw new Error('missing'); } } } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showOpenDialog: async () => f.folders,
      showErrorMessage: async message => { f.errors.push(message); }, showWarningMessage: async message => { f.warnings.push(message); },
      showInformationMessage: async (message, options, ...buttons) => {
        f.dialogs.push({ message, options, buttons });
        return f.select ? f.select(buttons) : f.choice === 'new' ? buttons[0] : f.choice === 'current' ? buttons[1] : undefined;
      } },
    commands: { registerCommand: (name, callback) => { callbacks.set(name, callback); return disposable; },
      executeCommand: async (name, ...args) => name === 'vscode.openFolder' ? f.opens.push({ uri: args[0].toString(), options: { ...args[1] } }) : callbacks.get(name)?.(...args) },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), URL });
  module.exports.configureLocalization(language === 'zh-cn' ? chinese : {}, language);
  const context = { extension: { packageJSON: { version: '0.1.0' } }, subscriptions: [],
    globalState: { get: key => storage.get(key), update: async (key, value) => storage.set(key, value) } };
  await module.exports.activate(context, {}, {});
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  return Object.assign(f, { execute: vscode.commands.executeCommand, open: module.exports.openProjectFolder });
}

for (const language of ['en', 'zh-cn']) {
  for (const command of ['studio.openRecentProject', 'studio.openFolder', 'studio.openWorkspace']) {
    for (const choice of ['new', 'current', undefined]) {
      test(`${language}: ${command} respects the ${choice ?? 'cancelled'} window choice`, async t => {
        const f = await fixture(t, language); f.choice = choice;
        const project = { uri: 'vscode-remote://ssh-remote+host/projects/demo.code-workspace', label: 'Remote Project', kind: 'workspace', lastOpened: 1 };
        await f.execute(command, project);
        assert.equal(f.dialogs.length, 1);
        assert.equal(f.dialogs[0].options.modal, true);
        assert.equal(f.dialogs[0].message, language === 'en' ? 'Where would you like to open the project?' : '在何处打开项目？');
        assert.equal(f.dialogs[0].buttons[1], language === 'en' ? 'Open in Current Window' : '在当前窗口打开');
        assert.equal(f.opens.length, choice ? 1 : 0);
        if (choice) {
          assert.deepEqual(f.opens[0], { uri: command === 'studio.openRecentProject' ? project.uri : 'file:///projects/demo',
            options: { forceNewWindow: choice === 'new', forceReuseWindow: choice === 'current' } });
        }
        assert.deepEqual(f.errors, []);
      });
    }
  }
}

test('cancelled pickers and invalid or missing recent projects never show a window-choice dialog', async t => {
  const f = await fixture(t); f.folders = undefined;
  await f.execute('studio.openFolder'); await f.execute('studio.openWorkspace');
  await f.execute('studio.openRecentProject'); await f.execute('studio.openRecentProject', { uri: 'javascript:alert(1)' });
  f.missing = true;
  await f.execute('studio.openRecentProject', { uri: 'file:///missing', label: 'Missing', kind: 'folder', lastOpened: 1 });
  assert.deepEqual(f.opens, []); assert.deepEqual(f.dialogs, []); assert.equal(f.warnings.length, 1);
});

test('a disposed project view cannot open a window after the dialog resolves', async t => {
  const f = await fixture(t);
  let resolve, active = true;
  f.select = buttons => new Promise(done => { resolve = () => done(buttons[0]); });
  const opening = f.open(uri('file:///projects/demo'), () => active);
  active = false; resolve(); await opening;
  assert.deepEqual(f.opens, []);
});
