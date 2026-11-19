import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss } from './settings-ui-fixture.mjs';

const extension = new URL('../extensions/studio-workstation/', import.meta.url);
const [js, css, chinese, icons, font] = await Promise.all([
  readFile(new URL('dist/account-ui.js', extension), 'utf8'),
  readFile(new URL('dist/account-ui.css', extension), 'utf8'),
  readFile(new URL('l10n/bundle.l10n.zh-cn.json', extension), 'utf8'),
  readFile(new URL('dist/codicons/codicon.css', extension), 'utf8'),
  readFile(new URL('dist/codicons/codicon.ttf', extension)),
]);
const iconCss = icons.replace(/url\([^)]+\)/g, `url(data:font/ttf;base64,${font.toString('base64')})`);
const output = new URL('../.studio/settings-sidebar-ui/', import.meta.url);
await mkdir(output, { recursive: true });
const styles = (locator, properties) => locator.evaluate((node, properties) => {
  const style = getComputedStyle(node);
  return properties.map(property => style.getPropertyValue(property));
}, properties);
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
try {
  for (const language of ['en', 'zh-cn']) {
    const zh = language === 'zh-cn';
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${settingsThemeCss(zh ? 'dark' : 'light')}${iconCss}${css}</style></head>
      <body><main id="account-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle: zh ? JSON.parse(chinese) : {} }).replace(/</g, '\\u003c')}</script></body></html>`);
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), setState() {} });
    });
    await page.addScriptTag({ content: js });

    const assistant = { id: 'assistant', title: zh ? '小助手' : 'Project Assistant', type: 'bot', builtin: true, visible: true };
    const builtin = { id: 'builtin-board', title: zh ? '内置看板' : 'Built-in Board', type: 'kanban', builtin: true, visible: true };
    const board = { id: 'board', title: zh ? '团队看板' : 'Team Board', directory: '/fixtures/team-board', type: 'kanban', builtin: false, visible: true };
    const builtins = [assistant, builtin];
    const send = (type, data) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, ...data });
    const publish = (items, done = false, canAdd = true, error) => send('settings-sidebar-state', { state: { canAdd, items }, done, error });
    const category = id => page.locator(`#settings-navigation [data-section="${id}"]`);
    const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(`${name}-${language}.png`, output)) });
    await send('settings', { state: { ...settingsFixture(language), sidebar: { canAdd: true, items: builtins } } });
    await category('general').click();
    const general = page.locator('#settings-general');
    const cardProperties = ['background-color', 'border-radius', 'border-top-color', 'border-top-width'];
    const switchProperties = ['appearance', 'width', 'height', 'border-radius', 'background-color'];
    const generalCard = await styles(general.locator('.settings-card').first(), cardProperties);
    const generalSwitch = await styles(general.getByRole('switch', { checked: true }).first(), switchProperties);
    await screenshot('general');
    await category('sidebar').getByText(zh ? '右侧栏' : 'Right Sidebar', { exact: true }).click();
    const sidebar = page.locator('#settings-sidebar');
    const control = (id, action) => sidebar.locator(`[data-sidebar-id="${id}"][data-sidebar-action="${action}"]`);
    const add = sidebar.getByRole('button', { name: zh ? '从历史添加' : 'Add from History' });
    const list = sidebar.getByRole('list');
    const titles = () => list.locator('.setting-label').allTextContents();
    assert.equal(await sidebar.getByRole('heading', { name: zh ? '项目标签' : 'Project Tabs' }).isVisible(), true);
    assert.deepEqual(await styles(list, cardProperties), generalCard, 'The project list uses the General settings card style');
    await add.click();
    assert.equal(await add.isDisabled(), true);
    await publish([...builtins, board], true);
    assert.deepEqual(await titles(), [assistant.title, builtin.title, board.title]);
    for (const { title } of builtins) {
      const row = list.getByRole('listitem').filter({ hasText: title });
      assert.equal(await row.getByText(zh ? '始终显示' : 'Always visible', { exact: true }).isVisible(), true);
      assert.equal(await row.locator('.codicon-lock').count(), 1);
      assert.equal(await row.getByRole('switch').count(), 0);
      assert.equal(await row.locator('[data-sidebar-action="remove"]').count(), 0);
    }
    assert.equal(await control('assistant', 'down').isEnabled(), true);
    assert.equal(await control('builtin-board', 'up').isEnabled(), true);
    const visibility = sidebar.getByRole('switch', { name: zh ? `在右侧栏显示 ${board.title}` : `Show ${board.title} in the sidebar` });
    assert.deepEqual(await styles(visibility, switchProperties), generalSwitch, 'Visibility uses the General settings switch style');
    await page.mouse.move(0, 0);
    await screenshot('right-sidebar');

    assert.equal(await control('board', 'up').getAttribute('title'), zh ? '上移' : 'Move up');
    await control('board', 'up').click();
    await publish([assistant, board, builtin], true);
    assert.deepEqual(await titles(), [assistant.title, board.title, builtin.title]);
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
      const clipped = await list.evaluate(card => {
        const bounds = card.getBoundingClientRect();
        return [...card.querySelectorAll('button, .setting-description, .settings-sidebar-visibility')].filter(node => {
          const box = node.getBoundingClientRect();
          return box.left < bounds.left || box.right > bounds.right || node.scrollWidth > node.clientWidth + 1;
        }).map(node => node.textContent || node.getAttribute('aria-label'));
      });
      assert.deepEqual(clipped, [], `${language} at ${width}px: project controls and paths must fit inside the card`);
    }
    await screenshot('right-sidebar-narrow');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${language}: sidebar project settings, built-in locks, and narrow layout passed`);
  }
} finally { await browser.close(); }
