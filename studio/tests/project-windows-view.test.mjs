import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { ProjectWindowsProvider } from './extensions/studio-workstation/src/project-windows-view';
  export { configureLocalization } from './extensions/studio-workstation/src/localization';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const chinese = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));

function fixture(language = 'en') {
  class Emitter {
    listeners = new Set();
    event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
    fire() { for (const callback of this.listeners) callback(); }
    dispose() { this.listeners.clear(); }
  }
  const vscode = { EventEmitter: Emitter, TreeItem: class {
    constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); }
  }, TreeItemCollapsibleState: { None: 0, Expanded: 2 }, Uri: { parse: value => ({ toString: () => value }) } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name) });
  module.exports.configureLocalization(language === 'en' ? {} : chinese, language);
  return new module.exports.ProjectWindowsProvider();
}

function project(uri = 'file:///project', id = 'project-id') {
  const entries = ['main', 'chat', 'board'].map((entryId, index) => ({ entryId, type: ['workflow', 'conversation', 'kanban'][index], name: entryId }));
  return entries.map(entry => ({ uri, id, folderPath: new URL(uri).pathname, aggregateName: 'My Project', defaultEntry: 'main',
    entries, entryId: entry.entryId, name: entry.name, projectType: entry.type, manifest: { version: '1.2.3' },
    aggregateProjectCard: { icon: 'folder', iconColor: '#112233' }, projectCard: { icon: 'database', iconColor: '#445566' } }));
}
const entryIds = (view, root = view.getChildren()[0]) => Array.from(view.getChildren(root), entry => entry.entryId);

test('Explorer lists only the current project entries, including when another folder has the same project ID', () => {
  const view = fixture(), first = project('file:///first'), current = project('file:///current'), other = project('file:///other', 'other-id');
  const catalog = [...first, ...current, ...other];
  view.update(catalog, current[1]);
  const roots = view.getChildren();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].uri, 'file:///current');
  assert.deepEqual(entryIds(view), ['main', 'chat', 'board']);
  assert.ok(view.getChildren(roots[0]).every(entry => entry.uri === 'file:///current'));
  assert.deepEqual(Array.from(view.getChildren({ ...first[0], aggregateNode: true })), []);
  assert.deepEqual(Array.from(view.getChildren(current[0])), []);
  assert.equal(catalog.length, 9, 'the resource catalog remains complete');
  view.dispose();
});

test('focusing tools, the Assistant, or ordinary files preserves the current project and avoids redundant refreshes', () => {
  const view = fixture(), first = project('file:///first'), current = project('file:///current');
  let refreshes = 0;
  view.onDidChangeTreeData(() => refreshes++);
  view.update([...first, ...current], current[1]);
  view.update([...first, ...current]);
  view.update([...first, ...current], { ...first[0], uri: 'studio-assistant:workspace' });
  view.update([...first, ...current], { ...first[0], uri: 'studio-analysis:workspace', builtin: 'analysis' });
  view.update(structuredClone([...first, ...current]), current[2]);
  assert.equal(refreshes, 1);
  assert.equal(view.getChildren()[0].uri, current[0].uri);
  view.update([...first.map(entry => ({ ...entry, name: 'Other change' })), ...current]);
  assert.equal(refreshes, 1, 'changes to other projects do not repaint this tree');
  view.update([...first, ...current], first[0]);
  assert.equal(refreshes, 2);
  assert.equal(view.getChildren()[0].uri, first[0].uri);
  view.dispose();
});

test('manifest refresh updates entry metadata and removal clears stale project rows', () => {
  const view = fixture(), original = project();
  view.update(original);
  const oldRoot = view.getChildren()[0], oldId = view.getTreeItem(oldRoot).id;
  const updated = original.slice(0, 2).map(entry => ({ ...entry, name: `${entry.name} renamed`, manifest: { version: '1.3.0' } }));
  view.update(updated);
  assert.equal(view.getTreeItem(view.getChildren()[0]).id, oldId);
  assert.equal(view.getTreeItem(view.getChildren()[0]).description, '1.3.0');
  assert.deepEqual(entryIds(view), ['main', 'chat']);
  assert.equal(view.getChildren(oldRoot)[0].name, 'main renamed');
  const fallback = project('file:///fallback');
  view.update(fallback);
  assert.equal(view.getChildren()[0].uri, fallback[0].uri);
  assert.deepEqual(Array.from(view.getChildren(oldRoot)), []);
  view.update([]);
  assert.deepEqual(Array.from(view.getChildren()), []);
  view.dispose();
});

for (const language of ['en', 'zh-cn']) {
  test(`${language}: entries expose an open action, independent icons and types, with the version only on the project`, () => {
    const view = fixture(language), projects = project();
    view.update(projects, projects[1]);
    const root = view.getTreeItem(view.getChildren()[0]);
    assert.equal(root.label, 'My Project');
    assert.equal(root.description, '1.2.3');
    assert.equal(root.collapsibleState, 2);
    assert.equal(root.command, undefined);
    assert.match(decodeURIComponent(root.iconPath.toString()), /#112233/);
    for (const entry of view.getChildren(view.getChildren()[0])) {
      const item = view.getTreeItem(entry);
      assert.equal(item.command.command, 'studio.openProjectWindow');
      assert.equal(item.command.arguments[0], entry);
      assert.equal(item.command.title, language === 'en' ? 'Open Project Window' : '打开项目窗口');
      assert.equal(item.description, (language === 'en' ? ['Workflow', 'Conversation', 'Kanban'] : ['工作流', '对话', '看板'])[projects.indexOf(entry)]);
      assert.equal(item.collapsibleState, 0);
      assert.match(decodeURIComponent(item.iconPath.toString()), /#445566/);
      assert.ok(item.tooltip.includes(entry.folderPath));
    }
    view.dispose();
  });
}

test('a single-entry project still offers its entry as an independently openable row', () => {
  const view = fixture(), [main] = project();
  view.update([main]);
  assert.equal(view.getChildren().length, 1);
  assert.deepEqual(entryIds(view), ['main']);
  assert.equal(view.getTreeItem(view.getChildren(view.getChildren()[0])[0]).command.arguments[0], main);
  view.dispose();
});
