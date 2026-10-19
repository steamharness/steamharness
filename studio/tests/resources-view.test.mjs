import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-resources-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const project = (name, projectType = 'conversation') => ({ id: name, uri: `file:///${name}`, folderPath: `/${name}`, name, projectType });

function fixture(t, operation = async () => ({ items: [], total: 0, hasMore: false }), connection) {
  const providers = new Map(), commands = new Map(), views = new Map(), messages = new Map(), receivers = new Map(), calls = [], contextValues = [], copied = [], invalidated = [];
  let accountChanged;
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (_root, ...parts) => ({ toString: () => parts.join('/') }) },
    workspace: { isTrusted: true },
    env: { language: 'en', clipboard: { writeText: async text => { copied.push(text); } } },
    window: { registerWebviewViewProvider: (id, provider) => { providers.set(id, provider); return disposable; }, showWarningMessage: async () => "Delete" },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; }, executeCommand: async (...args) => contextValues.push(args) },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), crypto: globalThis.crypto, AbortController });
  const provider = new module.exports.ResourceViews({ subscriptions: [], extensionUri: {} }, {
    resource: async (...args) => { calls.push(args); return operation(...args); },
  }, { getConnection: () => connection, onDidChange: callback => { accountChanged = callback; return disposable; },
    invalidate: async current => { invalidated.push(current); connection = undefined; accountChanged({ status: 'expired' }); }, open() {} }, { appendLine() {} });
  t.after(() => provider.dispose());
  for (const kind of ['kv', 'knowledge']) {
    const sent = []; messages.set(kind, sent);
    const view = { webview: { cspSource: 'self', asWebviewUri: uri => uri,
      onDidReceiveMessage: fn => { receivers.set(kind, fn); return disposable; }, postMessage: async message => { sent.push(message); return true; } },
      onDidChangeVisibility: () => disposable, onDidDispose: () => disposable, show() {} };
    providers.get(`studio.${kind}`).resolveWebviewView(view); views.set(kind, view);
  }
  const state = kind => messages.get(kind).findLast(item => item.type === 'resources-state');
  const send = async (kind, input = { action: 'list' }, extra = {}) => {
    receivers.get(kind)({ type: 'request', id: 1, generation: state(kind).generation, projectUri: state(kind).selected, input, ...extra });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { provider, commands, messages, receivers, views, calls, state, send, contextValues, copied, invalidated, vscode,
    accountChanged: (status = 'signed-out', nextConnection) => { connection = nextConnection; accountChanged({ status }); } };
}

test('resource tabs appear only for detected projects and exclude the standalone assistant', t => {
  const { provider, state, contextValues } = fixture(t);
  provider.update([project('conversation'), project('workflow', 'workflow'), project('kanban', 'kanban'), { ...project('assistant'), assistant: { standalone: true } }]);
  assert.deepEqual(Array.from(state('kv').projects, item => item.name), ['conversation', 'workflow', 'kanban']);
  assert.equal(contextValues.at(-1)[2], true);
  provider.update([]); assert.equal(contextValues.at(-1)[2], false); assert.equal(state('knowledge').selected, undefined);
});

test('both panels follow the active project and explicit project selection', t => {
  const { provider, receivers, state } = fixture(t);
  const projects = [project('first'), project('second')];
  provider.update(projects, projects[0]);
  receivers.get('kv')({ type: 'select', projectUri: projects[1].uri });
  assert.equal(state('knowledge').selected, projects[1].uri);
  provider.update(projects, projects[0]); assert.equal(state('kv').selected, projects[1].uri);
  provider.update(projects, projects[1]);
  provider.update(projects, projects[0]); assert.equal(state('knowledge').selected, projects[0].uri);
});

test('a foreign server card locates the exact document with the owner runtime and read-only access', async t => {
  const { provider, state, send, calls, messages } = fixture(t);
  const owner = project('owner'), remote = { ...project('database'), uri: 'workflow-server:database', folderPath: '' };
  provider.update([owner], owner);
  await provider.open('knowledge', remote, { source: 'server', projectId: remote.id, documentId: 'document-b' }, owner);
  assert.equal(state('knowledge').selected, remote.uri);
  assert.equal(state('knowledge').focus.documentId, 'document-b'); assert.equal(state('knowledge').readOnly, true);
  await send('knowledge', { action: 'get', documentId: 'document-b', source: 'local' });
  assert.equal(calls[0][0], owner); assert.equal(calls[0][1].source, 'server'); assert.equal(calls[0][1].projectId, remote.id);
  await send('knowledge', { action: 'delete', documentId: 'document-b' });
  assert.equal(calls.length, 1); assert.match(messages.get('knowledge').at(-1).error, /read-only/);
});

test('a card for an already opened foreign project remains read-only and own-project navigation restores editing', async t => {
  const { provider, state, send, calls, messages } = fixture(t);
  const owner = project('owner'), other = project('other');
  provider.update([owner, other], owner);
  await provider.open('knowledge', other, { source: 'local', projectId: other.id, documentId: 'doc' }, owner);
  assert.equal(state('knowledge').readOnly, true);
  await send('knowledge', { action: 'save', documentId: 'doc', markdown: 'Changed' });
  assert.equal(calls.length, 0); assert.match(messages.get('knowledge').at(-1).error, /read-only/);
  provider.update([{ ...owner }, { ...other }], { ...owner });
  assert.equal(state('knowledge').readOnly, true);
  await provider.open('knowledge', other, { source: 'local', projectId: other.id, documentId: 'doc' }, other);
  assert.equal(state('knowledge').readOnly, false);
  await send('knowledge', { action: 'save', documentId: 'doc', markdown: 'Changed' });
  assert.equal(calls.length, 1);
});

test('an own-project Server card keeps the workspace project and its editable knowledge view', async t => {
  const { provider, state, send, calls } = fixture(t);
  const owner = project('owner'), remote = { ...owner, uri: 'workflow-server:owner', folderPath: '' };
  provider.update([owner], owner);
  await provider.open('knowledge', remote, { source: 'server', projectId: owner.id, documentId: 'doc' }, owner);
  assert.equal(state('knowledge').selected, owner.uri);
  assert.equal(state('knowledge').readOnly, false);
  await send('knowledge', { action: 'get', documentId: 'doc', source: 'server' });
  assert.equal(calls[0][0], owner); assert.equal(calls[0][1].source, 'server');
});

test('switching to a foreign preview project as the active workspace restores its native resource controls', async t => {
  const { provider, state } = fixture(t);
  const owner = project('owner'), other = project('other');
  provider.update([owner, other], owner);
  await provider.open('kv', other, { source: 'local', projectId: other.id, key: 'key' }, owner);
  const generation = state('kv').generation;
  provider.update([owner, other], other);
  assert.equal(state('kv').selected, other.uri); assert.equal(state('kv').readOnly, false);
  assert.ok(state('kv').generation > generation); assert.equal(state('kv').focus, undefined);
});

test('late replies and requests for a previously selected project cannot update the current panel', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { provider, state, send, calls, messages } = fixture(t, () => pending);
  const projects = [project('first'), project('second')]; provider.update(projects, projects[0]);
  const generation = state('kv').generation;
  await send('kv'); const signal = calls[0][2];
  provider.update(projects, projects[1]); assert.equal(signal.aborted, true);
  finish({ items: [{ title: 'old project data' }] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.get('kv').filter(message => message.type === 'resources-result').length, 0);
  await send('kv', { action: 'delete', key: 'old' }, { generation, projectUri: projects[0].uri });
  assert.equal(calls.length, 1);
});

test('the host supplies the view kind and rejects untrusted workspace operations', async t => {
  const { provider, send, calls, messages, vscode } = fixture(t); provider.update([project('project')]);
  await send('kv', { action: 'list', kind: 'knowledge' }); assert.equal(calls[0][1].kind, 'kv');
  vscode.workspace.isTrusted = false;
  await send('knowledge'); assert.equal(calls.length, 1);
  assert.match(messages.get('knowledge').at(-1).error, /unavailable/);
});

test('logout aborts resource work and clears the renderer generation', async t => {
  const { provider, send, calls, state, accountChanged } = fixture(t, undefined, { serverUrl: 'https://steamharness.test', accessToken: 'test-token' }); provider.update([project('project')]);
  await send('kv'); const generation = state('kv').generation; accountChanged();
  assert.equal(calls[0][2].aborted, true); assert.ok(state('kv').generation > generation);
});

test('repeated account checks and unchanged project scans preserve in-flight resource requests', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const connection = { serverUrl: 'https://steamharness.test', accessToken: 'test-token' };
  const { provider, send, calls, state, messages, accountChanged } = fixture(t, () => pending, connection);
  const projects = [project('project')]; provider.update(projects, projects[0]);
  const generation = state('kv').generation;
  await send('kv');
  for (const status of ['checking', 'authenticated', 'error', 'authenticated']) { accountChanged(status, { ...connection }); }
  provider.update(projects.map(item => ({ ...item })), { ...projects[0] });
  assert.equal(state('kv').generation, generation);
  assert.equal(calls[0][2].aborted, false);
  finish({ items: [{ title: 'retained' }] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.get('kv').filter(message => message.type === 'resources-result').length, 1);
});

test('a new account token invalidates both resource panels', t => {
  const connection = { serverUrl: 'https://steamharness.test', accessToken: 'test-token' };
  const { provider, state, accountChanged } = fixture(t, undefined, connection); provider.update([project('project')]);
  const generation = state('kv').generation;
  accountChanged('authenticated', { ...connection, accessToken: 'other-account' });
  assert.ok(state('kv').generation > generation);
  assert.equal(state('kv').generation, state('knowledge').generation);
});

test('copy uses the VS Code clipboard and ignores a previous project context', async t => {
  const { provider, send, state, copied } = fixture(t); const projects = [project('first'), project('second')];
  provider.update(projects, projects[0]); const generation = state('kv').generation;
  await send('kv', undefined, { type: 'copy', text: '{"value":7}' });
  provider.update(projects, projects[1]);
  await send('kv', undefined, { type: 'copy', text: 'stale', generation, projectUri: projects[0].uri });
  assert.deepEqual(copied, ['{"value":7}']);
});

test('an unauthorized resource request expires the captured account and refreshes the login state', async t => {
  const connection = { serverUrl: 'https://steamharness.test', accessToken: 'test-token' };
  const { provider, send, state, invalidated } = fixture(t, async () => { throw Object.assign(new Error('Expired'), { status: 401 }); }, connection);
  provider.update([project('project')]); const generation = state('kv').generation;
  await send('kv');
  assert.deepEqual([invalidated, state('kv').authenticated, state('kv').generation > generation], [[connection], false, true]);
});
