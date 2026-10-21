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
  get value() { return this.current; }
  clear() { this.dispose(); }
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
class CustomEditorInput extends WebviewInput {
  constructor(name, resource) { super(name); this.resource = resource; this.webview.providedViewType = 'test.file-preview'; }
}
const tools = [{ id: 'editor', icon: 'code', editor: true }, ...['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace'].map(id => ({ id, icon: id, view: `studio.${id}` })),
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
      notifyActive: () => active.fire({ editor: group.activeEditor }),
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
  let tabs, active, instances, activeInstance, partVisible;
  const workspaceState = { update: (items, selected, children, selectedChild) => { tabs = items; active = selected; instances = children; activeInstance = selectedChild; } };
  const parent = { classList: { toggle() {} }, querySelector: () => undefined };
  const elements = new Map();
  const element = selector => {
    const node = { parentElement: parent, style: {}, hidden: true, clientWidth: 600, clientHeight: 800,
      getBoundingClientRect: () => ({ width: 600, height: 800 }), remove() {} };
    elements.set(selector, node); return node;
  };
  class SplitView {
    views = []; visible = [];
    addView(view, size) { this.views.push({ view, size }); this.visible.push(true); }
    setViewVisible(index, visible) { this.visible[index] = visible; }
    isViewVisible(index) { return this.visible[index]; }
    getViewSize(index) { return this.views[index].size; }
    resizeView(index, size) { this.views[index].size = size; }
    layout() { for (const [index, { view, size }] of this.views.entries()) { if (this.visible[index]) { view.layout(size); } } }
    onDidSashChange = noEvent.event;
    dispose() {}
  }
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
  const views = { onDidChangeViewVisibility: viewChange.event, openView: async id => { visibleView = id; viewChange.fire({ id, visible: true }); },
    openViewContainer: async id => { visibleView = id; } };
  let sidebarVisible = false, sidebarRequest, sidebarDisposed = false, toolsVisible = true;
  const layoutChange = new Emitter();
  const layout = { onDidChangePartVisibility: layoutChange.event, isVisible: () => toolsVisible,
    createEmbeddedSideBar: (_container, request) => { sidebarRequest = request; return {
      setVisible: value => { sidebarVisible = value; }, layout() {}, dispose() { sidebarDisposed = true; sidebarVisible = false; },
    }; } };
  const storage = { get: key => saved.get(key), getObject: key => saved.get(key), getNumber: (key, _scope, fallback) => saved.get(key) ?? fallback,
    store: (key, value) => saved.set(key, structuredClone(value)) };
  const calls = [], terminalChanged = new Emitter(), terminalSelected = new Emitter();
  const terminalGroups = { instances: [], activeInstance: undefined, onDidChangeInstances: terminalChanged.event,
    onDidChangeActiveInstance: terminalSelected.event,
    focusInstance: async instance => { terminalGroups.activeInstance = instance; terminalSelected.fire(instance); } };
  let terminalId = 0;
  const terminals = { onAnyInstanceTitleChange: noEvent.event,
    createTerminal: async () => { const instance = { instanceId: ++terminalId, title: `Shell ${terminalId}` }; terminalGroups.instances.push(instance); terminalChanged.fire(); return instance; },
    safeDisposeTerminal: async instance => { if (instance.veto) { return; } terminalGroups.instances = terminalGroups.instances.filter(value => value !== instance);
      if (terminalGroups.activeInstance === instance) { terminalGroups.activeInstance = terminalGroups.instances.at(-1); }
      terminalChanged.fire(); } };
  const commands = { executeCommand: async (name, ...args) => { calls.push([name, ...args]); } };
  const exports = load(workspaceCode, { Disposable, DisposableStore, MutableDisposable, RunOnceScheduler, toDisposable, EditorInput, WebviewInput, CustomEditorInput,
    $: element, append: (parent, node) => { node.parentElement = parent; return node; }, clearNode() {}, addDisposableListener: () => toDisposable(() => undefined),
    getWindow: () => ({ ResizeObserver: class { observe() {} disconnect() {} } }), SplitView, Orientation: { HORIZONTAL: 1 }, Event: { None: noEvent.event },
    StorageScope: { WORKSPACE: 1 }, StorageTarget: { MACHINE: 1 }, EditorsOrder: {}, GroupsOrder: {}, Parts: { AUXILIARYBAR_PART: 'auxiliary' }, TerminalLocation: { Panel: 1 },
    EditorResourceAccessor: { getOriginalUri: editor => editor.resource }, SideBySideEditor: { PRIMARY: 1 },
    studioModeState: state, studioSteamToolDefinitions: tools, studioSteamWorkspaceState: workspaceState,
    registerEditorOpenTarget: policy.registerEditorOpenTarget,
  });
  const workspace = new exports.StudioSteamWorkspace(parent, groups, views, { getViewContainerByViewId: () => ({}) }, layout, storage, commands, terminals, terminalGroups,
    { openEditor: (editor, options, group) => group.openEditor(editor, options) });
  const host = elements.get('.part.editor.studio-steam-editors');
  t.after(() => workspace.dispose());
  return { workspace, policy, left, right, auxiliary, state, saved, viewChange, host, calls, terminalGroups,
    get activeGroup() { return activeGroup; },
    addToolGroup: () => { const group = createGroup(4 + part.groups.length); part.groups.push(group); addedGroup.fire(group); return group; },
    get locked() { return locked; },
    get tabs() { return tabs; }, get active() { return active; }, get instances() { return instances; }, get activeInstance() { return activeInstance; },
    get partVisible() { return partVisible; }, get visibleView() { return visibleView; },
    get sidebarVisible() { return sidebarVisible; }, get sidebarDisposed() { return sidebarDisposed; },
    requestSidebar: visible => sidebarRequest(visible),
    setToolsVisible: visible => { toolsVisible = visible; layoutChange.fire(); } };
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

test('all resource instances group under their tool and closing one selects a sibling before another category', async t => {
  const f = fixture(t); await f.workspace.activate();
  for (const kind of ['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace']) {
    await f.workspace.openTool(kind);
    const first = new WebviewInput(`${kind} 2`); first.webview.providedViewType = `studio.tool.${kind}`;
    const second = new WebviewInput(`${kind} 3`); second.webview.providedViewType = `studio.tool.${kind}`;
    await f.right.openEditor(first); const firstId = f.activeInstance;
    await f.right.openEditor(new EditorInput('Interleaved file'));
    await f.right.openEditor(second); const secondId = f.activeInstance;
    assert.equal(f.tabs.filter(tab => tab.id === kind).length, 1);
    assert.deepEqual(Array.from(f.instances, tab => tab.id), [kind, firstId, secondId]);
    await f.workspace.close(secondId, true);
    assert.equal(f.active, kind); assert.equal(f.activeInstance, firstId);
    await f.workspace.select(kind); assert.equal(f.activeInstance, firstId);
    await f.workspace.newInstance(kind); assert.deepEqual(f.calls.at(-1), ['studio.createToolInstance', kind]);
    first.dirty = true; f.right.veto = true;
    await f.workspace.close(kind);
    assert.equal(f.instances.find(tab => tab.id === firstId).label, `${kind} 2`);
    f.right.veto = false; await f.workspace.close(kind);
    assert.equal(f.tabs.some(tab => tab.id === kind), false);
  }
});

test('browser instances and secondary projects use child tabs while the original runtime stays pinned', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate();
  await f.workspace.openTool('browser'); assert.deepEqual(f.calls.at(-1), ['simpleBrowser.show']);
  const browser = new WebviewInput('Browser 1'); browser.webview.providedViewType = 'simpleBrowser.view';
  const next = new EditorInput('Browser 2'); next.typeId = 'workbench.editorinputs.browser';
  await f.right.openEditor(browser); const firstId = f.activeInstance;
  await f.right.openEditor(next);
  assert.equal(f.active, 'browser'); assert.equal(f.instances.length, 2);
  await f.workspace.openTool('browser'); assert.equal(f.calls.length, 1);
  await f.workspace.newInstance('browser'); assert.equal(f.calls.at(-1)[0], 'simpleBrowser.show'); assert.equal(f.calls.at(-1)[2].forceNew, true);
  await f.workspace.close(firstId, true); assert.ok(f.right.contains(next));
  const other = new WebviewInput('Other project', 'file:///other'); other.webview.providedViewType = 'studio.projectTool';
  await f.right.openEditor(other); assert.equal(f.active, 'project');
  assert.deepEqual(f.left.editors, [runtime]);
  await f.workspace.deactivate(f.left);
  assert.ok(f.left.contains(other) && f.left.contains(next));
});

test('asynchronous native fallback after closing a child cannot replace the selected sibling tool view', async t => {
  const f = fixture(t); await f.workspace.activate();
  await f.right.openEditor(new EditorInput('Source behind the tool'));
  await f.workspace.openTool('kv');
  const instance = new WebviewInput('KV 2'); instance.webview.providedViewType = 'studio.tool.kv';
  await f.right.openEditor(instance); const id = f.activeInstance;
  await f.workspace.close(id, true); f.right.notifyActive();
  assert.equal(f.active, 'kv'); assert.equal(f.activeInstance, 'kv'); assert.equal(f.partVisible, false);
});

test('terminal child tabs select and close actual sessions, honor veto and retain sessions when hiding their category', async t => {
  const f = fixture(t); await f.workspace.activate();
  await f.workspace.newInstance('terminal'); await f.workspace.newInstance('terminal');
  assert.equal(f.active, 'terminal'); assert.equal(f.instances.length, 2);
  const [first, second] = f.terminalGroups.instances;
  await f.workspace.select(`terminal:${first.instanceId}`, true); assert.equal(f.terminalGroups.activeInstance, first);
  first.veto = true; await f.workspace.close(`terminal:${first.instanceId}`, true); assert.equal(f.instances.length, 2);
  first.veto = false; await f.workspace.close(`terminal:${first.instanceId}`, true);
  assert.equal(f.activeInstance, `terminal:${second.instanceId}`);
  await f.workspace.close('terminal'); assert.equal(f.terminalGroups.instances.length, 1);
  await f.workspace.openTool('terminal'); assert.equal(f.instances.length, 1);
  await f.workspace.deactivate(f.left); assert.equal(f.terminalGroups.instances[0], second);
});

test('the Editor tool opens an empty native workspace with Explorer and creates real untitled files', async t => {
  const f = fixture(t); await f.workspace.activate();
  await f.workspace.openTool('editor');
  assert.equal(f.active, 'editor'); assert.equal(f.instances.length, 0);
  assert.equal(f.sidebarVisible, true); assert.equal(f.partVisible, false);
  assert.ok(f.tabs.some(tab => tab.id === 'editor'));
  await f.workspace.newInstance('editor');
  assert.deepEqual(f.calls.at(-1), ['workbench.action.files.newUntitledFile']);
  await f.workspace.deactivate(f.left); assert.equal(f.sidebarDisposed, true);
});

test('Explorer can show a file in the selected Editor tool while retaining sidebar focus', async t => {
  const f = fixture(t); await f.workspace.activate();
  await f.workspace.openTool('editor'); f.left.focus();
  const source = new EditorInput('index.ts'); source.resource = 'file:///project/index.ts';
  await f.right.openEditor(source, { preserveFocus: true });
  assert.equal(f.instances.find(tab => tab.id === f.activeInstance)?.label, 'index.ts');
  assert.equal(f.partVisible, true); assert.equal(f.activeGroup, f.left);
});

test('files share one Editor category, retain dirty inputs across tools, and keep an empty editor after closing the last file', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate();
  const source = new EditorInput('index.ts'); source.resource = 'file:///project/index.ts'; source.dirty = true;
  const config = new EditorInput('package.json'); config.resource = 'file:///project/package.json';
  await f.right.openEditor(source); const sourceId = f.activeInstance;
  await f.right.openEditor(config); const configId = f.activeInstance;
  assert.deepEqual(Array.from(f.tabs, tab => tab.id), ['editor']);
  assert.deepEqual(Array.from(f.instances, tab => tab.label), ['index.ts', 'package.json']);
  assert.equal(f.tabs[0].dirty, true);
  await f.workspace.openTool('kv'); assert.equal(f.sidebarVisible, false);
  await f.workspace.openTool('editor'); assert.equal(f.activeInstance, configId); assert.equal(f.sidebarVisible, true);
  f.setToolsVisible(false); assert.equal(f.sidebarVisible, false); assert.equal(f.partVisible, false);
  f.setToolsVisible(true); assert.equal(f.sidebarVisible, true); assert.equal(f.right.activeEditor, config);
  await f.workspace.close(sourceId, true); await f.workspace.close(configId, true);
  assert.equal(f.active, 'editor'); assert.equal(f.instances.length, 0); assert.equal(f.partVisible, false);
  assert.deepEqual(f.left.editors, [runtime]);
});

test('Editor category close honors the native veto and native sidebar commands reveal the Editor tool', async t => {
  const f = fixture(t); await f.workspace.activate();
  const source = new EditorInput('unsaved.ts'); source.resource = 'untitled:unsaved.ts'; source.dirty = true;
  await f.right.openEditor(source); f.right.veto = true;
  await f.workspace.close('editor'); assert.equal(f.active, 'editor'); assert.ok(f.right.contains(source));
  await f.workspace.openTool('kv'); f.requestSidebar(true);
  assert.equal(f.active, 'editor'); assert.equal(f.sidebarVisible, true);
  f.requestSidebar(false); assert.equal(f.sidebarVisible, false); assert.equal(f.partVisible, true);
  f.right.veto = false; await f.workspace.close('editor');
  assert.equal(f.tabs.some(tab => tab.id === 'editor'), false); assert.equal(f.active, 'kv');
});

test('file-backed custom editors share Editor tabs while standalone webviews keep their own tool', async t => {
  const f = fixture(t); await f.workspace.activate();
  await f.right.openEditor(new CustomEditorInput('image.svg', 'file:///project/image.svg'));
  assert.deepEqual(Array.from(f.instances, tab => tab.label), ['image.svg']);
  assert.equal(f.active, 'editor'); assert.equal(f.sidebarVisible, true);
  const account = new WebviewInput('Account'); account.webview.providedViewType = 'studio.account';
  await f.right.openEditor(account);
  assert.deepEqual(Array.from(f.tabs, tab => tab.label), ['editor', 'Account']);
  assert.equal(f.instances.length, 0); assert.equal(f.sidebarVisible, false);
});

test('reload restores an empty Editor tool without revealing another tool input underneath', async t => {
  const saved = new Map([['studio.steamWorkspaceTabs', { tools: ['editor'], active: 'editor', emptyEditor: true }], ['studio.workbenchMode', 'steam']]);
  const f = fixture(t, saved), browser = new WebviewInput('Browser'); browser.webview.providedViewType = 'simpleBrowser.view';
  await f.right.openEditor(browser); await f.workspace.activate();
  assert.equal(f.active, 'editor'); assert.equal(f.instances.length, 0);
  assert.equal(f.partVisible, false); assert.equal(f.sidebarVisible, true); assert.ok(f.right.contains(browser));
});
