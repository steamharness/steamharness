import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss, selectSettingsOption } from './settings-ui-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extensions/studio-workstation');
const output = path.join(root, '.studio/settings-ui');
await mkdir(output, { recursive: true });
const [js, css, icons, font, chinese] = await Promise.all([
  readFile(path.join(extension, 'dist/account-ui.js'), 'utf8'), readFile(path.join(extension, 'dist/account-ui.css'), 'utf8'),
  readFile(path.join(extension, 'dist/codicons/codicon.css'), 'utf8'), readFile(path.join(extension, 'dist/codicons/codicon.ttf')),
  readFile(path.join(extension, 'l10n/bundle.l10n.zh-cn.json'), 'utf8'),
]);
const iconCss = icons.replace(/url\([^)]+\)/g, `url(data:font/ttf;base64,${font.toString('base64')})`);
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const page = await browser.newPage();
const errors = [], checks = [], screenshots = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => route.abort());
const send = (type, data) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, ...data });
const setting = key => page.locator(`[data-setting-input="${key}"]`);
const category = id => page.locator(`#settings-navigation [data-section="${id}"]`);
const last = type => page.evaluate(type => window.messages.filter(message => message.type === type).at(-1), type);
const account = { status: 'authenticated', revision: 1, serverUrl: 'https://server.example.test', user: { userId: 'user-id', displayName: 'SteamHarness Admin', email: 'admin@steamharness.local' } };
async function fits() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Settings must fit the editor width');
  const overflow = await page.evaluate(() => [...document.querySelectorAll('button,input,select,h1,h2,.setting-label')].filter(node => node.getClientRects().length).filter(node => {
    const box = node.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 2;
  }).map(node => node.outerHTML.slice(0, 160)));
  assert.deepEqual(overflow, [], 'Controls and labels must fit');
}

try {
  for (const language of ['en', 'zh-cn']) {
    for (const theme of ['light', 'dark', 'contrast']) {
      for (const width of theme === 'contrast' ? [640] : [1440, 960, 640, 360, 280]) {
        await page.goto('about:blank'); await page.setViewportSize({ width, height: 1000 });
        const bundle = language === 'en' ? {} : JSON.parse(chinese);
        await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${settingsThemeCss(theme)}\n${iconCss}\n${css}</style></head><body><main id="account-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle }).replace(/</g, '\\u003c')}</script></body></html>`);
        await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), setState: state => { window.savedState = state; } }); });
        await page.addScriptTag({ content: js });
        let state = settingsFixture(language);
        await send('settings', { state });
        await send('account', { state: { status: 'signed-out', serverUrl: account.serverUrl, revision: 0 } });
        await send('settings-navigate', { state: { section: 'general' } });
        assert.equal(await category('general').getAttribute('aria-current'), 'page');
        assert.equal(await page.locator('#settings-navigation button').count(), 4, 'Public settings has no injected category');
        await fits();
        assert.equal(await page.locator('select').count(), 0, 'Settings must use page menus, including language and scope');
        await selectSettingsOption(page, setting('workbench.colorTheme'), 'Light');
        assert.equal((await last('settings-update')).value, 'Light');
        await send('settings-saved', { key: 'workbench.colorTheme', target: 'user' });
        const languageChoice = page.locator('#settings-language-choice');
        assert.equal(await page.locator('#settings-language-current').textContent(), language === 'en'
          ? 'Current display language: English. Changes take effect after restarting Studio.'
          : '当前显示语言：简体中文。切换语言需重启 Studio 后生效。');
        assert.equal(await page.locator('#settings-language-pending').isVisible(), false);
        await languageChoice.click();
        const menu = page.locator('.settings-dropdown-menu:popover-open');
        assert.deepEqual(await menu.locator('[role="option"]').evaluateAll(nodes => nodes.map(node => node.dataset.value)), ['system', 'zh-cn', 'en']);
        assert.deepEqual(await menu.locator('[role="option"] > span:last-child').allTextContents(), [language === 'en' ? 'Follow system' : '跟随系统', '简体中文', 'English']);
        const menuBounds = await menu.boundingBox();
        assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1);
        assert.ok(menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 1001);
        await languageChoice.press('Escape');
        await selectSettingsOption(page, languageChoice, 'zh-cn');
        assert.equal((await last('settings-language')).value, 'zh-cn');
        assert.equal(await languageChoice.isDisabled(), true);
        await send('settings', { state });
        assert.equal(await languageChoice.evaluate(node => node.value), 'zh-cn', 'A settings refresh cannot overwrite the pending language');
        await send('settings-language-result', { value: 'system' });
        assert.equal(await languageChoice.evaluate(node => node.value), 'system', 'Canceling restart restores the saved mode');
        await selectSettingsOption(page, languageChoice, 'en');
        await send('settings-language-result', { value: 'system', message: 'Fixture locale failure' });
        assert.equal(await page.locator('#settings-language-error').textContent(), 'Fixture locale failure');
        assert.equal(await languageChoice.isEnabled(), true);
        await selectSettingsOption(page, languageChoice, 'zh-cn');
        await send('settings-language-result', { value: 'zh-cn' });
        assert.equal(await page.locator('#settings-language-error').isVisible(), false);
        assert.equal(await page.locator('#settings-language-pending').isVisible(), language === 'en');
        await fits();
        if (language === 'en' && width === 1440) {
          const name = `settings-${language}-${theme}-pending-language.png`;
          await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
        }
        await page.locator('[data-language-reset]').click();
        assert.equal((await last('settings-language')).value, 'system');
        await send('settings-language-result', { value: 'system' });
        await setting('studio.recentProjects.limit').fill('22');
        assert.equal((await last('settings-update')).key, 'workbench.colorTheme', 'Text/number controls save on confirmation');
        await setting('studio.recentProjects.limit').press('Enter');
        assert.equal((await last('settings-update')).value, 22);
        await send('settings-saved', { key: 'studio.recentProjects.limit', target: 'user' });
        await setting('studio.terminal.name').fill('Draft terminal');
        await send('settings', { state });
        assert.equal(await setting('studio.terminal.name').inputValue(), 'Draft terminal');
        assert.equal(await setting('studio.terminal.name').evaluate(node => document.activeElement === node), true);
        await category('editor').click();
        await send('settings-saved', { key: 'studio.terminal.name', target: 'user' });
        await setting('editor.fontSize').fill('18'); await setting('editor.fontSize').press('Enter');
        assert.equal((await last('settings-update')).target, 'user');
        await send('settings-error', { key: 'editor.fontSize', target: 'user', message: 'Fixture write failure' });
        assert.equal(await setting('editor.fontSize').getAttribute('aria-invalid'), 'true');
        assert.equal(await setting('editor.fontSize').inputValue(), '18');
        await setting('editor.fontSize').fill('20'); await setting('editor.fontSize').press('Enter');
        await send('settings-saved', { key: 'editor.fontSize', target: 'user' });
        assert.equal(await setting('editor.fontSize').getAttribute('aria-invalid'), 'false');
        await page.locator('[data-reset="editor.fontSize"]').click();
        assert.equal((await last('settings-update')).reset, true);
        await send('settings-saved', { key: 'editor.fontSize', target: 'user' });
        await selectSettingsOption(page, setting('editor.wordWrap'), 'bounded');
        await selectSettingsOption(page, page.locator('#settings-target'), 'workspace');
        assert.equal((await last('settings-target')).target, 'workspace');
        state = { ...state, target: 'workspace' }; await send('settings', { state });
        await selectSettingsOption(page, setting('editor.wordWrap'), 'on');
        assert.equal((await last('settings-update')).target, 'workspace');
        await send('settings-saved', { key: 'editor.wordWrap', target: 'user' });
        assert.equal(await setting('editor.wordWrap').isDisabled(), true, 'A user save cannot acknowledge a pending workspace save');
        await send('settings-saved', { key: 'editor.wordWrap', target: 'workspace' });
        assert.equal(await setting('editor.wordWrap').isDisabled(), false);
        await fits();
        await page.locator('#settings-search').fill('editor.fontSize');
        assert.equal(await setting('editor.fontSize').isVisible(), true); assert.equal(await setting('editor.tabSize').isVisible(), false);
        await page.locator('#settings-search').fill('no-such-setting');
        assert.equal(await page.locator('#settings-no-results').isVisible(), true);
        await page.locator('#settings-search').press('Escape');
        await send('account', { state: account }); await category('account').click();
        for (const [id, value] of [['settings-account-name', account.user.displayName], ['settings-account-label', account.user.email]]) {
          const node = page.locator(`#${id}`);
          assert.equal(await node.getAttribute('title'), value);
          if (await node.isVisible()) {
            if (width === 1440) { assert.equal(await node.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'The standard account name and email fit the desktop sidebar'); }
            assert.equal(await node.evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1), true, 'Sidebar identity stays on one line');
            assert.equal(await node.evaluate(node => {
              const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(node);
              selection.removeAllRanges(); selection.addRange(range); const value = selection.toString(); selection.removeAllRanges(); return value;
            }), value, 'Truncated identity remains fully selectable without the system clipboard');
          }
        }
        assert.equal(await page.locator('#profile').isVisible(), true);
        await page.locator('[data-copy="userId"]').click(); assert.equal((await last('copy')).field, 'userId');
        await fits();
        await category('about').click();
        assert.equal(await page.locator('#settings-studio-version').textContent(), '0.1.0');
        await page.locator('[data-settings-action="documentation"]').click(); assert.equal((await last('settings-action')).action, 'documentation');
        await fits();
        const provider = { id: 'plugin', title: language === 'en' ? 'Plugin Information' : '扩展信息', icon: 'sparkle' };
        state = { ...state, providers: [provider] }; await send('settings', { state });
        await send('account-sections', { states: [{ ...provider, loading: false, failed: false, sections: [{ id: 'details', title: 'Details', metrics: [{ label: 'Requests', value: '42' }] }] }] });
        await category('provider:plugin').click(); assert.equal(await page.locator('.metric-value').textContent(), '42');
        await send('account', { state: { status: 'expired', serverUrl: account.serverUrl, user: account.user, revision: 2 } });
        assert.equal(await page.locator('[data-provider]').count(), 0); assert.equal(await page.locator('#settings-sign-in').isVisible(), true);
        await page.locator('#settings-provider-sign-in').click(); assert.equal(await page.locator('#login-form').isVisible(), true);
        await category('general').click(); await fits();
        assert.equal(await page.evaluate(() => Object.keys(window.savedState).sort().join(',')), 'query,scroll,section,target');
        if ((width === 1440 && theme !== 'contrast') || (width === 360 && theme === 'light')) {
          const name = `settings-${language}-${theme}-${width}.png`;
          await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
          if (width === 1440) {
            await languageChoice.click();
            const menuName = `settings-${language}-${theme}-language.png`;
            await page.screenshot({ path: path.join(output, menuName), fullPage: true }); screenshots.push(menuName);
            await languageChoice.press('Escape');
          }
        }
        checks.push(`${language}/${theme}/${width}: navigation, scopes, saves, reset, search, account, providers, expiry, layout`);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Settings UI: ${checks.length} scenarios passed. Screenshots: ${output}`);
} finally {
  await writeFile(path.join(output, 'proof.json'), JSON.stringify({ checks, screenshots, errors }, null, 2));
  await browser.close();
}
