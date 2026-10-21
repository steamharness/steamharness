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
class MutableDisposable {
  set value(value) { this.current?.dispose(); this.current = value; }
  dispose() { this.current?.dispose(); this.current = undefined; }
}
class RunOnceScheduler {
  constructor(callback) { this.callback = callback; }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(this.callback, 0); }
  dispose() { clearTimeout(this.timer); }
}
class EditorInput {
  disposedEvent = new Emitter();
  onWillDispose = this.disposedEvent.event;
  constructor(name) { this.name = name; }
  getName() { return this.name; }
  isDirty() { return !!this.dirty; }
  isDisposed() { return !!this.disposed; }
  dispose() { this.disposed = true; this.disposedEvent.fire(); }
}
class WebviewInput extends EditorInput {
  constructor(name, uri) { super(name); this.webview = { providedViewType: 'studio.project', state: JSON.stringify({ projectUri: uri }) }; }
}
const tools = [...['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace'].map(id => ({ id, icon: id, view: `studio.${id}` })),
  { id: 'terminal', icon: 'terminal', view: 'terminal' }, { id: 'browser', command: 'simpleBrowser.show' }, { id: 'project', command: 'studio.openProjectInTab' }];
function fixture(t, saved = new Map()) {
  const toDisposable = dispose => ({ dispose });
  const load = (code, common) => {
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: () => new Proxy(common, { get: (target, key) => key in target ? target[key] : () => undefined }) });
    return module.exports;
  };
  const policy = load(policyCode, { toDisposable });
  let activeGroup;
  const createGroup = id => {
    const model = new Emitter(), active = new Emitter(), opening = new Emitter(), closed = new Emitter();
    const group = { id, editors: [], activeEditor: undefined, veto: false,
      onDidModelChange: model.event, onDidActiveEditorChange: active.event, onWillOpenEditor: opening.event,
      onDidCloseEditor: closed.event,
      getEditors: () => group.editors, focus() { activeGroup = group; },
      contains: editor => group.editors.includes(editor),
      openEditor: async (editor, options) => {
        opening.fire({ editor });
        if (!group.editors.includes(editor)) { group.editors.push(editor); }
        if (!options?.inactive && !options?.preserveFocus) { activeGroup = group; }
        if (!options?.inactive && group.activeEditor !== editor) { group.activeEditor = editor; active.fire({ editor }); }
        model.fire();
      },
      closeEditor: async editor => {
        if (group.veto) { return false; }
        group.editors = group.editors.filter(value => value !== editor);
        group.activeEditor = group.editors.at(-1); active.fire({}); model.fire(); closed.fire({ editor }); return true;
      },
      moveEditors: (entries, target) => {
        if (group === target) { return true; }
        for (const { editor } of entries) { if (!target.editors.includes(editor)) { target.editors.push(editor); } }
        group.editors = group.editors.filter(editor => !entries.some(entry => entry.editor === editor));
        group.activeEditor = group.editors.at(-1);
        model.fire(); return true;
      },
    };
    return group;
  };
  const left = createGroup(1), right = createGroup(2), auxiliary = createGroup(3);
  const stateChange = new Emitter(), viewChange = new Emitter(), noEvent = new Emitter(), addedGroup = new Emitter();
  const state = { state: { projectUri: 'file:///project', labels: Object.fromEntries(tools.map(tool => [tool.id, tool.id])) }, onDidChangeState: stateChange.event };
  let tabs, active, partVisible;
  const workspaceState = { update: (items, selected) => { tabs = items; active = selected; } };
  const parent = { classList: { toggle() {} }, querySelector: () => undefined };
  const host = { parentElement: parent, hidden: true, getBoundingClientRect: () => ({ width: 600, height: 800 }), remove() {} };
  const part = { groups: [right], activeGroup: right, windowId: 1, whenReady: Promise.resolve(),
    enforcePartOptions: () => toDisposable(() => undefined),
    onDidAddGroup: addedGroup.event, onDidRemoveGroup: noEvent.event, onDidActivateGroup: noEvent.event,
    layout() {}, setVisible: visible => { partVisible = visible; }, dispose() {} };
  let locked = false;
  const main = { groups: [left], activeGroup: left, windowId: 1, getGroups: () => [left], getGroup: id => id === left.id ? left : undefined,
    enforceSingleGroup: () => { locked = true; return toDisposable(() => { locked = false; }); } };
  const groups = { mainPart: main, createEmbeddedEditorPart: () => part,
    get activeGroup() { return activeGroup; },
    getGroup: id => [left, right, auxiliary].find(group => group.id === id), getPart: group => ({ windowId: group === auxiliary ? 2 : 1 }) };
  let visibleView;
  const views = { onDidChangeViewVisibility: viewChange.event, openView: async id => { visibleView = id; viewChange.fire({ id, visible: true }); } };
  const layout = { onDidChangePartVisibility: noEvent.event, isVisible: () => true };
  const storage = { get: key => saved.get(key), getObject: key => saved.get(key), store: (key, value) => saved.set(key, structuredClone(value)) };
  const exports = load(workspaceCode, { Disposable, DisposableStore, MutableDisposable, RunOnceScheduler, toDisposable, EditorInput, WebviewInput,
    $: () => host, append: () => host, clearNode() {}, getWindow: () => ({ ResizeObserver: class { observe() {} disconnect() {} } }),
    StorageScope: { WORKSPACE: 1 }, StorageTarget: { MACHINE: 1 }, EditorsOrder: {}, GroupsOrder: {}, Parts: { AUXILIARYBAR_PART: 'auxiliary' },
    studioModeState: state, studioSteamToolDefinitions: tools, studioSteamWorkspaceState: workspaceState,
    registerEditorOpenTarget: policy.registerEditorOpenTarget,
  });
  const workspace = new exports.StudioSteamWorkspace(parent, groups, views, { getViewContainerByViewId: () => ({}) }, layout, storage);
  t.after(() => workspace.dispose());
  return { workspace, policy, left, right, auxiliary, state, saved, viewChange, host,
    get activeGroup() { return activeGroup; },
    addToolGroup: () => { const group = createGroup(4 + part.groups.length); part.groups.push(group); addedGroup.fire(group); return group; },
    get locked() { return locked; },
    get tabs() { return tabs; }, get active() { return active; }, get partVisible() { return partVisible; }, get visibleView() { return visibleView; } };
}

test('Steam reserves only the selected project and routes every other editor and explicit first-column target to tools', async t => {
  const f = fixture(t), project = new WebviewInput('Project', 'file:///project');
  await f.left.openEditor(project); await f.workspace.activate();
  assert.equal(f.policy.getEditorOpenTarget(project, f.right), f.left);
  assert.equal(f.policy.getEditorOpenTarget(project, f.auxiliary), f.left);
  for (const name of ['Account', 'Settings', 'File', 'Preview', 'Store']) {
    const editor = new EditorInput(name);
    for (const preferred of [undefined, 1, f.left, -2, -3, -4]) { assert.equal(f.policy.getEditorOpenTarget(editor, preferred), f.right); }
  }
  assert.equal(f.policy.getEditorOpenTarget(new WebviewInput('Other project', 'file:///other'), f.left), f.right);
  assert.equal(f.policy.getEditorOpenTarget(new WebviewInput('Another new project'), f.left), f.right);
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
  second.viewChange.fire({ id: 'terminal', visible: true });
  assert.equal(second.active, 'terminal'); assert.equal(second.tabs.length, 4);
  await second.workspace.close('terminal');
  second.viewChange.fire({ id: 'terminal', visible: true });
  assert.equal(second.active, 'terminal'); assert.equal(second.tabs.length, 4);
});

test('closing and reopening a project routes a new uninitialized panel to the runtime without a stale input reference', async t => {
  const f = fixture(t), project = new WebviewInput('Project', 'file:///project');
  await f.left.openEditor(project); await f.workspace.activate();
  await f.left.closeEditor(project); project.dispose();
  const reopened = new WebviewInput('Project'); reopened.webview.state = undefined;
  assert.equal(f.policy.getEditorOpenTarget(reopened, f.right), f.left);
  assert.equal(f.policy.getEditorOpenTarget(new WebviewInput('Other project', 'file:///other'), f.left), f.right);
  assert.equal(f.locked, true);
  await f.workspace.deactivate(f.left); assert.equal(f.locked, false);
});

test('restoring multiple projects uses the pinned runtime URI even when the other project is active', async t => {
  const f = fixture(t), original = new WebviewInput('Original', 'file:///original'), other = new WebviewInput('Other', 'file:///other');
  await f.left.openEditor(other); await f.right.openEditor(original);
  f.state.state.projectUri = 'file:///other';
  await f.workspace.activate('file:///original');
  assert.ok(f.left.contains(original)); assert.ok(f.right.contains(other));
  await f.left.closeEditor(original); original.dispose();
  const uninitializedTool = new WebviewInput('Other tool project'); uninitializedTool.webview.providedViewType = 'studio.projectTool';
  assert.equal(f.policy.getEditorOpenTarget(uninitializedTool, f.left), f.right);
  const reopened = new WebviewInput('Original', 'file:///original');
  assert.equal(f.policy.getEditorOpenTarget(reopened, f.left), f.left);
  assert.equal(f.policy.getEditorOpenTarget(other, f.left), f.right);
});

test('moving IDE sources during reload preserves the restored active tool editor', async t => {
  const saved = new Map([['studio.steamWorkspaceTabs', { tools: [], active: 'editor' }], ['studio.workbenchMode', 'steam']]);
  const f = fixture(t, saved), project = new WebviewInput('Project', 'file:///project');
  const source = new EditorInput('IDE source'), other = new WebviewInput('Other project', 'file:///other');
  await f.left.openEditor(project); await f.left.openEditor(source); await f.right.openEditor(other);
  const move = f.left.moveEditors;
  f.left.moveEditors = (entries, target) => { const result = move(entries, target); target.activeEditor = source; return result; };
  await f.workspace.activate();
  assert.equal(f.right.activeEditor, other);
  assert.equal(f.tabs.find(tab => tab.id === f.active)?.label, 'Other project');
});

test('split copies get independent tabs and closing one preserves the other group input', async t => {
  const f = fixture(t); await f.workspace.activate();
  const editor = new EditorInput('shared.txt'), second = f.addToolGroup();
  await f.right.openEditor(editor); await second.openEditor(editor);
  const ids = Array.from(f.tabs.filter(tab => tab.label === 'shared.txt'), tab => tab.id);
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  await f.workspace.select(ids[0]); assert.equal(f.active, ids[0]);
  await f.workspace.close(ids[0]);
  assert.equal(f.right.editors.length, 0); assert.ok(second.editors.includes(editor));
  assert.deepEqual(Array.from(f.tabs.filter(tab => tab.label === 'shared.txt'), tab => tab.id), [ids[1]]);
});

test('source documents move away from the runtime and return to their original IDE group', async t => {
  const f = fixture(t), source = new EditorInput('Source'), project = new WebviewInput('Project', 'file:///project');
  await f.left.openEditor(source); await f.left.openEditor(project); await f.workspace.activate();
  assert.deepEqual(f.left.editors, [project]); assert.ok(f.right.editors.includes(source));
  await f.workspace.deactivate(f.auxiliary);
  assert.ok(f.left.editors.includes(source)); assert.equal(f.auxiliary.editors.length, 0);
});

test('a runtime restored in the tool part is recovered before routing is enabled', async t => {
  const f = fixture(t), project = new WebviewInput('Project', 'file:///project');
  await f.right.openEditor(project); await f.workspace.activate();
  assert.ok(f.left.editors.includes(project)); assert.equal(f.right.editors.length, 0);
});

test('background native editor restoration keeps the selected tool visible', async t => {
  const f = fixture(t), project = new WebviewInput('Project', 'file:///project');
  await f.left.openEditor(project); await f.workspace.activate();
  await f.workspace.openTool('kv'); f.left.focus();
  await f.right.openEditor(new EditorInput('Background file'), { preserveFocus: true });
  assert.equal(f.active, 'kv'); assert.equal(f.partVisible, false);
});

test('an editor opened before leaving Steam cannot focus its retired tool group after completion', async t => {
  const f = fixture(t); await f.workspace.activate();
  const editor = new EditorInput('Slow editor'); await f.right.openEditor(editor);
  const id = f.active;
  let finish;
  f.right.openEditor = () => new Promise(resolve => { finish = resolve; });
  const selecting = f.workspace.select(id);
  await f.workspace.deactivate(f.left); f.left.focus(); finish(); await selecting;
  assert.equal(f.activeGroup, f.left); assert.equal(f.partVisible, false);
});
