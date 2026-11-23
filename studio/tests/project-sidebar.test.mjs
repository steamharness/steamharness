import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { outputFiles: [bundle] } = await build({ stdin: { contents: `
  export { ProjectSidebar } from './project-sidebar';
  export { bindHostedSidebar } from './project-sidebar-view';
  export { hostedSidebarHtml } from './project-sidebar-html';
  export { readSidebarProjectEntries } from './project-sidebar-node';`,
  resolveDir: fileURLToPath(new URL('../extensions/studio-workstation/src/', import.meta.url)) },
  platform: 'node', format: 'cjs', bundle: true, external: ['vscode'], write: false });

const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => Promise.withResolvers();
const flush = () => new Promise(resolve => setImmediate(resolve));
const disposable = { dispose() {} };
const projectId = '74e7ef44-9410-4054-aaed-40f196208426';
const board = { directory: '/history/board', projectId, title: 'Board', type: 'kanban', entryId: 'board' };

function emitter() {
  const listeners = new Set();
  return {
    event(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    fire(event) { for (const listener of listeners) listener(event); },
    dispose() { listeners.clear(); },
  };
}

function createView(visible = true) {
  const visibility = emitter(), disposed = emitter(), messages = emitter();
  return { visible, webview: { html: '', onDidReceiveMessage: messages.event }, onDidDispose: disposed.event, onDidChangeVisibility: visibility.event,
    setVisible(value) { this.visible = value; visibility.fire(); }, dispose: disposed.fire };
}

function fixture(t, initial, options = {}) {
  const views = new Map(), commands = new Map(), tabs = [], calls = [], errors = [];
  const configuration = emitter(), output = { appendLine: error => errors.push(error) };
  let prefs = initial, trusted = true;
  const uri = url => ({ scheme: url.protocol.slice(0, -1), query: url.search, fragment: url.hash, path: url.pathname, fsPath: url.protocol === 'file:' ? fileURLToPath(url) : '', toString: () => url.href });
  const vscode = {
    env: { language: options.language ?? 'en' }, ConfigurationTarget: { Global: 1 }, ProgressLocation: { Notification: 15 }, EventEmitter: class { constructor() { return emitter(); } }, FileType: { Directory: 2, File: 1 },
    Uri: { file: path => uri(pathToFileURL(path)), parse: value => uri(new URL(value)), joinPath: (value, part) => uri(new URL(part, `${value}/`)) },
    workspace: {
      workspaceFolders: [], isTrusted: true, onDidChangeConfiguration: configuration.event,
      fs: {
        async stat(file) {
          if (['/history/board', '/history/projects/examples/other', '/history/node_modules/ignored'].includes(path.dirname(file.fsPath))) return { type: 1 };
          throw new Error('Missing manifest');
        },
        async readDirectory(dir) {
          return { '/history': [['board', 2], ['projects', 2], ['node_modules', 2]], '/history/projects': [['examples', 2]], '/history/projects/examples': [['other', 2]] }[dir.fsPath] ?? [];
        },
      },
      getConfiguration: () => ({ inspect: () => ({ globalValue: prefs, workspaceValue: initial }), update: async (_key, value, target) => {
        assert.equal(target, 1); prefs = clone(value); configuration.fire({ affectsConfiguration: key => key === 'studio.sidebar.entries' });
      } }),
    },
    commands: {
      registerCommand: (id, run) => { commands.set(id, run); return disposable; },
      executeCommand: async (id, ...args) => {
        if (/^studio\.internal(?:Show|Close|Prepare)LaunchpadApp$/.test(id)) return options.launchpad(id, ...args);
        if (id === 'studio.internalSyncSidebarTabs') tabs.push(clone(args[0]));
        if (id === 'studio.internalSidebarHistory') return ['file:///history/board', 'file:///history', 'vscode-remote://remote/path'];
        if (id === 'studio.internalSidebarProjectTrust') { calls.push(['trust', ...args]); return trusted && !String(args[0]).endsWith('/other'); }
      },
    },
    window: {
      registerWebviewViewProvider: (id, provider) => {
        assert.ok(!views.has(id)); views.set(id, provider); return { dispose: () => views.delete(id) };
      },
      withProgress: (_, run) => run(null, { isCancellationRequested: false }),
      showQuickPick: async items => { calls.push(['picks', ...items.map(item => item.description)]); return items; },
      showWarningMessage: async (_label, _options, proceed) => options.confirm === false ? undefined : proceed,
      showInformationMessage: async () => undefined,
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), crypto: globalThis.crypto, AbortController, Error, URL, setTimeout, clearTimeout });
  const sidebar = new module.exports.ProjectSidebar({ subscriptions: [], globalState: { get: () => [] } }, {
    readSidebarEntries: async directory => { calls.push(['manifest', directory]); return options.read?.(directory) ?? [{ ...board, directory }]; },
    inspect: async (directories, metadata) => {
      calls.push(['inspect', ...directories]);
      return options.inspect ? options.inspect(directories, metadata) : { projects: [{ id: projectId, projectType: board.type, entryId: board.entryId, folderPath: board.directory }], errors: [] };
    },
    openHostedSidebar: options.openHostedSidebar ?? (async () => { assert.fail('startup must not launch a preview'); }),
  }, output);
  t.after(() => sidebar.dispose());
  sidebar.registerHosted({ id: 'builtin-chat', viewId: 'studio.fixture', title: 'Chat', getState: () => ({ message: 'Fixture' }), onDidChange: () => disposable });
  const sessions = [];
  const start = () => sidebar.start({ resolveWebviewView() {} }, () => [], async (project, view) => {
    const end = deferred();
    const session = { project, closed: end.promise, disposed: false, async dispose() { this.disposed = true; end.resolve(); } };
    sessions.push(session); view.webview.html = '<iframe></iframe>'; return session;
  });
  return { ...module.exports, sidebar, start, output, calls, tabs, commands, views, sessions, revoke: () => { trusted = false; commands.get('studio.internalSidebarTrustChanged')(); }, prefs: () => prefs };
}

test('a host workspace replaces the default assistant and stops its mount on invalidation', async t => {
  const f = fixture(t, {}), changed = emitter(), view = createView();
  let trusted = true;
  const project = { id: projectId, entryId: 'main', projectType: 'bot', folderBot: { id: projectId, directory: '/folder', background: false } };
  f.sidebar.overrideAssistant({ title: 'Folder Assistant', onDidChange: changed.event,
    check: async () => { if (!trusted) throw new Error('No longer trusted'); }, load: async () => project });
  await f.start();
  const assistant = f.views.get('studio.developerAssistant');
  assistant.resolveWebviewView(view);
  await flush();
  assert.equal(view.title, 'Folder Assistant');
  assert.equal(f.sessions[0].project, project);
  trusted = false; changed.fire(); await flush();
  assert.equal(f.sessions[0].disposed, true);
  assert.match(view.webview.html, /No longer trusted/);
});

test('launchpad shares a warming preview across clicks, and replaces it on account change', async t => {
  const auth = new AbortController(), ready = deferred();
  let created = 0, closed = 0;
  const mounted = [], opened = [], revoked = [];
  const f = fixture(t, {}, {
    openHostedSidebar: async (_project, binding) => {
      created++; assert.equal(binding.bootstrap.secret, 'host-only');
      return { url: 'http://127.0.0.1:1234/nonce/index.html', nonce: 'nonce', close: async () => { closed++; } };
    },
    async launchpad(cmd, key, arg, view) {
      if (cmd === 'studio.internalCloseLaunchpadApp') { revoked.push(key); return; }
      if (cmd === 'studio.internalShowLaunchpadApp') { opened.push([key,arg,view.id,view.titlebarOverlay]); assert.match(view.html,/id="project-frame"/); assert.doesNotMatch(view.html,/host-only/); return true; }
      mounted.push(key); assert.equal(arg.port,1234);
      assert.doesNotMatch(JSON.stringify(arg), /host-only/); await ready.promise; return true;
    },
  });
  f.sidebar.registerHosted({ id:'hosted',title:'Chat',getState:()=>({binding:{bootstrap:{secret:'host-only'}}}) });
  const warm = f.sidebar.prepareHostedInLaunchpad('hosted',auth.signal);
  const first = f.sidebar.showHostedInLaunchpad('hosted','r1',auth.signal,{ id: 'a&b', route: '/chat?id=a%26b', titlebarOverlay: true });
  ready.resolve(); const { key } = await warm; await first;
  await f.sidebar.showHostedInLaunchpad('hosted','r2',auth.signal,{ id: 'other', route: '/chat?id=other' });
  assert.deepEqual([created,closed,mounted,opened],[1,0,[key],[[key,'r1','a&b',true],[key,'r2','other',undefined]]]);
  auth.abort(); assert.deepEqual([closed,revoked],[1,[key]]);
  const { key: second } = await f.sidebar.prepareHostedInLaunchpad('hosted',new AbortController().signal);
  assert.notEqual(second,key); await f.commands.get('studio.internalReleaseHostedLaunchpadApp')(key);
  assert.equal(closed,1); f.sidebar.dispose(); assert.equal(closed,2);
});

test('restores the order without inspecting or starting anything and locks built-ins', async t => {
  const saved = { ...board, id: projectId, visible: true };
  const f = fixture(t, { order: [projectId, 'builtin-chat', 'assistant'], projects: [saved] });
  await f.start();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.tabs[0].map(tab => tab.viewId), [`studio.sidebar.${projectId}`, 'studio.fixture', 'studio.developerAssistant']);
  await f.sidebar.edit({ action: 'toggle', id: 'assistant' });
  await f.sidebar.edit({ action: 'remove', id: 'builtin-chat' });
  assert.equal(f.tabs.length, 1);
  await f.sidebar.edit({ action: 'up', id: 'assistant' });
  assert.deepEqual(f.prefs().order, [projectId, 'assistant', 'builtin-chat']);
  await f.sidebar.edit({ action: 'toggle', id: projectId });
  assert.deepEqual(f.tabs.at(-1).map(tab => tab.viewId), ['studio.developerAssistant', 'studio.fixture']);
  assert.deepEqual(f.calls, []);
});

test('finds all history entries without executing CLI and only saves confirmed trusted projects', async t => {
  const f = fixture(t, undefined);
  await f.start();
  await f.sidebar.edit({ action: 'add' });
  assert.deepEqual(f.calls, [['manifest', '/history/board'], ['manifest', '/history/projects/examples/other'], ['picks', 'Kanban · board', 'Kanban · board'],
    ['manifest', '/history/board'], ['trust', 'file:///history/board', true], ['manifest', '/history/projects/examples/other'], ['trust', 'file:///history/projects/examples/other', true]]);
  assert.equal(f.prefs().projects.length, 1);
  assert.equal(f.prefs().projects[0].directory, board.directory);
  assert.notEqual(f.prefs().projects[0].id, f.prefs().projects[0].projectId);
  const cancelled = fixture(t, undefined, { confirm: false });
  await cancelled.start(); await cancelled.sidebar.edit({ action: 'add' });
  assert.equal(cancelled.prefs(), undefined);
  assert.ok(!cancelled.calls.some(([name]) => name === 'trust'));
});

test('restores the localized entry title from preferences without reading project files', async t => {
  const saved = { ...board, id: projectId, visible: true, localizedNames: { en: 'Tasks', 'zh-CN': '任务看板' } };
  const f = fixture(t, { projects: [saved] }, { language: 'zh-cn' });
  await f.start();
  assert.equal(f.tabs[0].find(tab => tab.viewId === `studio.sidebar.${projectId}`).title, '任务看板');
  assert.deepEqual(f.calls, []);
});

test('starts only on visible mount and releases it on hide or trust revocation', async t => {
  const saved = { ...board, id: projectId, visible: true };
  const f = fixture(t, { order: [], projects: [saved] });
  await f.start();
  const id = `studio.sidebar.${projectId}`, first = createView(false);
  f.views.get(id).resolveWebviewView(first);
  assert.equal(f.calls.length, 0);
  first.setVisible(true); await flush();
  assert.equal(f.sessions.length, 1);
  await f.sidebar.edit({ action: 'toggle', id: projectId });
  assert.equal(f.sessions[0].disposed, true);
  assert.equal(f.views.has(id), false);
  await f.sidebar.edit({ action: 'toggle', id: projectId });
  const second = createView(); f.views.get(id).resolveWebviewView(second); await flush();
  assert.equal(f.sessions.length, 2);
  f.revoke(); await flush();
  assert.equal(f.sessions[1].disposed, true);
  assert.match(second.webview.html, /Trust this project folder/);
});

test('does not inspect a replaced entry; hiding cancels an in-flight inspection', async t => {
  const saved = { ...board, id: projectId, visible: true };
  const changed = fixture(t, { projects: [saved] }, { read: () => [{ ...board, directory: '/different/realpath' }] });
  await changed.start();
  const first = createView(); changed.views.get(`studio.sidebar.${projectId}`).resolveWebviewView(first); await flush();
  assert.match(first.webview.html, /entry has changed/);
  assert.ok(!changed.calls.some(([name]) => name === 'trust' || name === 'inspect'));

  const started = deferred();
  const f = fixture(t, { projects: [saved] }, { inspect: (_, { signal }) => {
    started.resolve(signal);
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ projects: [], errors: [] }), { once: true }));
  } });
  await f.start(); f.views.get(`studio.sidebar.${projectId}`).resolveWebviewView(createView());
  const signal = await started.promise;
  await f.sidebar.edit({ action: 'toggle', id: projectId });
  assert.equal(signal.aborted, true);
  assert.equal(f.sessions.length, 0);
});

test('packaged previews wait for visibility, recover missing files and discard stale account mounts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), view = createView(false), changed = emitter();
  let binding = { service: 'fixture' }, activeMount = deferred(), calls = 0, closed = 0;
  const preview = { url: 'http://127.0.0.1:32123/fixture', nonce: 'fixture', close: async () => { closed++; } };
  f.bindHostedSidebar(view, { title: 'Fixture', getState: () => binding ? { binding } : { message: 'Signed out' }, onDidChange: changed.event }, async () => {
    if (++calls === 1) throw new Error('Still building');
    return activeMount.promise;
  }, f.output);
  assert.equal(calls, 0);
  view.setVisible(true); await flush();
  assert.match(view.webview.html, /files are unavailable/);
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);
  binding = undefined; changed.fire();
  activeMount.resolve(preview); await flush();
  assert.match(view.webview.html, /Signed out/); assert.equal(closed, 1);
  activeMount = deferred(); binding = { service: 'fixture' }; changed.fire();
  activeMount.resolve(preview); await flush();
  assert.match(view.webview.html, /<iframe/);
  view.dispose(); assert.equal(closed, 2);
});

test('only the focused standalone frame can request clipboard edits; replies come from its webview host', t => {
  const { hostedSidebarHtml } = fixture(t);
  const origin = 'http://127.0.0.1:32123', hostOrigin = 'vscode-webview://fixture', nonce = 'fixture';
  const preview = { url: `${origin}/fixture`, nonce };
  assert.doesNotMatch(hostedSidebarHtml('en', 'Sidebar', preview), /web-app-clipboard|vscode-webview-exec-command/);
  const html = hostedSidebarHtml('en', 'Chat', preview, '/chat');
  assert.match(html, /allow="microphone 'none'"/);
  const events = [], listeners = {};
  const addEventListener = (type, listener) => { listeners[type] = listener; };
  const frame = {
    contentWindow: { postMessage: (message, targetOrigin) => events.push(['frame', message, targetOrigin]) },
    dispatchEvent: event => events.push(['event', event.type, event.detail]),
    clientWidth: 500, clientHeight: 400, getBoundingClientRect: () => ({ left: 2, top: 3 }),
  };
  const parent = {}, document = { activeElement: frame, getElementById: () => frame, hasFocus: () => focused };
  let focused = true;
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ postMessage: message => events.push(['host', message]) }),
    document, addEventListener, CustomEvent, window: { parent, origin: hostOrigin, addEventListener },
  });
  const send = (type, requestId, data = {}, event = {}) => listeners.message({
    origin, source: frame.contentWindow, data: { type: `steamharness:web-app-${type}`, version: 1, nonce, requestId, ...data }, ...event,
  });
  send('clipboard', 'copy-1', { text: 'draft' }, { source: {} });
  send('clipboard', 'copy-1', { text: 'draft' }, { origin: 'http://foreign.test' });
  send('clipboard', 'copy-1', { text: 'draft', nonce: 'invalid' });
  send('paste', 'paste-1', { version: 0 });
  send('paste', '');
  focused = false;
  send('paste', 'paste-1');
  focused = true; document.activeElement = {};
  send('paste', 'paste-1');
  assert.deepEqual(events, []);
  document.activeElement = frame;
  send('clipboard', 'copy-1', { text: 'draft' });
  send('paste', 'paste-1');
  send('contextmenu', 'menu-1', { x: 13, y: 17, editable: true, selection: false });
  const clipboardData = { text: 'native' };
  const edit = new CustomEvent('vscode-webview-exec-command', { cancelable: true, detail: { command: 'paste', requestId: 'paste-1', clipboard: clipboardData } });
  listeners['vscode-webview-exec-command'](edit);
  assert.equal(edit.defaultPrevented, true);
  const data = { type: 'studio-web-app-contextmenu-action', requestId: 'menu-1', command: 'paste' };
  listeners.message({ origin: hostOrigin, source: {}, data });
  listeners.message({ origin: hostOrigin, source: parent, data });
  listeners.message({ origin: hostOrigin, source: parent, data: { type: 'studio-web-app-clipboard-result', requestId: 'copy-1', ok: true } });
  assert.deepEqual(clone(events), [
    ['host', { type: 'studio-web-app-clipboard', requestId: 'copy-1', text: 'draft' }],
    ['event', 'vscode-webview-paste', { requestId: 'paste-1' }],
    ['host', { type: 'studio-web-app-contextmenu', requestId: 'menu-1', x: 15, y: 20, editable: true, selection: false }],
    ['frame', { type: 'steamharness:web-app-edit', version: 1, nonce, command: 'paste', requestId: 'paste-1', clipboardData }, origin],
    ['frame', { type: 'steamharness:web-app-contextmenu-action', version: 1, nonce, requestId: 'menu-1', command: 'paste' }, origin],
    ['frame', { type: 'steamharness:web-app-clipboard-result', version: 1, nonce, requestId: 'copy-1', ok: true }, origin],
  ]);
});

test('history discovery uses the project contract without executing entries and rejects escaped files', async t => {
  const f = fixture(t);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-sidebar-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'dist/steamharness/build/board'), { recursive: true });
  await writeFile(path.join(project, 'steamharness.json'), JSON.stringify({ id: projectId, name: 'Sidebar test', version: '1.0.0', defaultEntry: 'assistant', entries: [
    { entryId: 'assistant', type: 'bot', name: 'Assistant fixture', root: '.', entry: 'index.js' },
    { entryId: 'board', type: 'kanban', name: 'Board', root: '.', entry: 'dist/steamharness/build/board/index.html' },
  ] }));
  await writeFile(path.join(project, 'index.js'), 'throw new Error("must not execute");');
  const artifact = path.join(project, 'dist/steamharness/build/board/index.html');
  await writeFile(path.join(root, 'elsewhere.html'), '<html>elsewhere</html>');
  await symlink(path.join(root, 'elsewhere.html'), artifact);
  assert.deepEqual(Array.from(await f.readSidebarProjectEntries(project), entry => entry.type), ['bot']);
  await rm(artifact); await writeFile(artifact, '<html>fixture</html>');
  assert.deepEqual(Array.from(await f.readSidebarProjectEntries(project), entry => entry.type), ['bot', 'kanban']);
});
