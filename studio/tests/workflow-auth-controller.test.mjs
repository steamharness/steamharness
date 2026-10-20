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
  const f = { profile: { userId: 'user', email: 'user@example.test', displayName: 'User', avatarUrl: 'data:image/png;base64,b2xk' }, requests: 0, messages: [], opened: [], copied: [], commands: new Map(), executed: [] };
  let stored = JSON.stringify({ serverUrl, accessToken: 'test-token', apiKeyId: 'test-key', user: f.profile });
  const disposable = { dispose() {} };
  const vscode = {
    EventEmitter: Emitter, StatusBarAlignment: { Left: 1 },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
    Uri: { parse: value => ({ toString: () => value, toJSON: () => value }), joinPath: (_base, ...parts) => ({ toString: () => `file:///extension/${parts.join('/')}` }) },
    ThemeIcon: class { constructor(id) { this.id = id; } }, ViewColumn: { Active: 1 },
    env: { language: 'en', openExternal: async uri => { f.opened.push(uri.toString()); }, clipboard: { writeText: async text => { f.copied.push(text); } } },
    commands: {
      registerCommand: (id, callback) => { f.commands.set(id, callback); return disposable; },
      executeCommand: async (id, ...args) => { f.executed.push({ id, args }); },
    },
    authentication: { registerAuthenticationProvider: (_id, _label, provider) => {
      f.provider = provider; provider.onDidChangeSessions(event => sessions.push(event)); return disposable;
    } },
    workspace: { getConfiguration: () => ({ get: () => serverUrl }), onDidChangeConfiguration: configuration.event },
    window: { state: { focused: true }, onDidChangeWindowState: focus.event,
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createWebviewPanel: (_type, _title, _column, options) => {
        const disposed = new Emitter(), received = new Emitter(), changed = new Emitter();
        f.panel = { visible: true, options, reveal() {}, onDidDispose: disposed.event, onDidChangeViewState: changed.event,
          dispose: () => disposed.fire(),
          webview: { cspSource: 'test-source', asWebviewUri: value => value, postMessage: async message => { f.messages.push(message); },
            onDidReceiveMessage: callback => { f.message = callback; return received.event(callback); } } };
        return f.panel;
      } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id), URL, AbortSignal, AbortController, crypto: globalThis.crypto,
    fetch: async () => { f.requests++; return Response.json({ errCode: 0, data: { profile: f.profile, principal: { apiKeyId: 'test-key' } } }); },
    setInterval: (callback, ms) => { const timer = { callback, ms, unref() {} }; intervals.add(timer); return timer; },
    clearInterval: timer => intervals.delete(timer),
  });
  const context = { subscriptions: [], secrets: { get: async () => stored, store: async value => { stored = value; }, delete: async () => { stored = undefined; }, onDidChange: secretsChanged.event } };
  const controller = new module.exports.AccountController(context);
  t.after(() => controller.dispose());
  await controller.initialize();
  return Object.assign(f, { controller, intervals, sessions,
    focus: focused => { vscode.window.state.focused = focused; focus.fire({ focused }); },
    poll: () => { for (const timer of intervals) { timer.callback(); } },
  });
}

async function until(read) {
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (read()) { return; }
  }
  assert.fail('Account profile did not refresh');
}

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
