import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss, selectSettingsOption } from './settings-ui-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extensions/studio-workstation');
const assets = process.env.STEAMHARNESS_STUDIO_TEST_SETTINGS_ASSETS ?? path.join(extension, 'dist');
const output = path.join(root, '.studio/settings-ui');
await mkdir(output, { recursive: true });
const [js, css, icons, font, chinese] = await Promise.all([
  readFile(path.join(assets, 'account-ui.js'), 'utf8'), readFile(path.join(assets, 'account-ui.css'), 'utf8'),
  readFile(path.join(assets, 'codicons/codicon.css'), 'utf8'), readFile(path.join(assets, 'codicons/codicon.ttf')),
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
const account = { status: 'authenticated', revision: 1, aiConfigured: true, serverUrl: 'https://server.example.test', user: { userId: 'user-id', displayName: 'SteamHarness Admin', email: 'admin@steamharness.local' } };
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
      for (const width of theme === 'contrast' ? [701, 700, 640] : [1440, 960, 640, 360, 280]) {
        await page.goto('about:blank'); await page.setViewportSize({ width, height: 1000 });
        const bundle = language === 'en' ? {} : JSON.parse(chinese);
        await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${settingsThemeCss(theme)}\n${iconCss}\n${css}</style></head><body data-platform="true"><main id="account-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle }).replace(/</g, '\\u003c')}</script></body></html>`);
        await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), setState: state => { window.savedState = state; } }); });
        await page.addScriptTag({ content: js });
        let state = { ...settingsFixture(language, [], 'user', true), sidebar: { items: [], canAdd: true },
          desktopNotificationStatus: { platform: 'macos', permission: 'unknown', appName: 'SteamHarness Dev' } };
        await send('settings', { state });
        await send('account', { state: { status: 'signed-out', serverUrl: account.serverUrl, revision: 0 } });
        await send('settings-navigate', { state: { section: 'general' } });
        assert.equal(await category('general').getAttribute('aria-current'), 'page');
        assert.deepEqual(await page.locator('#settings-navigation button').evaluateAll(buttons => buttons.map(button => button.dataset.section)),
          ['account', 'general', 'editor', 'sidebar', 'models', 'permissions', 'notifications', 'about']);
        assert.equal(await category('notifications').textContent(), language === 'en' ? 'Notifications' : '通知');
        await category('notifications').click();
        assert.equal(await page.locator('#settings-notification-status').textContent(), language === 'en' ? 'Check permission in system settings' : '授权状态需在系统设置中确认');
        for (const [permission, en, zh] of [['granted', 'System notifications allowed', '已允许系统通知'], ['denied', 'System notifications blocked', '系统通知已被禁止'], ['not-determined', 'Notification permission not requested', '尚未请求系统通知权限']]) {
          await send('settings', { state: { ...state, desktopNotificationStatus: { ...state.desktopNotificationStatus, permission } } });
          assert.equal(await page.locator('#settings-notification-status').textContent(), language === 'en' ? en : zh);
        }
        const desktop = setting('studio.notifications.desktop'), workbench = setting('studio.notifications.workbench');
        await desktop.uncheck();
        assert.deepEqual(await last('settings-update'), { type: 'settings-update', key: 'studio.notifications.desktop', value: false, reset: false, target: 'user' });
        assert.equal(await workbench.isChecked(), true);
        await page.locator('[data-settings-action="notification-settings"]').click();
        assert.deepEqual(await last('settings-action'), { type: 'settings-action', action: 'notification-settings' });
        await fits();
        await category('general').click();
        if (width > 700) {
          const modelDivider = await category('models').evaluate(button => {
            const previous = button.previousElementSibling.getBoundingClientRect();
            const divider = getComputedStyle(button, '::before');
            return { gap: button.getBoundingClientRect().top - previous.bottom, border: divider.borderTopWidth, borderColor: divider.borderTopColor };
          });
          assert.ok(modelDivider.gap >= 16, 'The wide sidebar separates the Models category');
          assert.equal(modelDivider.border, '1px'); assert.notEqual(modelDivider.borderColor, 'rgba(0, 0, 0, 0)');
          if (theme === 'contrast') {
            await category('models').click();
            const borders = await category('models').evaluate(button => {
              const style = getComputedStyle(button);
              return [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
            });
            assert.deepEqual(borders, Array(4).fill('rgb(243, 133, 24)'), 'The category divider never covers the high-contrast selection border');
            await category('general').click();
          }
        } else {
          const provider = { id: 'system-ai', title: language === 'en' ? 'System AI' : '系统 AI', icon: 'sparkle' };
          await send('settings', { state: { ...state, remoteAccess: true, providers: [provider] } });
          const navigation = page.locator('#settings-navigation');
          const layout = () => navigation.locator('button').evaluateAll(buttons => buttons.map(button => {
            const { left, right, top, height } = button.getBoundingClientRect();
            return { section: button.dataset.section, left, top, height, radius: getComputedStyle(button).borderRadius,
              start: button.firstElementChild.getBoundingClientRect().left - left, end: right - button.lastElementChild.getBoundingClientRect().right };
          }));
          const tabs = await layout();
          await category('models').click();
          assert.equal(await category('models').getAttribute('aria-current'), 'page');
          assert.deepEqual(await layout(), tabs, 'Selecting Models does not change the tab layout');
          await category('models').press('ArrowRight');
          assert.equal(await category('permissions').getAttribute('aria-current'), 'page');
          assert.equal(await category('permissions').evaluate(button => button === document.activeElement), true);
          await category('permissions').press('ArrowLeft');
          assert.equal(await category('models').getAttribute('aria-current'), 'page');
          for (const [index, tab] of tabs.entries()) {
            const previous = tabs[index - 1];
            if (previous && tab.left > previous.left) assert.equal(tab.top, previous.top, `${tab.section} aligns with other tabs on its row`);
            assert.equal(tab.height, tabs[0].height, `${tab.section} uses the standard compact height`);
            assert.equal(tab.radius, tabs[0].radius, `${tab.section} uses the standard compact corners`);
          }
          assert.ok(tabs.every(tab => Math.abs(tab.start - tab.end) <= 1), 'A wrapped row does not stretch its tabs');
          if (language === 'zh-cn' && theme === 'dark' && width === 640) {
            const name = 'settings-navigation-zh-cn-dark-640.png';
            await navigation.screenshot({ path: path.join(output, name) }); screenshots.push(name);
          }
          await send('settings', { state });
          await category('general').click();
        }
        const browserKey = 'studio.browser.linkTarget', browserChoice = setting(browserKey);
        assert.match(await browserChoice.innerText(), language === 'en' ? /Built-in browser/ : /内置浏览器/);
        await selectSettingsOption(page, browserChoice, 'external');
        assert.deepEqual(await last('settings-update'), { type: 'settings-update', key: browserKey, value: 'external', reset: false, target: 'user' });
        state = { ...state, items: state.items.map(item => item.key === browserKey ? { ...item, value: 'external', configured: true } : item) };
        await send('settings-saved', { key: browserKey, target: 'user', state });
        assert.match(await browserChoice.innerText(), language === 'en' ? /System default browser/ : /系统默认浏览器/);
        await selectSettingsOption(page, browserChoice, 'internal');
        assert.equal((await last('settings-update')).value, 'internal');
        state = { ...state, items: state.items.map(item => item.key === browserKey ? { ...item, value: 'internal', configured: false } : item) };
        await send('settings-saved', { key: browserKey, target: 'user', state });
        await fits();
        assert.equal(await page.locator('#settings-general select, #settings-editor select, #settings-scope select').count(), 0, 'General and editor settings must use page menus, including language and scope');
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
        await category('permissions').click();
        const permissionKey = 'studio.agent.permissionPolicy';
        const permissions = page.locator('#settings-permissions');
        const radios = permissions.locator('input[type="radio"]');
        const radio = value => permissions.locator(`input[type="radio"][value="${value}"]`);
        assert.equal(await permissions.isVisible(), true);
        assert.equal(await page.locator('#settings-title').textContent(), language === 'en' ? 'Permissions' : '权限');
        assert.equal(await page.locator('#settings-scope').isVisible(), false);
        assert.equal(await radios.count(), 3);
        assert.equal(await permissions.getByText(language === 'en'
          ? 'Sensitive permissions, including the use of saved credentials, require approval.'
          : '使用已保存的凭据等敏感权限需授权。').isVisible(), true);
        assert.equal(await permissions.locator('.settings-radio-choice').evaluateAll(choices => choices.every(choice => {
          const input = choice.querySelector('input').getBoundingClientRect(), copy = choice.querySelector('.settings-radio-copy').getBoundingClientRect();
          return copy.left > input.right && Math.abs(copy.top - input.top) < 6;
        })), true, 'Radio controls align beside their wrapping labels at every width');
        assert.equal(await radio('auto').isChecked(), true);
        await radio('auto').focus(); await radio('auto').press('ArrowUp');
        assert.deepEqual(await last('settings-update'), { type: 'settings-update', key: permissionKey, value: 'workspace', reset: false, target: 'user' });
        assert.equal(await radio('workspace').isChecked(), true);
        assert.equal(await radio('workspace').isDisabled(), true);
        await send('settings', { state });
        assert.equal(await radio('workspace').isChecked(), true, 'Refresh preserves a pending permission change');
        await send('settings-error', { key: permissionKey, target: 'user', message: 'Fixture permission failure' });
        assert.equal(await radio('workspace').getAttribute('aria-invalid'), 'true');
        assert.equal(await radio('workspace').isEnabled(), true);
        await radio('read-only').check();
        state = { ...state, items: state.items.map(item => item.key === permissionKey ? { ...item, value: 'read-only', configured: true } : item) };
        await send('settings', { state }); await send('settings-saved', { key: permissionKey, target: 'user' });
        assert.equal(await radio('read-only').getAttribute('aria-invalid'), 'false');
        assert.equal(await radio('read-only').isChecked(), true);
        await page.locator(`[data-reset="${permissionKey}"]`).click();
        assert.equal((await last('settings-update')).reset, true);
        assert.equal((await last('settings-update')).target, 'user');
        state = { ...state, items: state.items.map(item => item.key === permissionKey ? { ...item, value: 'auto', configured: false } : item) };
        await send('settings', { state }); await send('settings-saved', { key: permissionKey, target: 'user' });
        assert.equal(await radio('auto').isChecked(), true);
        await fits();
        if ([1440, 360].includes(width)) {
          const name = `settings-permissions-${language}-${theme}-${width}.png`;
          await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
        }
        await page.locator('#settings-search').fill(permissionKey);
        assert.equal(await permissions.isVisible(), true); assert.equal(await page.locator('#settings-editor').isVisible(), false);
        await page.locator('#settings-search').fill(state.items.find(item => item.key === permissionKey).options.find(option => option.value === 'read-only').label);
        assert.equal(await permissions.isVisible(), true, 'Permission option labels are searchable');
        await page.locator('#settings-search').fill('editor.fontSize');
        assert.equal(await permissions.isVisible(), false);
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
        assert.equal(await page.locator('#profile-server, #profile-transport, #account-server, [data-copy="serverUrl"]').count(), 0);
        assert.ok(!(await page.locator('#settings-account').innerText()).includes(account.serverUrl));
        await page.locator('[data-copy="userId"]').click(); assert.equal((await last('copy')).field, 'userId');
        await fits();
        await category('about').click();
        assert.equal(await page.locator('#settings-studio-version').textContent(), '0.1.0');
        assert.equal(await page.locator('#settings-core-version').textContent(), '0.2.7');
        assert.equal(await page.locator('#settings-cli-version').textContent(), '0.2.8');
        assert.equal(await page.locator('#settings-vscode-version').textContent(), '1.141.0');
        assert.equal(await page.locator('#settings-vscode-version').locator('xpath=preceding-sibling::dt[1]').textContent(), language === 'en' ? 'VS Code engine version' : 'VS Code 内核版本');
        const logo = page.locator('#settings-studio-logo');
        assert.equal(await logo.isVisible(), true);
        assert.equal(await logo.getAttribute('src'), state.studioLogo);
        await logo.evaluate(image => image.decode());
        await page.locator('[data-settings-action="documentation"]').click(); assert.equal((await last('settings-action')).action, 'documentation');
        await fits();
        const provider = { id: 'plugin', title: language === 'en' ? 'Plugin Information' : '扩展信息', icon: 'sparkle' };
        state = { ...state, providers: [provider] }; await send('settings', { state });
        await send('account-sections', { states: [{ ...provider, loading: false, failed: false, sections: [{ id: 'details', title: 'Details', metrics: [{ label: 'Requests', value: '42' }] }] }] });
        await send('account', { state: { ...account, aiConfigured: false, status: 'signed-out', user: undefined } });
        assert.equal(await page.locator('#settings-provider-sign-in').textContent(), language === 'en' ? 'Sign in to connect System AI' : '登录后连接系统 AI');
        await send('account', { state: account });
        await send('account-sections', { states: [{ ...provider, loading: false, failed: false, sections: [{ id: 'details', title: 'Details', metrics: [{ label: 'Requests', value: '42' }] }] }] });
        await category('provider:plugin').click(); assert.equal(await page.locator('.metric-value').textContent(), '42');
        await send('account', { state: { status: 'expired', serverUrl: account.serverUrl, user: account.user, revision: 2 } });
        assert.equal(await page.locator('[data-provider]').count(), 0); assert.equal(await page.locator('#settings-sign-in').isVisible(), true);
        await page.locator('#settings-provider-sign-in').click(); assert.equal((await last('connect-system-ai')).type, 'connect-system-ai');
        await category('account').click();
        assert.equal(await page.locator('#login-form, #login-email, #login-password').count(), 0);
        assert.equal(await page.locator('#account-sign-in').isVisible(), true);
        assert.ok(!(await page.locator('#settings-account').innerText()).includes(account.serverUrl));
        await page.locator('#open-login').click(); assert.equal((await last('open-login')).type, 'open-login');
        await page.locator('#settings-identity').click(); assert.equal((await last('open-login')).type, 'open-login');
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
