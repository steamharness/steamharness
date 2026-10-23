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
const parts = { ACTIVITYBAR_PART: 'activity', SIDEBAR_PART: 'sidebar', PANEL_PART: 'panel', AUXILIARYBAR_PART: 'auxiliary', EDITOR_PART: 'editor', TITLEBAR_PART: 'titlebar', STATUSBAR_PART: 'statusbar' };
const locations = { Sidebar: 0, Panel: 1, AuxiliaryBar: 2 };

function fixture(t, saved = new Map()) {
  const commands = new Map(), stateChange = new Emitter(), calls = [], settings = new Map(), errors = [];
  const resized = new Emitter(), visibilityChanged = new Emitter(), windowResized = new Emitter();
  const state = { state: { available: false, labels: {} }, steam: false, busy: false, onDidChangeState: stateChange.event,
    setMode(steam, busy, targetSteam = steam) { this.steam = steam; this.busy = busy; this.targetSteam = targetSteam; } };
  const register = (id, handler) => { commands.set(id, handler); return { dispose: () => commands.delete(id) }; };
  const containers = new Map([
    ['studio-kv', { id: 'studio-kv', location: 1 }], ['studio-knowledge', { id: 'studio-knowledge', location: 1 }],
    ['studio-info', { id: 'studio-info', location: 0 }], ['studio-assistant', { id: 'studio-assistant', location: 2 }],
    ['studio-versions', { id: 'studio-versions', location: 0 }], ['studio-trace', { id: 'studio-trace', location: 1 }],
    ['studio-steam-tools', { id: 'studio-steam-tools', location: 2 }], ['files', { id: 'files', location: 0 }],
    ['terminal', { id: 'terminal', location: 1 }],
  ]);
  const viewContainers = { 'studio.kv': 'studio-kv', 'studio.knowledge': 'studio-knowledge', 'studio.projectInfo': 'studio-info',
    'studio.developerAssistant': 'studio-assistant', 'studio.versions': 'studio-versions', 'studio.trace': 'studio-trace', 'studio.steamTools': 'studio-steam-tools', terminal: 'terminal' };
  const visible = new Map(Object.values(parts).map(part => [part, true]));
  const sizes = new Map(Object.values(parts).map((part, index) => [part, { width: 48 + index * 100, height: 720 }]));
  const active = new Map([[0, 'files'], [1, 'studio-kv'], [2, 'studio-assistant']]);
  const classes = new Set();
  const document = { documentElement: { classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)) } },
    startViewTransition: callback => { calls.push('transition'); const finished = Promise.resolve().then(callback); return { ready: Promise.resolve(), updateCallbackDone: finished, finished, skipTransition: () => calls.push('skipTransition') }; } };
  const win = { document, setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) };
  const mainClasses = new Set();
  const mainContainer = { classList: { add: name => mainClasses.add(name), remove: name => mainClasses.delete(name), contains: name => mainClasses.has(name) }, querySelectorAll: () => [] };
  const elements = new Map(Object.values(parts).map(part => [part, { animate: (frames, options) => {
    calls.push(['animate', frames, part, options]);
    return f.animate?.(frames, part) ?? { finished: Promise.resolve(), cancel() {} };
  } }]));
  let maximized = false, groupMaximized = false, options = false;
  const layout = {
    onDidResizeParts: resized.event, onDidChangePartVisibility: visibilityChanged.event, onDidLayoutMainContainer: windowResized.event,
    setWindowChromeHidden: value => { f.chromeHidden = value; calls.push(['windowChrome', value]); },
    mainContainer, mainContainerDimension: { width: 1440, height: 900 },
    getContainer: (_window, part) => elements.get(part),
    isVisible: part => visible.get(part), getSize: part => ({ ...sizes.get(part) }),
    setPartHidden: (hidden, part) => {
      if (visible.get(part) === !hidden) { return; }
      visible.set(part, !hidden);
      if (hidden && part === 'auxiliary') { sizes.set(part, { ...sizes.get(part), width: 0 }); }
      visibilityChanged.fire({ partId: part, visible: !hidden });
    },
    setSize: (part, size) => sizes.set(part, { ...size }),
    isAuxiliaryBarMaximized: () => maximized, setAuxiliaryBarMaximized: value => { maximized = value; },
    isPanelMaximized: () => visible.get('panel') && !visible.get('editor') && !maximized,
    toggleMaximizedPanel: () => visible.set('editor', !visible.get('editor')),
  };
  const editor = { id: 'dirty source', isDirty: true }, result = { id: 'retained project webview' };
  const group = { id: 1, activeEditor: editor, contains: candidate => [editor, result].includes(candidate),
    openEditor: async candidate => { group.activeEditor = candidate; visible.set('editor', true); calls.push(['editor', candidate.id]); } };
  const editorLayout = { orientation: 0, groups: [{ size: .6 }, { size: .4 }] };
  const mainPart = { activeGroup: group, groups: [group, { id: 2 }], getGroup: id => mainPart.groups.find(group => group.id === id),
    getGroups: () => mainPart.groups,
    getLayout: () => groupMaximized ? { orientation: 0, groups: [{ size: 1.6 }, { size: .4 }] } : editorLayout,
    applyLayout: value => { groupMaximized = false; calls.push(['restoreGroups', value]); },
    toggleMaximizeGroup: () => { groupMaximized = !groupMaximized; calls.push(['toggleMaximizeGroup', groupMaximized]); },
    arrangeGroups: (_arrangement, target = mainPart.activeGroup) => { groupMaximized = true; calls.push('maximizeGroup'); calls.push(['maximizeGroupTarget', typeof target === 'number' ? target : target.id]); }, hasMaximizedGroup: () => groupMaximized,
    enforcePartOptions: value => { options = value; return { dispose: () => { options = false; } }; } };
  const groups = { ...mainPart, mainPart };
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
  const f = { calls, saved, visible, sizes, active, containers, settings, errors, state, editor, result, group, layout, groups, mainPart, views, win, classes, loading: false, projectOpen: false,
    resizeTools: width => { sizes.set('auxiliary', { ...sizes.get('auxiliary'), width }); resized.fire(); },
    resizeWindow: width => { layout.mainContainerDimension.width = width; windowResized.fire(layout.mainContainerDimension); },
    flush: () => storage.flush(),
    prepare: async () => { group.activeEditor = result; visible.set('editor', true); return true; },
    cancelPreparation: () => undefined,
    publish: available => { state.state.available = available; stateChange.fire(state.state); },
    run: (name, ...args) => commands.get(`studio.internal${name}`)(undefined, ...args),
    get options() { return options; } };
  const service = () => undefined;
  const common = {
    getWindow: () => win, Sequencer, Codicon: { tools: {} }, Disposable, DisposableStore, MutableDisposable, localize2: (key, value) => ({ value, original: value }),
    CommandsRegistry: { registerCommand: register }, ConfigurationTarget: { MEMORY: 8 }, ContextKeyExpr: { has: () => true },
    SyncDescriptor: class {}, Registry: { as: () => ({ registerViewContainer: value => containers.get(value.id) ?? value, registerViews() {} }) },
    StorageScope: { WORKSPACE: 1 }, StorageTarget: { MACHINE: 1 }, StudioSteamTools: class {}, studioModeState: state, studioWindowChrome: {},
    studioSteamToolDefinitions: Object.keys(viewContainers).filter(view => view !== 'studio.steamTools').map(view => ({
      id: { 'studio.projectInfo': 'info', 'studio.developerAssistant': 'assistant' }[view] ?? view.replace('studio.', ''), view,
    })).concat([{ id: 'browser', command: 'simpleBrowser.show' }, { id: 'project', command: 'studio.openProjectInTab' }]),
    StudioModeLoading: class { show() { f.loading = true; calls.push('loading'); } hide() { f.loading = false; } layout() {} dispose() {} },
    ViewPane: class {}, ViewPaneContainer: class {}, WorkbenchPhase: { AfterRestored: 3 }, registerWorkbenchContribution2() {},
    Extensions: {}, ViewContainerLocation: locations, GroupsArrangement: { MAXIMIZE: 0 }, GroupsOrder: { GRID_APPEARANCE: 2 }, Parts: parts,
  };
  const module = { exports: {} };
  runInNewContext(compiled, { exports: module.exports, module, require: () => new Proxy(common, { get: (object, key) => key in object ? object[key] : service }) });
  const controller = new module.exports.StudioModeContribution(layout, groups,
    { openEditor: (editor, options, group) => { groupMaximized = false; return group.openEditor(editor); } }, views, descriptors, context, configuration, storage,
    { executeCommand: async (command, ...args) => {
      if (command === 'studio.internalCancelSteamPreparation') { calls.push('cancelPreparation'); return f.cancelPreparation(); }
      if (command !== 'studio.internalPrepareSteamProject') { calls.push(['command', command, ...args]); return f.toolCommand?.(command); }
      calls.push('prepare'); const ready = await f.prepare(...args); if (ready) { f.projectOpen = true; } return ready;
    } }, { error: error => errors.push(String(error)) }, { createInstance: () => ({
      get hasProject() { return f.projectOpen; },
      activate: () => views.openView('studio.steamTools', true),
      home: () => views.openView('studio.steamTools', true),
      openTool: id => {
        const tool = common.studioSteamToolDefinitions.find(tool => tool.id === id);
        if (tool.command) { calls.push(['command', tool.command]); return f.toolCommand?.(tool.command); }
        return views.openView(tool.view, true);
      },
      deactivate: async () => undefined, select() {}, close() {}, dispose() {},
    }) });
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
  assert.equal(f.chromeHidden, true);
  assert.equal(f.state.steam, true); assert.deepEqual({ ...f.options }, { showTabs: 'none', editorActionsLocation: 'hidden' });
  assert.equal(f.group.activeEditor, f.result);
  for (const part of ['activity', 'sidebar', 'panel']) { assert.equal(f.visible.get(part), false); }
  assert.equal(f.settings.get('side'), 'left');
  assert.equal(f.active.get(2), 'studio-steam-tools');
  assert.equal(f.sizes.get('auxiliary').width, 480);
  await f.run('OpenSteamTool', 'kv'); await f.run('OpenSteamTool', 'info');
  assert.equal(f.containers.get('studio-kv').location, 2);
  assert.equal(f.containers.get('studio-info').location, 2);
  await f.run('OpenSteamTools'); assert.equal(f.active.get(2), 'studio-steam-tools');
  await f.run('EnterIdeMode');
  assert.equal(f.state.steam, false); assert.equal(f.options, false);
  assert.equal(f.settings.get('side'), 'right');
  assert.equal(f.containers.get('studio-kv').location, 1);
  assert.equal(f.containers.get('studio-info').location, 0);
  assert.equal(f.chromeHidden, false);
  assert.deepEqual(f.visible, beforeVisible); assert.deepEqual(f.sizes, beforeSizes); assert.deepEqual(f.active, beforeActive);
  assert.equal(f.group.activeEditor, f.editor); assert.equal(f.editor.isDirty, true);
  assert.equal(f.saved.has('studio.ideLayout'), false);
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
});

test('terminal tool and native view opens share the right workspace and restore the IDE location', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode');
  await f.run('OpenSteamTool', 'terminal');
  assert.equal(f.containers.get('terminal').location, 2);
  assert.equal(f.active.get(2), 'terminal'); assert.equal(f.visible.get('panel'), false);
  await f.run('OpenSteamTools'); await f.views.openView('terminal', true);
  assert.equal(f.active.get(2), 'terminal'); assert.equal(f.visible.get('panel'), false);
  await f.run('EnterIdeMode');
  assert.equal(f.containers.get('terminal').location, 1);
  await f.views.openView('terminal', true);
  assert.equal(f.active.get(1), 'terminal');
});

test('browser and project tools invoke native commands without inventing view tabs', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode');
  await f.run('OpenSteamTool', 'browser'); await f.run('OpenSteamTool', 'project');
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'command'), [
    ['command', 'simpleBrowser.show'], ['command', 'studio.openProjectInTab'],
  ]);
});

test('opening another project cannot replace the pinned runtime on retry or reload', async t => {
  const f = fixture(t); f.state.state.projectUri = 'file:///original'; f.publish(true);
  await f.run('EnterSteamMode');
  f.state.state.projectUri = 'file:///other'; f.projectOpen = false;
  let prepared; f.prepare = async uri => { prepared = uri; return true; };
  await f.run('EnterSteamMode'); assert.equal(prepared, 'file:///original');
  const restored = fixture(t, new Map(f.saved)); restored.state.state.projectUri = 'file:///other';
  restored.prepare = async uri => { prepared = uri; return true; }; restored.publish(true);
  await restored.run('EnterSteamMode'); assert.equal(prepared, 'file:///original');
});

test('a pending browser or project picker does not block returning to IDE', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode');
  let finish; f.toolCommand = () => new Promise(resolve => { finish = resolve; });
  const picking = f.run('OpenSteamTool', 'project');
  await f.run('EnterIdeMode'); assert.equal(f.state.steam, false);
  finish(); await picking;
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
  assert.equal(f.calls.filter(call => call === 'maximizeGroup').length, 1);
});

for (const initialSteam of [false, true]) {
  test(`reversing during the outgoing animation keeps ${initialSteam ? 'Steam' : 'IDE'} intact and skips obsolete initialization`, async t => {
    const f = fixture(t); f.publish(true);
    await f.run(initialSteam ? 'EnterSteamMode' : 'EnterIdeMode');
    f.calls.length = 0;
    f.animate = frames => {
      if (frames[1].opacity !== 0) return { finished: Promise.resolve(), cancel() {} };
      let finish;
      return { finished: new Promise(resolve => { finish = resolve; }), cancel: () => finish() };
    };
    const switching = f.run(initialSteam ? 'EnterIdeMode' : 'EnterSteamMode');
    await new Promise(resolve => setImmediate(resolve));
    const reverting = f.run(initialSteam ? 'EnterSteamMode' : 'EnterIdeMode');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.some(call => call[0] === 'windowChrome'), false);
    assert.equal(f.calls.some(call => call[0] === 'view'), false);
    assert.equal(f.calls.includes('prepare'), false);
    await Promise.all([switching, reverting]);
    await f.flush();
    assert.equal(f.saved.has('studio.ideLayout'), initialSteam);
    assert.equal(f.state.steam, initialSteam);
  });
}

test('cancelling persisted Steam startup before the layout changes remembers IDE for the next reload', async t => {
  const f = fixture(t, new Map([['studio.workbenchMode', 'steam']]));
  f.animate = frames => {
    if (frames[1].opacity !== 0) return { finished: Promise.resolve(), cancel() {} };
    let finish;
    return { finished: new Promise(resolve => { finish = resolve; }), cancel: () => finish() };
  };
  f.publish(true);
  await new Promise(resolve => setImmediate(resolve));
  await f.run('EnterIdeMode');
  assert.equal(f.saved.get('studio.workbenchMode'), 'ide');
  assert.equal(f.calls.includes('prepare'), false);
});

test('closing the ready project invalidates preparation even when Steam mode remains selected', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode');
  f.group.activeEditor = undefined;
  f.projectOpen = false;
  f.state.state.ready = false; f.publish(true);
  await f.run('EnterSteamMode');
  assert.equal(f.calls.filter(call => call === 'prepare').length, 2);
  assert.equal(f.calls.filter(call => call === 'maximizeGroup').length, 1);
  assert.equal(f.state.steam, true);
});

for (const failure of ['unavailable', 'error']) {
  test(`an outdated ${failure} preparation cannot cancel a newer Steam request`, async t => {
    const f = fixture(t); f.publish(true);
    let finish, fail;
    f.prepare = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const first = f.run('EnterSteamMode');
    await new Promise(resolve => setImmediate(resolve));
    f.prepare = async () => true;
    const latest = f.run('EnterSteamMode');
    if (failure === 'error') { fail(new Error('outdated project startup')); } else { finish(false); }
    await Promise.all([first, latest]);
    assert.equal(f.state.steam, true); assert.equal(f.state.busy, false);
    assert.equal(f.calls.filter(call => call === 'prepare').length, 2);
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'editor').length, 0);
  });
}

test('a superseded layout failure rolls back before retrying the newest Steam request', async t => {
  const f = fixture(t); f.publish(true);
  let fail;
  const openView = f.views.openView;
  f.views.openView = () => new Promise((resolve, reject) => { fail = reject; });
  const first = f.run('EnterSteamMode');
  await new Promise(resolve => setImmediate(resolve));
  f.views.openView = openView;
  const latest = f.run('EnterSteamMode');
  fail(new Error('outdated tool view'));
  await Promise.all([first, latest]);
  assert.equal(f.state.steam, true); assert.equal(f.saved.get('studio.workbenchMode'), 'steam');
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'restoreGroups').length, 1);
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
  const moves = f.calls.filter(call => Array.isArray(call) && call[0] === 'move' && call[1] === 'studio-kv').length;
  await f.run('OpenSteamTool', '__proto__'); f.publish(true); f.publish(true);
  await f.run('EnterSteamMode'); assert.equal(f.calls.length, count);
  await f.run('OpenSteamTool', 'kv'); await f.run('OpenSteamTool', 'kv');
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'move' && call[1] === 'studio-kv').length, moves);
});

test('cold startup shows the live Steam layout while preparation is pending', async t => {
  const f = fixture(t); f.publish(true);
  let finish;
  f.prepare = () => new Promise(resolve => { finish = resolve; });
  const entering = f.run('EnterSteamMode');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual({ steam: f.state.steam, busy: f.state.busy, loading: f.loading, sidebar: f.visible.get('sidebar'), transitions: f.classes.size },
    { steam: true, busy: true, loading: true, sidebar: false, transitions: 0 });
  finish(true); await entering;
  assert.equal(f.loading, false); assert.equal(f.state.busy, false);
});

test('returning to IDE cancels pending preparation without waiting for project readiness', async t => {
  const f = fixture(t); f.publish(true);
  let finish;
  f.prepare = () => new Promise(resolve => { finish = resolve; });
  f.cancelPreparation = () => finish(false);
  const entering = f.run('EnterSteamMode');
  await new Promise(resolve => setImmediate(resolve));
  await f.run('EnterIdeMode'); await entering;
  assert.deepEqual({ steam: f.state.steam, busy: f.state.busy, loading: f.loading, editor: f.group.activeEditor.id },
    { steam: false, busy: false, loading: false, editor: f.editor.id });
  assert.equal(f.calls.includes('cancelPreparation'), true);
});

test('a retained project frame is revealed before animating the incoming Steam view', async t => {
  const f = fixture(t); f.state.state.ready = true; f.publish(true);
  let incomingLoading;
  f.animate = frames => {
    if (frames[0].opacity === 0) incomingLoading = f.loading;
    return { finished: Promise.resolve(), cancel() {} };
  };
  await f.run('EnterSteamMode');
  assert.equal(incomingLoading, false); assert.equal(f.group.activeEditor, f.result);
});

test('slow view initialization retains a live loading state and still animates its incoming layout', async t => {
  const f = fixture(t); f.publish(true);
  let finish;
  const open = f.views.openView;
  f.views.openView = async (...args) => { await new Promise(resolve => { finish = resolve; }); return open(...args); };
  const entering = f.run('EnterSteamMode');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.loading, true); assert.equal(f.calls.includes('transition'), false);
  finish(); await entering;
  assert.ok(f.calls.some(call => call[0] === 'animate' && call[1][0].opacity === 0));
});

test('asynchronous view restoration measures the layout after outgoing transforms have been removed', async t => {
  const f = fixture(t), effects = new Set(); f.publish(true);
  f.animate = () => {
    const effect = { finished: Promise.resolve(), cancel: () => effects.delete(effect) };
    effects.add(effect); return effect;
  };
  const open = f.views.openView;
  f.views.openView = async (...args) => {
    assert.equal(effects.size, 0, 'Layout measurements must not include outgoing translations');
    assert.equal(f.layout.mainContainer.classList.contains('studio-mode-changing-layout'), true);
    return open(...args);
  };
  await f.run('EnterSteamMode');
  assert.equal(effects.size, 0);
  assert.equal(f.layout.mainContainer.classList.contains('studio-mode-changing-layout'), false);
});

test('both directions fade outgoing chrome before hiding it and fade in every visible incoming part', async t => {
  const f = fixture(t); f.publish(true);
  await f.run('EnterSteamMode'); await f.run('EnterIdeMode');
  const effects = f.calls.filter(call => call[0] === 'animate');
  assert.deepEqual([...new Set(effects.map(call => call[1].map(frame => frame.opacity).join(',')))].sort(), ['0,1', '1,0']);
  assert.ok(effects.some(call => call[1][0].transform === 'translateX(32px)'));
  assert.ok(effects.some(call => call[1][0].transform === 'translateX(-32px)'));
  for (const part of ['titlebar', 'statusbar', 'activity', 'sidebar', 'panel']) {
    assert.ok(effects.some(call => call[2] === part && call[1][1].opacity === 0), `${part} has an exit effect`);
    assert.ok(effects.some(call => call[2] === part && call[1][0].opacity === 0), `${part} has an entrance effect`);
  }
  const firstHide = f.calls.findIndex(call => call[0] === 'windowChrome' && call[1]);
  assert.ok(f.calls.slice(0, firstHide).some(call => call[0] === 'animate' && call[1][1].opacity === 0));
});

test('reduced motion applies the layout immediately and each mode retains its own tool width', async t => {
  const f = fixture(t); f.win.matchMedia = () => ({ matches: true });
  f.publish(true); await f.run('EnterSteamMode'); f.resizeTools(512);
  await f.run('EnterIdeMode'); await f.run('EnterSteamMode');
  assert.equal(f.sizes.get('auxiliary').width, 512);
  assert.equal(f.calls.some(call => call[0] === 'animate'), false);
});

test('the workbench reduced-motion preference also skips the workspace effects', async t => {
  const f = fixture(t); f.layout.mainContainer.classList.contains = name => name === 'monaco-reduce-motion';
  f.publish(true); await f.run('EnterSteamMode'); await f.run('EnterIdeMode');
  assert.equal(f.calls.some(call => call[0] === 'animate'), false);
});

test('layout visibility changes wait until outgoing elements finish fading', async t => {
  const f = fixture(t), finish = []; f.publish(true);
  f.animate = frames => {
    if (frames[1].opacity !== 0) return { finished: Promise.resolve(), cancel() {} };
    let resolve;
    const finished = new Promise(done => { resolve = done; }); finish.push(resolve);
    return { finished, cancel: resolve };
  };
  const entering = f.run('EnterSteamMode');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.chromeHidden, undefined); assert.ok(finish.length > 0);
  for (const resolve of finish) resolve();
  await entering;
  assert.equal(f.chromeHidden, true);
});

test('tools default to a third of the window until the user chooses a width', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode');
  for (const [windowWidth, toolWidth] of [[1440, 480], [1200, 400], [800, 280], [480, 170], [1800, 600]]) {
    f.resizeWindow(windowWidth);
    assert.equal(f.sizes.get('auxiliary').width, toolWidth);
  }
  await f.run('EnterIdeMode'); await f.flush();
  assert.equal(f.saved.has('studio.steamToolsWidth'), false, 'Automatic layout must not become a user preference');
});

test('dragged tool width survives hiding, mode switches and reload without first leaving Steam', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode'); f.resizeTools(576);
  await f.flush();
  assert.equal(f.saved.get('studio.steamToolsWidth'), 576);
  f.layout.setPartHidden(true, 'auxiliary');
  f.layout.setPartHidden(false, 'auxiliary');
  assert.equal(f.sizes.get('auxiliary').width, 576);
  f.layout.setPartHidden(true, 'auxiliary');
  await f.run('EnterIdeMode');
  assert.equal(f.sizes.get('auxiliary').width, 348, 'The IDE retains its separate width');
  f.resizeTools(420); // An IDE resize must not overwrite the Steam preference.
  await f.run('EnterSteamMode');
  assert.equal(f.sizes.get('auxiliary').width, 576);
  await f.flush();
  const restarted = fixture(t, new Map(f.saved));
  restarted.publish(true); await restarted.run('OpenSteamTools');
  assert.equal(restarted.sizes.get('auxiliary').width, 576);
});

test('narrow windows and hidden tools do not overwrite the preferred width across reloads', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode'); f.resizeTools(720);
  f.resizeWindow(800);
  assert.equal(f.sizes.get('auxiliary').width, 480);
  f.layout.setPartHidden(true, 'auxiliary'); await f.run('EnterIdeMode');
  await f.flush();
  assert.equal(f.saved.get('studio.steamToolsWidth'), 720);
  const restarted = fixture(t, new Map(f.saved)); restarted.resizeWindow(800);
  restarted.publish(true); await restarted.run('EnterSteamMode');
  assert.equal(restarted.sizes.get('auxiliary').width, 480);
  restarted.resizeWindow(1440);
  assert.equal(restarted.sizes.get('auxiliary').width, 720);
});

test('hidden, maximized or invalid tool sizes cannot become saved preferences', async t => {
  const f = fixture(t); f.publish(true); await f.run('EnterSteamMode'); f.resizeTools(600);
  f.layout.setPartHidden(true, 'auxiliary'); f.resizeTools(0);
  f.layout.setPartHidden(false, 'auxiliary');
  f.layout.setAuxiliaryBarMaximized(true); f.resizeTools(1440);
  f.layout.setAuxiliaryBarMaximized(false);
  for (const width of [0, -1, NaN, Infinity]) { f.resizeTools(width); }
  await f.flush();
  assert.equal(f.saved.get('studio.steamToolsWidth'), 600);
});

test('invalid stored tool widths fall back to a third of the window', async t => {
  for (const width of [0, -1, NaN, Infinity]) {
    const f = fixture(t, new Map([['studio.steamToolsWidth', width]]));
    f.publish(true); await f.run('EnterSteamMode');
    assert.equal(f.sizes.get('auxiliary').width, 480);
  }
});

test('mode changes use the main editor part even when an auxiliary editor window is active', async t => {
  const f = fixture(t);
  const auxiliary = { id: 3, activeEditor: { id: 'auxiliary source' } };
  f.groups.activeGroup = auxiliary;
  f.groups.groups = [...f.mainPart.groups, auxiliary];
  f.groups.getLayout = () => assert.fail('must not capture the active auxiliary window');
  f.groups.applyLayout = () => assert.fail('must not restore into the active auxiliary window');
  f.groups.arrangeGroups = () => assert.fail('must not maximize the active auxiliary window');
  f.publish(true); await f.run('EnterSteamMode');
  f.groups.groups.pop(); // Closing an auxiliary window must not block main-window restoration.
  await f.run('EnterIdeMode');
  assert.equal(f.group.activeEditor, f.editor);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'restoreGroups').length, 1);
});

test('returning to IDE restores an originally maximized panel after reopening the source editor', async t => {
  const f = fixture(t); f.visible.set('editor', false);
  assert.equal(f.layout.isPanelMaximized(), true);
  f.publish(true); await f.run('EnterSteamMode');
  assert.equal(f.visible.get('editor'), true);
  await f.run('EnterIdeMode');
  assert.equal(f.layout.isPanelMaximized(), true);
});

test('returning to IDE restores maximized groups from their original unmaximized proportions', async t => {
  const f = fixture(t); f.mainPart.arrangeGroups();
  f.publish(true);
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.run('EnterSteamMode'); await f.run('EnterIdeMode');
    assert.equal(f.mainPart.hasMaximizedGroup(), true);
  }
  const restores = f.calls.filter(call => Array.isArray(call) && call[0] === 'restoreGroups');
  assert.deepEqual(restores.map(call => JSON.parse(JSON.stringify(call[1]))), Array.from({ length: 3 }, () => ({ orientation: 0, groups: [{ size: .6 }, { size: .4 }] })));
  assert.ok(f.calls.findIndex(call => Array.isArray(call) && call[0] === 'toggleMaximizeGroup') < f.calls.findIndex(call => Array.isArray(call) && call[0] === 'windowChrome'));
});

test('Steam maximizes the result column while IDE restores a different maximized source group', async t => {
  const f = fixture(t);
  const source = { ...f.group, id: 2 };
  f.mainPart.groups[1] = source; f.mainPart.activeGroup = source;
  f.mainPart.arrangeGroups();
  f.publish(true); await f.run('EnterSteamMode'); await f.run('EnterIdeMode');
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'maximizeGroupTarget').map(call => call[1]), [2, 1, 2]);
});

test('interrupted animations complete the mode request and release all effects', async t => {
  const f = fixture(t); f.publish(true);
  let cancelled = 0;
  f.animate = () => ({ finished: Promise.reject(new Error('Animation was cancelled')), cancel() { cancelled++; } });
  await f.run('EnterSteamMode'); await f.run('EnterIdeMode');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.steam, false); assert.equal(f.state.busy, false); assert.ok(cancelled > 0);
});
