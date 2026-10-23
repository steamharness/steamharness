import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const toolCode = await compile('../extensions/studio-workstation/src/tool-instances.ts');
const browserCode = await compile('../upstream/vscode/extensions/simple-browser/src/simpleBrowserManager.ts');
class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
}
function fixture(t, options = {}) {
  const panels = [], commands = new Map(), serializers = new Map(), instances = [];
  const panel = (viewType, title) => {
    const closed = new Emitter(), changed = new Emitter();
    const result = { viewType, title, active: true, visible: true, viewColumn: 1, webview: {},
      onDidDispose: closed.event, onDidChangeViewState: changed.event,
      reveal() { for (const other of panels) { other.active = false; } result.active = true; changed.fire({ webviewPanel: result }); },
      dispose() { if (!result.disposed) { result.disposed = true; closed.fire(); } },
    };
    for (const other of panels) { other.active = false; }
    panels.push(result); return result;
  };
  const disposable = { dispose() {} }, context = { subscriptions: [] };
  const vscode = { ViewColumn: { Active: 1 }, commands: {
    registerCommand: (id, run) => { assert.equal(commands.has(id), false); commands.set(id, run); return disposable; },
    executeCommand: (id, ...args) => commands.get(id)?.(...args),
  }, window: {
    registerWebviewPanelSerializer: (id, serializer) => { serializers.set(id, serializer); return disposable; },
    createWebviewPanel: (type, title, column, webviewOptions) => { const created = panel(type, title); created.options = webviewOptions; return created; },
  } };
  const module = { exports: {} };
  runInNewContext(toolCode, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : { t: value => value } });
  const manager = new module.exports.ToolInstances(context, (kind, subscriptions, restored) => {
    const instance = { kind, restored, updates: [], selected: undefined,
      update(projects, preferred) { instance.updates.push([projects, preferred]); instance.selected ??= preferred; return options.update?.(); },
      resolve(view) { instance.view = view; }, selectProject: async () => { instance.picked = true; },
    };
    subscriptions.push({ dispose() { instance.disposed = true; } }); instances.push(instance); return instance;
  });
  t.after(() => manager.dispose());
  return { manager, panels, panel, commands, serializers, instances };
}

test('each tool creates independent retained panels and closes only its own controller', async t => {
  const f = fixture(t), projects = [{ uri: 'file:///first' }, { uri: 'file:///second' }];
  f.manager.update(projects, projects[0]);
  for (const kind of ['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace']) {
    f.manager.update(projects, projects[0]);
    await f.commands.get('studio.createToolInstance')(kind); await f.manager.open(kind);
    const [first, second] = f.instances.slice(-2), [a, b] = f.panels.slice(-2);
    assert.notEqual(first, second); assert.notEqual(first.view.webview, second.view.webview);
    assert.equal(first.restored, false); assert.equal(second.restored, false);
    assert.equal(a.options.retainContextWhenHidden, true);
    first.selected = projects[1]; f.manager.update(projects, projects[1]);
    assert.equal(first.updates.at(-1)[1], projects[0]); assert.equal(first.selected, projects[1]); assert.equal(second.selected, projects[0]);
    await f.commands.get('studio.selectToolInstanceProject')(); assert.equal(second.picked, true); assert.equal(first.picked, undefined);
    a.dispose(); assert.equal(first.disposed, true); assert.equal(second.disposed, undefined);
    await f.manager.open(kind); assert.equal(f.panels.at(-1).title.endsWith(' 4'), true);
    assert.equal(b.disposed, undefined);
  }
  await f.manager.open('unrecognized'); assert.equal(f.panels.length, 18); assert.equal(f.serializers.size, 6);
});

test('restored panels keep their project URI through delayed discovery and reserve their instance number', async t => {
  const f = fixture(t), restored = f.panel('studio.tool.kv', 'KV Storage 8');
  await f.serializers.get(restored.viewType).deserializeWebviewPanel(restored, { projectUri: 'file:///second' });
  assert.equal(f.instances[0].restored, true);
  const projects = [{ uri: 'file:///first' }, { uri: 'file:///second' }];
  f.manager.update(projects, projects[0]);
  assert.equal(f.instances[0].updates.at(-1)[1], projects[1]);
  await f.manager.open('kv'); assert.equal(f.panels.at(-1).title, 'KV Storage 9');
});

test('deserialization without saved state still restores rather than creating another tool session', async t => {
  const f = fixture(t), restored = f.panel('studio.tool.assistant', 'Assistant 2');
  await f.serializers.get(restored.viewType).deserializeWebviewPanel(restored, undefined);
  assert.equal(f.instances[0].restored, true);
  await f.manager.open('assistant'); assert.equal(f.instances[1].restored, false);
});

test('closing a tool during asynchronous initialization never resolves or leaks the retired panel', async t => {
  let finish;
  const f = fixture(t, { update: () => new Promise(resolve => { finish = resolve; }) });
  const opening = f.manager.open('knowledge'); f.panels[0].dispose(); finish(); await opening;
  assert.equal(f.instances[0].disposed, true); assert.equal(f.instances[0].view, undefined);
});

test('browser forceNew retains separate pages and future navigation follows the selected surviving view', () => {
  const views = [];
  const create = url => {
    const closed = new Emitter(), changed = new Emitter();
    const view = { url, active: true, onDispose: closed.event, onDidChangeViewState: changed.event,
      show(url) { view.url = url; }, select() { for (const other of views) { other.active = false; } view.active = true; changed.fire(); },
      dispose() { view.disposed = true; closed.fire(); },
    }; views.push(view); return view;
  };
  const module = { exports: {} };
  runInNewContext(browserCode, { module, exports: module.exports, require: name => name === 'vscode' ? {} : { SimpleBrowserView: { create: (_uri, url) => create(url), restore: (_uri, url) => create(url) } } });
  const manager = new module.exports.SimpleBrowserManager({});
  manager.show('https://first.test'); manager.show('https://second.test', { forceNew: true });
  assert.equal(views.length, 2); assert.equal(views[0].url, 'https://first.test');
  views[0].select(); manager.show('https://first-next.test');
  assert.equal(views[0].url, 'https://first-next.test'); assert.equal(views[1].url, 'https://second.test');
  views[0].dispose(); manager.show('https://second-next.test');
  assert.equal(views.length, 2); assert.equal(views[1].url, 'https://second-next.test');
  manager.dispose(); assert.equal(views[1].disposed, true);
});
