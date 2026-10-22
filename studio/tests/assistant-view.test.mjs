import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/assistant-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const folder = path => ({ uri: { scheme: 'file', fsPath: path, toString: () => `file://${path}` }, name: path });
const descriptor = () => ({ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', folderPath: '/assistant/app', name: 'Project Assistant', projectType: 'conversation',
  entrypoints: [], fields: [{ name: 'model', defaultValue: 'assistant-model' }], tools: [{ name: 'read' }, { name: 'skill' }],
  assistant: { standalone: true, workdir: '/assistant/workspace', roots: [{ uri: 'file:///assistant/workspace', folderPath: '/assistant/workspace', name: 'Assistant' }] },
});

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = new Map();
  const disposable = { dispose() {} };
  const events = {};
  const receivers = new Set(), disposals = new Set();
  events.message = message => Promise.all([...receivers].map(receive => receive(message)));
  events.dispose = () => { for (const dispose of [...disposals]) { dispose(); } };
  const inspections = [], projects = [], sessions = [], messages = [], executions = [];
  const uri = folder('/extension').uri;
  const vscode = {
    env: { language: 'en' },
    Uri: { joinPath: (root, ...parts) => ({ toString: () => `${root.toString()}/${parts.join('/')}` }) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable; }, executeCommand: async (...args) => { executions.push(args); } },
    workspace: { workspaceFolders: options.folders ?? [folder('/workspace')], isTrusted: options.trusted ?? true,
      getWorkspaceFolder: uri => vscode.workspace.workspaceFolders.filter(folder => String(uri).startsWith(`${folder.uri}/`)).sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0],
      onDidChangeWorkspaceFolders: callback => { events.folders = callback; return disposable; },
      onDidGrantWorkspaceTrust: callback => { events.trust = callback; return disposable; },
      onDidChangeConfiguration: callback => { events.configuration = callback; return disposable; },
    },
    window: { registerWebviewViewProvider: () => disposable, onDidChangeActiveTextEditor: callback => { events.editor = callback; return disposable; } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), crypto: globalThis.crypto, setTimeout, clearTimeout });
  const runtime = { available: options.available ?? true,
    inspect: async () => { throw new Error('The workspace executor must not be used as the assistant.'); },
    inspectAssistant: async (...args) => { inspections.push(args); return options.inspect ? options.inspect(...args) : { projects: [descriptor()], errors: [] }; },
  };
  const provider = new module.exports.AssistantViewProvider({ subscriptions: [], extensionUri: uri }, runtime, { appendLine() {} }, async (project, view) => {
    projects.push(project);
    await options.open?.(project, view);
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    const session = { closed, finish, disposed: false, dispose: async () => { session.disposed = true; await options.close?.(); finish(); } };
    sessions.push(session);
    return session;
  }, options.register ?? true);
  t.after(() => provider.dispose());
  const view = { webview: { options: {}, cspSource: 'https://test.vscode-webview.net', asWebviewUri: uri => uri,
    onDidReceiveMessage: callback => { receivers.add(callback); return { dispose: () => receivers.delete(callback) }; }, postMessage: async message => { messages.push(message); } },
    onDidDispose: callback => { disposals.add(callback); return { dispose: () => disposals.delete(callback) }; }, show() {},
  };
  const flushEditor = async () => {
    t.mock.timers.tick(150);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { provider, view, vscode, events, commands, inspections, projects, sessions, messages, executions, flushEditor };
}

test('the assistant loads its own executor, parameters and skills without inspecting the workspace', async t => {
  const { provider, view, inspections, projects, executions } = fixture(t);
  await provider.resolveWebviewView(view);
  assert.equal(inspections[0][0].folderPath, '/workspace');
  assert.equal(inspections[0][1].length, 1);
  assert.equal(projects[0].folderPath, '/assistant/app');
  assert.equal(projects[0].uri, 'studio-assistant:%2Fworkspace');
  assert.equal(projects[0].assistant.workdir, '/workspace');
  assert.equal(projects[0].fields[0].defaultValue, 'assistant-model');
  assert.ok(projects[0].tools.some(tool => tool.name === 'skill'));
  assert.equal(view.description, '/workspace');
  assert.equal(executions.length, 0);
});

test('active files select their workspace root and switching stops the old assistant before rebinding', async t => {
  let save;
  const { provider, view, vscode, events, inspections, projects, sessions, flushEditor } = fixture(t, {
    folders: [folder('/workspace'), folder('/other-project')], close: () => new Promise(resolve => { save = resolve; }),
  });
  await provider.resolveWebviewView(view);
  vscode.window.activeTextEditor = { document: { uri: 'file:///other-project/index.ts' } };
  events.editor();
  await flushEditor();
  assert.equal(sessions[0].disposed, true);
  assert.equal(inspections.length, 1);
  save(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(projects[1].assistant.workdir, '/other-project');
  assert.equal(projects[1].assistant.roots[0].folderPath, '/other-project');
  assert.equal(projects[1].assistant.roots[1].folderPath, '/workspace');
  assert.notEqual(projects[1].uri, projects[0].uri);
  vscode.window.activeTextEditor = undefined; events.editor(); await flushEditor();
  assert.equal(sessions.length, 2, 'Focusing the assistant must retain the current folder.');
  vscode.window.activeTextEditor = { document: { uri: 'file:///unopened/index.ts' } }; events.editor(); await flushEditor();
  assert.equal(sessions.length, 2, 'A file outside the workspace must not change scope.');
});

test('an assistant panel pins its own workspace folder while the IDE assistant can follow active files', async t => {
  const f = fixture(t, { register: false, folders: [folder('/workspace'), folder('/other-project')] });
  await f.provider.resolveWebviewView(f.view);
  f.vscode.window.activeTextEditor = { document: { uri: 'file:///other-project/index.ts' } };
  f.events.editor(); await f.flushEditor();
  assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0].disposed, false);
  assert.equal(f.projects[0].assistant.workdir, '/workspace');
  assert.equal(f.commands.has('studio.newAssistantConversation'), false);
  f.vscode.workspace.workspaceFolders = [folder('/other-project')];
  await f.events.folders();
  assert.equal(f.sessions[0].disposed, true); assert.equal(f.projects.at(-1).assistant.workdir, '/other-project');
});

test('removing workspace folders stops the assistant and empty workspaces offer Open Folder', async t => {
  const { provider, view, vscode, events, executions, inspections, sessions } = fixture(t);
  await provider.resolveWebviewView(view);
  vscode.workspace.workspaceFolders = [];
  await events.folders();
  assert.equal(inspections.length, 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].disposed, true);
  assert.match(view.webview.html, /Open a folder/);
  events.message({ type: 'assistant-open-folder' });
  assert.equal(executions.at(-1)[0], 'studio.openFolder');
});

test('adding a linked root rebinds the scope and a nested active file chooses the deepest root', async t => {
  const { provider, view, vscode, events, projects, sessions, flushEditor } = fixture(t);
  await provider.resolveWebviewView(view);
  vscode.workspace.workspaceFolders.push(folder('/workspace/nested'));
  vscode.window.activeTextEditor = { document: { uri: 'file:///workspace/nested/index.ts' } };
  await events.folders();
  assert.equal(sessions[0].disposed, true);
  assert.equal(projects[1].assistant.workdir, '/workspace/nested');
  assert.equal(projects[1].assistant.roots.length, 2);
  vscode.window.activeTextEditor = { document: { uri: 'file:///workspace/index.ts' } }; events.editor(); await flushEditor();
  assert.equal(projects[2].assistant.workdir, '/workspace');
  assert.equal(projects[2].uri, projects[0].uri, 'Returning to a folder must restore its history identity.');
});

test('disposing the view during inspection never opens an orphan assistant', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { provider, view, events, projects } = fixture(t, { inspect: () => pending });
  const binding = provider.resolveWebviewView(view);
  await new Promise(resolve => setImmediate(resolve));
  events.dispose();
  finish({ projects: [descriptor()], errors: [] });
  await binding;
  assert.equal(projects.length, 0);
});

test('missing assistant dependencies show retry without asking to select another project', async t => {
  let installed = false;
  const { provider, view, events, projects } = fixture(t, { inspect: () => installed ? { projects: [descriptor()], errors: [] } : { projects: [], errors: ['Install @steamharness/cli for <assistant>.'] } });
  await provider.resolveWebviewView(view);
  assert.equal(projects.length, 0);
  assert.match(view.webview.html, /&lt;assistant&gt;/);
  assert.match(view.webview.html, /assistant-retry/);
  assert.doesNotMatch(view.webview.html, /assistant-settings|assistantProjectPath/);
  installed = true;
  events.message({ type: 'assistant-retry' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(projects[0].assistant.workdir, '/workspace');
});

test('retry immediately reports progress, ignores duplicates, shows failures and can succeed on the next attempt', async t => {
  let attempt = 0, rejectRetry;
  const f = fixture(t, {
    inspect: () => {
      attempt++;
      if (attempt === 1) { throw new Error('Initial startup failed'); }
      if (attempt === 2) { return new Promise((_resolve, reject) => { rejectRetry = reject; }); }
      return { projects: [descriptor()], errors: [] };
    },
    open: (_project, view) => { view.webview.html = '<main>Assistant ready</main>'; },
  });
  await f.provider.resolveWebviewView(f.view);
  const retry = f.events.message({ type: 'assistant-retry' });
  assert.match(f.view.webview.html, /Retrying Assistant\.\.\./);
  assert.match(f.view.webview.html, /<button[^>]*aria-busy="true"[^>]* disabled/);
  await new Promise(resolve => setImmediate(resolve));
  await f.events.message({ type: 'assistant-retry' });
  assert.equal(attempt, 2, 'A duplicate click must not start another inspection.');
  rejectRetry(new Error('Tool initialization failed <again>'));
  await retry;
  assert.match(f.view.webview.html, /Assistant retry failed/);
  assert.match(f.view.webview.html, /Tool initialization failed &lt;again&gt;/);
  assert.doesNotMatch(f.view.webview.html.match(/<button[^>]*>/)[0], /disabled/);
  await f.events.message({ type: 'assistant-retry' });
  assert.equal(f.view.webview.html, '<main>Assistant ready</main>');
  assert.equal(f.sessions.length, 1);
});

test('a stale retry failure cannot replace the state of a changed workspace', async t => {
  let attempt = 0, rejectRetry;
  const f = fixture(t, { inspect: () => {
    if (++attempt === 1) { throw new Error('Initial startup failed'); }
    return new Promise((_resolve, reject) => { rejectRetry = reject; });
  } });
  await f.provider.resolveWebviewView(f.view);
  const retry = f.events.message({ type: 'assistant-retry' });
  await new Promise(resolve => setImmediate(resolve));
  f.vscode.workspace.workspaceFolders = [];
  const changed = f.events.folders();
  rejectRetry(new Error('Stale retry failure'));
  await Promise.all([retry, changed]);
  assert.match(f.view.webview.html, /Open a folder/);
  assert.doesNotMatch(f.view.webview.html, /Stale retry failure|Assistant retry failed/);
  assert.equal(f.projects.length, 0);
});

test('the opened project cannot impersonate the dedicated assistant', async t => {
  const { provider, view, projects } = fixture(t, { inspect: () => ({ projects: [{ ...descriptor(), id: 'build-in-pi' }], errors: [] }) });
  await provider.resolveWebviewView(view);
  assert.equal(projects.length, 0);
  assert.match(view.webview.html, /assistant-retry/);
});

for (const [name, options] of [['empty workspace', { folders: [] }], ['untrusted workspace', { trusted: false }]]) {
  test(`the assistant waits in an ${name}`, async t => {
    const { provider, view, vscode, events, projects, inspections } = fixture(t, options);
    await provider.resolveWebviewView(view);
    assert.equal(projects.length, 0); assert.equal(inspections.length, 0);
    assert.match(view.webview.html, name === 'empty workspace' ? /Open a folder/ : /Trust the current workspace/);
    assert.match(view.webview.html, /<link rel="stylesheet" href="file:\/\/\/extension\/dist\/scrollbars.css">/);
    assert.match(view.webview.html, /style-src https:\/\/test.vscode-webview.net 'nonce-/);
    vscode.workspace.workspaceFolders = [folder('/workspace')]; vscode.workspace.isTrusted = true;
    await (name === 'empty workspace' ? events.folders() : events.trust());
    assert.equal(projects[0].assistant.workdir, '/workspace');
  });
}

test('a superseded inspection cannot open a worker in the previous folder', async t => {
  let finish;
  const { provider, view, vscode, events, projects, flushEditor } = fixture(t, {
    folders: [folder('/workspace'), folder('/other-project')],
    inspect: target => target.folderPath === '/workspace' ? new Promise(resolve => { finish = resolve; }) : { projects: [descriptor()], errors: [] },
  });
  const binding = provider.resolveWebviewView(view);
  await new Promise(resolve => setImmediate(resolve));
  vscode.window.activeTextEditor = { document: { uri: 'file:///other-project/index.ts' } };
  events.editor(); finish({ projects: [descriptor()], errors: [] });
  await binding;
  assert.equal(projects.length, 0, 'A pending debounce must immediately invalidate the previous inspection.');
  await flushEditor();
  assert.equal(projects.length, 1); assert.equal(projects[0].assistant.workdir, '/other-project');
});

test('rapid editor changes debounce the rebind while preserving the current conversation', async t => {
  const { provider, view, vscode, events, projects, sessions, flushEditor } = fixture(t, {
    folders: [folder('/workspace'), folder('/other-project')],
  });
  await provider.resolveWebviewView(view);
  vscode.window.activeTextEditor = { document: { uri: 'file:///other-project/first.ts' } };
  events.editor(); t.mock.timers.tick(100);
  vscode.window.activeTextEditor = { document: { uri: 'file:///other-project/latest.ts' } };
  events.editor(); t.mock.timers.tick(149);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(projects.length, 1);
  assert.equal(sessions[0].disposed, false);
  await flushEditor();
  assert.equal(projects.length, 2);
  assert.equal(sessions[0].disposed, true);
  assert.equal(projects[1].assistant.workdir, '/other-project');
});

test('the browser extension host reports that the independent CLI needs Node', async t => {
  const { provider, view, projects, inspections } = fixture(t, { available: false });
  await provider.resolveWebviewView(view);
  assert.equal(projects.length, 0);
  assert.equal(inspections.length, 0);
  assert.ok(view.webview.html.includes('Node'));
});

test('assistant commands restart an exited CLI before sending the command', async t => {
  const { provider, view, sessions, messages, commands } = fixture(t);
  await provider.resolveWebviewView(view);
  sessions[0].finish(); await sessions[0].closed;
  await commands.get('studio.newAssistantConversation')();
  assert.equal(sessions.length, 2);
  assert.equal(messages.at(-1).command, 'new');
});
