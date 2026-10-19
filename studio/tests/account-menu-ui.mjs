import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

register();
const { accountMenuState } = await import('../extensions/studio-workstation/src/account-menu-state.ts');
const { configureLocalization } = await import('../extensions/studio-workstation/src/localization.ts');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.studio/account-menu-ui');
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: { contents: `
    import { StudioAccountMenu } from './upstream/vscode/src/vs/workbench/browser/parts/studioAccountMenu.ts';
    import { ContextView, ContextViewDOMPosition, AnchorAlignment, AnchorAxisAlignment } from './upstream/vscode/src/vs/base/browser/ui/contextview/contextview.ts';
    import { CommandsRegistry } from './upstream/vscode/src/vs/platform/commands/common/commands.ts';
    const anchor = document.querySelector('#avatar');
    const context = new ContextView(document.body, ContextViewDOMPosition.FIXED);
    let state, refreshDone, snapshotDone;
    let snapshot;
    const commands = [], errors = [];
    const menu = new StudioAccountMenu({ executeCommand: async command => {
      if (command === 'studio.internalGetAccountMenuState') { return snapshot ?? state; }
      commands.push(command);
      if (command === 'studio.refreshAccount') { await new Promise(resolve => { refreshDone = resolve; }); }
    } }, { getContextKeyValue: () => true }, {
      showContextView: delegate => { context.show(delegate); return { close: () => context.hide() }; },
      layout: () => context.layout(),
    }, { error: error => errors.push(String(error)) });
    window.fixture = {
      commands, errors,
      open: side => menu.toggle(anchor, { anchorAlignment: side === 'right' ? AnchorAlignment.LEFT : AnchorAlignment.RIGHT, anchorAxisAlignment: AnchorAxisAlignment.HORIZONTAL }),
      push: value => { state = value; CommandsRegistry.getCommand('studio.internalUpdateAccountMenuState').handler(undefined, value); },
      finishRefresh: () => { refreshDone(); },
      holdSnapshot: () => { snapshot = new Promise(resolve => { snapshotDone = resolve; }); },
      finishSnapshot: value => { snapshotDone(value); snapshot = undefined; },
      dispose: () => { menu.dispose(); context.dispose(); },
    };
  `, loader: 'ts', resolveDir: root },
  outfile: 'account-menu.js', bundle: true, platform: 'browser', format: 'iife', write: false,
  tsconfig: path.join(root, 'upstream/vscode/src/tsconfig.json'), logLevel: 'silent',
});
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const workbenchStyles = await readFile(path.join(root, 'upstream/vscode/src/vs/workbench/browser/media/style.css'), 'utf8');
const iconDirectory = path.join(root, 'node_modules/@vscode/codicons/dist');
const font = await readFile(path.join(iconDirectory, 'codicon.ttf'));
const icons = (await readFile(path.join(iconDirectory, 'codicon.css'), 'utf8')).replace(/url\([^)]+\)/g, `url(data:font/ttf;base64,${font.toString('base64')})`);
const chinese = JSON.parse(await readFile(path.join(root, 'extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json'), 'utf8'));
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => route.abort());
const checks = [];
const account = { status: 'authenticated', revision: 1, serverUrl: 'http://127.0.0.1:7126',
  user: { userId: 'user', displayName: 'SteamHarness Admin', email: 'admin@example.test',
    avatarUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' } };
const push = value => page.evaluate(value => window.fixture.push(value), value);
const command = id => page.locator(`[data-command="${id}"]`);
const menu = page.locator('.studio-account-menu');
async function fits() {
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.studio-account-menu, .studio-account-menu button, .studio-account-name, .studio-account-email, .studio-account-action-label')]
    .filter(node => node.getClientRects().length).filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1 || node.scrollWidth > node.clientWidth + 1;
    }).map(node => node.className));
  assert.deepEqual(overflow, [], 'Menu, account fields and actions must fit');
}
try {
  for (const language of ['en', 'zh-cn']) {
    configureLocalization(language === 'en' ? {} : chinese, language);
    const initial = accountMenuState(account);
    for (const theme of ['light', 'dark']) {
      const dark = theme === 'dark';
      for (const width of [1440, 360, 280]) {
        await page.setViewportSize({ width, height: 700 });
        await page.setContent(`<!doctype html><html lang="${language}"><head><style>
          :root { color-scheme:${theme}; --vscode-menu-background:${dark ? '#252526' : '#fff'}; --vscode-menu-foreground:${dark ? '#ddd' : '#222'};
          --vscode-descriptionForeground:${dark ? '#aaa' : '#616161'}; --vscode-widget-border:${dark ? '#454545' : '#dedede'}; --vscode-widget-shadow:#0002;
          --vscode-menu-separatorBackground:${dark ? '#454545' : '#e6e6e6'}; --vscode-toolbar-hoverBackground:${dark ? '#ffffff18' : '#0000000d'};
          --vscode-list-hoverBackground:${dark ? '#323232' : '#f2f2f2'}; --vscode-focusBorder:#0078d4; --vscode-testing-iconPassed:#238636;
          --vscode-errorForeground:${dark ? '#f48771' : '#a1260d'}; --vscode-editorWarning-foreground:#b58800; --vscode-progressBar-background:#0078d4;
          --vscode-scrollbarSlider-background:#79797966; }
          body { margin:0; height:100vh; background:${dark ? '#1f1f1f' : '#f6f6f6'}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
          #avatar { position:fixed; left:8px; bottom:34px; width:32px; height:32px; }
          ${workbenchStyles}\n${icons}\n${stylesheet}
        </style></head><body class="monaco-workbench mac"><button id="avatar" aria-label="Account">A</button></body></html>`);
        await page.addScriptTag({ content: javascript });
        await push(initial);
        await page.evaluate(() => window.fixture.open());
        assert.deepEqual(await menu.evaluate(node => ({
          focused: document.activeElement === node,
          focusedButtons: node.querySelectorAll('button:focus').length,
          outline: getComputedStyle(node).outlineStyle,
        })), { focused: true, focusedButtons: 0, outline: 'none' }, 'Opening the menu must not highlight an action');
        await fits();
        assert.equal(await command('studio.openAccount').textContent(), language === 'en' ? 'Personal Information' : '个人信息');
        assert.doesNotMatch(await menu.textContent(), /Manage Trusted|Manage Extension|Manage Language|AI|余额|套餐|用量/);
        assert.equal(await menu.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), true);
        await page.screenshot({ path: path.join(output, `menu-${language}-${theme}-${width}.png`) });
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('.studio-account-close').evaluate(node => document.activeElement === node && node.matches(':focus-visible')), true);
        await page.keyboard.press('ArrowDown');
        assert.equal(await command('studio.openAccount').evaluate(node => document.activeElement === node && node.matches(':focus-visible')), true);
        await page.keyboard.press('ArrowDown');
        assert.equal(await command('studio.refreshAccount').evaluate(node => document.activeElement === node), true);
        await page.keyboard.press('End');
        assert.equal(await command('studio.logout').evaluate(node => document.activeElement === node), true);
        await page.keyboard.press('Home');
        assert.equal(await page.locator('.studio-account-close').evaluate(node => document.activeElement === node), true);
        await page.keyboard.press('Tab');
        assert.equal(await command('studio.openAccount').evaluate(node => document.activeElement === node), true);
        await command('studio.refreshAccount').click();
        assert.equal(await command('studio.refreshAccount').getAttribute('aria-disabled'), 'true');
        assert.equal(await menu.isVisible(), true);
        assert.equal(await command('studio.refreshAccount').getAttribute('aria-busy'), 'true');
        await command('studio.refreshAccount').evaluate(node => node.click());
        assert.deepEqual(await page.evaluate(() => window.fixture.commands), ['studio.refreshAccount']);
        const updated = accountMenuState({ ...account, user: { ...account.user, displayName: 'Updated Admin' } });
        await push(updated);
        assert.equal(await menu.locator('.studio-account-name').textContent(), 'Updated Admin');
        assert.equal(await command('studio.refreshAccount').evaluate(node => document.activeElement === node), true);
        await page.evaluate(() => window.fixture.finishRefresh());
        await command('studio.refreshAccount').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelector('[data-command="studio.refreshAccount"]').getAttribute('aria-disabled') === 'false');
        await page.keyboard.press('Escape');
        assert.equal(await menu.isVisible(), false);
        assert.equal(await page.locator('#avatar').evaluate(node => document.activeElement === node), true);
        await page.evaluate(() => window.fixture.open('right'));
        await fits();
        await page.keyboard.press('ArrowUp');
        assert.equal(await command('studio.logout').evaluate(node => document.activeElement === node), true);
        await command('studio.openAccount').click();
        assert.equal(await menu.isVisible(), false);
        assert.deepEqual(await page.evaluate(() => window.fixture.commands), ['studio.refreshAccount', 'studio.openAccount']);
        await page.evaluate(() => window.fixture.open());
        await page.mouse.click(width - 8, 8);
        assert.equal(await menu.isVisible(), false);
        const long = accountMenuState({ ...account, user: { ...account.user, displayName: 'A'.repeat(80), email: `${'account'.repeat(12)}@example.test` } });
        await push(long);
        await page.evaluate(() => window.fixture.open());
        await fits();
        await push(accountMenuState({ status: 'expired', serverUrl: account.serverUrl, revision: 2, error: language === 'en' ? 'Sign in again.' : '请重新登录。' }));
        assert.equal(await command('studio.refreshAccount').isVisible(), false);
        assert.equal(await command('studio.logout').isVisible(), false);
        assert.equal(await command('studio.openAccount').textContent(), language === 'en' ? 'Sign In' : '登录');
        assert.equal(await menu.locator('img').getAttribute('src'), null);
        assert.equal(await menu.evaluate(node => document.activeElement === node), true, 'Account updates must preserve the neutral initial focus');
        await fits();
        await page.evaluate(() => window.fixture.dispose());
        assert.deepEqual(await page.evaluate(() => window.fixture.errors), []);
        checks.push(`${language}/${theme}/${width}: neutral initial focus, layout, avatar, public data, refresh, profile, expiry, keyboard and outside dismissal`);
      }
    }
  }
  // A stale snapshot must not reopen a dismissed menu or replace a later account update.
  await page.addScriptTag({ content: javascript });
  configureLocalization({}, 'en');
  await push(accountMenuState(account));
  await page.evaluate(() => { window.fixture.holdSnapshot(); window.pendingOpen = window.fixture.open(); });
  await page.evaluate(() => window.fixture.open());
  await page.evaluate(state => { window.fixture.finishSnapshot(state); return window.pendingOpen; }, accountMenuState(account));
  assert.equal(await menu.isVisible(), false);
  await page.evaluate(() => { window.fixture.holdSnapshot(); window.pendingOpen = window.fixture.open(); });
  await push(accountMenuState({ ...account, user: { ...account.user, displayName: 'New Account' } }));
  await page.evaluate(state => { window.fixture.finishSnapshot(state); return window.pendingOpen; }, accountMenuState(account));
  assert.equal(await menu.locator('.studio-account-name').textContent(), 'New Account');
  await command('studio.logout').click();
  assert.equal(await menu.isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.fixture.commands), ['studio.logout']);
  await page.evaluate(() => window.fixture.dispose());
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, races: 'dismissed and replaced snapshots ignored', errors }, null, 2));
  console.log(`${checks.length} account menu UI cases passed; snapshot races passed. Screenshots: ${output}`);
} finally {
  configureLocalization({}, 'en');
  await browser.close();
}
