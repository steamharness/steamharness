import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/webview/versions.ts'], bundle: true,
  platform: 'browser', format: 'iife', outfile: 'versions-ui.js', write: false });
const code = compiled.outputFiles.find(file => file.path.endsWith('.js')).text;
for (const language of ['en', 'zh-cn']) {
  test(`version rows render aggregate versions and escaped metadata in ${language}`, async () => {
    const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
    const events = new Map();
    const app = { innerHTML: '', setAttribute() {}, querySelector() {}, querySelectorAll: () => [] };
    runInNewContext(code, { acquireVsCodeApi: () => ({ postMessage() {}, setState() {} }),
      document: { documentElement: { lang: language }, activeElement: null, querySelector: () => app,
        getElementById: () => ({ textContent: JSON.stringify({ bundle, locale: language }) }) },
      window: { scrollY: 0, scrollTo() {} }, scrollY: 0, addEventListener: (name, listener) => events.set(name, listener) });
    const state = { type: 'versions-state', generation: 1, signedIn: true, loading: false, busy: false,
      project: { id: 'project', name: '<Project>', uri: 'file:///project' }, localVersion: '1.0.0',
      canDownload: true, transfersAvailable: true,
      versions: [{ version: '1.0.0', latest: true, releaseLog: '<script>notes</script>',
        entries: [{entryId:'main',type:'workflow',name:'Main'}],defaultEntry:'main' }] };
    assert.doesNotThrow(() => events.get('message')({ data: state }));
    assert.ok(app.innerHTML.includes('1.0.0'));
    assert.ok(app.innerHTML.includes('&lt;Project&gt;'));
    assert.ok(app.innerHTML.includes('&lt;script&gt;notes&lt;/script&gt;'));
    assert.ok(!app.innerHTML.includes('<script>'));
  });
}


test('source versions hide sign-in, server comparisons and upgrade controls', async () => {
  const events = new Map(), app = { innerHTML: '', setAttribute() {}, querySelectorAll: () => [] };
  runInNewContext(code, { acquireVsCodeApi: () => ({ postMessage() {}, setState() {} }),
    document: { documentElement: { lang: 'en' }, activeElement: null, querySelector: () => app, getElementById: () => ({ textContent: '{}' }) },
    window: { scrollY: 0, scrollTo() {} }, addEventListener: (name, listener) => events.set(name, listener) });
  events.get('message')({ data: { type: 'versions-state', generation: 1, signedIn: false, loading: false, busy: false,
    project: { id: 'source', name: 'Source', uri: 'file:///source' }, localVersion: '1.2.3', update: { status: 'source', localVersion: '1.2.3', canDownload: false }, versions: [] } });
  assert.match(app.innerHTML, /1.2.3/);
  assert.doesNotMatch(app.innerHTML, /sign-in|upgrade|Server Version|No published versions/);
});
