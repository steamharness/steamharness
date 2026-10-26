import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-auth.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}

async function fixture(t) {
  const focus = new Emitter(), secretsChanged = new Emitter(), configuration = new Emitter(), intervals = new Set(), sessions = [];
  const serverUrl = 'http://127.0.0.1:7126';
  const f = { profile: { userId: 'user', email: 'user@example.test', displayName: 'User', avatarUrl: 'data:image/png;base64,b2xk' }, languagePreference: 'system', requests: 0, messages: [], opened: [], copied: [], commands: new Map(), executed: [] };
  const defaults = { 'editor.fontSize': 14, 'studio.project.serverUrl': serverUrl };
  const user = {}, workspace = {}, writes = [];
  let stored = JSON.stringify({ serverUrl, accessToken: 'test-token', apiKeyId: 'test-key', user: f.profile });
  const disposable = { dispose() {} };
  const vscode = {
    EventEmitter: Emitter, StatusBarAlignment: { Left: 1 },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
    Uri: { parse: value => ({ toString: () => value, toJSON: () => value }), joinPath: (_base, ...parts) => ({ toString: () => `file:///extension/${parts.join('/')}` }) },
    ThemeIcon: class { constructor(id) { this.id = id; } }, ViewColumn: { Active: 1 },
    env: { language: 'en', openExternal: async uri => { f.opened.push(uri.toString()); }, clipboard: { writeText: async text => { f.copied.push(text); } } },
    version: '1.141.0', extensions: { all: [], onDidChange: configuration.event },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand: (id, callback) => { f.commands.set(id, callback); return disposable; },
      executeCommand: async (id, ...args) => {
        f.executed.push({ id, args });
        if (id === 'studio.internalGetDisplayLanguage') { return f.languagePreference; }
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
    window: { state: { focused: true }, onDidChangeWindowState: focus.event,
      registerWebviewPanelSerializer: (type, serializer) => { f.serializer = serializer; f.viewType = type; return disposable; },
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createWebviewPanel: (_type, _title, _column, options) => {
        const disposed = new Emitter(), received = new Emitter(), changed = new Emitter();
        const messages = [];
        f.panel = { visible: true, options, reveal() {}, onDidDispose: disposed.event, onDidChangeViewState: changed.event,
          dispose: () => disposed.fire(),
          webview: { cspSource: 'test-source', messages, asWebviewUri: value => value, postMessage: async message => { messages.push(message); f.messages.push(message); },
            onDidReceiveMessage: callback => { f.message = callback; return received.event(callback); } } };
        return f.panel;
      } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id), URL, Error, AbortSignal, AbortController, crypto: globalThis.crypto, setTimeout, clearTimeout,
    fetch: async () => { f.requests++; return Response.json({ errCode: 0, data: { profile: f.profile, principal: { apiKeyId: 'test-key' } } }); },
    setInterval: (callback, ms) => { const timer = { callback, ms, unref() {} }; intervals.add(timer); return timer; },
    clearInterval: timer => intervals.delete(timer),
  });
  const context = { extension: { packageJSON: { version: '0.1.0' } }, subscriptions: [], secrets: { get: async () => stored, store: async value => { stored = value; }, delete: async () => { stored = undefined; }, onDidChange: secretsChanged.event } };
  const controller = new module.exports.AccountController(context);
  t.after(() => controller.dispose());
  await controller.initialize();
  return Object.assign(f, { controller, intervals, sessions, vscode, user, workspace, writes,
    focus: focused => { vscode.window.state.focused = focused; focus.fire({ focused }); },
    poll: () => { for (const timer of intervals) { timer.callback(); } },
  });
}

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

test('returning to Studio refreshes the profile and updates the native authentication avatar', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.getSessions([], {}))[0].account.icon.toString(), f.profile.avatarUrl);
  const connection = JSON.stringify(f.controller.getConnection());
  f.focus(false);
  f.profile = { ...f.profile, avatarUrl: 'data:image/webp;base64,bmV3' };
  f.focus(true);
  await until(() => f.controller.getState().user.avatarUrl === f.profile.avatarUrl);
  assert.equal((await f.provider.getSessions([], {}))[0].account.icon.toString(), f.profile.avatarUrl);
  assert.equal(f.sessions.at(-1).changed[0].account.icon.toString(), f.profile.avatarUrl);
  assert.equal(JSON.stringify(f.controller.getConnection()), connection);
});

test('Studio polls profiles while focused and disposes the timer and focus subscription', async t => {
  const f = await fixture(t);
  assert.equal([...f.intervals][0].ms, 30_000);
  f.focus(false); f.poll();
  assert.equal(f.requests, 1);
  f.focus(true);
  await until(() => f.requests === 2);
  const sessions = f.sessions.length;
  f.profile = { ...f.profile, avatarUrl: undefined };
  f.poll();
  await until(() => !f.controller.getState().user.avatarUrl);
  assert.equal((await f.provider.getSessions([], {}))[0].account.icon, undefined);
  assert.equal(f.sessions.length, sessions + 1);
  const requests = f.requests;
  f.controller.dispose();
  assert.equal(f.intervals.size, 0);
  f.focus(true); f.poll();
  assert.equal(f.requests, requests);
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
  assert.deepEqual(f.opened, ['http://127.0.0.1:7126/settings/profile', 'http://127.0.0.1:7126/settings/api-keys']);
  assert.deepEqual(f.copied, ['user']);
  f.controller.dispose();
  await f.message({ type: 'copy', field: 'email' });
  await f.message({ type: 'open-profile' });
  assert.equal(f.copied.length, 1);
  assert.equal(f.opened.length, 2);
});

test('sign out immediately clears contributed content even when a section refresh is pending', async t => {
  const f = await fixture(t);
  let release, signal;
  f.controller.registerSectionProvider({ id: 'example', title: 'Example', load: (_connection, abort) => {
    signal = abort;
    return new Promise(resolve => { release = resolve; });
  } });
  f.controller.open(); await f.message({ type: 'ready' });
  await until(() => release);
  const refreshing = f.message({ type: 'refresh-sections' });
  await f.message({ type: 'logout' });
  assert.equal(f.controller.getState().status, 'signed-out');
  assert.equal(signal.aborted, true);
  release([{ id: 'old', title: 'Old account data' }]);
  await refreshing;
  assert.equal(f.messages.filter(message => message.type === 'account-sections').at(-1).states.length, 0);
  assert.ok(!JSON.stringify(f.messages).includes('test-token'));
});

test('the avatar menu exposes only public profile data and refreshes both the menu and authentication avatar', async t => {
  const f = await fixture(t);
  f.controller.setAiConnection({ serverUrl: 'https://private.example.test', accessToken: 'private-token' });
  let sectionLoads = 0;
  f.controller.registerSectionProvider({ id: 'optional', title: 'Optional', load: async () => { sectionLoads++; return []; } });
  const read = f.commands.get('studio.internalGetAccountMenuState');
  const initial = read();
  assert.equal(initial.name, 'User');
  assert.equal(initial.labels.profile, 'Personal Information');
  assert.doesNotMatch(JSON.stringify(initial), /test-token|test-key|private-token|private\.example|aiConfigured|aiServerUrl/);
  f.profile = { ...f.profile, displayName: 'Updated User', avatarUrl: 'data:image/webp;base64,bmV3' };
  await f.commands.get('studio.refreshAccount')();
  assert.equal(sectionLoads, 0, 'Refreshing the avatar menu must not load optional account sections');
  assert.equal(read().name, 'Updated User');
  assert.equal((await f.provider.getSessions([], {}))[0].account.icon.toString(), f.profile.avatarUrl);
  assert.deepEqual(f.executed.filter(command => command.id === 'studio.internalUpdateAccountMenuState').at(-1).args[0], read());
  await f.commands.get('studio.logout')();
  assert.equal(read().hasAccount, false);
  assert.equal(read().email, undefined);
  assert.equal(read().avatarUrl, undefined);
});
