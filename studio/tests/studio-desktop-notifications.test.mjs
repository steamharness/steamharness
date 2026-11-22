import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import test from 'node:test';

const source = fileURLToPath(new URL('../upstream/vscode/src/vs/workbench/electron-browser/studioDesktopNotifications.ts', import.meta.url));
const script = (await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'mock-services', setup(builder) {
    builder.onResolve({ filter: /^\.\.\// }, args => ({ path: args.path, external: true }));
  } }],
})).outputFiles[0].text;

function fixture() {
  const registry = new Map(), center = [], native = [], cleared = [], focused = [], actions = [], launchpad = [], badges = [];
  const listeners = new Set(), config = new Map();
  const mainWindow = {};
  let owner = true, focusedWindow = false, actionValid = true, ownership;
  const nativeResult = Promise.withResolvers();
  const services = {
    host: { get hasFocus() { return focusedWindow; },
      focus: async (window, options) => focused.push({ window, options }) },
    native: { isStudioNotificationWindow: async () => ownership ? ownership.promise : owner,
      openStudioLaunchpadInbox: async () => { launchpad.push('inbox'); return true; }, showToast: options => { native.push(options); return nativeResult.promise; },
      clearToast: async id => { cleared.push(id); }, setStudioUnreadCount: async count => { badges.push(count); },
      getStudioDesktopNotificationStatus: async () => ({ platform: 'macos', appName: 'SteamHarness Dev', permission: 'unknown' }),
      openStudioNotificationSettings: async () => true },
    configuration: { getValue: key => config.get(key),
      onDidChangeConfiguration(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; } },
    notifications: {
      notify(options) {
        center.push(options);
        let onClose;
        const handle = { onDidClose(listener) { onClose = listener; return { dispose() { onClose = undefined; } }; }, close() { options.closed = true; onClose?.(); } };
        options.close = handle.close;
        return handle;
      } },
    commands: { async executeCommand(name, id) { actions.push([name, id]); return actionValid; } },
  };
  const modules = {
    'actions.js': { toAction: x => x }, 'window.js': { mainWindow },
    'commands.js': { CommandsRegistry: { registerCommand: (id, handler) => registry.set(id, handler) }, ICommandService: 'commands' },
    'native.js': { FocusMode: { Force: 2 }, INativeHostService: 'native' },
    'configuration.js': { IConfigurationService: 'configuration' },
    'notification.js': { INotificationService: 'notifications', Severity: { Info: 1 } },
    'lifecycle.js': { DisposableStore: class { items = []; add(item) { this.items.push(item); } dispose() { this.items.splice(0).forEach(item => item.dispose()); } } },
    'notificationMessage.js': { NotificationText: { concat: message => ({ literal: message }) } },
    'host.js': { IHostService: 'host' },
  };
  runInNewContext(script, { require: file => modules[file.split('/').at(-1)] });
  const accessor = { get: id => services[id] };
  const notice = { id: 'notice-1', source: { id: 'example.source', label: 'Example' }, title: 'Example', message: '2 unread items', actionLabel: 'Open' };
  return {
    center, native, cleared, focused, actions, nativeResult, notice, launchpad, badges, listeners,
    post: () => registry.get('studio.internalPostDesktopNotification')(accessor, notice),
    dismiss: () => registry.get('studio.internalDismissDesktopNotification')(accessor, notice.id),
    run: (id, ...args) => registry.get(id)(accessor, ...args),
    setFocused: () => { focusedWindow = true; },
    switchWindow: () => { owner = false; },
    invalidate: () => { actionValid = false; },
    targetInbox: () => { actionValid = 'launchpadInbox'; },
    deferOwner: () => ownership = Promise.withResolvers(),
    setChannel: (channel, enabled) => {
      const key = `studio.notifications.${channel}`;
      config.set(key, enabled);
      for (const listener of listeners) listener({ affectsConfiguration: setting => setting === key });
    },
  };
}

test('background desktop notifications do not focus the window until an accepted user click', async () => {
  const f = fixture();
  assert.equal(await f.post(), true);
  assert.equal(f.center[0].priority, undefined, 'use the regular VS Code toast even while in the background');
  assert.equal(f.native[0].dedupeKey, f.notice.source.id);
  assert.equal(f.native[0].body, f.notice.message);
  assert.equal(f.focused.length, 0);
  f.nativeResult.resolve({ clicked: true }); await setImmediate();
  assert.deepEqual(f.actions, [['studio.internalDesktopNotificationAction', f.notice.id]]);
  assert.equal(f.focused.length, 1);
  assert.equal(f.center[0].closed, true);
});

test('an IM alert attempts desktop delivery in the foreground, with independent channel switches', async () => {
  for (const [desktop, workbench] of [[true, true], [true, false], [false, true], [false, false]]) {
    const f = fixture(); f.setFocused();
    f.setChannel('desktop', desktop); f.setChannel('workbench', workbench);
    assert.equal(await f.post(), true);
    assert.deepEqual([f.native.length, f.center.length], [Number(desktop), Number(workbench)]);
  }
});

test('turning off desktop notification closes only the desktop alert and invalidates a late click', async () => {
  const f = fixture(); await f.post(); f.setChannel('desktop', false);
  assert.deepEqual(f.cleared, [f.notice.id]);
  f.nativeResult.resolve({ clicked: true }); await setImmediate();
  assert.equal(f.actions.length, 0);
  assert.equal(f.center[0].closed, undefined);
  f.setChannel('workbench', false);
  assert.equal(f.center[0].closed, true);
  assert.equal(f.listeners.size, 0);
});

test('closing a workbench notification does not cancel the native channel', async () => {
  const f = fixture(); await f.post();
  f.center[0].close();
  assert.deepEqual(f.cleared, []);
  f.nativeResult.resolve({ clicked: true }); await setImmediate();
  assert.equal(f.focused.length, 1);
  assert.equal(f.listeners.size, 0);
});

test('permission and badge commands forward to the native host without assuming authorization', async () => {
  const f = fixture();
  assert.equal((await f.run('studio.internalGetDesktopNotificationStatus')).permission, 'unknown');
  assert.equal(await f.run('studio.internalOpenNotificationSettings'), true);
  await f.run('studio.internalSetUnreadCount', 3);
  await f.run('studio.internalSetUnreadCount', 0);
  assert.deepEqual(f.badges, [3, 0]);
});

test('IM notification clicks open the resident launchpad without refocusing the posting project', async () => {
  for (const background of [true, false]) {
    const f = fixture(); f.targetInbox();
    if (!background) f.setFocused();
    await f.post();
    if (background) { f.nativeResult.resolve({ clicked: true }); await setImmediate(); }
    else await f.center[0].actions.primary[0].run();
    assert.deepEqual(f.launchpad, ['inbox']); assert.deepEqual(f.focused, []);
    assert.equal(f.center[0].closed, true);
  }
});

test('ownership races, dismissal during posting and invalidated actions are ignored', async () => {
  const owner = fixture(); owner.switchWindow();
  assert.equal(await owner.post(), false);
  assert.equal(owner.center.length, 0);
  const cancelled = fixture(), pending = cancelled.deferOwner(), posting = cancelled.post();
  cancelled.dismiss(); pending.resolve(true);
  assert.equal(await posting, false);
  assert.equal(cancelled.native.length, 0);
  const stale = fixture(); await stale.post(); stale.invalidate();
  stale.nativeResult.resolve({ clicked: true }); await setImmediate();
  assert.equal(stale.focused.length, 0);
});
