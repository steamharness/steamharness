import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = new URL('../upstream/vscode/src/vs/workbench/', import.meta.url);
const compile = async file => ts.transpileModule(await readFile(new URL(file, root), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const [model, registration] = await Promise.all([compile('common/studioSidebar.ts'), compile('browser/parts/auxiliarybar/studioSidebarTabs.ts')]);
const ids = values => Array.from(values, value => value.id);
const tab = (id, icon = 'layout') => ({ id, viewId: `studio.${id}`, title: id, icon });
const assistant = tab('studio-assistant', 'steamharness-bot'), board = tab('studio-sidebar.board'), bot = tab('studio-sidebar.bot', 'steamharness-bot');

function fixture({ visible = true, saved } = {}) {
  const commands = new Map(), containers = new Map(), views = new Map(), opens = [], registered = [], events = new Set();
  const parts = { AUXILIARYBAR_PART: 'workbench.parts.auxiliarybar' };
  const registry = {
    get: id => containers.get(id),
    registerViewContainer(container, location) {
      assert.equal(location, 2);
      containers.set(container.id, container); registered.push(container.id); return container;
    },
    deregisterViewContainer(container) { containers.delete(container.id); if (active === container.id) active = undefined; },
  };
  const viewRegistry = {
    getView: id => [...views.values()].flat().find(view => view.id === id),
    getViews: container => views.get(container.id),
    registerViews(descriptors, container) { views.set(container.id, descriptors); },
    deregisterViews(_descriptors, container) { views.delete(container.id); },
  };
  let active;
  const services = {
    IViewsService: { openViewContainer: async (id, focus) => { opens.push({ id, focus }); active = id; } },
    IWorkbenchLayoutService: { isVisible: part => part === parts.AUXILIARYBAR_PART && visible },
    IPaneCompositePartService: { getLastActivePaneCompositeId: () => active ?? saved, getActivePaneComposite: () => active },
  };
  const models = {}, globals = {
    Emitter: class { event = listener => events.add(listener); fire() { for (const listener of events) listener(); } },
    CommandsRegistry: { registerCommand: (id, run) => commands.set(id, run) },
    Registry: { as: extension => extension === 'containers' ? registry : viewRegistry },
    Extensions: { ViewContainersRegistry: 'containers', ViewsRegistry: 'views' },
    ViewContainerLocation: { AuxiliaryBar: 2 },
    ThemeIcon: { fromId: id => ({ id }) }, Parts: parts,
    ExtensionIdentifier: class { constructor(value) { this.value = value; } },
    SyncDescriptor: class {}, ViewPaneContainer: class {}, WebviewViewPane: class {},
    ...Object.fromEntries(Object.keys(services).map(service => [service, service])),
  };
  runInNewContext(model, { exports: models, require: () => globals });
  runInNewContext(registration, { exports: {}, require: id => id.endsWith('/studioSidebar.js') ? models : globals });
  return {
    sync(tabs) { commands.get('studio.internalSyncSidebarTabs')({ get: service => services[service] }, tabs); },
    listed: () => models.applyStudioSidebarOrder([{ id: 'other-view', pinned: false }, ...[...containers.keys()].map(id => ({ id, pinned: false }))]),
    opens, views, registered,
  };
}

test('native project tabs restore the previous selection and reorder without recreating the views', () => {
  const f = fixture({ saved: board.id });
  f.sync([assistant, board, bot]);
  assert.deepEqual(f.opens, [{ id: board.id, focus: false }]);
  assert.deepEqual(Array.from(f.views.get(board.id), view => [view.type, view.canMoveView, view.canToggleVisibility]), [['webview', false, false]]);
  f.sync([bot, assistant, board]);
  assert.deepEqual(f.registered, [assistant.id, board.id, bot.id]);
  assert.deepEqual(Array.from(f.listed(), value => [value.id, value.pinned]), [[bot.id, true], [assistant.id, true], [board.id, true], ['other-view', false]]);
  f.sync([bot, assistant]);
  assert.deepEqual(f.opens, [{ id: board.id, focus: false }, { id: assistant.id, focus: false }]);
  assert.deepEqual(ids(f.listed()), [bot.id, assistant.id, 'other-view']);
});

test('native project tab registration does not reopen a collapsed sidebar', () => {
  const f = fixture({ visible: false, saved: board.id });
  f.sync([assistant, board, bot]);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(ids(f.listed()), [assistant.id, board.id, bot.id, 'other-view']);
});

test('native workspace projects keep their supplied order and fall back to the assistant after removal', () => {
  const first = { ...tab('studio-sidebar.workspace-first', 'steamharness-bot'), title: 'First Bot' };
  const second = { ...tab('studio-sidebar.workspace-second', 'steamharness-bot'), title: 'Second Bot' };
  const f = fixture({ saved: second.id });
  f.sync([assistant, first, second]);
  assert.deepEqual(ids(f.listed()), [assistant.id, first.id, second.id, 'other-view']);
  assert.deepEqual(f.opens, [{ id: second.id, focus: false }]);
  f.sync([assistant, first]);
  assert.deepEqual(ids(f.listed()), [assistant.id, first.id, 'other-view']);
  assert.deepEqual(f.opens.at(-1), { id: assistant.id, focus: false });
  assert.deepEqual(f.registered, [assistant.id, first.id, second.id]);
});

test('initial layout does not replace a saved tab before projects register', async () => {
  const text = await readFile(new URL('browser/layout.ts', root), 'utf8');
  const source = ts.createSourceFile('layout.ts', text, ts.ScriptTarget.Latest, true);
  const findRestore = node => {
    if (ts.isArrowFunction(node) && ts.isBlock(node.body) && node.body.statements.some(statement => statement.getText(source) === "mark('code/willRestoreAuxiliaryBar');")) return node.body;
    return ts.forEachChild(node, findRestore);
  };
  const body = findRestore(source).getText(source);
  const opens = [];
  for (const [id, registered, visible] of [[board.id, false, true], [board.id, true, false], [board.id, true, true], ['other-view', false, true]]) {
    await runInNewContext(`(async () => ${body})()`, {
      state: { initialization: { views: { containerToRestore: { auxiliaryBar: id } } } },
      Parts: { AUXILIARYBAR_PART: 'workbench.parts.auxiliarybar' }, ViewContainerLocation: { AuxiliaryBar: 2 },
      restoreDefaultViewsPromise: Promise.resolve(), isVisible: () => visible,
      isStudioSidebarTab: key => key === board.id, viewDescriptorService: { getViewContainerById: () => registered ? { id } : null },
      mark() {}, openViewContainer: (_, key) => opens.push(key),
    });
  }
  assert.deepEqual(opens, [board.id, 'other-view']);
});
