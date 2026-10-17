import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/webview/versions.ts'], bundle: true,
  platform: 'browser', format: 'iife', outfile: 'versions-ui.js', write: false });
const code = compiled.outputFiles.find(file => file.path.endsWith('.js')).text;
for (const language of ['en', 'zh-cn']) {
  test(`version rows render external references and escaped metadata in ${language}`, async () => {
    const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
    const events = new Map();
    const app = { innerHTML: '', setAttribute() {}, querySelector() {}, querySelectorAll: () => [] };
    runInNewContext(code, { acquireVsCodeApi: () => ({ postMessage() {} }),
      document: { documentElement: { lang: language }, activeElement: null, querySelector: () => app,
        getElementById: () => ({ textContent: JSON.stringify({ bundle, locale: language }) }) },
      window: { scrollY: 0, scrollTo() {} }, scrollY: 0, addEventListener: (name, listener) => events.set(name, listener) });
    const state = { type: 'versions-state', generation: 1, signedIn: true, loading: false, busy: false,
      project: { id: 'project', name: '<Project>', uri: 'file:///project' }, localVersion: '1.0.0',
      canDownload: true, transfersAvailable: true,
      versions: [{ version: '1.0.0', latest: true, releaseLog: '<script>notes</script>',
        dependencies: [{ alias: 'external', projectId: 'other', delivery: 'external' },
          { alias: 'included', projectId: 'included', delivery: 'included', version: '2.0.0' }] }] };
    assert.doesNotThrow(() => events.get('message')({ data: state }));
    assert.ok(app.innerHTML.includes(bundle.External));
    assert.ok(app.innerHTML.includes('2.0.0'));
    assert.ok(app.innerHTML.includes('&lt;Project&gt;'));
    assert.ok(app.innerHTML.includes('&lt;script&gt;notes&lt;/script&gt;'));
    assert.ok(!app.innerHTML.includes('<script>'));
  });
}
