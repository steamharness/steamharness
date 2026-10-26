import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsThemeCss } from './settings-ui-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extensions/studio-workstation');
const output = path.join(root, '.studio/login-ui');
await mkdir(output, { recursive: true });
const [js, css, icons, font, chinese] = await Promise.all([
  readFile(path.join(extension, 'dist/login-ui.js'), 'utf8'), readFile(path.join(extension, 'dist/login-ui.css'), 'utf8'),
  readFile(path.join(extension, 'dist/codicons/codicon.css'), 'utf8'), readFile(path.join(extension, 'dist/codicons/codicon.ttf')),
  readFile(path.join(extension, 'l10n/bundle.l10n.zh-cn.json'), 'utf8'),
]);
const iconCss = icons.replace(/url\([^)]+\)/g, `url(data:font/ttf;base64,${font.toString('base64')})`);
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const page = await browser.newPage();
const errors = [], checks = [], screenshots = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => route.abort());
const signedOut = { status: 'signed-out', serverUrl: 'https://server.example.test', revision: 0 };
const send = message => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message);
const countLogins = () => page.evaluate(() => window.messages.filter(message => message.type === 'login').length);

async function fits() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Login must fit the editor width');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('button,input,h1,h2,p,label')].filter(node => node.getClientRects().length).filter(node => {
    const box = node.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 2;
  }).map(node => node.outerHTML.slice(0, 160))), []);
}

try {
  for (const language of ['en', 'zh-cn']) {
    for (const theme of ['light', 'dark', 'contrast']) {
      for (const width of theme === 'contrast' ? [640] : [1440, 640, 360, 280]) {
        await page.goto('about:blank'); await page.setViewportSize({ width, height: 900 });
        const bundle = language === 'en' ? {} : JSON.parse(chinese);
        await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${settingsThemeCss(theme)}\n${iconCss}\n${css}</style></head><body><main id="login-app"></main><script id="studio-localization" type="application/json">${JSON.stringify({ locale: language, bundle }).replace(/</g, '\\u003c')}</script></body></html>`);
        await page.evaluate(() => {
          window.messages = []; window.savedState = { password: 'do-not-restore' };
          window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), setState: state => { window.savedState = state; }, getState: () => { throw new Error('Login must not restore form state'); } });
        });
        await page.addScriptTag({ content: js });
        await send({ type: 'account', state: signedOut });
        const server = page.locator('#server-url'), email = page.locator('#login-email'), password = page.locator('#login-password');
        assert.equal(await page.locator('h1').textContent(), language === 'en' ? 'Sign in to SteamHarness' : '登录 SteamHarness');
        assert.equal(await page.locator('#settings-navigation').count(), 0);
        assert.equal(await password.inputValue(), ''); assert.deepEqual(await page.evaluate(() => window.savedState), {});
        await page.locator('#login-submit').click(); assert.equal(await countLogins(), 0, 'Invalid forms must not submit');
        await server.focus(); await server.press('Tab'); assert.equal(await email.evaluate(node => node === document.activeElement), true);
        await server.fill('https://draft.example.test'); await email.fill('user@example.test'); await password.fill('fixture-password');
        await page.locator('#show-password').click(); assert.equal(await password.getAttribute('type'), 'text');
        assert.equal(await page.locator('#show-password').getAttribute('aria-label'), language === 'en' ? 'Hide password' : '隐藏密码');
        await send({ type: 'account', state: { ...signedOut, revision: 1 } });
        assert.equal(await server.inputValue(), 'https://draft.example.test'); assert.equal(await email.inputValue(), 'user@example.test'); assert.equal(await password.inputValue(), 'fixture-password');
        await fits();
        if (width === 1440 && theme !== 'contrast') {
          const filename = `login-${language}-${theme}.png`;
          await password.fill(''); await page.locator('#show-password').click();
          await page.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename);
          await password.fill('fixture-password');
        }
        await password.press('Enter');
        assert.equal(await countLogins(), 1);
        assert.deepEqual(await page.evaluate(() => window.messages.find(message => message.type === 'login')), { type: 'login', serverUrl: 'https://draft.example.test', email: 'user@example.test', password: 'fixture-password' });
        assert.equal(await password.inputValue(), ''); assert.equal(await password.getAttribute('type'), 'password');
        assert.equal(await page.locator('#login-submit').isDisabled(), true); assert.equal(await email.isDisabled(), true);
        await page.locator('#login-form').evaluate(form => form.dispatchEvent(new Event('submit', { cancelable: true })));
        assert.equal(await countLogins(), 1, 'Pending requests must not submit twice');
        await send({ type: 'account', busy: true, state: { ...signedOut, status: 'checking' } });
        await send({ type: 'login-result', state: { ...signedOut, status: 'error' }, message: 'Fixture request failed' });
        assert.equal(await page.locator('#login-error').textContent(), 'Fixture request failed'); assert.equal(await page.locator('#login-submit').isEnabled(), true);
        assert.equal(await server.inputValue(), 'https://draft.example.test'); assert.equal(await email.inputValue(), 'user@example.test');
        await password.fill('another-draft');
        await send({ type: 'account', state: { ...signedOut, serverUrl: 'https://new.example.test' } });
        assert.equal(await server.inputValue(), 'https://new.example.test'); assert.equal(await email.inputValue(), ''); assert.equal(await password.inputValue(), '');
        await send({ type: 'account', state: { ...signedOut, status: 'expired' } });
        assert.equal(await page.locator('#login-error').textContent(), language === 'en' ? 'Sign-in expired. Sign in again.' : '登录已失效，请重新登录。');
        await fits();
        const selected = await page.locator('h1').evaluate(node => {
          const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
        });
        assert.equal(selected, await page.locator('h1').textContent());
        await password.fill('external-sign-in-draft');
        await send({ type: 'account', state: { ...signedOut, status: 'authenticated', user: { userId: 'user', email: 'user@example.test', displayName: 'User' } } });
        assert.equal(await password.inputValue(), '', 'Signing in from another window must clear the password draft');
        assert.equal(await page.locator('#login-form').isVisible(), false); assert.equal(await page.locator('#login-success').isVisible(), true);
        await page.locator('#open-account').click(); assert.equal(await page.evaluate(() => window.messages.at(-1).type), 'open-account');
        assert.deepEqual(await page.evaluate(() => window.savedState), {});
        await fits();
        checks.push(`${language}/${theme}/${width}: layout, localization, validation, keyboard, drafts, retry, expiry, safe restoration, account navigation`);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Login UI: ${checks.length} scenarios passed. Screenshots: ${output}`);
} finally {
  await writeFile(path.join(output, 'proof.json'), JSON.stringify({ checks, screenshots, errors }, null, 2));
  await browser.close();
}
