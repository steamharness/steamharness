import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';

// Exercise the kernel handlers without starting Electron or touching the user's windows.
const kernel = new URL('../upstream/vscode/', import.meta.url);
const require = createRequire(new URL('package.json', kernel));
const { outputFiles } = await build({ stdin: { contents: `
  export { WindowsMainService } from './src/vs/platform/windows/electron-main/windowsMainService.ts';
  export { LaunchMainService } from './src/vs/platform/launch/electron-main/launchMainService.ts';
  export { LifecycleMainService } from './src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts';
  export { createStudioTray } from './src/vs/platform/windows/electron-main/studioTray.ts';`, resolveDir: fileURLToPath(kernel) },
  tsconfig: fileURLToPath(new URL('src/tsconfig.json', kernel)), bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }, electron = {};
new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, id => id === 'electron' ? electron : require(id));
const { WindowsMainService, LaunchMainService, LifecycleMainService, createStudioTray } = module.exports;

function mockWindow(isStudioLaunchpad) {
  const win = new EventEmitter();
  const calls = [];
  return { id: isStudioLaunchpad ? 1 : 2, isStudioLaunchpad, calls,
    win: Object.assign(win, { isDestroyed: () => false, isMinimized: () => false, show: () => calls.push('show'), hide: () => calls.push('hide') }),
    focus: () => calls.push('focus'), sendWhenReady: (_channel, _token, action) => calls.push(action.id),
    onWillLoad: () => ({ dispose() {} }), close: () => calls.push('close') };
}

test('background creation is silent and concurrent tray requests share the console', async () => {
  const window = mockWindow(true), created = Promise.withResolvers(), live = [];
  let creations = 0;
  const windows = Object.assign(Object.create(WindowsMainService.prototype), {
    lifecycleMainService: {}, getWindows: () => live,
    openInBrowserWindow: async options => {
      creations++; assert.ok(options.forceNewWindow && options.studioLaunchpad.background);
      await created.promise; live.push(window); return window;
    },
  });
  const pending = windows.openStudioLaunchpad(true);
  const reveal = windows.openStudioLaunchpad();
  assert.deepEqual(window.calls, []);
  created.resolve();
  assert.equal(await pending, window); assert.equal(await reveal, window);
  assert.equal(creations, 1); assert.deepEqual(window.calls, ['show', 'focus']);
  window.calls.length = 0;
  await windows.openStudioLaunchpad(true); assert.deepEqual(window.calls, []);
  await windows.openStudioLaunchpad(); assert.deepEqual(window.calls, ['show', 'focus', 'studio.internalShowLaunchpad']);
  assert.deepEqual(windows.resolveContextWindow.call({ getWindowById: () => window }, { contextWindowId: 1 }, false), { windowToUse: undefined, forceNewWindow: true });
});

test('second launch without paths reveals the console and an explicit path takes normal project routing', async () => {
  const calls = [];
  const launch = Object.assign(Object.create(LaunchMainService.prototype), { windowsMainService: {
    hasStudioLaunchpad: true, openStudioLaunchpad: () => { calls.push('console'); return mockWindow(true); },
    open: options => { calls.push([...options.cli._]); return [mockWindow(false)]; },
  } });
  await launch.startOpenWindow({ _: [] }, {});
  await launch.startOpenWindow({ _: ['/example/project'] }, {});
  assert.deepEqual(calls, ['console', ['/example/project']]);
});

test('close hides only the console while explicit quit unloads both windows', async () => {
  const lifecycle = Object.assign(Object.create(LifecycleMainService.prototype), {
    trace() {}, windowCounter: 0, windowToCloseRequest: new Set(), _onBeforeCloseWindow: { fire() {} }, unload: async () => false,
  });
  const consoleWindow = mockWindow(true), project = mockWindow(false);
  for (const window of [consoleWindow, project]) lifecycle.registerWindow(window);
  const close = window => window.win.emit('close', { preventDefault() {} });
  close(consoleWindow); close(project); await setImmediate();
  assert.deepEqual(consoleWindow.calls, ['hide']); assert.deepEqual(project.calls, ['close']);
  lifecycle._quitRequested = true; close(consoleWindow); await setImmediate();
  assert.deepEqual(consoleWindow.calls, ['hide', 'close']);
});

test('tray click and menu actions reveal the launchpad and quit explicitly', () => {
  const calls = []; let statusIcon, items;
  Object.assign(electron, { Menu: { buildFromTemplate: template => (items = template) },
    nativeImage: { createFromBuffer: () => ({ setTemplateImage() {} }) },
    Tray: class extends EventEmitter {
      constructor() { super(); statusIcon = this; }
      setToolTip() {} setContextMenu() {} popUpContextMenu() {} destroy() { calls.push('destroy'); }
    } });
  const tray = createStudioTray(() => calls.push('show'), () => calls.push('quit'));
  statusIcon.emit('click'); items[0].click(); items.at(-1).click(); tray.dispose();
  assert.deepEqual(calls, ['show', 'show', 'quit', 'destroy']);
});
