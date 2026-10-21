import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = '../upstream/vscode/src/vs/workbench/';
const compile = async path => ts.transpileModule(await readFile(new URL(root + path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText;
const [workspaceCode, policyCode] = await Promise.all([
  compile('contrib/studioMode/browser/studioSteamWorkspace.ts'), compile('services/editor/common/editorOpenTarget.ts'),
]);
class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) { listener(value); } }
}
class Disposable {
  items = []; _register(value) { this.items.push(value); return value; }
  dispose() { for (const value of this.items.splice(0).reverse()) { value.dispose(); } }
}
class DisposableStore extends Disposable {
  add(value) { return this._register(value); }
  clear() { super.dispose(); }
}
class RunOnceScheduler {
  constructor(callback) { this.callback = callback; }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(this.callback, 0); }
  dispose() { clearTimeout(this.timer); }
}
class EditorInput {
  constructor(name) { this.name = name; }
  getName() { return this.name; }
  isDirty() { return !!this.dirty; }
}
class WebviewInput extends EditorInput {
  constructor(name, uri) { super(name); this.webview = { providedViewType: 'studio.project', state: JSON.stringify({ projectUri: uri }) }; }
}
const tools = ['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace'].map(id => ({ id, icon: id, view: `studio.${id}` }));
function fixture(t, saved = new Map()) {
  const toDisposable = dispose => ({ dispose });
  const load = (code, common) => {
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: () => new Proxy(common, { get: (target, key) => key in target ? target[key] : () => undefined }) });
    return module.exports;
  };
  const policy = load(policyCode, { toDisposable });
  const createGroup = id => {
    const model = new Emitter(), active = new Emitter(), opening = new Emitter();
    const group = { id, editors: [], activeEditor: undefined, veto: false,
      onDidModelChange: model.event, onDidActiveEditorChange: active.event, onWillOpenEditor: opening.event,
      getEditors: () => group.editors, focus() {},
      openEditor: async (editor, options) => {
        opening.fire({ editor });
        if (!group.editors.includes(editor)) { group.editors.push(editor); }
        if (!options?.inactive && group.activeEditor !== editor) { group.activeEditor = editor; active.fire({ editor }); }
        model.fire();
      },
      closeEditor: async editor => {
        if (group.veto) { return false; }
        group.editors = group.editors.filter(value => value !== editor);
        group.activeEditor = group.editors.at(-1); active.fire({}); model.fire(); return true;
      },
      moveEditors: (entries, target) => {
        target.editors.push(...entries.map(entry => entry.editor)); group.editors = []; group.activeEditor = undefined;
        model.fire(); return true;
      },
    };
    return group;
  };
  const left = createGroup(1), right = createGroup(2), auxiliary = createGroup(3);
  const stateChange = new Emitter(), viewChange = new Emitter(), noEvent = new Emitter();
  const state = { state: { projectUri: 'file:///project', labels: Object.fromEntries(tools.map(tool => [tool.id, tool.id])) }, onDidChangeState: stateChange.event };
  let tabs, active, partVisible;
  const workspaceState = { update: (items, selected) => { tabs = items; active = selected; } };
  const parent = { classList: { toggle() {} }, querySelector: () => undefined };
  const host = { parentElement: parent, hidden: true, getBoundingClientRect: () => ({ width: 600, height: 800 }), remove() {} };
  const part = { groups: [right], activeGroup: right, windowId: 1, whenReady: Promise.resolve(),
    enforcePartOptions: () => toDisposable(() => undefined),
    onDidAddGroup: noEvent.event, onDidRemoveGroup: noEvent.event,
    layout() {}, setVisible: visible => { partVisible = visible; }, dispose() {} };
  const main = { groups: [left], activeGroup: left, windowId: 1, getGroups: () => [left] };
  const groups = { mainPart: main, createEmbeddedEditorPart: () => part,
    getGroup: id => [left, right, auxiliary].find(group => group.id === id), getPart: group => ({ windowId: group === auxiliary ? 2 : 1 }) };
  let visibleView;
  const views = { onDidChangeViewVisibility: viewChange.event, openView: async id => { visibleView = id; viewChange.fire({ id, visible: true }); } };
  const layout = { onDidChangePartVisibility: noEvent.event, isVisible: () => true };
  const storage = { get: key => saved.get(key), getObject: key => saved.get(key), store: (key, value) => saved.set(key, structuredClone(value)) };
  const exports = load(workspaceCode, { Disposable, DisposableStore, RunOnceScheduler, toDisposable, EditorInput, WebviewInput,
    $: () => host, append: () => host, clearNode() {}, getWindow: () => ({ ResizeObserver: class { observe() {} disconnect() {} } }),
    StorageScope: { WORKSPACE: 1 }, StorageTarget: { MACHINE: 1 }, EditorsOrder: {}, GroupsOrder: {}, Parts: { AUXILIARYBAR_PART: 'auxiliary' },
    studioModeState: state, studioSteamToolDefinitions: tools, studioSteamWorkspaceState: workspaceState,
    registerEditorOpenTarget: policy.registerEditorOpenTarget,
  });
  const workspace = new exports.StudioSteamWorkspace(parent, groups, views, { getViewContainerByViewId: () => ({}) }, layout, storage);
  t.after(() => workspace.dispose());
  return { workspace, policy, left, right, auxiliary, state, saved, viewChange, host,
    get tabs() { return tabs; }, get active() { return active; }, get partVisible() { return partVisible; }, get visibleView() { return visibleView; } };
}

test('Steam reserves only the selected project and routes every other editor and explicit first-column target to tools', async t => {
  const f = fixture(t), project = new WebviewInput('Project', 'file:///project');
  await f.left.openEditor(project); await f.workspace.activate();
  assert.equal(f.policy.getEditorOpenTarget(project, f.right), f.left);
  for (const name of ['Account', 'Settings', 'File', 'Preview', 'Store']) {
    const editor = new EditorInput(name);
    for (const preferred of [undefined, 1, f.left, -2, -3, -4]) { assert.equal(f.policy.getEditorOpenTarget(editor, preferred), f.right); }
  }
  assert.equal(f.policy.getEditorOpenTarget(new WebviewInput('Other project', 'file:///other'), f.left), f.right);
  assert.equal(f.policy.getEditorOpenTarget(new EditorInput('Auxiliary window'), f.auxiliary), undefined);
  assert.equal(f.left.activeEditor, project);
  await f.workspace.deactivate(f.left);
  assert.equal(f.policy.getEditorOpenTarget(new EditorInput('IDE file'), f.left), undefined);
});

test('tool tabs deduplicate and switch alongside retained native inputs; closing selects the neighboring tab', async t => {
  const f = fixture(t); await f.workspace.activate();
  assert.equal(f.tabs.length, 0);
  await f.workspace.openTool('kv'); await f.workspace.openTool('info'); await f.workspace.openTool('kv');
  assert.deepEqual(Array.from(f.tabs, tab => tab.id), ['kv', 'info']);
  const editor = new EditorInput('Account'); await f.right.openEditor(editor);
  const editorId = f.active;
  assert.ok(editorId.startsWith('editor:')); assert.equal(f.partVisible, true);
  await f.workspace.select('kv'); assert.equal(f.partVisible, false);
  await f.workspace.select(editorId); assert.equal(f.right.activeEditor, editor); assert.equal(f.partVisible, true);
  await f.workspace.close('info'); assert.equal(f.active, editorId);
  await f.workspace.close(editorId); assert.equal(f.active, 'kv'); assert.equal(f.partVisible, false);
  await f.workspace.close('kv'); assert.equal(f.tabs.length, 0); assert.equal(f.visibleView, 'studio.steamTools');
});

test('native close veto preserves dirty tabs and returning to IDE transfers the exact unsaved input', async t => {
  const f = fixture(t); await f.workspace.activate();
  const editor = new EditorInput('Unsaved'); editor.dirty = true;
  await f.right.openEditor(editor); f.right.veto = true;
  const id = f.active; await f.workspace.close(id);
  assert.equal(f.active, id); assert.equal(f.tabs.find(tab => tab.id === id).dirty, true);
  await f.workspace.deactivate(f.left);
  assert.ok(f.left.editors.includes(editor)); assert.equal(editor.isDirty(), true);
  assert.equal(f.right.editors.length, 0); assert.equal(f.host.hidden, true);
});

test('tool order and selection restore after reload and externally opened views join the same workspace', async t => {
  const saved = new Map(), first = fixture(t, saved); await first.workspace.activate();
  await first.workspace.openTool('knowledge'); await first.workspace.openTool('kv');
  const second = fixture(t, saved); await second.workspace.activate();
  assert.deepEqual(Array.from(second.tabs, tab => tab.id), ['knowledge', 'kv']); assert.equal(second.active, 'kv');
  second.viewChange.fire({ id: 'studio.trace', visible: true });
  assert.equal(second.active, 'trace'); assert.equal(second.tabs.length, 3);
});
