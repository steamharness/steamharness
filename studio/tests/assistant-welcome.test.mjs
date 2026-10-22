import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const { JSDOM } = createRequire(new URL('../../shared/package.json', import.meta.url))('jsdom');
const compiled = await build({ entryPoints: ['extensions/studio-workstation/webview/welcome.ts'], bundle: true, platform: 'browser', format: 'iife', write: false });

for (const language of ['en', 'zh-cn']) {
  test(`Assistant retry responds before the host replies and prevents duplicate clicks in ${language}`, async t => {
    const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
    const dom = new JSDOM('<div role="status" aria-busy="false"><p id="assistant-status"></p><button id="assistant-action" data-action="assistant-retry"></button></div>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const { window } = dom, document = window.document, posted = [];
    const button = document.querySelector('button');
    button.textContent = bundle['Retry'];
    button.dataset.busyLabel = bundle['Retrying...'];
    button.dataset.busyStatus = bundle['Retrying Assistant...'];
    window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(message) });
    window.eval(compiled.outputFiles[0].text);
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, bundle['Retrying...']);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelector('[role="status"]').getAttribute('aria-busy'), 'true');
    assert.equal(document.getElementById('assistant-status').textContent, bundle['Retrying Assistant...']);
    assert.deepEqual(posted.map(message => message.type), ['assistant-retry']);
    button.click(); button.onclick();
    assert.equal(posted.length, 1);
  });
}
