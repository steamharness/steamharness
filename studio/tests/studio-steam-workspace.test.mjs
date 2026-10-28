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
  matches(other) { return this === other; }
  dispose() { this.disposed = true; this.disposedEvent.fire(); }
}
class WebviewInput extends EditorInput {
  constructor(name, uri) { super(name); this.webview = { providedViewType: 'studio.project', state: JSON.stringify({ projectUri: uri }) }; }
}
class CustomEditorInput extends WebviewInput {
  constructor(name, resource) { super(name); this.resource = resource; this.webview.providedViewType = 'test.file-preview'; }
}
const tools = [{ id: 'editor', icon: 'code', editor: true }, { id: 'settings', icon: 'settings-gear', command: 'studio.openSettings' }, { id: 'login', icon: 'sign-in', command: 'studio.openLogin' }, ...['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace'].map(id => ({ id, icon: id, view: `studio.${id}` })),
  { id: 'terminal', icon: 'terminal', view: 'terminal' }, { id: 'browser', command: 'simpleBrowser.show' }, { id: 'project', command: 'studio.openProjectInTab' }];
class StudioToolViewInput extends EditorInput {
  constructor(toolId, viewId) { super(toolId); this.toolId = toolId; this.viewId = viewId; }
  matches(other) { return other instanceof StudioToolViewInput && other.viewId === this.viewId; }
}
class TerminalEditorInput extends EditorInput {
  typeId = 'workbench.editors.terminal';
  constructor(instance) { super(instance.title); this.terminalInstance = instance; }
}
function fixture(t, saved = new Map()) {
  const toDisposable = dispose => ({ dispose });
  const load = (code, common) => {
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: () => new Proxy(common, { get: (target, key) => key in target ? target[key] : () => undefined }) });
    return module.exports;
  };
  const policy = load(policyCode, { toDisposable });
  let activeGroup, nextGroup = 4, workspace;
  const parts = new Map(), noEvent = new Emitter(), viewChange = new Emitter(), stateChange = new Emitter();
  const createGroup = id => {
    const model = new Emitter(), active = new Emitter(), opening = new Emitter(), closed = new Emitter();
    const group = { id, editors: [], activeEditor: undefined, veto: false,
      scopedContextKeyService: { createKey() {} },
      onDidModelChange: model.event, onDidActiveEditorChange: active.event, onWillOpenEditor: opening.event, onDidCloseEditor: closed.event,
      getEditors: () => group.editors.slice(), focus() { activeGroup = group; }, contains: editor => group.editors.includes(editor),
      notifyActive: () => active.fire({ editor: group.activeEditor }),
      openEditor: async (editor, options) => {
        opening.fire({ editor });
        if (!group.editors.includes(editor)) { group.editors.push(editor); }
        if (!options?.inactive && !options?.preserveFocus) { activeGroup = group; }
        if (!options?.inactive && group.activeEditor !== editor) { group.activeEditor = editor; active.fire({ editor }); }
        model.fire();
      },
      closeEditor: async editor => {
        if (group.veto || editor.terminalInstance?.veto) { return false; }
        if (group.beforeClose) { await group.beforeClose(editor); }
        group.editors = group.editors.filter(value => value !== editor);
        group.activeEditor = group.editors.at(-1); active.fire({}); model.fire(); closed.fire({ editor });
        if (editor.terminalInstance) { terminals.instances = terminals.instances.filter(instance => instance !== editor.terminalInstance); }
        return true;
      },
      moveEditors: (entries, target) => {
        if (group === target) { return true; }
        if (group.moveVeto) { return false; }
        for (const { editor } of entries) { if (!target.editors.includes(editor)) { target.editors.push(editor); } }
        group.editors = group.editors.filter(editor => !entries.some(entry => entry.editor === editor));
        group.activeEditor = group.editors.at(-1); model.fire(); return true;
      },
    };
    return group;
  };
  const left = createGroup(1), right = createGroup(2), auxiliary = createGroup(3);
  let locked = false;
  const main = { groups: [left], activeGroup: left, windowId: 1, getGroups: () => [left], getGroup: id => id === left.id ? left : undefined,
    enforceSingleGroup: () => { locked = true; return toDisposable(() => { locked = false; }); } };
  const allGroups = () => [left, auxiliary, ...[...parts.values()].flatMap(part => part.groups)];
  const groups = { mainPart: main, get activeGroup() { return activeGroup; },
    activateGroup: group => { activeGroup = group; },
    getGroup: id => allGroups().find(group => group.id === id), getPart: group => ({ windowId: group === auxiliary ? 2 : 1 }),
    createEmbeddedEditorPart: (host, id) => {
      const category = id.replace('workbench.parts.studioSteamEditors', '').replace(/^\./, '') || 'editor';
      const added = new Emitter();
      const part = { host, groups: [category === 'editor' ? right : createGroup(nextGroup++)], windowId: 1, whenReady: Promise.resolve(), visible: false,
        get activeGroup() { return part.groups.find(group => group === activeGroup) ?? part.groups[0]; },
        enforcePartOptions: options => { part.options = options; return toDisposable(() => undefined); },
        onDidAddGroup: added.event, onDidRemoveGroup: noEvent.event, onDidActivateGroup: noEvent.event,
        addGroup() { const group = createGroup(nextGroup++); part.groups.push(group); added.fire(group); return group; },
        layout() {}, setVisible: visible => { part.visible = visible; }, dispose() { parts.delete(category); } };
      parts.set(category, part); return part;
    } };
  let visibleView, sidebarVisible = false, sidebarRequest, sidebarDisposed = false, toolsVisible = true;
  const views = { onDidChangeViewVisibility: viewChange.event, openView: async id => { visibleView = id; viewChange.fire({ id, visible: true }); },
    openViewContainer: async id => { visibleView = id; } };
  const parent = { classList: { toggle() {} }, querySelector: () => undefined };
  const elements = new Map();
  const element = selector => {
    const node = { parentElement: parent, children: [], style: {}, hidden: true, classList: { toggle() {} }, clientWidth: 600, clientHeight: 800,
      querySelector: () => undefined, querySelectorAll: () => node.children.filter(child => child.selector?.includes('studio-steam-editors')),
      getBoundingClientRect: () => ({ width: 600, height: 800 }), remove() { this.parentElement.children = this.parentElement.children?.filter(child => child !== this); }, selector };
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
    onDidSashChange = noEvent.event; dispose() {}
  }
  const layoutChange = new Emitter();
  const layout = { onDidChangePartVisibility: layoutChange.event, isVisible: () => toolsVisible,
    createEmbeddedSideBar: (_container, request) => { sidebarRequest = request; return {
      setVisible: value => { sidebarVisible = value; }, layout() {}, dispose() { sidebarDisposed = true; sidebarVisible = false; },
    }; } };
  const storage = { get: key => saved.get(key), getObject: key => saved.get(key), getNumber: (key, _scope, fallback) => saved.get(key) ?? fallback,
    store: (key, value) => saved.set(key, structuredClone(value)) };
  const calls = [], terminalChanged = new Emitter(), terminalInputs = new Map();
  const terminalGroups = { instances: [], onDidChangeInstances: terminalChanged.event };
  const editors = { openEditor: async (editor, options, preferred) => {
    const target = policy.getEditorOpenTarget(editor, preferred) ?? preferred ?? right;
    await target.openEditor(editor, options);
    if (editor instanceof StudioToolViewInput && !options?.inactive) { await views.openView(editor.viewId); }
  } };
  const terminals = { instances: [], createTerminal: async () => {
    const instance = { instanceId: terminals.instances.length + 1, title: 'Shell' };
    terminals.instances.push(instance); const input = new TerminalEditorInput(instance); terminalInputs.set(instance, input);
    await editors.openEditor(input); return instance;
  }, moveToEditor: (instance, id) => {
    terminalGroups.instances = terminalGroups.instances.filter(value => value !== instance); terminalChanged.fire();
    const input = terminalInputs.get(instance) ?? new TerminalEditorInput(instance); terminalInputs.set(instance, input);
    void editors.openEditor(input, {}, groups.getGroup(id));
  }, moveToTerminalView: async instance => {
    const input = terminalInputs.get(instance);
    for (const group of allGroups()) { if (group.contains(input)) { group.editors = group.editors.filter(editor => editor !== input); group.activeEditor = group.editors.at(-1); group.notifyActive(); } }
    terminalGroups.instances.push(instance); terminalChanged.fire();
    await views.openView('terminal');
  } };
  const commands = { executeCommand: async (name, ...args) => { calls.push([name, ...args]); } };
  const state = { state: { projectUri: 'file:///project', labels: Object.fromEntries(tools.map(tool => [tool.id, tool.id])) }, onDidChangeState: stateChange.event };
  const workspaceState = { tabs: [], update: (items, selected, children, selectedChild, tool) => {
    Object.assign(workspaceState, { tabs: items, active: selected, instances: children, activeInstance: selectedChild, tool }); } };
  const exports = load(workspaceCode, { Disposable, DisposableStore, MutableDisposable, RunOnceScheduler, toDisposable, EditorInput, WebviewInput, CustomEditorInput, StudioToolViewInput, TerminalEditorInput,
    $: element, append: (parent, node) => { node.parentElement = parent; parent.children?.push(node); return node; }, clearNode() {}, addDisposableListener: () => toDisposable(() => undefined),
    getWindow: () => ({ ResizeObserver: class { observe() {} disconnect() {} } }), SplitView, Orientation: { HORIZONTAL: 1 }, Event: { None: noEvent.event },
    StorageScope: { WORKSPACE: 1 }, StorageTarget: { MACHINE: 1 }, EditorsOrder: {}, GroupsOrder: {}, Parts: { AUXILIARYBAR_PART: 'auxiliary' },
    EditorResourceAccessor: { getOriginalUri: editor => editor.resource }, SideBySideEditor: { PRIMARY: 1 },
    studioModeState: state, studioSteamToolDefinitions: tools, studioSteamWorkspaceState: workspaceState, registerEditorOpenTarget: policy.registerEditorOpenTarget,
  });
  workspace = new exports.StudioSteamWorkspace(parent, groups, views, { getViewContainerByViewId: () => ({}) }, layout, storage, commands, terminals, terminalGroups, editors);
  t.after(() => workspace.dispose());
  return { workspace, policy, left, right, auxiliary, state, saved, viewChange, calls, terminalGroups, terminals, parts,
    open: (editor, options, preferred) => editors.openEditor(editor, options, preferred),
    get activeGroup() { return activeGroup; }, get locked() { return locked; },
    get tabs() { return workspaceState.tabs; }, get active() { return workspaceState.active; },
    get instances() { return workspaceState.instances; }, get activeInstance() { return workspaceState.activeInstance; },
    get partVisible() { return [...parts.values()].some(part => part.visible); }, get visibleView() { return visibleView; },
    get sidebarVisible() { return sidebarVisible; }, get sidebarDisposed() { return sidebarDisposed; },
    requestSidebar: visible => sidebarRequest(visible), setToolsVisible: visible => { toolsVisible = visible; layoutChange.fire(); },
  };
}
const file = name => Object.assign(new EditorInput(name), { resource: `file:///project/${name}` });
const panel = (tool, name = `${tool} 2`) => { const input = new WebviewInput(name); input.webview.providedViewType = `studio.tool.${tool}`; return input; };
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('the runtime remains pinned while files, explicit targets and separate windows keep their ownership', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate();
  for (const preferred of [undefined, 1, f.left, -2, -3, -4]) { assert.equal(f.policy.getEditorOpenTarget(file('source.ts'), preferred), f.right); }
  assert.equal(f.policy.getEditorOpenTarget(runtime, f.right), f.left);
  assert.equal(f.policy.getEditorOpenTarget(file('external.ts'), f.auxiliary), undefined);
  assert.equal(f.locked, true);
  await f.workspace.deactivate(f.left);
  assert.equal(f.policy.getEditorOpenTarget(file('ide.ts'), f.left), undefined); assert.equal(f.locked, false);
});

test('native file and resource parts have separate groups and preserve their exact inputs when switching categories', async t => {
  const f = fixture(t); await f.workspace.activate();
  const source = file('index.ts'); source.dirty = true;
  await f.open(source); await f.workspace.openTool('kv');
  const retained = f.parts.get('kv').activeGroup.activeEditor;
  await f.open(panel('kv')); await f.workspace.openTool('editor');
  assert.equal(f.right.activeEditor, source); assert.equal(f.sidebarVisible, true);
  await f.workspace.openTool('kv');
  assert.deepEqual(Array.from(f.instances, tab => tab.label), ['kv', 'kv 2']);
  assert.equal(f.parts.get('kv').groups[0].contains(retained), true);
  assert.equal(f.parts.get('kv').options.showTabs, 'multiple'); assert.equal(f.parts.get('kv').options.editorActionsLocation, 'default');
  assert.equal(f.right.contains(source), true); assert.equal(f.sidebarVisible, false);
});

test('all six retained views and independent panels share their own native category without duplicating the retained input', async t => {
  const f = fixture(t); await f.workspace.activate();
  for (const kind of ['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace']) {
    await f.workspace.openTool(kind); const retained = f.parts.get(kind).groups[0].editors[0];
    await f.workspace.openTool(kind); await f.open(panel(kind));
    assert.equal(f.instances.length, 2); assert.equal(f.parts.get(kind).groups[0].editors[0], retained);
    await f.workspace.newInstance(kind); assert.deepEqual(f.calls.at(-1), ['studio.createToolInstance', kind]);
  }
});

test('settings owns a native category across mode changes and preserves the project and other tools', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate(); await f.workspace.openTool('kv');
  const resource = f.parts.get('kv').activeGroup.activeEditor;
  await f.workspace.openTool('settings'); assert.deepEqual(f.calls.at(-1), ['studio.openSettings']);
  const settings = new WebviewInput('Settings'); settings.webview.providedViewType = 'studio.settings';
  await f.open(settings);
  assert.equal(f.active, 'settings'); assert.equal(f.parts.get('settings').activeGroup.activeEditor, settings);
  assert.equal(f.parts.get('kv').activeGroup.activeEditor, resource); assert.equal(f.left.activeEditor, runtime);
  await f.workspace.deactivate(f.left); assert.equal(f.left.contains(settings), true);
  await f.workspace.activate();
  assert.equal(f.parts.get('settings').activeGroup.activeEditor, settings); assert.equal(f.left.activeEditor, runtime);
  await f.workspace.close('settings');
  assert.equal(f.tabs.some(tab => tab.id === 'settings'), false); assert.equal(f.left.activeEditor, runtime);
});

test('login has its own native category and survives mode changes alongside settings and the running project', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate(); await f.workspace.openTool('kv');
  const resource = f.parts.get('kv').activeGroup.activeEditor;
  const settings = new WebviewInput('Settings'); settings.webview.providedViewType = 'studio.settings'; await f.open(settings);
  await f.workspace.openTool('login'); assert.deepEqual(f.calls.at(-1), ['studio.openLogin']);
  const login = new WebviewInput('Sign In'); login.webview.providedViewType = 'studio.login'; await f.open(login);
  assert.equal(f.active, 'login'); assert.equal(f.parts.get('login').activeGroup.activeEditor, login);
  assert.equal(f.parts.get('settings').activeGroup.activeEditor, settings);
  assert.equal(f.parts.get('kv').activeGroup.activeEditor, resource);
  await f.workspace.deactivate(f.left); assert.equal(f.left.contains(login), true);
  await f.workspace.activate();
  assert.equal(f.parts.get('login').activeGroup.activeEditor, login);
  await f.workspace.openTool('kv');
  assert.equal(f.parts.get('kv').activeGroup.activeEditor.viewId, resource.viewId); assert.equal(f.left.activeEditor, runtime);
  await f.workspace.openTool('login');
  await f.workspace.close('login');
  assert.equal(f.tabs.some(tab => tab.id === 'login'), false);
  assert.equal(f.parts.get('settings').activeGroup.contains(settings), true); assert.equal(f.left.activeEditor, runtime);
});

test('closing a native child selects a sibling in the same tool and respects a close veto', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.openTool('kv');
  await f.open(panel('kv')); const second = f.activeInstance;
  await f.open(panel('kv', 'kv 3')); const third = f.activeInstance;
  const group = f.parts.get('kv').groups[0]; group.veto = true;
  assert.equal(await f.workspace.close(third, true), false); assert.equal(f.instances.length, 3);
  group.veto = false; await f.workspace.close(third, true);
  assert.equal(f.active, 'kv'); assert.equal(f.activeInstance, second);
});

test('a dirty close cancellation stops Close Others and preserves remaining tool categories', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.openTool('kv');
  const source = file('dirty.ts'); source.dirty = true; await f.open(source);
  await f.workspace.openTool('knowledge'); f.right.veto = true;
  await f.workspace.closeTabs('kv', 'others');
  assert.deepEqual(Array.from(f.tabs, tab => tab.id), ['kv', 'editor', 'knowledge']);
  assert.equal(f.right.contains(source), true);
});

test('Close Others and Close All operate on tool categories while preserving the runtime', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate();
  await f.workspace.openTool('kv'); await f.workspace.openTool('knowledge'); await f.open(file('index.ts'));
  await f.workspace.closeTabs('kv', 'others');
  assert.deepEqual(Array.from(f.tabs, tab => tab.id), ['kv']); assert.equal(f.left.activeEditor, runtime);
  await f.workspace.closeTabs('kv', 'all');
  assert.equal(f.tabs.length, 0); assert.equal(f.visibleView, 'studio.steamTools'); assert.equal(f.left.activeEditor, runtime);
});

test('a selection made while close is awaiting a native confirmation owns the visible tool', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.open(file('dirty.ts'));
  const id = f.activeInstance; let release;
  f.right.beforeClose = () => new Promise(resolve => { release = resolve; });
  const closing = f.workspace.close(id, true);
  await f.workspace.openTool('kv'); release(); await closing;
  assert.equal(f.active, 'kv'); assert.equal(f.instances[0].label, 'kv');
});

test('returning to IDE keeps dirty objects and retires synthetic view tabs without recreating controllers', async t => {
  const f = fixture(t), source = file('dirty.ts'); source.dirty = true;
  await f.left.openEditor(source); await f.workspace.activate(); await f.workspace.openTool('assistant');
  await f.open(panel('assistant')); const input = f.parts.get('assistant').groups[0].activeEditor;
  await f.workspace.deactivate(f.left);
  assert.equal(f.left.contains(source), true); assert.equal(source.isDirty(), true); assert.equal(f.left.contains(input), true);
  assert.equal(f.left.editors.some(editor => editor instanceof StudioToolViewInput), false); assert.equal(f.sidebarDisposed, true);
  await f.workspace.activate(); assert.equal(f.parts.get('assistant').groups[0].contains(input), true);
  assert.equal(f.parts.get('assistant').groups[0].editors.some(editor => editor instanceof StudioToolViewInput), true);
});

test('the selected retained view survives mode changes with additional instances, and closing it prevents resurrection', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.openTool('kv');
  const original = f.activeInstance; await f.open(panel('kv'));
  await f.workspace.select(original, true); await f.workspace.deactivate(f.left); await f.workspace.activate();
  assert.equal(f.instances.length, 2);
  assert.equal(f.parts.get('kv').activeGroup.activeEditor instanceof StudioToolViewInput, true);
  await f.workspace.close(f.activeInstance, true);
  await f.workspace.deactivate(f.left); await f.workspace.activate();
  assert.equal(f.instances.length, 1);
  assert.equal(f.parts.get('kv').activeGroup.editors.some(editor => editor instanceof StudioToolViewInput), false);
});

test('closing the last native tool tab does not reopen the category on a later mode change', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.openTool('knowledge');
  await f.parts.get('knowledge').activeGroup.closeEditor(f.parts.get('knowledge').activeGroup.activeEditor);
  assert.equal(f.visibleView, 'studio.steamTools');
  await f.workspace.deactivate(f.left); await f.workspace.activate();
  assert.equal(f.tabs.some(tab => tab.id === 'knowledge'), false);
});

test('old mixed part restoration redistributes real inputs and preserves a saved empty Editor category', async t => {
  const saved = new Map([['studio.steamWorkspaceTabs', { tools: ['editor'], active: 'editor', emptyEditor: true }], ['studio.workbenchMode', 'steam']]);
  const f = fixture(t, saved), kv = panel('kv');
  await f.right.openEditor(kv); await f.workspace.activate();
  assert.equal(f.active, 'editor'); assert.equal(f.instances.length, 0); assert.equal(f.sidebarVisible, true);
  assert.equal(f.parts.get('kv').groups[0].contains(kv), true); assert.equal(f.right.contains(kv), false);
});

test('each saved category restores its native part and inactive default views without stealing selection', async t => {
  const saved = new Map([['studio.steamWorkspaceTabs', { tools: ['kv', 'knowledge'], parts: ['editor', 'kv', 'knowledge'], active: 'kv' }], ['studio.workbenchMode', 'steam']]);
  const f = fixture(t, saved); await f.workspace.activate();
  assert.equal(f.parts.size, 3); assert.deepEqual(Array.from(f.tabs, tab => tab.id), ['kv', 'knowledge']); assert.equal(f.active, 'kv');
  assert.deepEqual(saved.get('studio.steamWorkspaceTabs').parts, ['editor', 'kv', 'knowledge']);
});

test('split groups keep a copied file independently and preserve their ownership after one tab closes', async t => {
  const f = fixture(t); await f.workspace.activate(); const source = file('index.ts'); await f.open(source);
  const first = f.activeInstance, split = f.parts.get('editor').addGroup(); await f.open(source, {}, split);
  assert.equal(f.instances.length, 2); assert.notEqual(f.activeInstance, first);
  await f.workspace.close(f.activeInstance, true); assert.equal(f.right.contains(source), true); assert.equal(split.contains(source), false);
});

test('native toolbar additions honor the group in their command context instead of the globally active category', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.openTool('kv');
  const kvGroup = f.parts.get('kv').addGroup(); await f.workspace.openTool('knowledge');
  await f.workspace.newInstance(undefined, kvGroup.id);
  assert.equal(f.activeGroup, kvGroup); assert.deepEqual(f.calls.at(-1), ['studio.createToolInstance', 'kv']);
});

test('Explorer previews keep sidebar focus, native close leaves an empty Editor, and hide/show retains the input', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.openTool('editor'); f.left.focus();
  const source = file('index.ts'); await f.open(source, { preserveFocus: true });
  assert.equal(f.active, 'editor'); assert.equal(f.activeGroup, f.left); assert.equal(f.partVisible, true);
  f.setToolsVisible(false); assert.equal(f.partVisible, false); assert.equal(f.sidebarVisible, false);
  f.setToolsVisible(true); assert.equal(f.right.activeEditor, source); assert.equal(f.sidebarVisible, true);
  await f.workspace.close(f.activeInstance, true); assert.equal(f.active, 'editor'); assert.equal(f.instances.length, 0);
  await f.workspace.newInstance('editor'); assert.deepEqual(f.calls.at(-1), ['workbench.action.files.newUntitledFile']);
});

test('late native selection cannot focus a retired Steam group after returning to IDE', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.open(file('index.ts')); const id = f.activeInstance;
  let finish; f.right.openEditor = () => new Promise(resolve => { finish = resolve; });
  const selecting = f.workspace.select(id, true); await f.workspace.deactivate(f.left); f.left.focus(); finish(); await selecting;
  assert.equal(f.activeGroup, f.left); assert.equal(f.partVisible, false);
});

test('closing and reopening the runtime repairs its identity without stealing secondary projects', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate(); await f.left.closeEditor(runtime);
  const reopened = new WebviewInput('Reopened'); assert.equal(f.policy.getEditorOpenTarget(reopened, f.right), f.left);
  await f.left.openEditor(reopened);
  const other = new WebviewInput('Other', 'file:///other'); other.webview.providedViewType = 'studio.projectTool';
  await f.open(other); assert.equal(f.active, 'project'); assert.equal(f.left.activeEditor, reopened);
});

test('browser add uses a fresh page and category routing retains files and secondary projects', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.openTool('browser');
  assert.deepEqual(f.calls.at(-1), ['simpleBrowser.show']);
  const browser = new WebviewInput('Browser'); browser.webview.providedViewType = 'simpleBrowser.view'; await f.open(browser);
  await f.workspace.newInstance('browser'); assert.equal(f.calls.at(-1)[2].forceNew, true);
  assert.equal(f.parts.get('browser').groups[0].contains(browser), true);
  const other = new WebviewInput('Other', 'file:///other'); other.webview.providedViewType = 'studio.projectTool'; await f.open(other);
  assert.equal(f.parts.get('project').groups[0].contains(other), true); assert.equal(f.parts.get('browser').groups[0].contains(browser), true);
});

test('entries opened from Assistant activate distinct project tabs while retaining the running project and Assistant', async t => {
  const f = fixture(t), runtime = new WebviewInput('Runtime', 'file:///project');
  await f.left.openEditor(runtime); await f.workspace.activate();
  await f.workspace.openTool('assistant');
  const assistant = f.parts.get('assistant').activeGroup.activeEditor;
  const entries = [];
  for (const name of ['Project Assistant', 'Studio Control', 'Project Assistant']) {
    const entry = new WebviewInput(name, 'studio-assistant:%2Fworkspace');
    entry.webview.providedViewType = 'studio.projectTool';
    entries.push(entry);
    await f.open(entry);
    assert.equal(f.active, 'project');
    assert.equal(f.activeGroup.activeEditor, entry);
    assert.equal(f.parts.get('project').visible, true);
    assert.equal(f.parts.get('assistant').visible, false);
    assert.equal(f.left.activeEditor, runtime);
    assert.equal(f.parts.get('assistant').groups[0].contains(assistant), true);
  }
  assert.equal(f.instances.length, 3);
  assert.deepEqual(f.parts.get('project').groups[0].editors, entries);
  await f.workspace.openTool('assistant');
  assert.equal(f.parts.get('assistant').activeGroup.activeEditor, assistant);
});

test('terminal native tabs close actual sessions with veto, while hiding the category preserves sessions', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.workspace.newInstance('terminal'); await f.workspace.newInstance('terminal');
  const first = f.instances[0].id; f.terminals.instances[0].veto = true;
  assert.equal(await f.workspace.close(first, true), false); assert.equal(f.instances.length, 2);
  f.terminals.instances[0].veto = false; await f.workspace.close(first, true); assert.equal(f.instances.length, 1);
  await f.workspace.close('terminal'); assert.equal(f.terminals.instances.length, 1); assert.equal(f.terminalGroups.instances.length, 1);
  assert.equal(f.tabs.some(tab => tab.id === 'terminal'), false);
  await f.workspace.openTool('terminal'); await settle(); assert.equal(f.instances.length, 1); assert.equal(f.terminals.instances.length, 1);
});

test('moving the last panel terminal does not create a duplicate during its asynchronous editor attachment', async t => {
  const f = fixture(t); await f.workspace.activate();
  const instance = { instanceId: 1, title: 'Existing shell' };
  f.terminals.instances = [instance]; f.terminalGroups.instances = [instance];
  let created = 0;
  f.terminals.createTerminal = async () => { ++created; };
  f.terminals.moveToEditor = () => {
    f.terminals.instances = []; f.terminalGroups.instances = [];
    f.viewChange.fire({ id: 'terminal', visible: true });
    f.terminals.instances = [instance];
  };
  await f.workspace.openTool('terminal'); await settle(); assert.equal(created, 0);
});

test('closing the terminal category reveals the selected fallback and a later terminal focus can reopen it', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.open(new EditorInput('file.ts', 'file:///file.ts'));
  await f.workspace.newInstance('terminal'); await f.workspace.close('terminal'); await settle();
  assert.equal(f.active, 'editor'); assert.equal(f.visibleView, 'studio.steamTools');
  f.viewChange.fire({ id: 'terminal', visible: true }); await settle();
  assert.equal(f.active, 'terminal'); assert.equal(f.instances.length, 1); assert.equal(f.terminals.instances.length, 1);
});

test('Steam terminals return to the panel on exit while preexisting IDE terminal editors retain their placement', async t => {
  const f = fixture(t), instance = { instanceId: 99, title: 'IDE terminal' }, input = new TerminalEditorInput(instance);
  await f.left.openEditor(input); await f.workspace.activate(); await f.workspace.newInstance('terminal');
  await f.workspace.deactivate(f.left);
  assert.equal(f.left.contains(input), true); assert.equal(f.terminalGroups.instances.length, 1);
  assert.equal(f.left.editors.filter(editor => editor instanceof TerminalEditorInput).length, 1);
});

test('file-backed custom editors use file tabs and standalone native inputs keep separate category groups', async t => {
  const f = fixture(t); await f.workspace.activate(); await f.open(new CustomEditorInput('image.svg', 'file:///project/image.svg'));
  const account = new EditorInput('Account'); account.typeId = 'studio.account'; await f.open(account);
  assert.deepEqual(Array.from(f.tabs, tab => tab.label), ['editor', 'Account']); assert.equal(f.sidebarVisible, false);
  assert.equal(f.parts.get('studio.account').groups[0].contains(account), true); assert.equal(f.right.editors.length, 1);
});

test('failed transfer back to IDE reports the failure and retains the live dirty input', async t => {
  const f = fixture(t); await f.workspace.activate(); const source = file('dirty.ts'); source.dirty = true; await f.open(source);
  f.right.moveVeto = true; await assert.rejects(f.workspace.deactivate(f.left), /Unable to move/);
  assert.equal(f.right.contains(source), true); assert.equal(source.isDirty(), true);
});
