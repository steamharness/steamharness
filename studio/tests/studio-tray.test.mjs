import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const source = new URL('../upstream/vscode/src/vs/platform/windows/electron-main/studioTray.ts', import.meta.url);
const { code } = await transform(await readFile(source, 'utf8'), { loader: 'ts', format: 'cjs' });

function fixture(platform, language) {
  const icons = [], titles = [], tooltips = [];
  const original = {
    getSize: () => ({ width: 16, height: 16 }),
    toBitmap: () => Buffer.alloc(32 * 32 * 4),
    setTemplateImage() {},
  };
  class Tray {
    destroyed = false;
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setImage(image) { icons.push(image); }
    setTitle(title) { titles.push(title); }
    setToolTip(tip) { tooltips.push(tip); }
    setContextMenu() {}
    on() {}
  }
  const modules = {
    electron: { Tray, nativeImage: { createFromBuffer: () => original, createFromBitmap: (pixels, options) => ({ pixels, options }) }, Menu: { buildFromTemplate: items => items } },
    'platform.js': { isLinux: platform === 'linux', isMacintosh: platform === 'mac' },
    'nls.js': { getNLSLanguage: () => language },
    'lifecycle.js': { toDisposable: dispose => ({ dispose }) },
  };
  const module = { exports: {} };
  runInNewContext(code, { module, Buffer, require: filename => modules[path.basename(filename)] });
  const tray = module.exports.createStudioTray(() => {}, () => {});
  return { tray, icons, titles, tooltips, original };
}

test('the macOS menu bar shows a localized tooltip and clears its title at zero unread', () => {
  const { tray, icons, titles, tooltips } = fixture('mac', 'zh-cn');
  for (const unread of [12, 102, 103, 0]) tray.setUnreadCount(unread);
  assert.deepEqual(titles, [' 12', ' 99+', '']);
  assert.equal(icons.length, 0);
  assert.deepEqual(tooltips.slice(2), ['SteamHarness Studio · 102 条未读消息', 'SteamHarness Studio · 103 条未读消息', 'SteamHarness Studio']);
});

for (const platform of ['win', 'linux']) {
  test(`${platform} tray paints an unread count at physical icon resolution and restores its original image`, () => {
    const { tray, icons, titles, original } = fixture(platform, 'en');
    for (const unread of [12, 102, 103, 0]) tray.setUnreadCount(unread);
    assert.equal(icons.length, 3);
    assert.equal(titles.length, 0);
    assert.equal(icons[2], original);
    assert.equal(JSON.stringify(icons[1].options), JSON.stringify({ width: 32, height: 32, scaleFactor: 2 }));
    assert.deepEqual([...icons[1].pixels.subarray(0, 32 * 18 * 4)], new Array(32 * 18 * 4).fill(0), 'the brand mark above the badge is untouched');
    assert.ok(icons[1].pixels.includes(0xff), 'the badge occupies actual bitmap pixels');
    assert.notDeepEqual(icons[0].pixels, icons[1].pixels, '12 and 99+ have different visible labels');
  });
}
