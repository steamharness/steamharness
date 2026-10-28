import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { register } from 'tsx/esm/api';
import { createRequire } from 'node:module';
register();
const require = createRequire(import.meta.url);
const { projectInfoItems } = await import('../extensions/studio-workstation/src/workflow-info.ts');

const project = (name = 'Example', projectType = 'workflow') => ({
  id: '294b1eec-23fa-42cf-9fd3-2417f71c0570',name,aggregateName:'Aggregate',projectType,entryId:'main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:projectType,root:'.',entry:projectType==='kanban'?'index.html':'index.ts',databases:[]}],databases:[], uri: `file:///${name}`, folderPath: `/${name}`, fields: [], entrypoints: [],
});
const fields = items => Object.fromEntries(items.flatMap(item => [[item.id, item], ...Object.entries(fields(item.children ?? []))]));
const values = items => Object.fromEntries(Object.values(fields(items)).filter(item => item.value !== undefined).map(item => [item.id, item.value]));

test('project declarations use the Desktop manifest fields and preserve extended identifiers', () => {
  const items = projectInfoItems(project(), { name: '@example/project', version: '1.2.3', description: 'Description',
    steamHarness: { projectInfo: {
      declarations: ['multilingual', 'multiplatform', 'custom-declaration', 'constructor'],
      localizedNames: { 'zh-CN': '\u793a\u4f8b', en: 'Example', ja: '\u4f8b' },
      platformSupport: { mode: 'specific', platforms: ['macos', 'web', 'linux', 'constructor'] },
    } },
  });
  assert.deepEqual(values(items), {
    name: '@example/project', type: 'Workflow', version: '1.2.3', uuid: project().id, path: '/Example', description: 'Description',
    'declaration:multilingual': "Declared", 'declaration:multiplatform': "Declared", 'declaration:custom-declaration': "Declared",
    'declaration:constructor': "Declared", 'name:zh-CN': '\u793a\u4f8b', 'name:en': 'Example', 'name:ja': '\u4f8b',
    'platform-mode': "Specific platforms", 'platform:macos': "Supported", 'platform:web': "Supported", 'platform:linux': "Supported",
    'platform:constructor': "Supported", 'window:main:id':'main','window:main:type':'Workflow','window:main:path':'./index.ts',
  });
  assert.equal(fields(items)['declaration:multilingual'].label, "Multiple languages");
  assert.equal(fields(items)['declaration:constructor'].label, 'constructor');
  assert.equal(fields(items)['platform:constructor'].label, 'constructor');
});

test('entry windows and empty database requirements are displayed for all types', () => {
  for (const type of ['workflow', 'conversation', 'kanban']) {
    const items = projectInfoItems(project('Example', type), {});
    assert.equal(fields(items)['databases:empty'].label, 'Not declared');assert.equal(values(items)['window:main:id'],'main');
    assert.equal(values(items).type, type[0].toUpperCase() + type.slice(1));
    assert.equal(fields(items)['declarations:empty'].label, "Not declared");
    assert.equal(fields(items).entrypoints, undefined);
  }
});

test('database requirements show host, binding and scoped permissions for the selected entry', () => {
  const current = project(); current.databases = [{ alias:'notes',host:'server',permissions:{kv:{read:{mode:'all'},write:{mode:'none'}},knowledge:{read:{mode:'prefixes',prefixes:['public/']},write:{mode:'none'}}} }];
  const items = projectInfoItems(current, {}), data = values(items);
  assert.equal(data['database:notes:host'],'Server');assert.equal(data['database:notes:binding'],'Not bound');
  assert.equal(data['database:notes:kv-read'],'All');assert.equal(data['database:notes:kv-write'],'Not allowed');
  assert.equal(data['database:notes:knowledge-read'],'Prefixes: public/');
});

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-info-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
function fixture(t, read) {
  const commands = new Map(), contexts = new Map(), opened = [], copied = [], messages = [];
  const disposable = { dispose() {} };
  let pick, receive;
  const uri = value => ({ toString: () => value });
  const view = { visible: true, onDidDispose: () => disposable, onDidChangeVisibility: () => disposable,
    webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value,
      postMessage: async message => { messages.push(message); return true; },
      onDidReceiveMessage: callback => { receive = callback; return disposable; } } };
  const vscode = {
    Uri: { parse: uri, joinPath: (root, ...parts) => uri(`${root.toString()}/${parts.join('/')}`) },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    window: { registerWebviewViewProvider: () => disposable, showQuickPick: async entries => entries.find(entry => entry.project.uri === pick) },
    workspace: { fs: { readFile: async target => new TextEncoder().encode(JSON.stringify(await read(target.toString()))) } },
    env: { language: 'en', clipboard: { writeText: async value => copied.push(value) } },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
      executeCommand: async (id, ...args) => { if (id === 'setContext') { contexts.set(...args); } else { opened.push([id, ...args]); } },
    },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), TextDecoder, crypto });
  const provider = new module.exports.InfoView({ subscriptions: [], extensionUri: uri('/extension') }, {
    getVersionStatus: () => ({ status: 'unpublished', canDownload: false }), onDidChangeVersions: () => disposable,
  });
  provider.resolveWebviewView(view);
  t.after(() => provider.dispose());
  return { provider, contexts, view, commands, copied, opened, messages, send: message => receive(message),
    state: () => messages.findLast(message => message.type === 'info-state'), choose: value => { pick = value; } };
}

test('ordinary workspaces and the independent assistant never expose the information tab', async t => {
  const { provider, contexts, state } = fixture(t, () => ({}));
  await provider.update([{ ...project('Assistant', 'conversation'), assistant: { standalone: true } }, project('Other', 'other')]);
  assert.deepEqual([...contexts], [['studio.projectInfoAvailable', false], ['studio.projectInfoMultipleProjects', false]]);
  assert.equal(state().items.length, 0);
  assert.equal(state().project, undefined);
});

test('late reads and disposal do not overwrite the selected project', async t => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const { provider, view, state, messages } = fixture(t, uri => uri.includes('/Slow/') ? slow : { name: 'Fast', version: '2.0.0' });
  assert.equal(view.title, 'Information');
  const first = project('Slow'), second = project('Fast', 'kanban');
  const pending = provider.update([first, second], first);
  assert.equal(state().items[0].id, 'loading');
  await provider.update([first, second], second);
  finish({ name: 'Slow', version: '1.0.0' }); await pending;
  assert.deepEqual([view.description, values(state().items).name, values(state().items).version], ['Aggregate / Fast', 'Fast', '2.0.0']);
  assert.equal(state().project.name, 'Aggregate');
  const closing = provider.update([first], first); provider.dispose(); const count = messages.length; await closing;
  assert.equal(messages.length, count);
});

test('project selection persists until the active project changes and source opens the selected project', async t => {
  const { provider, choose, commands, opened, copied, contexts, state } = fixture(t, uri => ({ name: uri.split('/').at(-2) }));
  const first = project('First'), second = project('Second', 'conversation');
  await provider.update([first, second], first);
  choose(second.uri); await commands.get('studio.selectInfoProject')();
  await provider.update([first, second], first);
  assert.equal(values(state().items).name, 'Second');
  await commands.get('studio.openInfoProjectSource')();
  assert.equal(opened[0][1], second);
  const uuid = fields(state().items).uuid;
  await commands.get('studio.copyProjectInfoValue')(uuid);
  assert.deepEqual(copied, [second.id]);
  assert.equal(contexts.get('studio.projectInfoMultipleProjects'), true);
  await provider.update([first, second], second); await provider.update([first, second], first);
  assert.equal(values(state().items).name, 'First');
});

test('manifest changes refresh the information and read failures remain visible', async t => {
  let version = '1.0.0', failed = false;
  const { provider, state } = fixture(t, () => { if (failed) { throw new Error('Manifest unavailable'); } return { name: 'Example', version }; });
  await provider.update([project()], project());
  version = '2.0.0'; await provider.update([project()], project());
  assert.equal(values(state().items).version, version);
  failed = true; await provider.update([project()], project());
  assert.equal(state().items[0].id, 'error');
  assert.match(state().items[0].value, /Manifest unavailable/);
});

test('webview copies only current declared values and acknowledges successful clipboard writes', async t => {
  const { provider, state, send, copied, messages, view } = fixture(t, () => ({}));
  await provider.update([project()]);
  const current = state();
  await send({ type: 'copy', generation: current.generation - 1, projectUri: current.project.uri, itemId: 'uuid' });
  await send({ type: 'copy', generation: current.generation, projectUri: 'file:///Other', itemId: 'uuid' });
  await send({ type: 'copy', generation: current.generation, projectUri: current.project.uri, itemId: 'missing', text: 'untrusted value' });
  assert.deepEqual(copied, []);
  await send({ type: 'copy', generation: current.generation, projectUri: current.project.uri, itemId: 'uuid' });
  assert.deepEqual(copied, [project().id]);
  assert.equal(messages.at(-1).type, 'info-copied');
  const count = messages.length; await send({ type: 'ready' });
  assert.equal(messages.length, count + 1);
  assert.match(view.webview.html, /Content-Security-Policy/);
  assert.match(view.webview.html, /info-ui\.js/);
});

test('refreshing the same project keeps its readable values while the manifest is loading', async t => {
  let finish, delay = false;
  const slow = new Promise(resolve => { finish = resolve; });
  const { provider, state } = fixture(t, () => delay ? slow : { name: 'Example', version: '1.0.0' });
  await provider.update([project()]);
  delay = true;
  const loading = provider.update([project()]);
  assert.equal(values(state().items).version, '1.0.0');
  finish({ name: 'Example', version: '2.0.0' }); await loading;
  assert.equal(values(state().items).version, '2.0.0');
});
