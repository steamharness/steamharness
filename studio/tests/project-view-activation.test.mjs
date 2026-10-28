import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('workflow.ts', await readFile(new URL('../extensions/studio-workstation/src/workflow.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const initializers = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['findProject', 'findWorkspace', 'projectSerializer', 'revealProject', 'createWorkspace', 'openProject'].includes(node.name.getText(source))) {
    initializers.set(node.name.getText(source), node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
function load(name, bindings = {}) {
  assert.ok(initializers.has(name));
  const compiled = ts.transpileModule(`(${initializers.get(name)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(compiled, { setTimeout, clearTimeout, t: text => text, Error, Promise, AbortController, URL, URLSearchParams, crypto: globalThis.crypto, projectWindowKey: p => `${p.uri}#entry=${p.entryId}`, provider:{projects:[]},resourceProjectDirectories:async()=>[],context:{}, ...bindings });
}
const revealProject = load('revealProject');

function panelFixture() {
  const changed = new Set(), closed = new Set();
  const subscribe = listeners => callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
  const panel = { active: false, viewColumn: 2, reveals: [],
    reveal(column) { panel.reveals.push(column); },
    onDidChangeViewState: subscribe(changed), onDidDispose: subscribe(closed) };
  return { panel, changed, closed, change: () => [...changed].forEach(callback => callback()), close: () => [...closed].forEach(callback => callback()) };
}

test('mode preparation waits for the project to activate in its target column', async () => {
  const f = panelFixture(), controller = new AbortController();
  let finished = false;
  const opening = revealProject(f.panel, 1, controller.signal).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  f.panel.active = true; f.change();
  assert.equal(finished, false);
  f.panel.viewColumn = 1; f.change(); await opening;
  assert.deepEqual({ reveals: f.panel.reveals, changed: f.changed.size, closed: f.closed.size }, { reveals: [1], changed: 0, closed: 0 });
});

test('canceling delayed activation releases the wait and its subscriptions', async () => {
  const f = panelFixture(), controller = new AbortController();
  const opening = revealProject(f.panel, 1, controller.signal);
  controller.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual([f.changed.size, f.closed.size], [0, 0]);
});

test('a new project panel waits for activation without a second reveal', async () => {
  const f = panelFixture();
  const opening = revealProject(f.panel, 1, new AbortController().signal, false);
  f.panel.active = true; f.panel.viewColumn = 1; f.change(); await opening;
  assert.deepEqual(f.panel.reveals, []);
});

test('an already active retained frame is not reopened asynchronously', async () => {
  const f = panelFixture(); f.panel.active = true; f.panel.viewColumn = 1;
  await revealProject(f.panel, 1, new AbortController().signal);
  assert.deepEqual({ reveals: f.panel.reveals, listeners: f.changed.size + f.closed.size }, { reveals: [], listeners: 0 });
});

test('closing the project panel rejects activation and removes its listeners', async () => {
  const f = panelFixture();
  const opening = revealProject(f.panel, 1, new AbortController().signal);
  f.close();
  await assert.rejects(opening, /no longer open/);
  assert.deepEqual([f.changed.size, f.closed.size], [0, 0]);
});

for (const canceled of [true, false]) {
  test(`project startup preserves ${canceled ? 'cancellation even when the CLI wraps its error' : 'a genuine CLI failure'}`, async () => {
    const controller = new AbortController(), starting = new Map(), startingDone = new Map(), startingSources = new Map();
    const failure = new Error('CLI startup failed');
    const createWorkspace = load('createWorkspace', {
      settling: new Map(), starting, startingDone, startingSources,
      projectAvailable: () => true, assertNotUpgrading() {},
      provider: {projects:[]},
      vscode: { ViewColumn: { Active: -1 }, ProgressLocation: { Window: 10 }, window: { withProgress: (_options, task) => task() } },
      launcher: { start: async () => { if (canceled) { controller.abort(); } throw failure; } },
    });
    await assert.rejects(createWorkspace({ uri: 'file:///project', folderPath: '/project' }, undefined, undefined, 1, controller.signal),
      canceled ? { name: 'AbortError' } : error => error === failure);
    assert.deepEqual([starting.size, startingDone.size, startingSources.size], [0, 0, 0]);
  });
}

test('an immediate Steam retry waits for canceled startup cleanup and then opens the project', async () => {
  const project = { uri: 'file:///project',entryId:'main' }, opening = new Map(), workspaces = new Map();
  const controller = new AbortController(); controller.abort();
  opening.set(`${project.uri}#entry=${project.entryId}`, Promise.reject(controller.signal.reason));
  const { panel } = panelFixture(); panel.active = true; panel.viewColumn = 1;
  let starts = 0;
  const openProject = load('openProject', {
    provider: { projects: [project] }, configurationProjects: new Map(), settling: new Map(), opening, workspaces,
    findProject:()=>project, findWorkspace: load('findWorkspace', { workspaces }), assertNotUpgrading() {}, revealProject,
    createWorkspace: async () => { starts++; workspaces.set(panel, { panel, project, running: true }); },
  });
  await openProject(project, 1, new AbortController().signal);
  assert.deepEqual({ starts, pending: opening.size, reveals: panel.reveals }, { starts: 1, pending: 0, reveals: [] });
});

test('Start targets open distinct aggregate entries and reuse only the matching entry panel', async () => {
  const uri = 'file:///aggregate', entries = ['agent', 'database', 'minimax'];
  const projects = entries.map(entryId => ({ uri, entryId, folderPath: '/aggregate', defaultEntry: 'agent',
    projectType: entryId === 'agent' ? 'conversation' : 'workflow' }));
  const provider = { projects }, workspaces = new Map(), opening = new Map(), starts = [];
  const findProject = load('findProject', { provider, externalProjects: new Map() });
  const openProject = load('openProject', {
    provider, findProject, findWorkspace: load('findWorkspace', { workspaces }), workspaces, opening, settling: new Map(), assertNotUpgrading() {}, revealProject,
    createWorkspace: async project => {
      starts.push(project.entryId);
      const { panel } = panelFixture(); panel.active = true; panel.viewColumn = 1;
      workspaces.set(panel, { panel, project, running: true });
    },
  });
  await openProject({ uri, entryId: 'minimax' });
  await openProject({ uri, entryId: 'database' });
  await openProject({ uri });
  await openProject({ uri, entryId: 'minimax' });
  assert.deepEqual({ starts, panels: workspaces.size, pending: opening.size }, { starts: ['minimax', 'database', 'agent'], panels: 3, pending: 0 });
});

function workspaceFixture() {
  const uri = 'file:///aggregate', entries = ['agent', 'workflow', 'board'];
  const projects = entries.map((entryId, index) => ({ uri, entryId, folderPath: '/aggregate', entryRoot: `/aggregate/${entryId}`,
    id: 'aggregate', defaultEntry: 'agent', name: entryId, entries: entries.map(entryId => ({ entryId })),
    projectType: ['conversation', 'workflow', 'kanban'][index] }));
  const workspaces = new Map(), sessions = new Set(), leases = [], panels = [], frames = [], deliveries = [];
  const disposable = { dispose() {} }, settling = new Map();
  const makePanel = (viewType = 'studio.projectTool') => {
    const f = panelFixture();
    const panel = Object.assign(f.panel, { viewType, webview: {
      options: {}, postMessage: async () => true, onDidReceiveMessage: callback => { panel.receive = callback; return disposable; },
    }, dispose: f.close });
    panels.push(panel); return panel;
  };
  const asUri = value => ({ fsPath: value, toString: () => value });
  const vscode = { ViewColumn: { Active: -1 }, ProgressLocation: { Window: 10 }, Uri: { parse: asUri, file: asUri },
    env: { language: 'en', asExternalUri: async uri => uri }, commands: { executeCommand: async () => undefined },
    workspace: { isTrusted: true }, window: { withProgress: (_options, task) => task(), createWebviewPanel: makePanel,
      onDidChangeActiveColorTheme: () => disposable } };
  const adapter = () => ({ receive: () => false, dispose() {} });
  let createWorkspace;
  const launcher = { available: true, start: async project => {
    let finish;
    const lease = { ready: { url: `http://127.0.0.1:4567/entries/${project.entryId}/#session=token`, traceProtocolVersion: 1 },
      closed: new Promise(resolve => { finish = resolve; }), closes: 0,
      close: async () => { lease.closes++; finish(); },
      onExit: callback => { lease.exit = callback; return disposable; } };
    leases.push(lease); return lease;
  } };
  const bindings = {
    vscode, launcher, workspaces, sessions, settling, starting: new Map(), startingDone: new Map(), startingSources: new Map(),
    sessionSources: new Map(), sessionStops: new Map(), provider: { projects }, projectAvailable: () => true,
    assertNotUpgrading() {}, projectDisplayName: project => project.name, theme: () => 'dark',
    trace: { bind: adapter }, fileIcons: { bind: adapter }, bindProjectClipboard: adapter,
    bindProjectPathPicker: webview => ({ ...adapter(), receive: message => {
      if (message.type !== 'workflow-path-picker') return false;
      deliveries.push({ panel: panels.find(panel => panel.webview === webview), request: message.requestId }); return true;
    } }), bindProjectPathOpen: adapter, bindProjectResourceCards: adapter,
    projectAvatarDataUrl: () => 'data:image/svg+xml,icon', chromeFor: () => ({ active: false }),
    projectFrameHtml: (...args) => { frames.push(args); return args[0]; }, output: { appendLine() {} },
    createWorkspace: (...args) => createWorkspace(...args),
    resolveProjectTab: async (_uri, entryId) => projects.find(project => project.entryId === entryId),
    findProject: (_uri, entryId) => projects.find(project => project.entryId === entryId),
    updateEntry() {}, scheduleEntry() {}, windowChrome: { revision: 0 },
  };
  createWorkspace = load('createWorkspace', bindings);
  return { projects, workspaces, leases, panels, frames, deliveries, makePanel, bindings, createWorkspace };
}

for (const entryId of ['agent', 'workflow', 'board']) {
  test(`the ${entryId} entry opens repeatedly as native tabs with independent lifecycles and host adapters`, async () => {
    const f = workspaceFixture(), project = f.projects.find(project => project.entryId === entryId);
    await f.createWorkspace(project);
    const source = f.panels[0];
    for (let index = 0; index < 2; index++) {
      source.receive({ type: 'workflow-open-entry', version: 1, projectId: project.id, entryId });
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.panels.length, 3); assert.equal(f.workspaces.size, 3);
    assert.equal(f.panels[1].viewType, 'studio.projectTool');
    if (entryId === 'agent') assert.equal(f.frames[1][7], 'new');
    f.panels[1].receive({ type: 'workflow-path-picker', version: 1, requestId: 'second' });
    f.panels[2].receive({ type: 'workflow-path-picker', version: 1, requestId: 'third' });
    assert.deepEqual(f.deliveries.map(({ panel, request }) => [f.panels.indexOf(panel), request]), [[1, 'second'], [2, 'third']]);
    f.panels[1].dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.workspaces.size, 2);
    assert.deepEqual(f.leases.map(lease => lease.closes), [0, 1, 0]);
    f.leases[0].exit({ code: 1 });
    assert.equal(f.workspaces.get(source).running, false);
    assert.equal(f.workspaces.get(f.panels[2]).running, true);
    f.panels[0].dispose(); f.panels[2].dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.workspaces.size, 0);
    assert.deepEqual(f.leases.map(lease => lease.closes), [1, 1, 1]);
  });
}

test('restoring multiple native panels for the same entry keeps every panel and its lease', async () => {
  const f = workspaceFixture(), project = f.projects[1];
  const serializer = load('projectSerializer', { ...f.bindings, initialScan: Promise.resolve(), createWorkspace: f.createWorkspace });
  const panels = [f.makePanel(), f.makePanel()];
  await Promise.all(panels.map(panel => serializer.deserializeWebviewPanel(panel, { projectUri: project.uri, entryId: project.entryId })));
  assert.equal(f.workspaces.size, 2); assert.equal(f.leases.length, 2);
  for (const panel of panels) { assert.equal(f.workspaces.get(panel).project.entryId, project.entryId); panel.dispose(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.leases.map(lease => lease.closes), [1, 1]);
});
