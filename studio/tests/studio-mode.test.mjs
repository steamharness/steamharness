import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../upstream/vscode/src/vs/workbench/contrib/studioMode/browser/studioMode.contribution.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;

class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
}
class Disposable {
  _store = { isDisposed: false };
  disposables = [];
  _register(value) { this.disposables.push(value); return value; }
  dispose() { this._store.isDisposed = true; this.disposables.forEach(value => value.dispose()); }
}
class MutableDisposable {
  set value(value) { this.clear(); this.current = value; }
  clear() { this.current?.dispose(); this.current = undefined; }
  dispose() { this.clear(); }
}
class DisposableStore {
  items = [];
  add(item) { this.items.push(item); return item; }
  clear() { this.items.splice(0).forEach(item => item.dispose()); }
  dispose() { this.clear(); }
}
class Sequencer {
  current = Promise.resolve();
  queue(task) { const next = this.current.then(task, task); this.current = next; return next; }
}
const parts = { ACTIVITYBAR_PART: 'activity', SIDEBAR_PART: 'sidebar', PANEL_PART: 'panel', AUXILIARYBAR_PART: 'auxiliary', EDITOR_PART: 'editor' };
const locations = { Sidebar: 0, Panel: 1, AuxiliaryBar: 2 };

function fixture(t, saved = new Map()) {
  const commands = new Map(), stateChange = new Emitter(), calls = [], settings = new Map(), errors = [];
  const state = { state: { available: false, labels: {} }, steam: false, busy: false, onDidChangeState: stateChange.event,
    setMode(steam, busy) { this.steam = steam; this.busy = busy; } };
  const register = (id, handler) => { commands.set(id, handler); return { dispose: () => commands.delete(id) }; };
  const containers = new Map([
    ['studio-kv', { id: 'studio-kv', location: 1 }], ['studio-knowledge', { id: 'studio-knowledge', location: 1 }],
    ['studio-info', { id: 'studio-info', location: 0 }], ['studio-assistant', { id: 'studio-assistant', location: 2 }],
    ['studio-versions', { id: 'studio-versions', location: 0 }], ['studio-trace', { id: 'studio-trace', location: 1 }],
    ['studio-steam-tools', { id: 'studio-steam-tools', location: 2 }], ['files', { id: 'files', location: 0 }],
  ]);
  const viewContainers = { 'studio.kv': 'studio-kv', 'studio.knowledge': 'studio-knowledge', 'studio.projectInfo': 'studio-info',
    'studio.developerAssistant': 'studio-assistant', 'studio.versions': 'studio-versions', 'studio.trace': 'studio-trace', 'studio.steamTools': 'studio-steam-tools' };
  const visible = new Map(Object.values(parts).map(part => [part, true]));
  const sizes = new Map(Object.values(parts).map((part, index) => [part, { width: 48 + index * 100, height: 720 }]));
  const active = new Map([[0, 'files'], [1, 'studio-kv'], [2, 'studio-assistant']]);
  const document = { documentElement: { classList: { add() {}, remove() {} } },
    startViewTransition: callback => { calls.push('transition'); const finished = Promise.resolve().then(callback); return { updateCallbackDone: finished, finished }; } };
  const win = { document, matchMedia: () => ({ matches: false }) };
  const mainContainer = { classList: { add() {}, remove() {} } };
  let maximized = false, options = false;
  const layout = {
    mainContainer, mainContainerDimension: { width: 1440, height: 900 },
    isVisible: part => visible.get(part), getSize: part => ({ ...sizes.get(part) }),
    setPartHidden: (hidden, part) => visible.set(part, !hidden), setSize: (part, size) => sizes.set(part, { ...size }),
    isAuxiliaryBarMaximized: () => maximized, setAuxiliaryBarMaximized: value => { maximized = value; },
  };
  const editor = { id: 'dirty source', isDirty: true }, result = { id: 'retained project webview' };
  const group = { id: 1, activeEditor: editor, contains: candidate => [editor, result].includes(candidate),
    openEditor: async candidate => { group.activeEditor = candidate; calls.push(['editor', candidate.id]); } };
  const editorLayout = { orientation: 0, groups: [{ size: .6 }, { size: .4 }] };
  const groups = { activeGroup: group, groups: [group, { id: 2 }], getGroup: id => groups.groups.find(group => group.id === id),
    getLayout: () => editorLayout, applyLayout: value => calls.push(['restoreGroups', value]), arrangeGroups: () => calls.push('maximizeGroup'),
    enforcePartOptions: () => { options = true; return { dispose: () => { options = false; } }; } };
  const views = {
    getVisibleViewContainer: location => containers.get(active.get(location)),
    openView: async id => { calls.push(['view', id]); const container = containers.get(viewContainers[id]); if (container) { active.set(container.location, container.id); visible.set(container.location === 2 ? 'auxiliary' : container.location === 1 ? 'panel' : 'sidebar', true); } },
    openViewContainer: async id => { const container = containers.get(id); active.set(container.location, id); },
    closeViewContainer: id => { for (const [key, value] of active) { if (value === id) { active.delete(key); } } },
  };
  const descriptors = {
    getViewContainerByViewId: id => containers.get(viewContainers[id]), getViewContainerById: id => containers.get(id),
    getViewContainerLocation: container => container.location,
    getViewContainersByLocation: location => [...containers.values()].filter(container => container.location === location),
    moveViewContainerToLocation: (container, location, index) => { calls.push(['move', container.id, location, index]); container.location = location; },
    overrideViewContainerLocation: (container, location) => {
      const previous = container.location;
      if (previous === location) { return { dispose() {} }; }
      calls.push(['move', container.id, location]); container.location = location;
      return { dispose: () => { container.location = previous; } };
    },
  };
  const configuration = { inspect: () => ({ memoryValue: settings.get('side') }),
    updateValue: async (key, value, target) => { assert.equal(target, 8); settings.set('side', value); calls.push(['config', key, value]); } };
  const pending = new Map();
  const stored = key => pending.has(key) ? pending.get(key) : saved.get(key);
  const storage = { getObject: key => stored(key) === undefined ? undefined : structuredClone(stored(key)), get: stored,
    getNumber: (key, scope, fallback) => stored(key) ?? fallback,
    store: (key, value) => pending.set(key, structuredClone(value)), remove: key => pending.set(key, undefined),
    flush: async () => { for (const [key, value] of pending) { if (value === undefined) { saved.delete(key); } else { saved.set(key, value); } } pending.clear(); } };
  const context = { createKey: id => ({ set: value => settings.set(id, value) }) };
  const f = { calls, saved, visible, sizes, active, containers, settings, errors, state, editor, result, group, layout, groups, win,
    prepare: async () => { group.activeEditor = result; return true; },
    publish: available => { state.state.available = available; stateChange.fire(state.state); },
    run: (name, ...args) => commands.get(`studio.internal${name}`)(undefined, ...args),
    get options() { return options; } };
  const service = () => undefined;
  const common = {
    getWindow: () => win, Sequencer, Codicon: { tools: {} }, Disposable, DisposableStore, MutableDisposable, localize2: (key, value) => ({ value, original: value }),
    CommandsRegistry: { registerCommand: register }, ConfigurationTarget: { MEMORY: 8 }, ContextKeyExpr: { has: () => true },
    SyncDescriptor: class {}, Registry: { as: () => ({ registerViewContainer: value => value, registerViews() {} }) },
    StorageScope: { WORKSPACE: 1 }, StorageTarget: { MACHINE: 1 }, StudioSteamTools: class {}, studioModeState: state,
    ViewPane: class {}, ViewPaneContainer: class {}, WorkbenchPhase: { AfterRestored: 3 }, registerWorkbenchContribution2() {},
    Extensions: {}, ViewContainerLocation: locations, GroupsArrangement: { MAXIMIZE: 0 }, Parts: parts,
  };
  const module = { exports: {} };
  runInNewContext(compiled, { exports: module.exports, module, require: () => new Proxy(common, { get: (object, key) => key in object ? object[key] : service }) });
  const controller = new module.exports.StudioModeContribution(layout, groups, views, descriptors, context, configuration, storage,
    { executeCommand: async () => { calls.push('prepare'); return f.prepare(); } }, { error: error => errors.push(String(error)) });
  t.after(() => controller.dispose());
  return f;
}

test('ordinary folders cannot enter Steam mode or start a project worker', async t => {
  const f = fixture(t); f.publish(false);
  await f.run('EnterSteamMode');
  assert.equal(f.state.steam, false); assert.equal(f.state.busy, false);
  assert.deepEqual(f.calls, []);
});

test('Steam mode keeps the existing result and restores IDE parts, tools, groups and dirty source', async t => {
  const f = fixture(t); f.settings.set('side', 'right');
  const beforeVisible = new Map(f.visible), beforeSizes = new Map(f.sizes), beforeActive = new Map(f.active);
  f.publish(true); await f.run('EnterSteamMode');
  assert.equal(f.state.steam, true); assert.equal(f.options, true);
  assert.equal(f.group.activeEditor, f.result);
  for (const part of ['activity', 'sidebar', 'panel']) { assert.equal(f.visible.get(part), false); }
  assert.equal(f.settings.get('side'), 'left');
  assert.equal(f.active.get(2), 'studio-steam-tools');
  assert.equal(f.sizes.get('auxiliary').width, 648);
  await f.run('OpenSteamTool', 'kv'); await f.run('OpenSteamTool', 'info');
  assert.equal(f.containers.get('studio-kv').location, 2);
  assert.equal(f.containers.get('studio-info').location, 2);
  await f.run('OpenSteamTools'); assert.equal(f.active.get(2), 'studio-steam-tools');
  await f.run('EnterIdeMode');
  assert.equal(f.state.steam, false); assert.equal(f.options, false);
  assert.equal(f.settings.get('side'), 'right');
  assert.equal(f.containers.get('studio-kv').location, 1);
  assert.equal(f.containers.get('studio-info').location, 0);
  assert.deepEqual(f.visible, beforeVisible); assert.deepEqual(f.sizes, beforeSizes); assert.deepEqual(f.active, beforeActive);
  assert.equal(f.group.activeEditor, f.editor); assert.equal(f.editor.isDirty, true);
  assert.equal(f.saved.has('studio.ideLayout'), false);
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
});

test('rapid mode requests coalesce while a project is preparing', async t => {
  const f = fixture(t); f.publish(true);
  let ready;
  f.prepare = () => new Promise(resolve => { ready = resolve; });
  const entering = f.run('EnterSteamMode');
  await new Promise(resolve => setImmediate(resolve));
  const leaving = f.run('EnterIdeMode'); ready(true);
  await Promise.all([entering, leaving]);
  assert.equal(f.state.steam, false); assert.equal(f.state.busy, false);
  assert.equal(f.saved.has('studio.ideLayout'), false);
  assert.equal(f.calls.filter(call => call === 'maximizeGroup').length, 0);
});

test('project removal restores the IDE and persisted tool positions after a restart', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode'); await f.run('OpenSteamTool', 'knowledge');
  const saved = new Map(f.saved);
  const restored = fixture(t, saved);
  restored.publish(false); await restored.run('EnterIdeMode');
  assert.equal(restored.state.steam, false); assert.equal(restored.containers.get('studio-knowledge').location, 1);
  assert.equal(saved.has('studio.ideLayout'), false); assert.equal(saved.get('studio.workbenchMode'), 'ide');
});

test('an immediate restart restores Steam mode and the saved IDE layout before delayed storage writes', async t => {
  const f = fixture(t); f.publish(true);
  await f.run('EnterSteamMode'); await f.run('EnterIdeMode'); await f.run('EnterSteamMode');
  const restarted = fixture(t, new Map(f.saved));
  restarted.publish(true); await restarted.run('OpenSteamTools');
  assert.equal(restarted.state.steam, true);
  assert.equal(restarted.visible.get('sidebar'), false);
  await restarted.run('EnterIdeMode');
  assert.equal(restarted.visible.get('sidebar'), true);
  assert.equal(restarted.containers.get('studio-kv').location, 1);
});

test('failed preparation, invalid tools and duplicate updates preserve the current layout', async t => {
  const f = fixture(t); f.publish(true); f.prepare = async () => false;
  await f.run('EnterSteamMode'); assert.equal(f.state.steam, false); assert.equal(f.options, false);
  f.prepare = async () => true; await f.run('EnterSteamMode');
  const count = f.calls.length;
  await f.run('OpenSteamTool', '__proto__'); f.publish(true); f.publish(true);
  await f.run('EnterSteamMode'); assert.equal(f.calls.length, count);
  await f.run('OpenSteamTool', 'kv'); await f.run('OpenSteamTool', 'kv');
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'move' && call[1] === 'studio-kv').length, 1);
});

test('reduced motion applies the layout immediately and each mode retains its own tool width', async t => {
  const f = fixture(t); f.win.matchMedia = () => ({ matches: true });
  f.publish(true); await f.run('EnterSteamMode'); f.sizes.set('auxiliary', { width: 512, height: 720 });
  await f.run('EnterIdeMode'); await f.run('EnterSteamMode');
  assert.equal(f.sizes.get('auxiliary').width, 512);
  assert.equal(f.calls.includes('transition'), false);
});
