import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss } from './settings-ui-fixture.mjs';

const base = new URL('../extensions/studio-workstation/', import.meta.url);
const [js, css, chinese] = await Promise.all([
  readFile(new URL('dist/account-ui.js', base), 'utf8'), readFile(new URL('dist/account-ui.css', base), 'utf8'), readFile(new URL('l10n/bundle.l10n.zh-cn.json', base), 'utf8'),
]);
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const errors = [], checks = [];
try {
  for (const language of ['en', 'zh-cn']) for (const theme of ['light', 'dark']) for (const width of [1280, 640, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }));
    await page.goto('https://studio-settings.example.test');
    await page.setContent(`<!doctype html><html lang="${language}"><head><style>${settingsThemeCss(theme)}\n${css}</style></head><body><main id="account-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle: language === 'en' ? {} : JSON.parse(chinese) }).replaceAll('<', '\\u003c')}</script></body></html>`);
    await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), setState: state => { window.savedState = state; } }); });
    await page.addScriptTag({ content: js });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const last = () => page.evaluate(() => window.messages.filter(message => message.type === 'settings-models').at(-1));
    const zh = language === 'zh-cn';
    await send({ type: 'settings', state: settingsFixture(language) });
    await send({ type: 'settings-models', state: { revision: 0, entries: [], systemAvailable: false } });
    await send({ type: 'settings-navigate', state: { section: 'models' } });
    assert.equal(await page.locator('#settings-title').textContent(), zh ? '模型' : 'Models');
    const pane = page.locator('#settings-models');
    await pane.getByRole('button', { name: zh ? '添加模型' : 'Add model', exact: true }).click();
    assert.equal(await page.locator('#user-model-source').isVisible(), false, 'OSS does not offer a system AI source');
    await page.locator('#user-model-name').fill('My model');
    await page.locator('#user-model-baseUrl').fill('https://model.example.test/v1');
    await page.locator('#user-model-model').fill('actual-model');
    await page.locator('#user-model-apiKey').fill('ui-test-only-secret');
    await pane.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
    const saved = await last(); assert.equal(saved.model.source, 'third-party'); assert.equal(saved.model.apiKey, 'ui-test-only-secret');
    assert.equal(await page.locator('#user-model-apiKey').inputValue(), '');
    assert.ok(!JSON.stringify(await page.evaluate(() => window.savedState)).includes('ui-test-only-secret'));
    const { apiKey: _, ...entry } = saved.model;
    const state = { revision: 1, entries: [{ ...entry, hasApiKey: true }], systemAvailable: false };
    await send({ type: 'settings-models-result', requestId: saved.requestId, state });
    assert.equal(await pane.locator('[data-model-id]').count(), 1);
    assert.ok((await pane.innerText()).includes(zh ? '默认模型' : 'Default model'));
    await pane.getByRole('button', { name: zh ? '编辑' : 'Edit', exact: true }).click();
    assert.equal(await page.locator('#user-model-apiKey').inputValue(), '');
    await pane.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
    await send({ type: 'settings-models', state: { ...state, systemAvailable: true } });
    await pane.getByRole('button', { name: zh ? '添加模型' : 'Add model', exact: true }).click();
    const request = await last(); assert.equal(request.action, 'catalog');
    await send({ type: 'settings-model-catalog', requestId: 'obsolete', catalog: { entries: [] } });
    await send({ type: 'settings-model-catalog', requestId: request.requestId, catalog: { entries: [{ id: 'plan-one', name: 'Plan', models: [{ id: 'system-model', name: 'System model' }] }] } });
    await page.locator('#user-model-name').fill('My subscription');
    await page.locator('#user-model-system').click();
    await page.locator('.settings-dropdown-menu:popover-open').getByRole('option', { name: 'System model · Plan', exact: true }).click();
    await pane.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
    const system = await last(); assert.equal(system.action, 'save'); assert.equal(system.model.source, 'system');
    assert.equal(system.model.credentialId, 'plan-one'); assert.equal(system.model.apiKey, undefined);
    await send({ type: 'settings-models-result', requestId: system.requestId, state: { ...state, revision: 2, systemAvailable: true, entries: [...state.entries, system.model] } });
    await pane.getByRole('button', { name: zh ? '设为默认' : 'Set as default', exact: true }).click();
    const preference = await last(); assert.equal(preference.action, 'default'); assert.equal(preference.id, system.model.id);
    await send({ type: 'settings-models-result', requestId: preference.requestId, state: { ...state, revision: 3, entries: [system.model, ...state.entries], systemAvailable: true } });
    await page.locator('#settings-search').fill('My subscription'); assert.equal(await pane.isVisible(), true);
    await page.locator('#settings-search').fill('');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    checks.push(`${language}/${theme}/${width}: add, edit, secure key, system source, default, search and layout`);
    await page.close();
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, errors }, null, 2));
} finally { await browser.close(); }
