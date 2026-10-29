import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss } from './settings-ui-fixture.mjs';

// Always headless; never use a system window, focus or clipboard.
const extension = new URL('../extensions/studio-workstation/', import.meta.url);
const output = new URL('../.studio/memory-settings-ui/', import.meta.url);
await mkdir(output, { recursive: true });
const [js, css, chinese, icons, iconFont] = await Promise.all([
  readFile(new URL('dist/account-ui.js', extension), 'utf8'),
  readFile(new URL('dist/account-ui.css', extension), 'utf8'),
  readFile(new URL('l10n/bundle.l10n.zh-cn.json', extension), 'utf8'),
  readFile(new URL('dist/codicons/codicon.css', extension), 'utf8'),
  readFile(new URL('dist/codicons/codicon.ttf', extension)),
]);
const iconCss = icons.replace(/url\([^)]+\)/g, `url(data:font/ttf;base64,${iconFont.toString('base64')})`);
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const page = await browser.newPage();
await page.emulateMedia({ reducedMotion: 'reduce' });
const errors = [], checks = [];
page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
await page.route('**/*', route => route.abort());
await page.route('https://memory-ui.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }));
const send = (type, value) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { type, ...value });
try {
  for (const language of ['en', 'zh-cn']) for (const theme of ['light', 'dark']) for (const width of [1440, 960, 640, 360]) {
    await page.goto('https://memory-ui.test/');
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${settingsThemeCss(theme)}\n${iconCss}\n${css}</style></head><body><main id="account-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle: language === 'en' ? {} : JSON.parse(chinese) }).replace(/</g, '\\u003c')}</script></body></html>`);
    await page.evaluate(() => {
      window.messages = [];
      window.memoryFixture = { caps: { connected: true, enabled: true, status: 'ready', automatic: true, readOnly: false }, prefs: { enabled: true, automatic: true }, items: [], status: 0 };
      window.acquireVsCodeApi = () => ({ setState() {}, postMessage(message) {
        window.messages.push(message);
        if (message.type !== 'settings-memory') return;
        const f = window.memoryFixture;
        let data;
        if (message.action === 'capabilities') data = { ...f.caps, enabled: f.prefs.enabled };
        if (message.action === 'preferences') data = f.prefs;
        if (message.action === 'setPreferences') data = (f.prefs = message.input);
        if (message.action === 'scopes' || message.action === 'jobs') data = [];
        if (message.action === 'list') data = { items: f.items };
        if (message.action === 'get') data = f.items.find(item => item.id === message.input.id);
        queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'settings-memory-result', requestId: message.requestId, data, ...(f.status ? { status: f.status, error: 'Fixture error' } : {}) } })));
      } });
    });
    await page.addScriptTag({ content: js });
    await send('settings', { state: settingsFixture(language) });
    await send('account', { state: { status: 'authenticated', revision: 1, serverUrl: 'https://server.example.test', user: { userId: 'user-id', displayName: 'SteamHarness Admin', email: 'admin@example.test' } } });
    await send('settings-navigate', { state: { section: 'memory' } });
    const panel = page.locator('.account-memory');
    const refresh = () => panel.getByRole('button', { name: language === 'en' ? 'Refresh' : '刷新', exact: true }).click();
    const settled = () => page.waitForFunction(() => document.querySelector('.account-memory')?.getAttribute('aria-busy') === 'false');
    await settled();
    const preferenceRows = await panel.locator('.am-preference').all();
    const firstRow = await preferenceRows[0].boundingBox();
    const secondRow = await preferenceRows[1].boundingBox();
    assert.equal(secondRow.y, firstRow.y + firstRow.height, 'Host label margins cannot separate continuous preference rows');
    for (const toggle of await panel.getByRole('switch').all()) {
      const bounds = await toggle.boundingBox();
      assert.equal(bounds.width, 34, 'Host input styles cannot enlarge memory switches');
      assert.equal(bounds.height, 20);
      assert.equal(await toggle.isChecked(), true);
      assert.ok(await toggle.getAttribute('aria-label'));
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language}/${theme}/${width} must fit`);
    const shell = await panel.boundingBox();
    const enabled = panel.getByRole('switch').first();
    await enabled.focus(); await enabled.press('Space'); await settled();
    assert.equal(await panel.getByRole('switch').nth(1).isDisabled(), true);
    await enabled.press('Space'); await settled();
    await page.locator('h1').click();
    if (width === 1440 || width === 360) await page.screenshot({ path: new URL(`${language}-${theme}-${width}.png`, output).pathname, fullPage: true });
    await page.evaluate(() => { window.memoryFixture.items = [{ id: 'one', scope: 'global', content: '长期偏好：跨项目使用简洁中文回答。\n完整内容 '.repeat(50), origin: 'manual', version: 2, updatedAt: '2026-10-29T00:00:00Z', sources: [{ id: 'source', role: 'user', content: '<script>source stays inert</script>' }] }]; });
    await refresh(); await panel.locator('.am-row').click(); await panel.locator('.am-content').waitFor();
    assert.equal((await panel.locator('.am-content').textContent()).length > 500, true);
    if (shell.width <= 620) assert.equal(await panel.locator('.am-list').isVisible(), false);
    assert.equal((await panel.boundingBox()).height, shell.height, 'Details cannot resize the panel');
    await panel.getByRole('button', { name: language === 'en' ? 'Back to list' : '返回列表' }).click();
    await page.evaluate(() => { window.memoryFixture.caps.connected = false; window.memoryFixture.caps.status = 'unconfigured'; });
    await refresh(); await panel.locator('.am-unavailable').waitFor();
    assert.doesNotMatch(await panel.locator('.am-status').textContent(), /sign in|登录/i);
    assert.equal(await panel.locator('.am-layout').isVisible(), false);
    assert.equal((await panel.boundingBox()).height, shell.height);
    await page.evaluate(() => { window.memoryFixture.status = 401; }); await refresh();
    await panel.getByRole('button', { name: language === 'en' ? 'Verify account authorization' : '验证账号授权' }).click();
    assert.equal(await page.evaluate(() => window.messages.at(-1).type), 'open-login');
    await page.evaluate(() => { window.memoryFixture.status = 503; }); await refresh(); await settled();
    assert.equal(await panel.locator('.am-status button').count(), 0);
    assert.equal(await panel.getByRole('switch').first().isDisabled(), true);
    checks.push({ language, theme, width, result: 'passed' });
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL('results.json', output), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Memory settings: ${checks.length} headless language/theme/width scenarios passed.`);
} finally { await browser.close(); }
