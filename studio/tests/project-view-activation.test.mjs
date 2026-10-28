import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('workflow.ts', await readFile(new URL('../extensions/studio-workstation/src/workflow.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const initializers = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['revealProject', 'createWorkspace', 'openProject'].includes(node.name.getText(source))) {
    initializers.set(node.name.getText(source), node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
function load(name, bindings = {}) {
  assert.ok(initializers.has(name));
  const compiled = ts.transpileModule(`(${initializers.get(name)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(compiled, { setTimeout, clearTimeout, t: text => text, Error, Promise, AbortController, projectWindowKey: p => `${p.uri}#entry=${p.entryId}`, provider:{projects:[]},resourceProjectDirectories:async()=>[],context:{}, ...bindings });
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
    findProject:()=>project,assertNotUpgrading() {}, revealProject,
    createWorkspace: async () => { starts++; workspaces.set(`${project.uri}#entry=${project.entryId}`, { panel, running: true }); },
  });
  await openProject(project, 1, new AbortController().signal);
  assert.deepEqual({ starts, pending: opening.size, reveals: panel.reveals }, { starts: 1, pending: 0, reveals: [] });
});
