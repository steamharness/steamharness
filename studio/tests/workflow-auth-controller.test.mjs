import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-auth.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const compiledUserSettings = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-user-settings.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}

async function fixture(t, { signedIn = true, sessionCookie, platform = true, connect = signedIn && platform, launchpad = false, serverUrl = 'http://127.0.0.1:7126', uiKind = 1 } = {}) {
  const focus = new Emitter(), secretsChanged = new Emitter(), configuration = new Emitter(), intervals = new Set(), sessions = [];
  const f = { profile: { userId: 'user', email: 'user@example.test', displayName: 'User', avatarUrl: 'data:image/png;base64,b2xk' }, languagePreference: 'system', requests: 0, requestUrls: [], statuses: [], messages: [], opened: [], copied: [], commands: new Map(), executed: [], serializers: new Map(), panels: [] };
  const defaults = { 'editor.fontSize': 14, 'studio.project.serverUrl': 'https://obsolete.example.test' };
  const user = {}, workspace = {}, writes = [];
  const saved = new Map();
  const stored = signedIn ? JSON.stringify({ serverUrl, accessToken: 'test-token', apiKeyId: 'test-key', user: f.profile, sessionCookie }) : undefined;
  const secretReads = [];
  const disposable = { dispose() {} };
  const vscode = {
    EventEmitter: Emitter, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
    Uri: { parse: value => ({ toString: () => value, toJSON: () => value }), joinPath: (_base, ...parts) => ({ toString: () => `file:///extension/${parts.join('/')}` }) },
    ThemeIcon: class { constructor(id) { this.id = id; } }, ViewColumn: { Active: 1 },
    env: { language: 'en', uiKind, openExternal: async uri => { f.opened.push(uri.toString()); return true; }, clipboard: { writeText: async text => { f.copied.push(text); } } },
    UIKind: { Desktop: 1, Web: 2 },
    version: '1.141.0', extensions: { all: [], onDidChange: configuration.event },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand: (id, callback) => { f.commands.set(id, callback); return disposable; },
      executeCommand: async (id, ...args) => {
        f.executed.push({ id, args });
        if (id === 'studio.internalIsLaunchpad') { return launchpad; }
        if (id === 'studio.internalGetDisplayLanguage') { return f.languagePreference; }
        if (id === 'studio.internalGetDesktopNotificationStatus') { return f.desktopNotificationStatus; }
        if (id === 'studio.internalOpenNotificationSettings') { return true; }
        if (id === 'studio.internalSetDisplayLanguage') {
          await f.beforeLanguage?.(args[0]);
          if (f.languageError) { throw new Error('Fixture language failure'); }
          if (!f.cancelLanguage) { f.languagePreference = args[0]; }
          return f.languagePreference;
        }
      },
    },
    authentication: { registerAuthenticationProvider: (_id, _label, provider) => {
      f.provider = provider; provider.onDidChangeSessions(event => sessions.push(event)); return disposable;
    } },
    workspace: { workspaceFolders: [{}], getConfiguration: (prefix = '') => ({
      get: key => { key = prefix ? `${prefix}.${key}` : key; return workspace[key] ?? user[key] ?? defaults[key]; },
      inspect: key => ({ defaultValue: defaults[key], globalValue: user[key], workspaceValue: workspace[key] }),
      update: async (key, value, target) => {
        writes.push({ key, value, target });
        await f.beforeWrite?.({ key, value, target });
        const values = target === 2 ? workspace : user;
        if (value === undefined) { delete values[key]; } else { values[key] = value; }
        configuration.fire({ affectsConfiguration: affected => affected === key });
      },
    }), onDidChangeConfiguration: configuration.event, onDidChangeWorkspaceFolders: configuration.event },
    window: { registerUriHandler: handler => { f.uriHandler = handler; return disposable; }, state: { focused: true }, onDidChangeWindowState: focus.event,
      showInputBox: async () => assert.fail('Connections must use the startup Server without prompting'),
      withProgress: async (_options, run) => {
        const cancel = new Emitter(); f.cancelAi = () => cancel.fire();
        return run({}, { onCancellationRequested: cancel.event, isCancellationRequested: false });
      },
      registerWebviewPanelSerializer: (type, serializer) => { f.serializers.set(type, serializer); if (type === 'studio.settings') { f.serializer = serializer; } return disposable; },
      registerWebviewViewProvider: (id, provider) => { assert.equal(id, 'studio.launchpadSettings'); f.settingsProvider = provider; return disposable; },
      createStatusBarItem: () => { const item = { show() {}, dispose() {} }; f.statuses.push(item); return item; },
      createWebviewPanel: (type, title, _column, options) => {
        const disposed = new Emitter(), received = new Emitter(), changed = new Emitter();
        const messages = [];
        const panel = { type, title, visible: true, options,
          reveal: () => { f.panel = panel; f.message = panel.message; }, onDidDispose: disposed.event, onDidChangeViewState: changed.event,
          dispose: () => { if (!panel.disposed) { panel.disposed = true; panel.visible = false; disposed.fire(); } },
          webview: { cspSource: 'test-source', messages, asWebviewUri: value => value, postMessage: async message => { messages.push(message); f.messages.push(message); },
            onDidReceiveMessage: callback => { f.message = panel.message = callback; return received.event(callback); } } };
        f.panel = panel; f.viewType = type; f.panels.push(panel);
        return panel;
      } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id), URL, URLSearchParams, btoa, Error, AbortSignal, AbortController, structuredClone, crypto: globalThis.crypto, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      f.requests++;
      f.requestUrls.push(url);
      const response = await f.fetch?.(url, options);
      if (response) { return response; }
      if (url.endsWith('/device/start')) return Response.json({errCode:0,data:{deviceCode:'host-device-secret',userCode:'ABCD-1234',verificationUriComplete:`${url.replace(/\/api\/auth\/device\/start$/, '')}/login/device?user_code=ABCD-1234`,intervalSeconds:1,expiresAt:new Date(Date.now()+60000).toISOString()}});
      if (url.endsWith('/device/token')) return Response.json({errCode:0,data:{accessToken:'test-token',apiKey:{id:'test-key'},user:f.profile}});
      if (url.endsWith('/device/cancel')) return Response.json({errCode:0,data:{cancelled:true}});
      return Response.json({errCode:0,data:{profile:f.profile,principal:{apiKeyId:'test-key'}}});
    },
    setInterval: (callback, ms) => { const timer = { callback, ms, unref() {} }; intervals.add(timer); return timer; },
    clearInterval: timer => intervals.delete(timer),
  });
  const context = { extension: { packageJSON: { version: '0.1.0' } }, subscriptions: [], secrets: {
    get: async key => { secretReads.push(key); return saved.has(key) ? saved.get(key) : key.startsWith('studio.project') ? stored : undefined; },
    store: async (key, value) => { saved.set(key, value); }, delete: async key => { saved.set(key, undefined); }, onDidChange: secretsChanged.event } };
  const controller = new module.exports.AccountController(context, undefined, platform, serverUrl, value => createHash('sha256').update(value).digest('hex'));
  await controller.initialize();
  t.after(() => controller.dispose());
  if (connect) await controller.connect();
  return Object.assign(f, { controller, intervals, sessions, vscode, user, workspace, writes, secretReads, saved,
    focus: focused => { vscode.window.state.focused = focused; focus.fire({ focused }); },
    poll: () => { for (const timer of intervals) { timer.callback(); } },
  });
}

test('Server pages reuse Studio credentials and discard a handoff if the account signs out', async t => {
  const f = await fixture(t), code = 'A'.repeat(43);
  f.fetch = async (url, options) => {
    if (url.endsWith('/api/auth/me')) return undefined;
    assert.equal(url, 'http://127.0.0.1:7126/api/auth/browser-session');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(options.body), { returnTo: '/projects/main' });
    return Response.json({ errCode: 0, data: { code } });
  };
  await f.controller.openServerPage('/projects/main');
  assert.equal(f.executed.at(-1).id, 'simpleBrowser.show');
  assert.deepEqual([...f.executed.at(-1).args], [`http://127.0.0.1:7126/api/auth/browser-session?code=${code}`]);
  let finish;
  f.fetch = url => url.endsWith('/api/auth/browser-session') ? new Promise(resolve => { finish = resolve; }) : undefined;
  const pending = f.controller.openServerPage('/projects/main');
  await until(() => finish);
  await f.controller.invalidate(f.controller.getConnection());
  finish(Response.json({ errCode: 0, data: { code } }));
  await pending;
  assert.equal(f.executed.filter(item => item.id === 'simpleBrowser.show').length, 1);
});

async function until(read) {
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (read()) { return; }
  }
  assert.fail('Expected asynchronous operation did not finish');
}

test('settings and account commands share one tab and navigate to their requested categories', async t => {
  const f = await fixture(t);
  f.commands.get('studio.openSettings')({ section: 'editor', query: 'editor.fontSize' });
  const panel = f.panel;
  await f.message({ type: 'ready' });
  assert.equal(f.viewType, 'studio.settings');
  assert.equal(f.messages.filter(message => message.type === 'settings-navigate').at(-1).state.section, 'editor');
  f.commands.get('studio.openAccount')();
  assert.equal(f.panel, panel);
  assert.equal(f.messages.filter(message => message.type === 'settings-navigate').at(-1).state.section, 'account');
  f.commands.get('studio.openSettings')();
  assert.equal(f.panel, panel);
  assert.equal(f.messages.filter(message => message.type === 'settings-navigate').at(-1).state.section, 'general');
  assert.ok(!JSON.stringify(f.messages).includes('test-token'));
});

test('selecting Models loads current plan offers when the built-in model catalogue is empty', async t => {
  const f = await fixture(t);
  let calls = 0, finish;
  const url = 'http://127.0.0.1:7126/settings/ai#ai-group-subscriptions';
  const offers = [{ name: 'Offer', price: 'CN¥25.00 / 30 days', url: 'http://127.0.0.1:7126/settings/ai#ai-subscription-25' }];
  f.controller.registerModelCatalogProvider({ load: async () => ({ entries: [] }), loadPlans: () => { ++calls; return new Promise(resolve => { finish = resolve; }); } });
  await f.controller.getSystemModelCatalog(new AbortController().signal);
  f.commands.get('studio.openSettings')({ section: 'general' });
  const panel = f.panel;
  await panel.message({ type: 'ready' });
  assert.equal(calls, 0);
  await panel.message({ type: 'settings-view-state', state: { section: 'models' } });
  const latest = () => panel.webview.messages.filter(message => message.type === 'settings-models').at(-1)?.state.plans;
  assert.equal(calls, 1);
  assert.equal(latest().loading, true);
  finish({ url, offers });
  await until(() => latest()?.catalog);
  assert.deepEqual(latest().catalog, { url, offers });
  assert.ok(!JSON.stringify(panel.webview.messages).includes('test-token'));
});

test('only enhanced desktop settings expose IM notification switches and system permissions', async t => {
  for (const [platform, uiKind, enabled] of [[true, 1, true], [true, 2, false], [false, 1, false]]) {
    const f = await fixture(t, { platform, uiKind, connect: false });
    f.desktopNotificationStatus = { platform: 'macos', permission: 'denied', appName: 'SteamHarness Dev' };
    f.commands.get('studio.openSettings')({ section: 'notifications' });
    await f.message({ type: 'ready' });
    const latest = () => f.messages.filter(message => message.type === 'settings').at(-1)?.state;
    if (enabled) await until(() => latest()?.desktopNotificationStatus);
    assert.equal(latest().items.filter(item => item.section === 'notifications').length, enabled ? 2 : 0);
    assert.equal(latest().desktopNotificationStatus, enabled ? f.desktopNotificationStatus : undefined);
    await f.message({ type: 'settings-action', action: 'notification-settings' });
    assert.equal(f.executed.some(({ id }) => id === 'studio.internalOpenNotificationSettings'), enabled);
    assert.equal(f.executed.some(({ id }) => id === 'studio.internalGetDesktopNotificationStatus'), enabled);
  }
});

test('launchpad settings reuse the account page without creating an editor or login panel', async t => {
  const f = await fixture(t, { launchpad: true, signedIn: false });
  const execute = f.vscode.commands.executeCommand;
  let current, opens = 0;
  f.vscode.commands.executeCommand = async (id, ...args) => {
    if (id === 'studio.internalCloseLaunchpadSettings') { current?.dispose(); current = undefined; return; }
    if (id !== 'studio.internalShowLaunchpadSettings') return execute(id, ...args);
    assert.deepEqual(args, ['Settings']);
    if (current) return;
    ++opens;
    const received = new Emitter(), disposed = new Emitter(), messages = [];
    current = {
      visible: true, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: disposed.event,
      dispose: () => disposed.fire(), messages,
      send: message => Promise.all([...received.listeners].map(listener => listener(message))),
      webview: { cspSource: 'test-source', asWebviewUri: value => value, onDidReceiveMessage: received.event,
        postMessage: async message => { messages.push(message); return true; } },
    };
    await f.settingsProvider.resolveWebviewView(current, {}, { isCancellationRequested: false });
  };
  await f.commands.get('studio.openSettings')({ section: 'account', target: 'user' });
  const first = current;
  assert.match(first.webview.html, /data-launchpad="true"/);
  assert.match(first.webview.html, /account-ui\.js/);
  await first.send({ type: 'ready' });
  const section = view => view.messages.filter(message => message.type === 'settings-navigate').at(-1).state.section;
  assert.equal(section(first), 'account');
  await first.send({ type: 'open-login' });
  assert.ok(f.executed.some(({ id }) => id === 'studio.launchpadSignIn'));
  for (const action of ['json-user', 'keybindings']) await first.send({ type: 'settings-action', action });
  assert.ok(!f.executed.some(({ id }) => id.startsWith('workbench.action.')));
  await f.commands.get('studio.openSettings')({ section: 'general' });
  assert.equal(current, first);
  assert.equal(section(first), 'general');
  await f.vscode.commands.executeCommand('studio.internalCloseLaunchpadSettings');
  await f.commands.get('studio.openSettings')({ section: 'account' });
  await current.send({ type: 'ready' });
  assert.notEqual(current, first);
  assert.equal(section(current), 'account');
  assert.equal(opens, 2);
  assert.equal(f.panels.length, 0);
});

for (const signedIn of [true, false]) {
  test(`embedded permission shortcuts open and reuse the user permissions page while ${signedIn ? 'signed in' : 'signed out'}`, async t => {
    const f = await fixture(t, { signedIn });
    f.vscode.commands.executeCommand = async (id, ...args) => f.commands.get(id)?.(...args);
    const module = { exports: {} };
    runInNewContext(compiledUserSettings.outputFiles[0].text, { module, exports: module.exports, require: () => f.vscode });
    const open = () => module.exports.openProjectUserSettings({ type: 'workflow-user-settings', version: 1, key: 'agent.permissionPolicy' });
    await open();
    const panel = f.panel;
    await panel.message({ type: 'ready' });
    assert.equal(panel.type, 'studio.settings');
    const navigation = () => JSON.parse(JSON.stringify(panel.webview.messages.filter(message => message.type === 'settings-navigate').at(-1).state));
    const destination = { section: 'permissions', query: '', target: 'user', scroll: 0 };
    assert.deepEqual(navigation(), destination);
    await panel.message({ type: 'settings-view-state', state: { section: 'editor', query: 'editor.fontSize', target: 'workspace' } });
    await open();
    assert.equal(f.panel, panel);
    assert.equal(f.panels.length, 1, 'The shortcut must reuse settings instead of creating another tab.');
    assert.deepEqual(navigation(), destination);
    await panel.message({ type: 'ready' });
    assert.deepEqual(navigation(), destination, 'Rehydrating the settings webview must preserve the permission destination.');
  });
}

test('signed-out account entrances reuse a separate login tab and settings cannot accept credentials', async t => {
  const f = await fixture(t, { signedIn: false });
  f.commands.get('studio.openSettings')({ section: 'account' });
  const settings = f.panel;
  await settings.message({ type: 'ready' });
  await settings.message({ type: 'login', serverUrl: 'http://127.0.0.1:7126', email: 'user@example.test', password: 'secret' });
  assert.equal(f.requests, 0);
  await settings.message({ type: 'open-login' });
  const login = f.panel;
  assert.notEqual(login, settings); assert.equal(login.type, 'studio.login');
  assert.equal(login.title, 'Sign In'); assert.equal(login.iconPath.id, 'sign-in');
  assert.equal(login.options.retainContextWhenHidden, false);
  assert.match(login.webview.html, /login-ui\.js/); assert.doesNotMatch(login.webview.html, /account-ui\.js|unsafe-inline/);
  await f.commands.get('studio.openLogin')(); assert.equal(f.panel, login);
  f.commands.get('studio.openAccount')(); assert.equal(f.panel, settings);
  f.commands.get('studio.openSettings')(); assert.equal(f.panel, settings);
  assert.equal(f.panels.length, 2);
});

test('the login serializer ignores persisted form data and keeps one login tab per window', async t => {
  const f = await fixture(t, { signedIn: false });
  const serializer = f.serializers.get('studio.login');
  const restored = f.vscode.window.createWebviewPanel('studio.login', 'Sign In', 1, {});
  await serializer.deserializeWebviewPanel(restored, { serverUrl: 'https://wrong.example', email: 'old@example.test', password: 'do-not-restore' });
  await restored.message({ type: 'ready' });
  assert.equal(restored.webview.messages.at(-1).state.serverUrl, 'http://127.0.0.1:7126');
  assert.doesNotMatch(JSON.stringify(restored.webview.messages), /do-not-restore|old@example/);
  const duplicate = f.vscode.window.createWebviewPanel('studio.login', 'Sign In', 1, {});
  await serializer.deserializeWebviewPanel(duplicate, {});
  assert.equal(duplicate.disposed, true); assert.equal(f.panel, restored);
  restored.dispose(); await f.commands.get('studio.openLogin')();
  assert.notEqual(f.panel, restored); assert.equal(f.panel.type, 'studio.login');
});

test('successful login updates the shared session and returns to the existing account settings tab', async t => {
  const f = await fixture(t, { signedIn: false });
  let deviceRequest;
  f.fetch = (url, options) => {
    if (url.endsWith('/device/start')) deviceRequest = JSON.parse(options.body);
  };
  f.commands.get('studio.openSettings')({ section: 'editor' }); const settings = f.panel;
  await f.commands.get('studio.openLogin')(); const login = f.panel;
  await login.message({ type: 'ready' });
  await login.message({ type: 'login', serverUrl: 'https://server.example.test' });
  assert.equal(deviceRequest.clientName, 'SteamHarness Studio');
  assert.equal(deviceRequest.source, 'desktop');
  assert.equal(deviceRequest.context.clientKind, 'studio');
  assert.equal(deviceRequest.context.channel, 'dev');
  assert.match(deviceRequest.context.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(login.disposed, true); assert.equal(f.panel, settings);
  assert.equal(settings.webview.messages.filter(message => message.type === 'settings-navigate').at(-1).state.section, 'account');
  assert.equal(f.controller.getState().status, 'authenticated');
  assert.equal(f.controller.getState().serverUrl, 'http://127.0.0.1:7126');
  assert.equal(f.writes.length, 0, 'Sign-in must not persist a separate server setting');
  assert.equal((await f.provider.getSessions([], {}))[0].accessToken, 'test-token');
  assert.doesNotMatch(JSON.stringify(f.messages), /fixture-password|test-token/);
  await f.commands.get('studio.openLogin')(); assert.equal(f.panel, settings); assert.equal(f.panels.length, 2);
});

test('Studio Web polls for approval and signs in without requesting a desktop callback', async t => {
  const f = await fixture(t, { signedIn: false, uiKind: 2 });
  let deviceRequest;
  f.fetch = (url, options) => {
    if (url.endsWith('/device/start')) deviceRequest = JSON.parse(options.body);
  };
  await f.commands.get('studio.openLogin')(); const login = f.panel;
  await login.message({ type: 'ready' });
  await login.message({ type: 'login' });

  assert.deepEqual(deviceRequest, { clientName: 'SteamHarness Studio Web', source: 'desktop' });
  assert.deepEqual(f.opened, ['http://127.0.0.1:7126/login/device?user_code=ABCD-1234']);
  assert.ok(f.requestUrls.some(url => url.endsWith('/device/token')));
  assert.equal(f.controller.getState().status, 'authenticated');
  assert.equal(login.disposed, true);
  assert.equal(f.panel.type, 'studio.settings');
});

test('the Web Launchpad restores and verifies a saved account without opening settings', async t => {
  const f = await fixture(t, { connect: false, launchpad: true, uiKind: 2 });
  await until(() => f.controller.getState().status === 'authenticated');
  assert.deepEqual(f.requestUrls, ['http://127.0.0.1:7126/api/auth/me']);
  assert.ok(f.executed.some(item => item.id === 'studio.internalUpdateAccountMenuState' && item.args[0].status === 'authenticated'));
  assert.equal(f.panels.length, 0);
});

test('failed login enables another attempt and the login panel cannot write settings', async t => {
  const f = await fixture(t, { signedIn: false });
  await f.commands.get('studio.openLogin')(); const login = f.panel;
  await login.message({ type: 'ready' });
  await login.message({ type: 'settings-update', key: 'editor.fontSize', value: 30, target: 'user' });
  assert.equal(f.writes.length, 0);
  f.fetch = async () => { throw new Error('Fixture login unavailable'); };
  const credentials = { type: 'login', serverUrl: 'http://127.0.0.1:7126' };
  await login.message(credentials);
  assert.equal(login.disposed, undefined);
  assert.equal(login.webview.messages.at(-1).type, 'login-result');
  assert.ok(login.webview.messages.at(-1).message); assert.equal(f.controller.getConnection(), undefined);
  f.fetch = undefined;
  await login.message(credentials);
  assert.equal(login.disposed, true); assert.equal(f.controller.getState().status, 'authenticated');
});

test('closing or recreating login during a request cannot submit twice or redirect a newer page', async t => {
  for (const recreate of [false, true]) {
    const f = await fixture(t, { signedIn: false });
    let release;
    f.fetch = url => url.endsWith('/api/auth/device/token') ? new Promise(resolve => { release = () => resolve(Response.json({ errCode: 0, data: { accessToken: 'test-token', apiKey: { id: 'test-key' }, user:f.profile } })); }) : undefined;
    await f.commands.get('studio.openLogin')(); const original = f.panel;
    await original.message({ type: 'ready' });
    const credentials = { type: 'login', serverUrl: 'http://127.0.0.1:7126' };
    const request = original.message(credentials); await until(() => release);
    if (!recreate) { original.dispose(); await f.commands.get('studio.openLogin')(); }
    const current = f.panel; await current.message({ type: 'ready' });
    assert.equal(current.webview.messages.at(-1).busy, true);
    const requests = f.requests; await current.message(credentials); assert.equal(f.requests, requests);
    release(); await request;
    assert.equal(current.disposed, undefined);
    assert.equal(f.panels.some(panel => panel.type === 'studio.settings'), false);
    assert.equal(current.webview.messages.at(-1).state.status, recreate ? 'authenticated' : 'error');
    assert.equal(current.webview.messages.some(message => message.type === 'login-result'), false);
    if (recreate) { await current.message({ type: 'open-account' }); assert.equal(current.disposed, true); assert.equal(f.panel.type, 'studio.settings'); }
    else assert.equal(f.controller.getConnection(),undefined);
  }
});

test('authentication requests wait on the login tab and closing settings does not cancel sign-in', async t => {
  const f = await fixture(t, { signedIn: false });
  f.commands.get('studio.openSettings')(); const settings = f.panel;
  let settled = false;
  const session = f.provider.createSession(['workflow']).finally(() => { settled = true; });
  await until(() => f.panel?.type === 'studio.login');
  const login = f.panel; assert.equal(login.type, 'studio.login');
  settings.dispose(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const cancelled = assert.rejects(session, /Sign-in cancelled/);
  login.dispose(); await cancelled;
  const retry = f.provider.createSession(['workflow']); await until(() => f.panel !== login); const next = f.panel;
  await next.message({ type: 'login', serverUrl: 'http://127.0.0.1:7126' });
  assert.equal((await retry).account.id, 'user');
});

test('display language uses the native preference, validates modes, and reflects cancellation and failures', async t => {
  const f = await fixture(t);
  f.commands.get('studio.openSettings')();
  f.languagePreference = 'en';
  await f.message({ type: 'ready' });
  assert.equal(f.messages.filter(message => message.type === 'settings').at(-1).state.languagePreference, 'en');
  for (const value of ['zh-cn', 'en', 'system']) {
    await f.message({ type: 'settings-language', value });
    const response = f.messages.at(-1);
    assert.equal(response.type, 'settings-language-result'); assert.equal(response.value, value); assert.equal(response.message, undefined);
  }
  f.cancelLanguage = true;
  await f.message({ type: 'settings-language', value: 'zh-cn' });
  assert.equal(f.messages.at(-1).value, 'system');
  f.cancelLanguage = false; f.languageError = true;
  await f.message({ type: 'settings-language', value: 'en' });
  assert.equal(f.messages.at(-1).value, 'system'); assert.equal(f.messages.at(-1).message, 'Fixture language failure');
  const calls = f.executed.filter(call => call.id === 'studio.internalSetDisplayLanguage').length;
  for (const value of ['fr', undefined, { locale: 'zh-cn' }]) {
    await f.message({ type: 'settings-language', value });
    assert.equal(f.messages.at(-1).message, 'Unsupported display language.');
  }
  assert.equal(f.executed.filter(call => call.id === 'studio.internalSetDisplayLanguage').length, calls);
  assert.equal(f.writes.length, 0, 'Display language must not be written as an editor configuration key');
});

test('a reopened settings tab serializes language changes and discards the previous tab response', async t => {
  const f = await fixture(t);
  f.commands.get('studio.openSettings')(); await f.message({ type: 'ready' });
  const oldPanel = f.panel;
  let release;
  f.beforeLanguage = value => value === 'zh-cn' ? new Promise(resolve => { release = resolve; }) : undefined;
  const oldWrite = f.message({ type: 'settings-language', value: 'zh-cn' });
  await until(() => release);
  oldPanel.dispose(); f.commands.get('studio.openSettings')(); await f.message({ type: 'ready' });
  const newWrite = f.message({ type: 'settings-language', value: 'en' });
  release(); await Promise.all([oldWrite, newWrite]);
  assert.equal(oldPanel.webview.messages.some(message => message.type === 'settings-language-result'), false);
  const responses = f.panel.webview.messages.filter(message => message.type === 'settings-language-result');
  assert.equal(responses.length, 1); assert.equal(responses[0].value, 'en');
  assert.equal(f.languagePreference, 'en');
});

test('deserialization restores navigation only and publishes the existing account session', async t => {
  const f = await fixture(t);
  const panel = f.vscode.window.createWebviewPanel('studio.settings', 'Settings', 1, {});
  await f.serializer.deserializeWebviewPanel(panel, { section: 'about', query: '', scroll: 37, password: 'do-not-restore' });
  await f.message({ type: 'ready' });
  const route = f.messages.filter(message => message.type === 'settings-navigate').at(-1).state;
  assert.equal(route.section, 'about'); assert.equal(route.scroll, 37);
  assert.equal(f.messages.find(message => message.type === 'account').state.status, 'authenticated');
  assert.ok(!JSON.stringify(f.messages).includes('do-not-restore'));
});

test('settings save acknowledgements contain the persisted snapshot for the current scope', async t => {
  const f = await fixture(t);
  f.commands.get('studio.openSettings')({ section: 'editor' });
  await f.message({ type: 'ready' });
  let release;
  f.beforeWrite = () => new Promise(resolve => { release = resolve; });
  const saving = f.message({ type: 'settings-update', key: 'editor.fontSize', value: 24, target: 'workspace' });
  await until(() => release);
  await f.message({ type: 'settings-target', target: 'workspace' });
  release(); await saving;
  const saved = f.messages.filter(message => message.type === 'settings-saved').at(-1);
  assert.equal(saved.target, 'workspace'); assert.equal(saved.state.target, 'workspace');
  const font = saved.state.items.find(item => item.key === 'editor.fontSize');
  assert.equal(font.value, 24); assert.equal(font.configured, true);
  assert.equal(f.user['editor.fontSize'], undefined); assert.equal(f.workspace['editor.fontSize'], 24);
});

test('settings failures return a current snapshot without writing invalid configuration', async t => {
  const f = await fixture(t);
  f.commands.get('studio.openSettings')({ section: 'editor' });
  await f.message({ type: 'ready' });
  for (const request of [
    { key: 'editor.fontSize', value: -1, target: 'user' },
    { key: 'studio.terminal.name', value: 'New name', target: 'workspace' },
    { key: 'unknown.setting', value: true, target: 'user' },
  ]) {
    await f.message({ type: 'settings-update', ...request });
    const failure = f.messages.filter(message => message.type === 'settings-error').at(-1);
    assert.equal(failure.key, request.key); assert.equal(failure.target, request.target);
    assert.ok(failure.message); assert.equal(failure.state.items.find(item => item.key === 'editor.fontSize').value, 14);
  }
  f.beforeWrite = async () => { throw new Error('Fixture storage failure'); };
  await f.message({ type: 'settings-update', key: 'editor.fontSize', value: 18, target: 'user' });
  const failure = f.messages.filter(message => message.type === 'settings-error').at(-1);
  assert.equal(failure.message, 'Fixture storage failure');
  assert.equal(failure.state.items.find(item => item.key === 'editor.fontSize').value, 14);
  assert.equal(f.writes.length, 1); assert.equal(f.user['editor.fontSize'], undefined);
});

test('closing and reopening settings cannot deliver an old save acknowledgement to the new tab', async t => {
  const f = await fixture(t);
  f.commands.get('studio.openSettings')({ section: 'editor' });
  const oldPanel = f.panel;
  await f.message({ type: 'ready' });
  let release;
  f.beforeWrite = ({ value }) => value === 18 ? new Promise(resolve => { release = resolve; }) : undefined;
  const oldSave = f.message({ type: 'settings-update', key: 'editor.fontSize', value: 18, target: 'user' });
  await until(() => release);
  oldPanel.dispose();
  f.commands.get('studio.openSettings')({ section: 'editor' });
  const newPanel = f.panel;
  assert.notEqual(newPanel, oldPanel);
  await f.message({ type: 'ready' });
  const newSave = f.message({ type: 'settings-update', key: 'editor.fontSize', value: 20, target: 'user' });
  release(); await Promise.all([oldSave, newSave]);
  assert.equal(oldPanel.webview.messages.some(message => message.type === 'settings-saved'), false);
  const saved = newPanel.webview.messages.filter(message => message.type === 'settings-saved');
  assert.equal(saved.length, 1); assert.equal(saved[0].state.items.find(item => item.key === 'editor.fontSize').value, 20);
  assert.deepEqual(f.writes.map(write => write.value), [18, 20]);
});

test('recreating a hidden webview cannot acknowledge a save from its previous page', async t => {
  const f = await fixture(t);
  f.commands.get('studio.openSettings')({ section: 'editor' });
  await f.message({ type: 'ready' });
  let release;
  f.beforeWrite = ({ value }) => value === 18 ? new Promise(resolve => { release = resolve; }) : undefined;
  const oldSave = f.message({ type: 'settings-update', key: 'editor.fontSize', value: 18, target: 'user' });
  await until(() => release);
  // retainContextWhenHidden is false: the same panel sends ready from its new page.
  await f.message({ type: 'ready' });
  const newSave = f.message({ type: 'settings-update', key: 'editor.fontSize', value: 20, target: 'user' });
  release(); await Promise.all([oldSave, newSave]);
  const saved = f.messages.filter(message => message.type === 'settings-saved');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state.items.find(item => item.key === 'editor.fontSize').value, 20);
});

test('explicit verification refreshes the native authentication avatar', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.getSessions([], {}))[0].account.icon.toString(), f.profile.avatarUrl);
  const connection = JSON.stringify(f.controller.getConnection());
  f.focus(false);
  f.profile = { ...f.profile, avatarUrl: 'data:image/webp;base64,bmV3' };
  f.focus(true);
  assert.notEqual(f.controller.getState().user.avatarUrl, f.profile.avatarUrl);
  await f.commands.get('studio.refreshAccount')();
  assert.equal((await f.provider.getSessions([], {}))[0].account.icon.toString(), f.profile.avatarUrl);
  assert.equal(f.sessions.at(-1).changed[0].account.icon.toString(), f.profile.avatarUrl);
  assert.equal(JSON.stringify(f.controller.getConnection()), connection);
});

test('both editions leave saved project credentials unread during local startup and settings', async t => {
  for (const platform of [false, true]) {
    const f = await fixture(t, { platform, connect: false });
    f.commands.get('studio.openSettings')({ section: 'general' });
    await f.message({ type: 'ready' });
    f.focus(false); f.focus(true); f.poll();
    assert.equal(f.requests, 0);
    assert.deepEqual(f.secretReads.filter(key => key !== 'studio.agent.models'), []);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.commands.has('studio.openLogin'), platform);
    assert.equal(f.commands.has('studio.openAccount'), platform);
    if (platform) {
      assert.equal((await f.provider.getSessions([], {})).length, 0);
      await f.commands.get('studio.refreshAccount')();
      assert.equal(f.requests, 1);
      assert.equal((await f.provider.getSessions([], {}))[0].accessToken, 'test-token');
    }
  }
});

test('account actions use fixed Server routes and copy account fields selected by the host', async t => {
  const f = await fixture(t);
  f.controller.open();
  await f.message({ type: 'ready' });
  assert.equal(f.messages.find(message => message.type === 'account-sections').states.length, 0);
  assert.ok(f.panel.webview.html.includes("default-src 'none'"));
  assert.ok(!f.panel.webview.html.includes('unsafe-inline'));
  await f.message({ type: 'open-profile', url: 'https://untrusted.example' });
  await f.message({ type: 'open-sessions' });
  await f.message({ type: 'copy', field: 'userId', value: 'test-token' });
  await f.message({ type: 'copy', field: 'accessToken' });
  await f.message({ type: 'copy', field: 'serverUrl' });
  assert.deepEqual(f.opened, ['http://127.0.0.1:7126/settings/profile', 'http://127.0.0.1:7126/settings/api-keys']);
  assert.deepEqual(f.copied, ['user']);
  f.controller.dispose();
  await f.message({ type: 'copy', field: 'email' });
  await f.message({ type: 'open-profile' });
  assert.equal(f.copied.length, 1);
  assert.equal(f.opened.length, 2);
});

test('sign out immediately clears contributed content even when a section refresh is pending', async t => {
  const f = await fixture(t, { connect: false });
  await f.controller.connectAi();
  let release, signal;
  f.controller.registerSectionProvider({ id: 'example', title: 'Example', load: (_connection, abort) => {
    signal = abort;
    return new Promise(resolve => { release = resolve; });
  } });
  f.controller.open(); await f.message({ type: 'ready' });
  const refreshing = f.message({ type: 'refresh-sections' });
  await until(() => release);
  await f.commands.get('studio.logout')();
  assert.equal(f.controller.getState().status, 'signed-out');
  assert.equal(signal.aborted, true);
  release([{ id: 'old', title: 'Old account data' }]);
  await refreshing;
  assert.ok(!f.messages.filter(message => message.type === 'account-sections').at(-1).states.some(state => state.sections.some(section => section.id === 'old')));
  assert.ok(!JSON.stringify(f.messages).includes('test-token'));
});

for (const serverUrl of ['http://localhost:7126', 'https://launch.example.test/services']) {
  test(`account and System AI use the startup Server ${serverUrl} without an address prompt`, async t => {
    const f = await fixture(t, { signedIn: false, serverUrl });
    const normalized = serverUrl.replace('localhost', '127.0.0.1');
    assert.equal(f.controller.getState().serverUrl, normalized);
    await f.commands.get('studio.openLogin')();
    await f.panel.message({ type: 'login', serverUrl: 'https://untrusted.example.test' });
    assert.equal(f.controller.getState().serverUrl, normalized);
    await f.vscode.workspace.getConfiguration('studio').update('project.serverUrl', 'https://other.example.test', 1);
    const otherKey = 'studio.system-ai.dev.' + encodeURIComponent('https://other.example.test');
    f.saved.set(otherKey, JSON.stringify({ serverUrl: 'https://other.example.test', accessToken: 'other-server-token' }));
    assert.equal((await f.controller.connectAi()).serverUrl, normalized);
    assert.equal(f.controller.getState().status, 'authenticated');
    assert.ok(f.requestUrls.every(url => url.startsWith(`${normalized}/`)), 'Both sign-ins stay on the startup Server');
    assert.ok(!f.secretReads.includes(otherKey), 'Credentials from another Server must not be read');
    assert.equal(f.writes.length, 1, 'Only the simulated legacy settings change writes a setting');
  });
}

test('System AI reuses the signed-in account unless an explicit AI session is configured', async t => {
  const f = await fixture(t);
  assert.equal(f.controller.getAiConnection().accessToken, 'test-token');
  assert.equal((await f.controller.connectAi()).accessToken, 'test-token');
  assert.equal(f.opened.length, 0);
});

test('an explicit cached System AI session is validated before it replaces the account connection', async t => {
  const f = await fixture(t, { connect: false });
  const requests = [];
  f.fetch = async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, 'Bearer explicit-ai-token');
    return Response.json({ errCode: 0, data: { profile: f.profile, principal: { apiKeyId: 'explicit-ai-key' } } });
  };
  const key = 'studio.system-ai.dev.' + encodeURIComponent('http://127.0.0.1:7126');
  f.saved.set(key, JSON.stringify({ serverUrl: 'http://127.0.0.1:7126', accessToken: 'explicit-ai-token' }));
  assert.equal((await f.controller.connectAi()).accessToken, 'explicit-ai-token');
  assert.equal(f.opened.length, 0);
  assert.ok(requests.every(url => url.endsWith('/api/auth/me')));
});

test('the avatar menu exposes only public profile data and refreshes both the menu and authentication avatar', async t => {
  const f = await fixture(t);
  let sectionLoads = 0;
  f.controller.registerSectionProvider({ id: 'optional', title: 'Optional', load: async () => { sectionLoads++; return []; } });
  const read = f.commands.get('studio.internalGetAccountMenuState');
  const initial = read();
  const local = await fixture(t, { platform: false, connect: false });
  assert.equal(local.commands.get('studio.internalGetAccountMenuState')().localProfile, true);
  assert.equal(local.requests, 0, 'reading local notification scope must not connect to the Server');
  assert.equal(initial.name, 'User');
  assert.match(initial.scopeKey, /^[a-f\d]{64}$/);
  const other = await fixture(t, {serverUrl: 'https://second.example.test'});
  assert.notEqual(other.commands.get('studio.internalGetAccountMenuState')().scopeKey, initial.scopeKey);
  assert.equal(initial.labels.profile, 'Personal Information');
  assert.doesNotMatch(JSON.stringify(initial), /test-token|test-key|private-token|private\.example|aiConfigured|serverUrl|aiServerUrl|127\.0\.0\.1/);
  for (const status of f.statuses) {
    assert.doesNotMatch(`${status.tooltip} ${status.accessibilityInformation.label}`, /127\.0\.0\.1|https?:/);
  }
  f.profile = { ...f.profile, displayName: 'Updated User', avatarUrl: 'data:image/webp;base64,bmV3' };
  await f.commands.get('studio.refreshAccount')();
  assert.equal(sectionLoads, 0, 'Refreshing the avatar menu must not load optional account sections');
  assert.equal(read().name, 'Updated User');
  assert.equal(read().scopeKey, initial.scopeKey);
  assert.equal((await f.provider.getSessions([], {}))[0].account.icon.toString(), f.profile.avatarUrl);
  assert.deepEqual(f.executed.filter(command => command.id === 'studio.internalUpdateAccountMenuState').at(-1).args[0], read());
  await f.commands.get('studio.logout')();
  assert.equal(read().hasAccount, false);
  assert.equal(read().scopeKey, undefined);
  assert.match(read().storeScopeKey, /^[a-f\d]{64}$/);
  await other.commands.get('studio.logout')();
  assert.notEqual(other.commands.get('studio.internalGetAccountMenuState')().storeScopeKey, read().storeScopeKey);
  assert.equal(local.commands.get('studio.internalGetAccountMenuState')().storeScopeKey, undefined);
  assert.equal(read().email, undefined);
  assert.equal(read().avatarUrl, undefined);
});
