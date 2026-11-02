import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { runDatabaseHostRequest } from '../extensions/studio-workstation/runtime/database-host.mjs';
const require = createRequire(import.meta.url);
const compiled = (await build({ entryPoints: ['extensions/studio-workstation/src/workflow-databases-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false })).outputFiles[0].text;
const ui = (await build({ entryPoints: ['extensions/studio-workstation/webview/databases.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false })).outputFiles[0].text;
const id = '00000000-0000-4000-8000-000000000001';
const resources = [{ id, kind: 'databases', name: 'Main' }, { id, kind: 'knowledge-bases', name: 'Docs' }];
const project = (entryId = 'agent') => ({ id: 'project', uri: 'file:///project', folderPath: '/project', name: 'Project', entryId, projectType: 'conversation', databases: [{ alias: 'main', databaseId: id }], knowledgeBases: [{ alias: 'docs', knowledgeBaseId: id }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, operation = async () => ({ resources })) {
  const providers = new Map(), calls = [], opened = [], messages = [], listeners = [], receivers = [];
  let connection = { serverUrl: 'https://server.test', accessToken: 'private-token' };
  const disposable = { dispose() {} };
  const vscode = { Uri: { joinPath: (_root, ...parts) => ({ toString: () => parts.join('/') }) }, workspace: { isTrusted: true }, env: { language: 'en' },
    window: { registerWebviewViewProvider: (id, provider) => { providers.set(id, provider); return disposable; } },
    commands: { registerCommand: () => disposable, executeCommand: async (...args) => { opened.push(args); } } };
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), crypto: globalThis.crypto, URL, AbortController, setTimeout, clearTimeout, structuredClone });
  const launcher = { inspect: async () => ({ projects: [project()], errors: [] }), database: async (...args) => { calls.push(args); return operation(...args); } };
  const controller = new module.exports.DatabaseViews({ extensionUri: {}, subscriptions: [] }, launcher, { getConnection: () => connection, onDidChange: fn => { listeners.push(fn); return disposable; }, open() {} }, { appendLine() {} });
  t.after(() => controller.dispose());
  const view = { visible: true, webview: { cspSource: 'self', asWebviewUri: uri => uri, postMessage: async message => { messages.push(message); return true; }, onDidReceiveMessage: fn => { receivers.push(fn); return disposable; } }, onDidChangeVisibility: () => disposable, onDidDispose: () => disposable };
  providers.get('studio.databases').resolveWebviewView(view);
  return { controller, calls, opened, vscode, state: () => messages.at(-1), send: message => receivers.forEach(fn => fn(message)), account: value => { connection = value; listeners.forEach(fn => fn()); } };
}
test('lists each resource once, records shared entry use and opens only verified Server URLs', async t => {
  const f = fixture(t), current = project(); f.controller.update([current, project('board')], current); await tick();
  assert.equal(f.state().databases.length, 2); assert.equal(f.state().databases[0].usage.length, 2);
  f.send({ type: 'open', key: `knowledge-bases:${id}`, url: 'https://attacker.test' }); await tick();
  assert.deepEqual(f.opened.at(-1), ['simpleBrowser.show', `https://server.test/databases/knowledge%3A${id}`]);
  assert.equal(JSON.stringify(f.state()).includes('private-token'), false);
  f.send({ type: 'open', key: 'databases:forged' }); await tick(); assert.equal(f.opened.length, 1);
});
test('account changes abort and discard old catalog replies', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; })); await tick();
  const signal = f.calls[0][1]; f.account({ serverUrl: 'https://server.test', accessToken: 'private-token' }); assert.equal(signal.aborted, false);
  f.account(undefined); assert.equal(signal.aborted, true); finish({ resources }); await tick();
  assert.equal(f.state().databases.length, 0); assert.equal(f.state().authenticated, false);
});
test('resource type filters have no local or remote switch and names cannot inject HTML', t => {
  const dom = new JSDOM('<div id="databases-app"></div>', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const sent = []; dom.window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage: message => sent.push(message) }); dom.window.eval(ui);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'databases-state', databases: resources.map(row => ({ ...row, name: row.kind === 'databases' ? '<img src=x>' : row.name, key: `${row.kind}:${row.id}`, usage: [] })), authenticated: true } }));
  const doc = dom.window.document, filter = doc.querySelector('#filter');
  assert.equal(doc.querySelector('img'), null); assert.equal(doc.querySelectorAll('.database-child').length, 2);
  assert.equal([...filter.options].some(option => ['local', 'server'].includes(option.value)), false);
  filter.value = 'knowledge-bases'; filter.dispatchEvent(new dom.window.Event('input')); assert.equal(doc.querySelectorAll('.database-child').length, 1);
  doc.querySelector('.database-child').click(); assert.equal(sent.at(-1).key, `knowledge-bases:${id}`);
});
test('catalog worker requires an account and refuses the removed KV management operations', async () => {
  await assert.rejects(runDatabaseHostRequest({ input: { action: 'catalog' } }), /Sign in/);
  await assert.rejects(runDatabaseHostRequest({ connection: { serverUrl: 'https://server.test', accessToken: 'test' }, input: { action: 'resource', kind: 'kv' } }), /Server Web/);
});
