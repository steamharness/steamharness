import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss } from './settings-ui-fixture.mjs';

const extension = new URL('../extensions/studio-workstation/', import.meta.url);
const [js, css, chinese] = await Promise.all(['dist/account-ui.js', 'dist/account-ui.css', 'l10n/bundle.l10n.zh-cn.json'].map(file => readFile(new URL(file, extension), 'utf8')));
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
try {
  for (const language of ['en', 'zh-cn']) {
    const zh = language === 'zh-cn';
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${settingsThemeCss(zh ? 'dark' : 'light')}${css}</style></head>
      <body><main id="account-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle: zh ? JSON.parse(chinese) : {} }).replace(/</g, '\\u003c')}</script></body></html>`);
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), setState() {} });
    });
    await page.addScriptTag({ content: js });

    const assistant = { id: 'assistant', title: zh ? '小助手' : 'Project Assistant', type: 'bot', builtin: true, visible: true };
    const builtin = { id: 'builtin-board', title: 'Built-in Board', type: 'kanban', builtin: true, visible: true };
    const board = { id: 'board', title: 'Team Board', directory: '/fixtures/team-board', type: 'kanban', builtin: false, visible: true };
    const builtins = [assistant, builtin];
    const send = (type, data) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, ...data });
    const publish = (items, done = false, canAdd = true, error) => send('settings-sidebar-state', { state: { canAdd, items }, done, error });
    await send('settings', { state: { ...settingsFixture(language), sidebar: { canAdd: true, items: builtins } } });
    await page.locator('#settings-navigation [data-section="sidebar"]').getByText(zh ? '右侧栏' : 'Right Sidebar', { exact: true }).click();
    const sidebar = page.locator('#settings-sidebar');
    const control = (id, action) => sidebar.locator(`[data-sidebar-id="${id}"][data-sidebar-action="${action}"]`);
    const add = sidebar.getByRole('button', { name: zh ? '从历史添加' : 'Add from History' });
    const titles = () => sidebar.locator('li strong').allTextContents();
    await add.click();
    assert.equal(await add.isDisabled(), true);
    await publish([...builtins, board], true);
    assert.deepEqual(await titles(), [assistant.title, builtin.title, board.title]);
    for (const { id } of builtins) {
      assert.equal(await control(id, 'toggle').isDisabled(), true);
      assert.equal(await control(id, 'toggle').isChecked(), true);
      assert.equal(await control(id, 'remove').count(), 0);
    }
    assert.equal(await control('board', 'up').getAttribute('title'), zh ? '上移' : 'Move up');
    await control('board', 'up').click();
    await publish([assistant, board, builtin], true);
    assert.deepEqual(await titles(), [assistant.title, board.title, builtin.title]);
    const visibility = control('board', 'toggle');
    await visibility.uncheck();
    assert.equal(await visibility.isDisabled(), true);
    await publish([assistant, board, builtin]);
    assert.equal(await visibility.isChecked(), false);
    const error = zh ? '无法保存设置。' : 'Unable to save setting.';
    await publish([assistant, board, builtin], true, true, error);
    assert.equal(await sidebar.getByRole('alert').textContent(), error);
    assert.equal(await visibility.isChecked(), true);
    assert.equal(await visibility.isDisabled(), false);
    await visibility.uncheck();
    await publish([assistant, { ...board, visible: false }, builtin], true);
    assert.equal(await visibility.isChecked(), false);
    await control('board', 'remove').click();
    await publish(builtins, true, false);
    assert.equal(await add.isDisabled(), true);
    assert.deepEqual(await titles(), [assistant.title, builtin.title]);
    assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'settings-sidebar').map(message => [message.action, message.id ?? null])),
      [['add', null], ['up', 'board'], ['toggle', 'board'], ['toggle', 'board'], ['remove', 'board']]);

    await publish([...builtins, { ...board, directory: `/fixtures/${'long-path-'.repeat(12)}` }]);
    for (const width of [640, 430, 280]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal(await sidebar.evaluate(node => node.scrollWidth <= node.clientWidth), true, `${language} at ${width}px`);
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${language}: sidebar project settings, built-in locks, and narrow layout passed`);
  }
} finally { await browser.close(); }
