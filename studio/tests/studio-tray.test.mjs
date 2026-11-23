import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext, Script } from 'node:vm';
import { build, transform } from 'esbuild';
import { JSDOM } from 'jsdom';

const source = new URL('../upstream/vscode/src/vs/platform/windows/', import.meta.url);
const { text: code } = (await build({ entryPoints: [fileURLToPath(new URL('electron-main/studioTray.ts', source))], write: false, bundle: true,
  format: 'cjs', platform: 'node', external: ['electron'], plugins: [{ name: 'mock-host', setup(builder) {
    builder.onResolve({ filter: /\/(platform|network|nls|lifecycle)\.js$/ }, ({ path }) => ({ path, external: true }));
  } }],
})).outputFiles[0];
const snapshot = (count, ...items) => ({ count, items });

function fixture(platform, language, markAll = async () => true) {
  const icons = [], titles = [], tooltips = [];
  const panels = [], actions = [];
  const workArea = { x: -1440, y: 25, width: 1440, height: 875 };
  const original = {
    getSize: () => ({ width: 16, height: 16 }),
    toBitmap: () => Buffer.alloc(32 * 32 * 4),
    setTemplateImage() {},
  };
  let icon;
  class Tray extends EventEmitter {
    destroyed = false;
    constructor() { super(); icon = this; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setImage(image) { icons.push(image); }
    setTitle(title) { titles.push(title); }
    setToolTip(tip) { tooltips.push(tip); }
    setContextMenu(menu) { this.menu = menu; }
    popUpContextMenu(menu) { this.menu = menu; }
  }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {},
        setWindowOpenHandler: () => {},
        send: (_channel, data) => { this.state = data; },
        ipc: { handle: (_channel, handler) => { this.mark = handler; } },
      });
      panels.push(this);
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    setBounds(bounds) { this.bounds = bounds; }
    isVisible() { return !!this.visible && !this.destroyed; }
    isDestroyed() { return !!this.destroyed; }
    show() { this.visible = true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const modules = {
    electron: { Tray, BrowserWindow, screen: { getCursorScreenPoint: () => ({ x: -20, y: 900 }), getDisplayNearestPoint: () => ({ workArea }) },
      nativeImage: { createFromBuffer: () => original, createFromBitmap: (pixels, options) => ({ pixels, options }) }, Menu: { buildFromTemplate: items => items } },
    'platform.js': { isLinux: platform === 'linux', isMacintosh: platform === 'mac' },
    'nls.js': { getNLSLanguage: () => language },
    'network.js': { FileAccess: { asFileUri: file => ({ fsPath: path.join(path.parse(process.cwd()).root, 'Studio Dev', file) }) } },
    'lifecycle.js': { toDisposable: dispose => ({ dispose }) },
    url: { pathToFileURL },
  };
  const module = { exports: {} };
  runInNewContext(code, { module, Buffer, require: filename => modules[path.basename(filename)] });
  const tray = module.exports.createStudioTray(() => actions.push('launchpad'), () => actions.push('quit'), markAll, error => { throw error; });
  return { tray, icon, panels, actions, icons, titles, tooltips, original };
}

test('the macOS menu bar shows a localized tooltip and clears its title at zero unread', () => {
  const { tray, icons, titles, tooltips } = fixture('mac', 'zh-cn');
  for (const unread of [12, 102, 103, 0]) tray.setNotifications(snapshot(unread));
  assert.deepEqual(titles, [' 12', ' 99+', '']);
  assert.equal(icons.length, 0);
  assert.deepEqual(tooltips.slice(2), ['SteamHarness Studio · 102 条未读消息', 'SteamHarness Studio · 103 条未读消息', 'SteamHarness Studio']);
});

for (const platform of ['win', 'linux']) {
  test(`${platform} tray paints an unread count at physical icon resolution and restores its original image`, () => {
    const { tray, icons, titles, original } = fixture(platform, 'en');
    for (const unread of [12, 102, 103, 0]) tray.setNotifications(snapshot(unread));
    assert.equal(icons.length, 3);
    assert.equal(titles.length, 0);
    assert.equal(icons[2], original);
    assert.equal(JSON.stringify(icons[1].options), JSON.stringify({ width: 32, height: 32, scaleFactor: 2 }));
    assert.deepEqual([...icons[1].pixels.subarray(0, 32 * 18 * 4)], new Array(32 * 18 * 4).fill(0), 'the brand mark above the badge is untouched');
    assert.ok(icons[1].pixels.includes(0xff), 'the badge occupies actual bitmap pixels');
    assert.notDeepEqual(icons[0].pixels, icons[1].pixels, '12 and 99+ have different visible labels');
  });
}

test('left click opens the Launchpad at zero, otherwise opens an anchored preview without opening the Launchpad', async () => {
  const { tray, icon, panels, actions } = fixture('mac', 'zh-cn');
  const bounds = { x: -19, y: 0, width: 18, height: 25 };
  icon.emit('click', {}, bounds);
  assert.deepEqual(actions, ['launchpad']);
  assert.equal(panels.length, 0);
  const message = { title: 'Bot', detail: '实际消息预览' };
  tray.setNotifications(snapshot(3, message));
  icon.emit('click', {}, bounds);
  await setImmediate();
  const [panel] = panels;
  assert.deepEqual(JSON.parse(JSON.stringify(panel.bounds)), { x: -366, y: 31, width: 360, height: 122 });
  assert.equal(panel.options.webPreferences.sandbox, true);
  assert.equal(panel.options.webPreferences.nodeIntegration, false);
  assert.match(panel.webContents.mainFrame.url, /\/Studio%20Dev\//);
  assert.deepEqual(panel.state.items, [message]);
  assert.equal(panel.state.labels.readAll, '全部已读');
  assert.deepEqual(actions, ['launchpad']);
  tray.setNotifications(snapshot(3, { title: 'Another sender' }));
  assert.equal(panel.state.items[0].title, 'Another sender', 'same count does not mean the preview is unchanged');
  tray.setNotifications(snapshot(3, { title: 'New account' }), true);
  assert.equal(panel.isDestroyed(), true);
});

test('mark all waits for acknowledgement and keeps failed notifications retryable', async () => {
  let succeed = false, attempts = 0;
  const { tray, icon, panels, actions } = fixture('win', 'en', async () => {
    attempts++;
    if (succeed) tray.setNotifications(snapshot(0));
    return succeed;
  });
  tray.setNotifications(snapshot(1, { title: 'Unread message' }));
  icon.emit('click', {}); // Missing tray bounds use the cursor.
  await setImmediate();
  const [panel] = panels;
  assert.ok(panel.bounds.y + panel.bounds.height < 900, 'bottom tray opens above the taskbar');
  assert.equal(await panel.mark({ senderFrame: { url: panel.webContents.mainFrame.url } }), false);
  assert.equal(attempts, 0, 'a foreign frame cannot mark notifications read');
  const event = { senderFrame: panel.webContents.mainFrame };
  assert.equal(await panel.mark(event), false);
  assert.equal(panel.state.count, 1);
  assert.equal(panel.isVisible(), true);
  succeed = true;
  assert.equal(await panel.mark(event), true);
  assert.equal(panel.isDestroyed(), true);
  icon.emit('click', {});
  assert.deepEqual(actions, ['launchpad']);
  assert.equal(attempts, 2);
});

test('right click keeps the original menu and dismisses the preview', async () => {
  const { tray, icon, panels, actions } = fixture('mac', 'en');
  tray.setNotifications(snapshot(1));
  icon.emit('click', {});
  await setImmediate();
  icon.emit('right-click');
  assert.equal(panels[0].isDestroyed(), true);
  assert.deepEqual(Array.from(icon.menu, ({ label, type }) => label ?? type), ['Show Launchpad', 'separator', 'Quit SteamHarness Studio']);
  icon.menu[0].click(); icon.menu[2].click();
  assert.deepEqual(actions, ['launchpad', 'quit']);
  assert.equal(fixture('linux', 'en').icon.menu.length, 3);
});

test('the sandboxed preview renders literal text and provides a localized retry state', async () => {
  const directory = new URL('electron-browser/', source);
  const html = await readFile(new URL('studioTrayPreview.html', directory), 'utf8');
  const { code: preload } = await transform(await readFile(new URL('preload-studioTrayPreview.ts', directory), 'utf8'), { loader: 'ts', format: 'esm' });
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  try {
    const result = Promise.withResolvers();
    const events = new EventEmitter(), { document } = dom.window;
    let requests = 0;
    dom.window.require = () => ({ ipcRenderer: { on: (name, listener) => events.on(name, listener), invoke: () => { requests++; return result.promise; } } });
    new Script(preload).runInContext(dom.getInternalVMContext());
    if (document.readyState === 'loading') await new Promise(resolve => dom.window.addEventListener('DOMContentLoaded', resolve, { once: true }));
    else dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const message = '<img src=x onerror=alert(1)>';
    events.emit('vscode:studioTray:preview', {}, { ...snapshot(1, { title: 'Bot', detail: message }), language: 'en',
      labels: { title: 'Unread notifications', readAll: 'Mark all as read', reading: 'Marking…', failed: 'Try again', noPreview: 'No preview available.' } });
    assert.equal(document.querySelector('li p').textContent, message);
    assert.equal(document.querySelectorAll('img').length, 0);
    const button = document.querySelector('button');
    button.click(); button.click();
    assert.equal(requests, 1);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Marking…');
    result.resolve(false); await setImmediate();
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Mark all as read');
    assert.equal(document.querySelector('[role=alert]').textContent, 'Try again');
  } finally { dom.window.close(); }
});
