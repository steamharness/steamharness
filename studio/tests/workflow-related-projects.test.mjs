import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { IMPORTED_PROJECTS_KEY } from '../extensions/studio-workstation/src/projects.ts';

const ids = ['294b1eec-23fa-42cf-9fd3-2417f71c0570', '615e6cf6-b40a-456a-8d19-b71c63454c7a', '4d8d3580-6356-42b1-a8f0-2a14b0a7b955'];
const project = (name, id = ids[0], projectType = 'workflow') => ({ id, name, projectType, uri: `file:///${name}`, folderPath: `/${name}`, fields: [], entrypoints: [] });
const imported = (name, id = ids[1]) => ({ id, name, uri: `file:///${name}` });
const manifest = (name, id = ids[0], relatedProjects = []) => ({ id, name, steamHarness: { projectInfo: { relatedProjects } } });
const relation = (alias = 'notes', projectId = ids[1]) => ({ alias, projectId });
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-related-projects-view.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], write: false });

function fixture(t, { files = new Map(), state = new Map([[IMPORTED_PROJECTS_KEY, []]]), discover, read, language = 'en', mockTimers = false, icons } = {}) {
  if (mockTimers) { t.mock.timers.enable({ apis: ['setTimeout'] }); }
  const commands = new Map(), opened = [], warnings = [], errors = [], output = [], view = { dispose() {} };
  const disposable = { dispose() {} };
  let warningChoice, folderChoice, focused;
  const uri = value => ({ toString: () => value, path: new URL(value).pathname, fsPath: new URL(value).pathname });
  const vscode = {
    env: { language },
    EventEmitter: class { event() {} fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class { constructor(id) { this.id = id; } },
    Uri: { parse: uri, joinPath: (root, ...parts) => uri(`${root.toString()}/${parts.join('/')}`) },
    window: { createTreeView: () => view, onDidChangeWindowState: callback => { focused = callback; return disposable; },
      showWarningMessage: async (...args) => { warnings.push(args); return warningChoice; },
      showOpenDialog: async () => folderChoice ? [uri(folderChoice)] : undefined,
      showErrorMessage: async message => { errors.push(message); },
    },
    workspace: { fs: { readFile: async target => {
      const content = read ? await read(target.toString()) : files.get(target.toString());
      if (content === undefined) { throw new Error('Not found'); }
      return new TextEncoder().encode(JSON.stringify(content));
    } } },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
      executeCommand: async (id, target, options) => opened.push({ id, uri: target.toString(), options }),
    },
  };
  const context = { subscriptions: [], globalState: { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), TextDecoder, URL, setTimeout, clearTimeout });
  const provider = new module.exports.RelatedProjectsView(context, { appendLine: line => output.push(line) },
    async root => (discover ? await discover(root.toString()) : [root.toString()]).map(uri), icons);
  t.after(() => provider.dispose());
  return { provider, state, commands, opened, warnings, errors, output, view,
    selectImport: (folder, action = "Import Project") => { warningChoice = action; folderChoice = folder; },
    focus: async () => {
      focused({ focused: true });
      t.mock.timers.tick(350);
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('an imported related project opens its verified folder in a new window', async t => {
  const state = new Map([[IMPORTED_PROJECTS_KEY, [imported('Notes')]]]);
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])], ['file:///Notes/package.json', manifest('Notes', ids[1])]]);
  const { provider, commands, opened, warnings, view } = fixture(t, { state, files });
  await provider.update([project('Owner')]);
  assert.equal(view.title, 'Related Projects');
  assert.equal(view.description, 'Owner');
  const item = provider.getChildren()[0], tree = provider.getTreeItem(item);
  assert.deepEqual([tree.label, tree.description, tree.contextValue], ['notes', 'Notes', 'studio.relatedProjectImported']);
  await commands.get('studio.openRelatedProject')(item);
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ id: 'vscode.openFolder', uri: 'file:///Notes', options: { forceNewWindow: true } }]);
  assert.deepEqual(warnings, []);
});

test('downloaded roots bind their own dependency version instead of another imported copy of its UUID', async t => {
  const root = project('Board-1.0.0');
  const oldNotes = { ...imported('Notes-1.0.0'), version: '1.0.0', downloadRootUri: root.uri };
  const newNotes = { ...imported('Notes-2.0.0'), version: '2.0.0', downloadRootUri: 'file:///Board-2.0.0' };
  const state = new Map([[IMPORTED_PROJECTS_KEY, [newNotes, oldNotes, { ...imported('Board-1.0.0', root.id), version: '1.0.0', downloadRootUri: root.uri }]]]);
  const files = new Map([[`${root.uri}/package.json`, manifest(root.name, root.id, [relation()])],
    [`${oldNotes.uri}/package.json`, { ...manifest(oldNotes.name, oldNotes.id), version: oldNotes.version }],
    [`${newNotes.uri}/package.json`, { ...manifest(newNotes.name, newNotes.id), version: newNotes.version }]]);
  const { provider } = fixture(t, { state, files });
  await provider.update([root]);
  assert.equal(provider.getChildren()[0].imported.uri, oldNotes.uri);
  assert.equal(provider.getTreeItem(provider.getChildren()[0]).description, 'Notes-1.0.0 \u00b7 1.0.0');
  assert.deepEqual(JSON.parse(JSON.stringify(await provider.bindings(root))), [{ alias: 'notes', projectDir: '/Notes-1.0.0' }]);
  files.delete(`${oldNotes.uri}/package.json`);
  assert.deepEqual(JSON.parse(JSON.stringify(await provider.bindings(root))), []);
});

test('downloaded dependencies resolve back to the root of their own downloaded group', async t => {
  const root = { ...imported('Board-1.0.0', ids[0]), version: '1.0.0', downloadRootUri: 'file:///Board-1.0.0' };
  const otherRoot = { ...imported('Board-2.0.0', ids[0]), version: '2.0.0', downloadRootUri: 'file:///Board-2.0.0' };
  const notes = { ...project('Notes-1.0.0', ids[1]), version: '1.0.0', downloadRootUri: root.uri };
  const state = new Map([[IMPORTED_PROJECTS_KEY, [otherRoot, root, notes]]]);
  const files = new Map([
    [`${notes.uri}/package.json`, { ...manifest(notes.name, notes.id, [relation('board', root.id)]), version: notes.version }],
    [`${root.uri}/package.json`, { ...manifest(root.name, root.id), version: root.version }],
    [`${otherRoot.uri}/package.json`, { ...manifest(otherRoot.name, otherRoot.id), version: otherRoot.version }],
  ]);
  const { provider } = fixture(t, { state, files });
  await provider.update([notes]);
  assert.equal(provider.getChildren()[0].imported.uri, root.uri);
  assert.deepEqual(JSON.parse(JSON.stringify(await provider.bindings(notes))), [{ alias: 'board', projectDir: '/Board-1.0.0' }]);
  files.delete(`${root.uri}/package.json`);
  assert.deepEqual(JSON.parse(JSON.stringify(await provider.bindings(notes))), []);
});

test('manually restoring a missing downloaded dependency preserves the group version binding', async t => {
  const root = project('Board-1.0.0');
  const pinned = { ...imported('Missing-1.0.0'), version: '1.0.0', downloadRootUri: root.uri };
  const state = new Map([[IMPORTED_PROJECTS_KEY, [pinned, { ...root, version: '1.0.0', downloadRootUri: root.uri }]]]);
  const files = new Map([[`${root.uri}/package.json`, manifest(root.name, root.id, [relation()])],
    ['file:///Restored/package.json', { ...manifest('Restored', pinned.id), version: pinned.version }]]);
  const { provider, commands, opened, selectImport } = fixture(t, { state, files });
  await provider.update([root]); selectImport('file:///Restored');
  await commands.get('studio.openRelatedProject')(provider.getChildren()[0]);
  await commands.get('studio.refreshRelatedProjects')();
  assert.equal(opened[0].uri, 'file:///Restored');
  assert.equal(provider.getChildren()[0].imported?.uri, 'file:///Restored');
  assert.equal(state.get(IMPORTED_PROJECTS_KEY).find(entry => entry.uri === 'file:///Restored').downloadRootUri, root.uri);
});

test('restoring a downloaded dependency cannot substitute a different version of the same UUID', async t => {
  const root = project('Board-1.0.0');
  const pinned = { ...imported('Missing-1.0.0'), version: '1.0.0', downloadRootUri: root.uri };
  const state = new Map([[IMPORTED_PROJECTS_KEY, [pinned, { ...root, version: '1.0.0', downloadRootUri: root.uri }]]]);
  const files = new Map([[`${root.uri}/package.json`, manifest(root.name, root.id, [relation()])],
    ['file:///Other/package.json', { ...manifest('Other', pinned.id), version: '2.0.0' }]]);
  const { provider, commands, opened, warnings, selectImport } = fixture(t, { state, files });
  await provider.update([root]); selectImport('file:///Other');
  await commands.get('studio.openRelatedProject')(provider.getChildren()[0]);
  assert.equal(opened.length, 0);
  assert.match(warnings.at(-1)[0], /version/);
  assert.equal(state.get(IMPORTED_PROJECTS_KEY).some(entry => entry.uri === 'file:///Other'), false);
});

test('imported relations use the detected project type while missing imports keep their link icon', async t => {
  const state = new Map([[IMPORTED_PROJECTS_KEY, [imported('Notes')]]]);
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation(), relation('missing', ids[2])])],
    ['file:///Notes/package.json', manifest('Notes', ids[1])]]);
  const { provider } = fixture(t, { state, files, icons: { resolveMany: async uris => uris.map(uri => ({ uri, projectType: 'conversation' })) } });
  await provider.update([project('Owner')]);
  assert.deepEqual(Array.from(provider.getChildren(), item => provider.getTreeItem(item).iconPath.id), ['comment-discussion', 'link']);
});

for (const [language, expected] of [['en', 'English notes'], ['zh-cn', 'Chinese notes'], ['fr', 'English notes']]) {
  test(`related project labels resolve ${language} localized names from the current manifest`, async t => {
    const state = new Map([[IMPORTED_PROJECTS_KEY, [imported('Notes')]]]);
    const notes = { ...manifest('Default notes', ids[1]), steamHarness: { projectInfo: { localizedNames: { EN: 'English notes', 'zh-cn': 'Chinese notes' } } } };
    const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])], ['file:///Notes/package.json', notes]]);
    const { provider } = fixture(t, { files, state, language });
    await provider.update([project('Owner')]);
    assert.equal(provider.getTreeItem(provider.getChildren()[0]).description, expected);
  });
}

test('existing imported folders migrate from recent aggregate roots and survive clearing recent history', async t => {
  const state = new Map([['studio.recentProjects', [{ uri: 'file:///aggregate', label: 'Aggregate', kind: 'folder', lastOpened: 1 }]]]);
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])], ['file:///aggregate/Notes/package.json', manifest('Notes', ids[1])]]);
  const first = fixture(t, { state, files, discover: root => root === 'file:///aggregate' ? ['file:///aggregate/Notes'] : [] });
  await first.provider.update([project('Owner')]);
  assert.equal(first.provider.getChildren()[0].imported.uri, 'file:///aggregate/Notes');
  state.set('studio.recentProjects', []); first.provider.dispose();
  const second = fixture(t, { state, files });
  await second.provider.update([project('Owner')]);
  await second.commands.get('studio.openRelatedProject')(second.provider.getChildren()[0]);
  assert.equal(second.opened[0].uri, 'file:///aggregate/Notes');
});

test('missing imports show the import prompt and cancellation leaves the current window intact', async t => {
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])]]);
  const { provider, commands, warnings, opened } = fixture(t, { files });
  await provider.update([project('Owner')]);
  const item = provider.getChildren()[0];
  assert.equal(provider.getTreeItem(item).description, "Not imported");
  await commands.get('studio.openRelatedProject')(item);
  assert.deepEqual([warnings.length, warnings[0][1], opened.length], [1, "Import Project", 0]);
  assert.match(warnings[0][0], /notes.*has not been imported/);
});

test('importing a matching directory records it and opens it in a new window', async t => {
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])], ['file:///Notes/package.json', manifest('Notes', ids[1])]]);
  const { provider, commands, state, opened, selectImport } = fixture(t, { files });
  await provider.update([project('Owner')]); selectImport('file:///Notes');
  await commands.get('studio.openRelatedProject')(provider.getChildren()[0]);
  await commands.get('studio.refreshRelatedProjects')();
  assert.deepEqual([opened[0].uri, opened[0].options.forceNewWindow, state.get(IMPORTED_PROJECTS_KEY).some(entry => entry.id === ids[1]),
    provider.getChildren()[0].imported.uri], ['file:///Notes', true, true, 'file:///Notes']);
});

test('a mismatched import and a stale recorded UUID cannot open a different project', async t => {
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])], ['file:///Notes/package.json', manifest('Notes', ids[2])]]);
  const state = new Map([[IMPORTED_PROJECTS_KEY, [imported('Notes')]]]);
  const { provider, commands, opened, warnings, selectImport } = fixture(t, { files, state });
  await provider.update([project('Owner')]); selectImport('file:///Notes');
  assert.equal(provider.getChildren()[0].imported, undefined);
  await commands.get('studio.openRelatedProject')(provider.getChildren()[0]);
  assert.equal(opened.length, 0);
  assert.match(warnings[1][0], /UUID.*does not match/);
});

test('opening rechecks identity and falls back to an available imported copy of the same project', async t => {
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])], ['file:///Notes/package.json', manifest('Notes', ids[1])],
    ['file:///Copy/package.json', manifest('Copy', ids[1])]]);
  const state = new Map([[IMPORTED_PROJECTS_KEY, [imported('Notes'), imported('Copy')]]]);
  const { provider, commands, opened } = fixture(t, { files, state });
  await provider.update([project('Owner')]);
  files.set('file:///Notes/package.json', manifest('Different', ids[2]));
  await commands.get('studio.openRelatedProject')(provider.getChildren()[0]);
  assert.equal(opened[0].uri, 'file:///Copy');
});

test('project switches and disposal prevent late manifest reads from replacing the related list', async t => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const { provider } = fixture(t, { read: uri => uri === 'file:///Slow/package.json' ? slow : manifest('Fast', ids[2], [relation('fast')]) });
  const first = project('Slow'), second = project('Fast', ids[2], 'conversation');
  const pending = provider.update([first, second], first);
  const switched = provider.update([first, second], second);
  finish(manifest('Slow', ids[0], [relation('slow')])); await Promise.all([pending, switched]);
  assert.equal(provider.getChildren()[0].alias, 'fast');
  const closing = provider.update([first], first); provider.dispose(); await closing;
  assert.equal(provider.getChildren().length, 0);
});

test('returning from another window refreshes new imports and all supported types are registered', async t => {
  const files = new Map([['file:///Owner/package.json', manifest('Owner', ids[0], [relation()])], ['file:///Notes/package.json', manifest('Notes', ids[1])]]);
  const { provider, state, focus, commands } = fixture(t, { files, mockTimers: true });
  const projects = [project('Owner'), project('Notes', ids[1], 'conversation'), project('Board', ids[2], 'kanban')];
  await provider.update(projects, projects[0]);
  assert.equal(state.get(IMPORTED_PROJECTS_KEY).length, 3);
  await provider.update([projects[0]], projects[0]);
  state.set(IMPORTED_PROJECTS_KEY, []); await commands.get('studio.refreshRelatedProjects')();
  assert.equal(provider.getChildren()[0].imported, undefined);
  state.set(IMPORTED_PROJECTS_KEY, [...state.get(IMPORTED_PROJECTS_KEY), imported('Notes')]);
  await focus();
  assert.equal(provider.getChildren()[0].imported.uri, 'file:///Notes');
  await provider.update([{ ...projects[0], assistant: { standalone: true } }]);
  assert.equal(provider.getChildren().length, 0);
});

test('runtime bindings use only imported folders with matching current UUIDs and refresh after import', async t => {
  const owner = project('Owner');
  const files = new Map([
    ['file:///Owner/package.json', manifest('Owner', ids[0], [relation('notes'), relation('missing', ids[2])])],
    ['file:///Moved/package.json', manifest('Moved', ids[2])],
    ['file:///Notes/package.json', manifest('Notes', ids[1])],
  ]);
  const state = new Map([[IMPORTED_PROJECTS_KEY, [imported('Gone'), imported('Moved')]]]);
  const { provider } = fixture(t, { files, state });
  await provider.update([owner], owner);
  assert.deepEqual(Array.from(await provider.bindings(owner)), []);
  state.set(IMPORTED_PROJECTS_KEY, [imported('Notes')]);
  assert.equal(JSON.stringify(await provider.bindings(owner)), JSON.stringify([{ alias: 'notes', projectDir: '/Notes' }]));
  files.set('file:///Notes/package.json', manifest('Changed', ids[2]));
  assert.deepEqual(Array.from(await provider.bindings(owner)), []);
});
