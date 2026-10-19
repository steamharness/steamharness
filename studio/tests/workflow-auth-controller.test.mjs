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
  const f = { profile: { userId: 'user', email: 'user@example.test', displayName: 'User', avatarUrl: 'data:image/png;base64,b2xk' }, requests: 0 };
  let stored = JSON.stringify({ serverUrl, accessToken: 'test-token', apiKeyId: 'test-key', user: f.profile });
  const disposable = { dispose() {} };
  const vscode = {
    EventEmitter: Emitter, StatusBarAlignment: { Left: 1 },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
    Uri: { parse: value => ({ toString: () => value, toJSON: () => value }) },
    commands: { registerCommand: () => disposable, executeCommand: async () => {} },
    authentication: { registerAuthenticationProvider: (_id, _label, provider) => {
      f.provider = provider; provider.onDidChangeSessions(event => sessions.push(event)); return disposable;
    } },
    workspace: { getConfiguration: () => ({ get: () => serverUrl }), onDidChangeConfiguration: configuration.event },
    window: { state: { focused: true }, onDidChangeWindowState: focus.event,
      createStatusBarItem: () => ({ show() {}, dispose() {} }) },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id), URL, AbortSignal,
    fetch: async () => { f.requests++; return Response.json({ errCode: 0, data: { profile: f.profile, principal: { apiKeyId: 'test-key' } } }); },
    setInterval: (callback, ms) => { const timer = { callback, ms, unref() {} }; intervals.add(timer); return timer; },
    clearInterval: timer => intervals.delete(timer),
  });
  const context = { secrets: { get: async () => stored, store: async value => { stored = value; }, delete: async () => { stored = undefined; }, onDidChange: secretsChanged.event } };
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
