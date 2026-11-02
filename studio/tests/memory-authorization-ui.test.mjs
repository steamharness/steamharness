import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/webview/login.ts'], bundle: true,
  format: 'iife', write: false, loader: { '.css': 'empty' } });
const message = 'Memory authorization is unavailable. Verify your account to restore memory; signing out is not required.';

for (const language of ['en', 'zh-cn']) test(`memory verification shows a usable form for an already signed-in account in ${language}`, async t => {
  const dom = new JSDOM('<main id="login-app"></main>', { runScripts: 'outside-only', url: 'https://studio.test' });
  t.after(() => dom.window.close());
  const { window } = dom, doc = window.document, calls = [];
  const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
  const localization = doc.createElement('script'); localization.id = 'studio-localization';
  localization.textContent = JSON.stringify({ bundle, locale: language }); doc.head.append(localization);
  window.acquireVsCodeApi = () => ({ postMessage: value => calls.push(value), setState() {} });
  window.eval(compiled.outputFiles[0].text);
  const state = { status: 'authenticated', serverUrl: 'https://server.test', revision: 1,
    user: { userId: 'user', email: 'user@example.test', displayName: 'User' } };
  const render = reauthorize => window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'account', state, reauthorize } }));
  render(false);
  assert.equal(doc.querySelector('#login-form').hidden, true);
  render(true);
  assert.equal(doc.querySelector('#login-form').hidden, false);
  assert.equal(doc.querySelector('#login-success').hidden, true);
  assert.equal(doc.querySelector('#login-status').textContent, bundle[message]);
  assert.equal(doc.querySelector('#login-email').value, 'user@example.test');
  assert.ok(!calls.some(call => call.type === 'logout'));
  const password = doc.querySelector('#login-password'); password.value = 'verification-only';
  doc.querySelector('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { type: 'login', serverUrl: 'https://server.test', email: 'user@example.test', password: 'verification-only' });
  assert.equal(password.value, '');
});
