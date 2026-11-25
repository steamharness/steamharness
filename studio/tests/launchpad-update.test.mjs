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
const update = { version: 'build', productVersion: '1.141.2' };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, zh, withUpdates = true) {
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
  const view = new StudioLaunchpadUpdate((en, cn) => zh ? cn : en, { version: '1.141.1', updater: withUpdates ? updater : undefined });
  window.document.body.append(view.element);
  t.after(() => { view.dispose(); window.close(); });
  return { view, calls, select: selector => view.element.querySelector(selector), fail: () => { failed = true; },
    setState: state => { updater.state = state; listener?.(state); } };
}

for (const [lang, zh] of [['en', false], ['zh-cn', true]]) {
  test(`Studio Launchpad follows native update actions and retry in ${lang}`, async t => {
    const f = fixture(t, zh), tLabel = (en, cn) => zh ? cn : en;
    const action = f.select('.lp-update-action'), status = f.select('[role=status]'), progress = f.select('progress');
    assert.equal(f.select('.lp-release-version').textContent, 'v1.141.1');
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
    assert.equal(status.textContent, 'v1.141.2');
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
  assert.equal(f.select('.lp-release-version').textContent, 'v1.141.1');
  assert.ok(f.select('.lp-update-action').hidden);
});
