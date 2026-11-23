import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';

// Exercise the kernel handlers without starting Electron or touching the user's windows.
const kernel = new URL('../upstream/vscode/', import.meta.url);
const require = createRequire(new URL('package.json', kernel));
const { outputFiles } = await build({ stdin: { contents: `
  export { CodeWindow } from './src/vs/platform/windows/electron-main/windowImpl.ts';
  export { WindowMode } from './src/vs/platform/window/electron-main/window.ts';
  export { URI } from './src/vs/base/common/uri.ts';
  export { Event } from './src/vs/base/common/event.ts';
  export { WindowsMainService } from './src/vs/platform/windows/electron-main/windowsMainService.ts';
  export { LaunchMainService } from './src/vs/platform/launch/electron-main/launchMainService.ts';
  export { LifecycleMainService } from './src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts';
  export { AuxiliaryWindowsMainService } from './src/vs/platform/auxiliaryWindow/electron-main/auxiliaryWindowsMainService.ts';
  export { AuxiliaryWindow } from './src/vs/platform/auxiliaryWindow/electron-main/auxiliaryWindow.ts';
  export { createStudioTray } from './src/vs/platform/windows/electron-main/studioTray.ts';`, resolveDir: fileURLToPath(kernel) },
  tsconfig: fileURLToPath(new URL('src/tsconfig.json', kernel)), bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false,
  define: { 'globalThis._VSCODE_FILE_ROOT': JSON.stringify(new URL('out/', kernel).href) } });
const loadKernel = platform => {
  const module = { exports: {} }, electron = {};
  new Function('module', 'exports', 'require', 'process', outputFiles[0].text)(module, module.exports,
    id => id === 'electron' ? electron : require(id), Object.create(process, { platform: { value: platform } }));
  return { electron, ...module.exports };
};
const { electron, CodeWindow, WindowMode, URI, Event, WindowsMainService, LaunchMainService, LifecycleMainService, AuxiliaryWindowsMainService, createStudioTray } = loadKernel(process.platform);

function mockWindow(isStudioLaunchpad) {
  const win = new EventEmitter();
  const calls = [];
  return { id: isStudioLaunchpad ? 1 : 2, isStudioLaunchpad, calls,
    win: Object.assign(win, { isDestroyed: () => false, isMinimized: () => false, show: () => calls.push('show'), hide: () => calls.push('hide') }),
    showStudioLaunchpad: () => calls.push('show', 'focus'), sendWhenReady: (_channel, _token, action) => calls.push(action.id),
    onWillLoad: () => ({ dispose() {} }), close: () => calls.push('close') };
}

function createWindow(t, studioLaunchpad, mode = WindowMode.Normal) {
  const calls = [], prompts = [], lifecycle = { quitRequested: false };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  Object.assign(electron, {
    ipcMain: new EventEmitter(), screen: { getAllDisplays: () => [{ workArea: area, bounds: area }] },
    app: { focus() {}, setProxy() {} },
    TouchBar: class { static TouchBarSegmentedControl = class {}; },
    BrowserWindow: class extends EventEmitter {
      id = 1;
      webContents = Object.assign(new EventEmitter(), { focus() {}, session: { webRequest: { onBeforeSendHeaders() {} }, setProxy() {} } });
      constructor(options) { super(); this.options = options; this.visible = options.show; }
      isDestroyed() { return this.destroyed ?? false; }
      isVisible() { return this.visible; }
      isMinimized() { return false; }
      isMaximized() { return this.maximized ?? false; }
      isFullScreen() { return false; }
      isSimpleFullScreen() { return false; }
      isDocumentEdited() { return false; }
      getRepresentedFilename() { return ''; }
      setSheetOffset() {} setTouchBar() {} setMenuBarVisibility() {} setTitle() {}
      getNativeWindowHandle() { return Buffer.alloc(0); }
      show() { this.visible = true; calls.push('show'); }
      hide() { this.visible = false; }
      focus() { calls.push('focus'); }
      maximize() { this.maximized = true; calls.push('maximize'); }
      async loadURL(url) { calls.push(['load', url]); }
      destroy() { this.destroyed = true; this.emit('closed'); }
    },
  });
  const log = { trace() {}, error() {}, warn() {} };
  const configuration = { getValue: () => undefined, inspect: () => ({}), onDidChangeConfiguration: Event.None };
  const dialogs = { showMessageBox: (options, owner) => {
    const response = Promise.withResolvers(); prompts.push({ options, owner, respond: response.resolve }); return response.promise;
  } };
  const window = new CodeWindow({ state: { x: 100, y: 100, width: 1000, height: 640, mode }, studioLaunchpad },
    log, { deregisterLoggers() {} }, { args: {}, isBuilt: true }, {}, {}, {}, {}, {}, configuration,
    { getWindowSplash: () => undefined }, { onDidDeleteUntitledWorkspace: Event.None }, {}, { publicLog2() {} },
    dialogs, lifecycle, { nameLong: 'SteamHarness Studio' },
    { createIPCObjectUrl: () => ({ resource: URI.parse('vscode:config'), dispose() {}, update() {} }) },
    {}, { getItem: () => undefined }, { invokeFunction: () => ({ show: mode === WindowMode.Normal, tabbingIdentifier: 'Studio' }) });
  const win = window.win;
  t.after(() => { if (!win.isDestroyed()) win.destroy(); });
  window.load({ userEnv: {}, isStudioLaunchpad: !!studioLaunchpad });
  const paint = (sender = win.webContents) => electron.ipcMain.emit('vscode:studioLaunchpadPainted', { sender });
  return { window, win, paint, lifecycle, calls, prompts };
}

test('foreground launchpad starts hidden and waits for its own renderer before applying native window state', t => {
  const f = createWindow(t, { background: false }, WindowMode.Maximized);
  assert.equal(f.win.options.show, false);
  assert.equal(f.win.options.paintWhenInitiallyHidden, true);
  assert.equal(f.win.options.tabbingIdentifier, undefined);
  f.window.showStudioLaunchpad();
  assert.equal(f.win.webContents.backgroundThrottling, false);
  f.win.emit('ready-to-show'); // Could be an earlier paint of the empty document.
  f.paint(new EventEmitter());
  assert.deepEqual(f.calls.slice(1), []);
  f.paint();
  assert.deepEqual(f.calls.slice(1), ['maximize', 'show', 'focus']);
  assert.equal(f.win.webContents.backgroundThrottling, true);
});

test('background launchpad stays hidden after it paints and then reveals without navigation', t => {
  const f = createWindow(t, { background: true });
  f.paint();
  assert.equal(f.win.isVisible(), false);
  f.window.showStudioLaunchpad();
  f.win.hide();
  f.window.showStudioLaunchpad();
  assert.deepEqual(f.calls.slice(1), ['show', 'focus', 'show', 'focus']);
});

test('reload of a hidden launchpad can paint again before a queued reveal', t => {
  const f = createWindow(t, { background: false });
  f.paint();
  f.window.showStudioLaunchpad();
  f.win.hide();
  f.window.load(f.window.config, { isReload: true });
  f.window.showStudioLaunchpad();
  assert.equal(f.win.isVisible(), false);
  assert.equal(f.win.webContents.backgroundThrottling, false);
  f.paint();
  assert.equal(f.win.isVisible(), true);
  assert.equal(f.win.webContents.backgroundThrottling, true);
});

test('ordinary project windows keep native startup visibility', t => {
  const f = createWindow(t, undefined);
  assert.equal(f.win.options.show, true);
  assert.equal(f.win.isVisible(), true);
});

test('standalone chats use native ownership rather than global always-on-top', t => {
  const { win } = createWindow(t, { background: false });
  electron.app = new EventEmitter();
  electron.ipcMain.handle = () => {};
  const service = new AuxiliaryWindowsMainService({ invokeFunction: (_fn, _state, overrides) => ({
    alwaysOnTop: overrides.alwaysOnTop ?? false,
  }) }, { trace() {} });
  t.after(() => service.dispose());
  const features = 'popup=yes,left=100,top=100,width=780,height=680';
  const chat = { features: features + ',window-keep-above-parent=yes' };
  assert.deepEqual(service.createWindow(chat, win), { parent: win, alwaysOnTop: false });
  assert.deepEqual(service.createWindow(chat), { alwaysOnTop: false });
  assert.deepEqual(service.createWindow({ features }, win), { alwaysOnTop: false });
  win.destroy();
  assert.deepEqual(service.createWindow(chat, win), { alwaysOnTop: false });
});

test('only opted-in macOS windows owned by the launchpad overlay their native buttons', t => {
  const parent = { isDestroyed: () => false };
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { electron, AuxiliaryWindowsMainService } = loadKernel(platform);
    const workArea = { x: 0, y: 0, width: 1600, height: 1024 };
    Object.assign(electron, { app: new EventEmitter(), ipcMain: { handle() {} }, screen: { getAllDisplays: () => [{ bounds: workArea, workArea }] } });
    const service = new AuxiliaryWindowsMainService({ invokeFunction: (_fn, _state, overrides) => ({
      titleBarStyle: 'default', frame: !overrides.frameless,
    }) }, { trace() {} });
    t.after(() => service.dispose());
    const features = 'left=100,top=100,width=780,height=680,window-keep-above-parent=yes,window-native-titlebar=yes';
    const overlay = { features: `${features},window-titlebar-overlay=yes` };
    const options = service.createWindow(overlay, parent);
    assert.equal(options.parent, parent);
    assert.equal(options.titleBarStyle, platform === 'darwin' ? 'hidden' : 'default');
    assert.equal(options.titleBarOverlay, platform === 'darwin' ? true : undefined);
    assert.equal(options.trafficLightPosition?.x, platform === 'darwin' ? 12 : undefined);
    assert.equal(service.createWindow({ features }, parent).titleBarStyle, 'default');
    assert.equal(service.createWindow(overlay).titleBarStyle, 'default');
    assert.equal(service.createWindow({ features: overlay.features + ',window-frameless=yes' }, parent).titleBarStyle, 'default');
  }
});

test('Command+W closes only the owned native auxiliary window, independently of renderer focus', t => {
  for (const [platform, owned] of [['darwin', true], ['darwin', false], ['linux', true]]) {
    const { electron, AuxiliaryWindow } = loadKernel(platform);
    let closes = 0, prevented = 0;
    const window = Object.assign(new EventEmitter(), {
      setMenu() {}, setAutoHideMenuBar() {}, setSheetOffset() {}, close() { closes++; },
    });
    Object.assign(electron, { BrowserWindow: { fromWebContents: () => window }, screen: { getAllDisplays: () => [] } });
    const contents = Object.assign(new EventEmitter(), { id: 5, isDestroyed: () => false });
    const parent = { close: () => assert.fail('Closing an auxiliary window must not close the launchpad') };
    const auxiliary = new AuxiliaryWindow(contents, owned ? { parent } : undefined, false, { args: {} }, { trace() {} },
      { getValue: () => undefined }, {}, { registerAuxWindow() {} });
    t.after(() => auxiliary.dispose());
    const key = (change = {}) => contents.emit('before-input-event', { preventDefault: () => prevented++ }, { type: 'keyDown', key: 'w', meta: true, ...change });
    for (const change of [{ key: 'q' }, { key: 'c' }, { meta: false, control: true }, { control: true }, { shift: true }, { alt: true }, { isComposing: true }, { type: 'keyUp' }]) key(change);
    assert.deepEqual([closes, prevented], [0, 0]);
    key(); key({ isAutoRepeat: true });
    assert.deepEqual([closes, prevented], platform === 'darwin' && owned ? [1, 2] : [0, 0]);
    window.emit('closed');
    assert.equal(contents.listenerCount('before-input-event'), 0);
  }
});

test('a failed background load stays silent until requested, then retries the same launchpad', async t => {
  const f = createWindow(t, { background: true });
  f.win.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', '', false);
  f.win.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', '', true);
  assert.deepEqual(f.prompts, []);
  f.window.showStudioLaunchpad();
  f.window.showStudioLaunchpad();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].owner, undefined);
  f.prompts[0].respond({ response: 0 });
  await setImmediate();
  assert.deepEqual(f.calls, [f.calls[0], f.calls[0]], 'retry reloads the same URL without showing an empty window');
  f.paint();
  assert.deepEqual(f.calls.slice(2), ['show', 'focus']);
});

test('if the bootstrap never signals, a foreground request can be dismissed without exposing an empty window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = createWindow(t, { background: false });
  f.window.showStudioLaunchpad();
  t.mock.timers.tick(30000);
  assert.equal(f.prompts.length, 1);
  f.prompts[0].respond({ response: 1 });
  await setImmediate();
  f.paint();
  assert.equal(f.win.isVisible(), false);
  assert.equal(f.calls.length, 1);
});

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

test('an inbox request shows only the launchpad and dispatches when ready, even on cold creation', async () => {
  const project = mockWindow(false), resident = mockWindow(true), live = [project];
  const windows = Object.assign(Object.create(WindowsMainService.prototype), {
    lifecycleMainService: {}, getWindows: () => live,
    openInBrowserWindow: async () => { live.push(resident); return resident; },
  });
  for (let i = 0; i < 2; ++i) {
    await windows.openStudioLaunchpad(false, 'inbox');
    assert.deepEqual(resident.calls.splice(0), ['show', 'focus', 'studio.internalOpenLaunchpadInbox']);
    assert.deepEqual(project.calls, []);
  }
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

test('the branded tray icon preserves launchpad and quit actions', async () => {
  const calls = []; let statusIcon, items;
  const isMacintosh = process.platform === 'darwin';
  const asset = isMacintosh ? 'steamharness-tray-template-36.png' : 'steamharness-icon-32.png';
  const expected = await readFile(new URL(`../../docs/assets/brand/${asset}`, import.meta.url));
  let templateImage = false;
  const image = { setTemplateImage(value) { templateImage = value; } };
  Object.assign(electron, { Menu: { buildFromTemplate: template => (items = template) },
    nativeImage: { createFromBuffer: (bytes, options) => {
      assert.ok(bytes.equals(expected), `the tray uses the SteamHarness brand asset ${asset}`);
      assert.equal(options.scaleFactor, 2);
      if (isMacintosh) {
        const dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; // PNG IHDR width and height
        assert.deepEqual(dimensions, [36, 36], 'the macOS template keeps its 18-point canvas at 2x');
      }
      return image;
    } },
    Tray: class extends EventEmitter {
      constructor(icon) { super(); assert.equal(icon, image); statusIcon = this; }
      setToolTip() {} setContextMenu() {} popUpContextMenu() {} destroy() { calls.push('destroy'); }
    } });
  const tray = createStudioTray(() => calls.push('show'), () => calls.push('quit'));
  assert.equal(templateImage, isMacintosh);
  statusIcon.emit('click'); items[0].click(); items.at(-1).click(); tray.dispose();
  assert.deepEqual(calls, ['show', 'show', 'quit', 'destroy']);
});
