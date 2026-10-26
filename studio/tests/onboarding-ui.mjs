import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsThemeCss } from './settings-ui-fixture.mjs';

const kernel = new URL('../upstream/vscode/', import.meta.url);
const output = new URL('../.studio/onboarding-ui/', import.meta.url);
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `
  export { OnboardingVariationA } from './src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA';
  export { onboardingStrings } from './src/vs/workbench/contrib/welcomeOnboarding/common/onboardingStrings';
  export { Emitter } from './src/vs/base/common/event';
  export { URI } from './src/vs/base/common/uri';
`, resolveDir: kernel.pathname, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'StudioOnboarding',
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }, loader: { '.css': 'empty' }, write: false });
const css = await readFile(new URL('src/vs/workbench/contrib/welcomeOnboarding/browser/media/variationA.css', kernel), 'utf8');
const iconFont = await readFile(new URL('../node_modules/@vscode/codicons/dist/codicon.ttf', import.meta.url));
const icons = (await readFile(new URL('../node_modules/@vscode/codicons/dist/codicon.css', import.meta.url), 'utf8'))
  .replace(/url\([^)]+\)/g, `url(data:font/ttf;base64,${iconFont.toString('base64')})`);
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const page = await browser.newPage();
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const filename = new URL(route.request().url()).pathname.split('/').at(-1);
  if (/^theme-preview-[\w-]+\.svg$/.test(filename)) {
    await route.fulfill({ path: new URL(`src/vs/workbench/contrib/welcomeOnboarding/browser/media/${filename}`, kernel).pathname, contentType: 'image/svg+xml' });
  } else { await route.abort(); }
});

async function show(language, theme, width, height) {
  await page.goto('about:blank');
  await page.setViewportSize({ width, height });
  await page.setContent(`<style>${settingsThemeCss(theme)}\n${icons}\n${css}\nbody { font-family:var(--vscode-font-family); }</style><button id="previous">Previous</button><main id="host"></main>`);
  await page.evaluate(language => {
    globalThis._VSCODE_NLS_LANGUAGE = language;
    globalThis._VSCODE_FILE_ROOT = 'https://studio.test/out/';
    globalThis._VSCODE_PRODUCT_JSON = { nameLong: 'SteamHarness Studio', onboardingThemes: [
      { id: 'dark-2026', themeId: 'dark', label: 'Dark' }, { id: 'light-2026', themeId: 'light', label: 'Light' },
    ] };
    globalThis._VSCODE_PACKAGE_JSON = { version: '1.141.0' };
  }, language);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const { OnboardingVariationA, Emitter, URI } = StudioOnboarding;
    const changes = new Emitter();
    globalThis.authenticated = false; globalThis.calls = []; globalThis.notifications = [];
    globalThis.setSignedIn = value => { authenticated = value; changes.fire({ affectsSome: keys => keys.has('studio.authenticated') }); };
    globalThis.onboarding = new OnboardingVariationA(
      { activeContainer: document.querySelector('#host') },
      { getColorTheme: () => ({ settingsId: 'dark' }), getColorThemes: async () => [], setColorTheme() {} },
      { getContextKeyValue: key => key === 'studio.authenticated' ? authenticated : undefined, onDidChangeContext: changes.event },
      {}, {}, {}, { notify: value => notifications.push(value) }, { exists: async () => false }, { userHome: () => URI.file('/studio-test') },
      { publicLog2() {} }, { executeCommand: async id => { calls.push({ id, modal: !!document.querySelector('[role="dialog"]') }); } }, { alert() {} },
    );
    document.querySelector('#previous').focus();
    onboarding.show(); onboarding.show();
  });
  await page.locator('.onboarding-a-overlay.visible').waitFor();
  await page.waitForFunction(() => document.querySelector('.onboarding-a-overlay').getAnimations({ subtree: true }).every(animation => animation.playState === 'finished'));
}

async function fits(context) {
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.onboarding-a-card button, .onboarding-a-signin-title, .onboarding-a-signin-subtitle')]
    .filter(element => element.checkVisibility()).filter(element => {
      const box = element.getBoundingClientRect();
      return box.left < 0 || box.right > innerWidth || element.scrollWidth > element.clientWidth + 1;
    }).map(element => element.textContent));
  assert.deepEqual(overflow, [], context);
}

try {
  for (const language of ['en', 'zh-cn']) {
    for (const theme of ['light', 'dark']) {
      for (const width of [1440, 720, 420, 320, 280]) {
        await show(language, theme, width, width <= 420 ? 480 : 900);
        assert.equal(await page.locator('[role="dialog"]').count(), 1);
        assert.equal(await page.locator('.onboarding-a-signin-title').textContent(), language === 'en' ? 'Welcome to SteamHarness Studio' : '欢迎使用 SteamHarness Studio');
        assert.doesNotMatch(await page.locator('[role="dialog"]').textContent(), /GitHub|Copilot|Google|Apple|GHE/);
        assert.equal(await page.locator('.onboarding-a-signin-brand-icon').evaluate(image => image.complete && image.naturalWidth > 0), true);
        await fits(`${language} ${theme} ${width}: sign-in`);
        const primaryFits = await page.locator('.onboarding-a-signin-actions button').evaluate(element => {
          const action = element.getBoundingClientRect(), body = element.closest('.onboarding-a-body').getBoundingClientRect();
          return action.top >= body.top && action.bottom <= body.bottom;
        });
        assert.equal(primaryFits, true, `${language} ${theme} ${width}: primary sign-in must be visible`);
        const selected = await page.locator('.onboarding-a-signin-title').evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element); getSelection().removeAllRanges(); getSelection().addRange(range);
          return getComputedStyle(element).userSelect !== 'none' && getSelection().toString() === element.textContent;
        });
        assert.equal(selected, true);
        await page.evaluate(() => getSelection().removeAllRanges());
        if (width === 1440 || width === 420) { await page.screenshot({ path: new URL(`${language}-${theme}-${width}.png`, output).pathname }); }
        const next = page.locator('.onboarding-a-footer-right button:last-child');
        await next.click();
        await fits(`${language} ${theme} ${width}: personalize`);
        await page.locator('.onboarding-a-footer-right button:first-child').click();
        await next.click();
        await page.locator('.onboarding-a-signin-nudge-btn').click();
        assert.deepEqual(await page.evaluate(() => calls), [{ id: 'studio.openAccount', modal: false }]);
        assert.equal(await page.locator('[role="dialog"]').count(), 0);
        checks.push(`${language} ${theme} ${width}: brand, copy selection, layout, skip/back and account handoff`);
      }
    }
  }
  await show('de', 'light', 960, 800);
  assert.equal(await page.locator('.onboarding-a-signin-title').textContent(), 'Welcome to SteamHarness Studio');
  await page.locator('.onboarding-a-signin-actions button').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('.onboarding-a-close-btn').evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('.onboarding-a-footer-right button:last-child').evaluate(element => document.activeElement === element), true);
  await page.evaluate(() => setSignedIn(true));
  assert.equal(await page.locator('.onboarding-a-signin-actions button').count(), 0);
  await page.evaluate(() => setSignedIn(false));
  assert.equal(await page.locator('.onboarding-a-signin-actions button').count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#previous').evaluate(element => document.activeElement === element), true);
  checks.push('English fallback, live session restoration/sign-out, keyboard focus trap, Escape and focus restoration');
  assert.deepEqual(errors, []);
  await writeFile(new URL('proof.json', output), JSON.stringify({ checks, errors }, null, 2));
  console.log(`${checks.length} offline headless onboarding scenarios passed.`);
} finally { await browser.close(); }
