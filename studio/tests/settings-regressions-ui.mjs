import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss, selectSettingsOption } from './settings-ui-fixture.mjs';

const extension = new URL('../extensions/studio-workstation/', import.meta.url);
const [js, css, chinese] = await Promise.all([
  readFile(new URL('dist/account-ui.js', extension), 'utf8'),
  readFile(new URL('dist/account-ui.css', extension), 'utf8'),
  readFile(new URL('l10n/bundle.l10n.zh-cn.json', extension), 'utf8').then(JSON.parse),
]);
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => route.abort());
const send = (type, data) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, ...data });
const writes = () => page.evaluate(() => window.messages.filter(message => message.type === 'settings-update'));
const input = key => page.locator(`[data-setting-input="${key}"]`);
const category = id => page.locator(`#settings-navigation [data-section="${id}"]`);
const main = page.locator('#settings-main');
const font = input('editor.fontSize');
const account = { status: 'authenticated', revision: 1, serverUrl: 'https://server.example.test', user: { userId: 'user-id', email: 'user@example.test', displayName: 'User' } };
const provider = { id: 'plugin', title: 'Plugin' };
const providerState = { ...provider, loading: false, failed: false, sections: [] };
const loaded = { ...providerState, sections: Array.from({ length: 16 }, (_, i) => ({ id: `details-${i}`, title: `Details ${i}`, rows: [{ label: `Row ${i}`, value: `Value ${i}` }] })) };
const withFont = (state, value, configured = true) => ({ ...state, items: state.items.map(item => item.key === 'editor.fontSize' ? { ...item, value, configured } : item) });

async function setup(language, section = 'editor', providers = []) {
  await page.goto('about:blank');
  await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${settingsThemeCss(language === 'en' ? 'light' : 'dark')}${css}</style></head><body><main id="account-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle: language === 'en' ? {} : chinese }).replace(/</g, '\\u003c')}</script></body></html>`);
  await page.evaluate(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), setState: state => { window.savedState = state; } });
  });
  await page.addScriptTag({ content: js });
  const state = settingsFixture(language, providers);
  await send('settings', { state });
  await send('account', { state: account });
  await send('settings-navigate', { state: { section } });
  return state;
}

try {
  for (const language of ['en', 'zh-cn']) {
    let state = await setup(language);
    await category('editor').focus();
    await send('settings', { state });
    assert.equal(await category('editor').evaluate(node => node === document.activeElement), true, 'A refresh must keep keyboard navigation focus');
    await category('about').focus();
    await send('settings', { state: { ...state, providers: [provider] } });
    assert.equal(await category('about').evaluate(node => node === document.activeElement), true, 'Registering a category must preserve focus');
    await category('about').press('ArrowUp');
    assert.equal(await category('provider:plugin').getAttribute('aria-current'), 'page');
    checks.push(`${language}: navigation focus`);

    state = await setup(language);
    const workspace = withFont({ ...state, target: 'workspace' }, 24);
    await font.focus();
    await send('settings', { state: workspace });
    assert.equal(await font.inputValue(), '24');
    await font.press('Tab');
    assert.deepEqual(await writes(), [], 'Changing scope must not write the old scope value on blur');
    await page.locator('#settings-search').fill('no-such-setting');
    await page.locator('#settings-no-results button').click();
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'settings-action').at(-1).action), 'json-workspace');
    await send('settings', { state });
    await page.locator('#settings-no-results button').click();
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'settings-action').at(-1).action), 'json-user');
    checks.push(`${language}: scope changes without edits`);

    state = await setup(language);
    await font.fill('18'); await font.press('Enter');
    await send('settings-error', { key: 'editor.fontSize', target: 'user', message: 'Fixture write failure', state });
    await send('settings', { state: workspace });
    assert.equal(await font.inputValue(), '24');
    assert.equal(await font.getAttribute('aria-invalid'), 'false');
    await send('settings', { state });
    assert.equal(await font.inputValue(), '18', 'Failed edits belong to their original scope');
    assert.equal(await font.getAttribute('aria-invalid'), 'true');
    await font.fill('14'); await font.press('Enter');
    assert.equal(await font.getAttribute('aria-invalid'), 'false', 'Returning to the saved value clears the error');
    assert.equal((await writes()).length, 1);
    checks.push(`${language}: failed edits stay in their scope`);

    state = await setup(language);
    await selectSettingsOption(page, input('editor.wordWrap'), 'bounded');
    await send('settings', { state: workspace });
    assert.equal(await input('editor.wordWrap').evaluate(node => node.value), 'off');
    assert.equal(await input('editor.wordWrap').isEnabled(), true);
    await send('settings', { state });
    assert.equal(await input('editor.wordWrap').evaluate(node => node.value), 'bounded');
    assert.equal(await input('editor.wordWrap').isDisabled(), true);
    state = { ...state, items: state.items.map(item => item.key === 'editor.wordWrap' ? { ...item, value: 'bounded', configured: true } : item) };
    await send('settings-saved', { key: 'editor.wordWrap', target: 'user', state });
    assert.equal(await input('editor.wordWrap').evaluate(node => node.value), 'bounded', 'Save acknowledgements must apply the updated snapshot atomically');
    assert.equal(await input('editor.wordWrap').isEnabled(), true);
    checks.push(`${language}: pending edits and save acknowledgement`);

    state = await setup(language, 'general');
    const theme = input('workbench.colorTheme');
    const menu = page.locator('.settings-dropdown-menu:popover-open');
    await theme.press('ArrowDown');
    assert.equal(await theme.getAttribute('aria-expanded'), 'true');
    await theme.press('End');
    await send('settings', { state });
    assert.equal(await menu.isVisible(), true, 'Refreshing unrelated settings must preserve the open menu');
    assert.equal(await menu.locator('.active').getAttribute('data-value'), 'Light');
    await theme.press('Escape');
    assert.equal(await menu.count(), 0); assert.equal((await writes()).length, 0);
    assert.equal(await theme.evaluate(node => node === document.activeElement), true);
    await theme.press('Enter'); await theme.press('End'); await theme.press('Enter');
    assert.equal((await writes()).at(-1).value, 'Light');
    await send('settings-saved', { key: 'workbench.colorTheme', target: 'user', state: { ...state, items: state.items.map(item => item.key === 'workbench.colorTheme' ? { ...item, value: 'Light' } : item) } });
    assert.equal(await theme.evaluate(node => node === document.activeElement), true, 'Completing a keyboard selection restores focus');
    await theme.press('ArrowDown'); await theme.press('Tab');
    assert.equal(await menu.count(), 0, 'Tab dismisses the menu without committing');
    assert.equal((await writes()).length, 1);
    await theme.click(); await page.locator('#settings-search').click();
    assert.equal(await menu.count(), 0);
    assert.equal(await page.locator('#settings-search').evaluate(node => node === document.activeElement), true);
    checks.push(`${language}: dropdown keyboard, refresh and dismissal`);

    state = await setup(language, 'general');
    const preferred = language === 'en' ? 'zh-cn' : 'en';
    state = { ...state, languagePreference: preferred };
    const languageChoice = page.locator('#settings-language-choice');
    const currentLanguage = page.locator('#settings-language-current');
    const pendingLanguage = page.locator('#settings-language-pending');
    const restartLanguage = page.locator('#settings-language-restart');
    await send('settings', { state });
    assert.equal(await languageChoice.evaluate(node => node.value), preferred, 'A saved preference remains selected while the old host is running');
    assert.equal(await currentLanguage.textContent(), language === 'en'
      ? 'Current display language: English. Changes take effect after restarting Studio.'
      : '当前显示语言：简体中文。切换语言需重启 Studio 后生效。');
    assert.equal(await pendingLanguage.locator('p').textContent(), language === 'en'
      ? 'Restart Studio to apply 简体中文.' : '重启 Studio 后切换为English。');
    assert.equal(await restartLanguage.textContent(), language === 'en' ? 'Restart to apply' : '重启并应用');
    await restartLanguage.click();
    assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'settings-language')), [{ type: 'settings-language', value: preferred }]);
    assert.equal(await languageChoice.isDisabled(), true);
    await send('settings', { state });
    assert.equal(await pendingLanguage.isVisible(), false, 'A refresh must not expose a second restart while one is pending');
    await send('settings-language-result', { value: preferred });
    assert.equal(await pendingLanguage.isVisible(), true, 'Canceling the restart keeps the unapplied preference visible');
    assert.equal(await restartLanguage.evaluate(node => node === document.activeElement), true, 'Canceling restart restores keyboard focus');
    await restartLanguage.click();
    await send('settings-language-result', { value: preferred, message: 'Fixture restart failure' });
    assert.equal(await page.locator('#settings-language-error').textContent(), 'Fixture restart failure');
    assert.equal(await restartLanguage.isEnabled(), true);
    assert.equal(await restartLanguage.evaluate(node => node === document.activeElement), true);
    await send('settings', { state: { ...state, languagePreference: language } });
    assert.equal(await pendingLanguage.isVisible(), false, 'Matching the active language needs no restart');
    await send('settings', { state: { ...state, languagePreference: 'system' } });
    assert.equal(await pendingLanguage.isVisible(), false, 'Following the system is a preference rather than a display language');
    checks.push(`${language}: active language and saved preference, restart retry, cancellation and failure`);

    state = await setup(language);
    await send('settings', { state: { ...state, workspaceAvailable: false } });
    const scope = page.locator('#settings-target');
    await scope.press('Enter');
    assert.equal(await menu.locator('[data-value="workspace"]').getAttribute('aria-disabled'), 'true');
    await scope.press('End'); await scope.press('Enter');
    assert.equal(await scope.evaluate(node => node.value), 'user');
    assert.equal(await page.evaluate(() => window.messages.some(message => message.type === 'settings-target')), false);
    checks.push(`${language}: unavailable workspace is skipped`);

    await page.setViewportSize({ width: 360, height: 450 });
    state = await setup(language, 'general');
    const options = Array.from({ length: 35 }, (_, i) => ({ value: `theme-${i}`, label: `Theme ${i} with a long descriptive label` }));
    state = { ...state, items: state.items.map(item => item.key === 'workbench.colorTheme' ? { ...item, options, value: 'theme-0' } : item) };
    await send('settings', { state });
    await theme.click(); await theme.press('End');
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 361 && bounds.y >= 0 && bounds.y + bounds.height <= 451, 'A long menu fits a short, narrow editor');
    assert.ok(await menu.evaluate(node => node.scrollTop > 0), 'Keyboard navigation scrolls the option list');
    assert.equal(await menu.isVisible(), true, 'Scrolling the menu must not close it');
    await theme.press('Escape');
    await theme.click();
    await main.evaluate(node => { node.scrollTop += 24; });
    await page.waitForFunction(() => !document.querySelector('.settings-dropdown-menu:popover-open'));
    await page.setViewportSize({ width: 1440, height: 800 });
    checks.push(`${language}: long menu positioning and scroll`);

    state = withFont(await setup(language), 16);
    await send('settings', { state });
    await font.fill('18');
    await page.locator('[data-reset="editor.fontSize"]').click();
    assert.equal((await writes()).length, 1);
    assert.equal((await writes())[0].reset, true, 'Reset must take precedence over the blur save');
    await send('settings-saved', { key: 'editor.fontSize', target: 'user', state: withFont(state, 14, false) });
    assert.equal(await font.inputValue(), '14');
    assert.equal(await page.locator('[data-reset="editor.fontSize"]').isDisabled(), true);
    checks.push(`${language}: reset while editing`);

    await setup(language, 'provider:plugin', [provider]);
    await send('account', { state: { ...account, status: 'error' } });
    assert.equal(await page.locator('#settings-sign-in').isVisible(), true, 'A restored but unverified account needs an explanation');
    assert.equal(await page.locator('#settings-sign-in p').textContent(), language === 'en' ? 'Account verification failed.' : chinese['Account verification failed.']);
    await page.locator('#settings-provider-sign-in').click();
    assert.equal(await category('account').getAttribute('aria-current'), 'page');
    await category('general').click();
    assert.equal(await input('studio.terminal.name').isEnabled(), true);
    checks.push(`${language}: unverified account provider fallback`);

    for (const phase of ['loading', 'uninitialized', 'unregistered']) {
      state = await setup(language, 'provider:plugin', phase === 'unregistered' ? [] : [provider]);
      if (phase !== 'unregistered') { await send('account-sections', { states: [{ ...providerState, loading: phase === 'loading' }] }); }
      await send('settings-navigate', { state: { section: 'provider:plugin', scroll: 400 } });
      await page.waitForTimeout(140);
      assert.equal(await page.evaluate(() => window.savedState.scroll), 400, 'Loading must retain the intended scroll position');
      if (phase === 'unregistered') { await send('settings', { state: { ...state, providers: [provider] } }); }
      await send('account-sections', { states: [loaded] });
      assert.equal(await main.evaluate(node => node.scrollTop), 400, `${phase} provider must restore its scroll after content arrives`);
      await send('settings-navigate', { state: { section: 'provider:plugin', scroll: 600 } });
      assert.equal(await main.evaluate(node => node.scrollTop), 600, 'Already loaded providers restore immediately');
      checks.push(`${language}: ${phase} provider scroll restoration`);
    }

    for (const interaction of ['wheel', 'keyboard', 'navigation', 'search']) {
      await setup(language, 'provider:plugin', [provider]);
      await send('account-sections', { states: [{ ...providerState, loading: true }] });
      await send('settings-navigate', { state: { section: 'provider:plugin', scroll: 400 } });
      if (interaction === 'wheel') { await main.dispatchEvent('wheel', { deltaY: 120 }); }
      else if (interaction === 'keyboard') { await main.dispatchEvent('keydown', { key: 'PageDown' }); }
      else if (interaction === 'navigation') { await category('general').click(); }
      else { await page.locator('#settings-search').fill('Plugin'); }
      await send('account-sections', { states: [loaded] });
      assert.equal(await main.evaluate(node => node.scrollTop), 0, 'User interaction must cancel deferred restoration');
      checks.push(`${language}: ${interaction} cancels pending scroll restoration`);
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Settings regressions: ${checks.length} scenarios passed.`);
} finally {
  await browser.close();
}
