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
  const registry = new Map(), center = [], native = [], cleared = [], focused = [], actions = [], launchpad = [];
  const filters = new Set();
  const mainWindow = {};
  let owner = true, focusedWindow = false, muted = false, sourceMuted = false, actionValid = true, ownership;
  const nativeResult = Promise.withResolvers();
  const services = {
    host: { hadLastFocus: async () => ownership ? ownership.promise : owner, get hasFocus() { return focusedWindow; },
      focus: async (window, options) => focused.push({ window, options }) },
    native: { openStudioLaunchpadInbox: async () => { launchpad.push('inbox'); return true; }, showToast: options => { native.push(options); return nativeResult.promise; },
      clearToast: async id => { cleared.push(id); } },
    notifications: { getFilter: source => (source ? sourceMuted : muted) ? 1 : 0,
      onDidChangeFilter(listener) { filters.add(listener); return { dispose() { filters.delete(listener); } }; },
      notify(options) {
        center.push(options);
        let onClose;
        return { onDidClose(listener) { onClose = listener; return { dispose() {} }; }, close() { options.closed = true; onClose(); } };
      } },
    commands: { async executeCommand(name, id) { actions.push([name, id]); return actionValid; } },
  };
  const modules = {
    'actions.js': { toAction: x => x }, 'window.js': { mainWindow },
    'commands.js': { CommandsRegistry: { registerCommand: (id, handler) => registry.set(id, handler) }, ICommandService: 'commands' },
    'native.js': { FocusMode: { Force: 2 }, INativeHostService: 'native' },
    'notification.js': { INotificationService: 'notifications', NotificationPriority: { SILENT: 2, DEFAULT: 0 }, NotificationsFilter: { OFF: 0 }, Severity: { Info: 1 } },
    'notificationMessage.js': { NotificationText: { concat: message => ({ literal: message }) } },
    'host.js': { IHostService: 'host' },
  };
  runInNewContext(script, { require: file => modules[file.split('/').at(-1)] });
  const accessor = { get: id => services[id] };
  const notice = { id: 'notice-1', source: { id: 'example.source', label: 'Example' }, title: 'Example', message: '2 unread items', actionLabel: 'Open' };
  return {
    center, native, cleared, focused, actions, nativeResult, notice, launchpad,
    post: () => registry.get('studio.internalPostDesktopNotification')(accessor, notice),
    dismiss: () => registry.get('studio.internalDismissDesktopNotification')(accessor, notice.id),
    setFocused: () => { focusedWindow = true; },
    switchWindow: () => { owner = false; },
    invalidate: () => { actionValid = false; },
    targetInbox: () => { actionValid = 'launchpadInbox'; },
    deferOwner: () => ownership = Promise.withResolvers(),
    disturb: (value, bySource = false) => { if (bySource) sourceMuted = value; else muted = value; for (const listener of filters) listener(); },
  };
}

test('background desktop notifications do not focus the window until an accepted user click', async () => {
  const f = fixture();
  assert.equal(await f.post(), true);
  assert.equal(f.center[0].priority, 2);
  assert.equal(f.native[0].dedupeKey, f.notice.source.id);
  assert.equal(f.native[0].body, f.notice.message);
  assert.equal(f.focused.length, 0);
  f.nativeResult.resolve({ clicked: true }); await setImmediate();
  assert.deepEqual(f.actions, [['studio.internalDesktopNotificationAction', f.notice.id]]);
  assert.equal(f.focused.length, 1);
  assert.equal(f.center[0].closed, true);
});

test('focused windows and Do Not Disturb only use the notification center', async () => {
  for (const configure of [f => f.setFocused(), f => f.disturb(true), f => f.disturb(true, true)]) {
    const f = fixture(); configure(f);
    assert.equal(await f.post(), true);
    assert.equal(f.center.length, 1);
    assert.equal(f.native.length, 0);
  }
  const f = fixture(); await f.post(); f.disturb(true);
  assert.deepEqual(f.cleared, [f.notice.id]);
  f.nativeResult.resolve({ clicked: true }); await setImmediate();
  assert.equal(f.actions.length, 0);
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
