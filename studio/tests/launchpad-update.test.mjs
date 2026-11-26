import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const directory = fileURLToPath(new URL('../upstream/vscode/src/vs/workbench/browser/', import.meta.url));
const { outputFiles } = await build({
  entryPoints: [`${directory}studioLaunchpadUpdate.ts`], bundle: true, platform: 'browser', format: 'iife', globalName: 'studio', write: false,
});

const idle = { type: 'idle' };
const update = { version: 'build', productVersion: '0.1.1' };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, zh, withUpdates = true, version = '0.1.0') {
  const { window } = new JSDOM('', { runScripts: 'outside-only' });
  const { StudioLaunchpadUpdate } = window.eval(`${outputFiles[0].text}\nstudio;`);
  const calls = [];
  let listener, failed = false;
  const updater = {
    state: idle,
    onStateChange(fn) { listener = fn; return { dispose() { listener = undefined; } }; },
    async checkForUpdates(explicit) { calls.push(['check', explicit]); if (failed) throw new Error('private detail'); },
    async downloadUpdate(explicit) { calls.push(['download', explicit]); },
    async applyUpdate() { calls.push(['apply']); },
    async quitAndInstall() { calls.push(['restart']); },
  };
  const view = new StudioLaunchpadUpdate((en, cn) => zh ? cn : en, { version: version ?? undefined,
    openAbout: () => calls.push(['about']), updater: withUpdates ? updater : undefined });
  window.document.body.append(view.element);
  t.after(() => { view.dispose(); window.close(); });
  return { view, calls, select: selector => view.element.querySelector(selector), fail: () => { failed = true; },
    setState: state => { updater.state = state; listener?.(state); } };
}

for (const [lang, zh] of [['en', false], ['zh-cn', true]]) {
  test(`Studio Launchpad follows native update actions and retry in ${lang}`, async t => {
    const f = fixture(t, zh), tLabel = (en, cn) => zh ? cn : en;
    const action = f.select('.lp-update-action'), status = f.select('[role=status]'), progress = f.select('progress');
    const version = f.select('.lp-release-version');
    assert.equal(version.textContent, 'v0.1.0');
    assert.equal(version.getAttribute('aria-label'), tLabel('About SteamHarness Studio (v0.1.0)', '关于 SteamHarness Studio (v0.1.0)'));
    assert.equal(action.textContent, tLabel('Check for updates', '检查更新'));
    action.click(); action.click(); await flush();
    assert.deepEqual(f.calls, [['check', true]]);

    f.setState({ type: 'checking for updates' });
    assert.ok(action.hidden);
    assert.equal(status.textContent, tLabel('Checking for updates…', '正在检查更新…'));
    f.setState({ type: 'downloading', update, totalBytes: 100, downloadedBytes: 42 });
    assert.equal(status.textContent, tLabel('Downloading update…', '正在下载更新…'));
    assert.equal(progress.value, 42);
    f.setState({ type: 'downloaded', update });
    assert.equal(action.textContent, tLabel('Install update', '安装更新'));
    action.click(); await flush();
    f.setState({ type: 'ready', update });
    assert.equal(action.textContent, tLabel('Restart to install', '重启并安装'));
    assert.equal(status.textContent, 'v0.1.1');
    action.click(); await flush();

    f.setState({ type: 'available for download', update });
    action.click(); await flush();
    assert.deepEqual(f.calls.slice(1), [['apply'], ['restart'], ['download', true]]);
    f.setState({ ...idle, notAvailable: true });
    assert.equal(status.textContent, tLabel('Up to date', '已是最新版本'));
    f.fail(); action.click(); await flush();
    assert.ok(!action.disabled);
    assert.equal(status.textContent, tLabel('Update failed. Try again.', '更新失败，请重试'));
  });
}

test('a deployment without a native updater still shows the Studio version', t => {
  const f = fixture(t, false, false);
  assert.equal(f.select('.lp-release-version').textContent, 'v0.1.0');
  assert.ok(f.select('.lp-update-action').hidden);
});

test('the version button opens About instead of checking for an update', t => {
  const f = fixture(t, false);
  f.select('.lp-release-version').click();
  assert.deepEqual(f.calls, [['about']]);
});

test('missing product metadata shows a link to About, not a kernel version', t => {
  const f = fixture(t, false, false, null);
  const button = f.select('.lp-release-version');
  assert.equal(button.textContent, 'About');
  button.click();
  assert.deepEqual(f.calls, [['about']]);
});
