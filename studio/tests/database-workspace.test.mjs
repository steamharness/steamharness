import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as core from '../../harness/dist/index.js';
import { runDatabaseHostRequest } from '../extensions/studio-workstation/runtime/database-host.mjs';
const require = createRequire(import.meta.url);
const compiled = (await build({ entryPoints: ['extensions/studio-workstation/src/workflow-databases-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false })).outputFiles[0].text;
const ui = (await build({ entryPoints: ['extensions/studio-workstation/webview/databases.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false })).outputFiles[0].text;
const id = '00000000-0000-4000-8000-000000000001', secondId = '00000000-0000-4000-8000-000000000002';
const space = (spaceId = id, host = 'local') => ({ spaceId, host, name: `${host} memory`, ownerId: 'owner', createdAt: '' });
const catalog = (spaces = [space()]) => ({ spaces, requests: [], grants: [], bindings: [] });
const project = (entryId = 'agent') => ({ id: 'project', uri: 'file:///project', folderPath: '/project', name: 'Project', entryId, projectType: 'conversation', databases: [{ alias: 'data', databaseId: id }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, hostOperation = async () => ({ local: catalog(), server: catalog([space(secondId, 'server')]) })) {
  const providers = new Map(), commands = new Map(), panels = [], calls = [], resourceCalls = [], accountListeners = [];
  let connection = { serverUrl: 'https://server.test', accessToken: 'test' };
  const disposable = { dispose() {} };
  const owner = () => {
    const messages = [], receivers = [], closeListeners = [];
    return { messages, receivers, visible: true, webview: { cspSource: 'self', asWebviewUri: uri => uri, postMessage: async message => { messages.push(message); return true; }, onDidReceiveMessage: fn => { receivers.push(fn); return disposable; } },
      onDidChangeVisibility: () => disposable, onDidDispose: fn => { closeListeners.push(fn); return disposable; },
      reveal() { this.revealed = true; }, dispose() { if (this.closed) return; this.closed = true; for (const fn of closeListeners) fn(); } };
  };
  const vscode = { Uri: { joinPath: (_root, ...parts) => ({ toString: () => parts.join('/') }) }, ThemeIcon: class {}, ViewColumn: { Active: 1 },
    workspace: { isTrusted: true }, env: { language: 'en', clipboard: { writeText: async () => {} } },
    window: { registerWebviewViewProvider: (id, provider) => { providers.set(id, provider); return disposable; }, createWebviewPanel: () => { const panel = owner(); panels.push(panel); return panel; }, showWarningMessage: async () => 'Delete' },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; }, executeCommand: async () => {} } };
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), crypto: globalThis.crypto, AbortController, setTimeout, clearTimeout, structuredClone });
  const launcher = { inspect: async () => ({ projects: [project()], errors: [] }), database: async (...args) => { calls.push(args); return hostOperation(...args); }, resource: async (...args) => { resourceCalls.push(args); return { items: [] }; } };
  const controller = new module.exports.DatabaseViews({ extensionUri: {}, subscriptions: [] }, launcher, { getConnection: () => connection, onDidChange: fn => { accountListeners.push(fn); return disposable; }, open() {} }, { appendLine() {} });
  t.after(() => controller.dispose());
  const view = owner(); providers.get('studio.databases').resolveWebviewView(view);
  const send = (owner, message) => { for (const receive of owner.receivers) receive(message); };
  const state = owner => owner.messages.findLast(item => item.type === 'databases-state' || item.type === 'resources-state');
  return { controller, launcher, view, panels, calls, resourceCalls, vscode, send, state, account: value => { connection = value; for (const fn of accountListeners) fn(); } };
}
test('directory shares one database between entries and opens an alias-scoped, reusable data tab', async t => {
  const f = fixture(t), current = project(); f.controller.update([current, project('board')], current); await tick();
  assert.equal(f.state(f.view).databases.length, 2); assert.equal(f.state(f.view).databases[0].usage.length, 2);
  f.send(f.view, { type: 'open', key: `local:${id}`, kind: 'kv', filter: 'project' });
  const panel = f.panels[0]; assert.match(panel.webview.html, /resources-ui.js/);
  f.send(panel, { type: 'ready' });
  f.send(panel, { type: 'request', id: 1, generation: 0, projectUri: `local:${id}`, input: { kind: 'knowledge', action: 'list', database: 'forged', source: 'server' } }); await tick();
  assert.equal(f.resourceCalls[0][0].entryId, 'agent'); assert.equal(f.resourceCalls[0][1].database, 'data'); assert.equal(f.resourceCalls[0][1].kind, 'kv'); assert.equal(f.resourceCalls[0][1].source, 'local'); assert.equal(f.resourceCalls[0][1].expectedDatabaseId, id);
  f.send(f.view, { type: 'open', key: `local:${id}`, kind: 'kv', filter: 'project' }); assert.equal(f.panels.length, 1); assert.equal(panel.revealed, true);
  f.send(f.view, { type: 'open', key: `server:${secondId}`, kind: 'knowledge', filter: 'all' });
  const remote = f.panels[1]; f.send(remote, { type: 'ready' }); f.send(remote, { type: 'request', id: 2, generation: 0, projectUri: `server:${secondId}`, input: { action: 'list' } }); await tick();
  assert.equal(f.calls.at(-1)[0].spaceId, secondId); assert.equal(f.calls.at(-1)[0].input.kind, 'knowledge');
});
test('account changes cancel catalog reads, discard late responses, and stable account checks keep work', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; })); await tick();
  const signal = f.calls[0][1]; f.account({ serverUrl: 'https://server.test', accessToken: 'test' }); assert.equal(signal.aborted, false);
  f.account(undefined); assert.equal(signal.aborted, true); finish({ local: catalog([space()]) }); await tick();
  assert.equal(f.state(f.view).databases.length, 0); assert.equal(f.state(f.view).authenticated, false);
});
test('account changes cancel native approvals without submitting old choices with the new account', async t => {
  const pending = { requestId: 'pending', status: 'pending', projectId: 'project', entryId: 'agent', alias: 'data', permissions: {}, target: { kind: 'create', name: 'Memory' } };
  const f = fixture(t, async () => ({ local: { ...catalog(), requests: [pending] } })); await tick();
  let finish;
  f.vscode.window.showQuickPick = async choices => choices[0];
  f.vscode.window.showInputBox = () => new Promise(resolve => { finish = resolve; });
  f.send(f.view, { type: 'review' }); await tick(); assert.equal(typeof finish, 'function');
  f.account({ serverUrl: 'https://other.test', accessToken: 'other' });
  finish('Approved'); await tick();
  assert.equal(f.calls.filter(([input]) => input.action === 'review').length, 0);
  assert.equal(f.state(f.view).error, '');
});
test('refreshing the catalog while an approval is open cannot release its operation lock', async t => {
  const pending = { requestId: 'pending', status: 'pending', projectId: 'project', entryId: 'agent', alias: 'data', permissions: {}, target: { kind: 'create', name: 'Memory' } };
  const f = fixture(t, async () => ({ local: { ...catalog(), requests: [pending] } })); await tick();
  let finish, prompts = 0;
  f.vscode.window.showQuickPick = async choices => { prompts++; return choices[0]; };
  f.vscode.window.showInputBox = () => new Promise(resolve => { finish = resolve; });
  f.send(f.view, { type: 'review' }); await tick(); assert.equal(prompts, 2);
  await f.controller.refresh(); assert.equal(f.state(f.view).loading, true);
  f.send(f.view, { type: 'review' }); await tick(); assert.equal(prompts, 2);
  finish(''); await tick(); assert.equal(f.calls.filter(([input]) => input.action === 'review').length, 1);
  assert.equal(f.state(f.view).loading, false);
});
test('a denied duplicate mutation cannot unlock a running operation, and untrusted workspaces cannot write', async t => {
  const f = fixture(t); await tick(); f.send(f.view, { type: 'open', key: `local:${id}`, kind: 'kv', filter: 'all' });
  const panel = f.panels[0]; f.send(panel, { type: 'ready' }); let finish;
  f.launcher.database = async (...args) => { f.calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  const save = id => f.send(panel, { type: 'request', id, generation: 0, projectUri: `local:${space().spaceId}`, input: { action: 'save', key: 'one', value: 1 } });
  const count = f.calls.length; save(1); save(2); save(3); await tick(); assert.equal(f.calls.length, count + 1);
  finish({ value: 1 }); await tick(); f.vscode.workspace.isTrusted = false; save(4); await tick();
  assert.match(panel.messages.at(-1).error, /Trust/); assert.equal(f.calls.length, count + 1);
});
test('database filters default to this project and separate local, server, all and search results', t => {
  const dom = new JSDOM('<div id="databases-app"></div>', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const sent = []; dom.window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage: message => sent.push(message) }); dom.window.eval(ui);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'databases-state', databases: [{ ...space(), key: `local:${id}`, available: true, usage: [{ name: 'Agent', alias: 'data' }] }, { ...space(secondId, 'server'), key: `server:${secondId}`, available: true, usage: [] }], authenticated: true, project: 'Project' } }));
  const doc = dom.window.document, filter = doc.querySelector('#database-filter'), titles = () => [...doc.querySelectorAll('.database-title')].map(item => item.textContent);
  assert.equal(filter.value, 'project'); assert.deepEqual(titles(), ['local memory']);
  filter.value = 'server'; filter.dispatchEvent(new dom.window.Event('change')); assert.deepEqual(titles(), ['server memory']);
  filter.value = 'all'; filter.dispatchEvent(new dom.window.Event('change')); assert.equal(titles().length, 2);
  const search = doc.querySelector('#database-search'); search.value = 'data'; search.dispatchEvent(new dom.window.Event('input')); assert.deepEqual(titles(), ['local memory']);
  doc.querySelector('.database-child').click(); assert.equal(sent.at(-1).key, `local:${id}`); assert.equal(sent.at(-1).kind, 'kv');
});
test('trusted host management retains data after consumer revocation and rejects nonexistent databases', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'database-host-worker-')), previous = process.env.STEAMHARNESS_DATABASES_DIR;
  process.env.STEAMHARNESS_DATABASES_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.STEAMHARNESS_DATABASES_DIR; else process.env.STEAMHARNESS_DATABASES_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const registry = new core.LocalDatabaseRegistry(), all = { mode: 'all' }, permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
  const request = registry.request({ projectId: '00000000-0000-4000-8000-000000000010', entryId: 'agent', alias: 'data', permissions, target: { kind: 'create', name: 'Retained' } });
  const approved = registry.review(request.requestId, { approve: true }); registry.revoke(registry.read().grants[0].grantId);
  const call = input => runDatabaseHostRequest({ input: { kind: 'host', host: 'local', spaceId: approved.databaseId, action: 'resource', ...input } }, core);
  await call({ input: { kind: 'kv', action: 'save', key: 'nullable', value: null } });
  assert.equal((await call({ input: { kind: 'kv', action: 'get', key: 'nullable' } })).value, null);
  assert.equal(await call({ input: { kind: 'kv', action: 'get', key: 'missing' } }), null);
  await assert.rejects(call({ spaceId: id, input: { kind: 'kv', action: 'list' } }), /does not exist/);
  const directory = await runDatabaseHostRequest({ input: { kind: 'host', action: 'catalog' } }, core); assert.equal(directory.local.spaces.length, 1);
});
