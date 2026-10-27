import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const studio = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.dirname(studio);
const cli = path.join(workspace, 'cli');
const web = path.join(cli, 'dist/web');
const proofDir = path.join(studio, '.studio/quick-parameters');
const { inspectLocalProjectStructure } = await import(pathToFileURL(path.join(workspace, 'harness/dist/index.js')).href);
const report = inspectLocalProjectStructure({ projectDir: path.join(workspace, 'build-in/build-in-developer-assistant') });
assert.deepEqual(report.diagnostics.violations, []);
assert.equal(report.params.some(field => field.name === 'contextWindow'), false);
const bundled = await build({ entryPoints: [path.join(cli, 'src/web/ui/parameter-actions.ts')], bundle: true,
  platform: 'browser', format: 'esm', write: false });
const script = bundled.outputFiles[0].text + `
  const parameters = ${JSON.stringify({ fields: report.params, paramLayout: report.paramLayout })};
  const state = { values: { model: 'long', provider: 'fixture', effort: 'high', permissionPolicy: '' }, states: {
    model: { resolvedOptions: [{ value: 'long', label: 'MiniMax-M3.1-Flash-Preview' }, { value: 'short', label: 'Short' }] },
    provider: { resolvedOptions: [{ value: 'fixture', label: 'Fixture' }] }
  }, disabled: false, loading: false };
  parameters.fields.find(field => field.name === 'permissionPolicy').userSettingValue = 'auto';
  const openedSettings = [];
  const controls = new ParameterActions(document.querySelector('#parameter-actions'), { current: () => state,
    onOpenUserSetting(key) { openedSettings.push(key); },
    fieldRoot() { throw new Error('Only Quick parameters are expected.'); },
    onChange(name, value) { state.values[name] = value; controls.update(); },
    onReset(names) { for (const name of names) { state.values[name] = parameters.fields.find(field => field.name === name).defaultValue ?? ''; } controls.update(); }
  });
  controls.render(parameters);
  window.quick = { controls, state, parameters, openedSettings };
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/codicons/codicon.css"><link rel="stylesheet" href="/workflow-ui.css">
  <style>:root { --vscode-editor-background: #fff; --vscode-editor-foreground: #202124; --vscode-font-family: system-ui;
    --vscode-descriptionForeground: #747474; --vscode-panel-border: #ddd; --vscode-textLink-foreground: #006bc2;
    --vscode-toolbar-hoverBackground: #eee; } main { width: 100%; max-width: 760px; height: 100vh; margin: 0 auto; padding: 12px; justify-content: flex-end; }
  </style></head><body><main><section class="composer"><textarea rows="2" placeholder="Write anything"></textarea>
  <div class="composer-toolbar"><div class="run-options"><button class="icon-button" aria-label="Add attachment"><span class="codicon codicon-attach"></span></button>
  <div id="parameter-actions" class="parameter-actions"></div></div><div class="composer-actions"><button class="send-button" aria-label="Send"><span class="codicon codicon-arrow-up"></span></button></div></div>
  </section></main><script type="module" src="/quick-ui.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (pathname === '/quick-ui.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); return; }
    const file = path.resolve(web, '.' + pathname);
    if (!file.startsWith(web + path.sep)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'font/ttf');
    response.end(await fs.readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await fs.mkdir(proofDir, { recursive: true });
let browser;
const errors = [];
const proof = [];
try {
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  page.on('pageerror', error => errors.push(error.message));
  const assertPermissionMenu = async () => {
    assert.deepEqual(await page.locator('.quick-option-copy > span').allTextContents(), ['Read only', 'Workspace', 'Auto approve']);
    assert.equal(await page.locator('.quick-param-row, .quick-detail-heading, .quick-detail').count(), 0);
    assert.equal(await page.locator('.quick-panel').count(), 1);
    const options = await page.locator('.quick-options-list').evaluate(list => {
      const bounds = list.getBoundingClientRect();
      return { bounds: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
        rows: [...list.children].map(option => {
          const box = option.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
        }) };
    });
    assert.ok(options.rows.every(row => row.top >= options.bounds.top - 1 && row.bottom <= options.bounds.bottom + 1
      && row.left >= options.bounds.left - 1 && row.right <= options.bounds.right + 1), JSON.stringify(options));
  };
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.quick && [...document.querySelectorAll('.param-action')].every(button => button.dataset.iconOnly === 'false'));
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.param-action').count(), 2);
  assert.equal(await page.locator('[data-action-id=ai] .codicon-sparkle').count(), 1);
  assert.equal(await page.locator('[data-action-id=permission] .codicon-shield').count(), 1);
  assert.equal(await page.locator('.param-action .codicon-chevron-up').count(), 0);
  assert.equal(await page.locator('[data-action-id=permission]').innerText(), 'Auto approve');
  assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.family === 'codicon' && font.status === 'loaded')), true);
  assert.equal(await page.locator('.param-action > .codicon').evaluateAll(icons => icons.every(icon => {
    const glyph = getComputedStyle(icon, '::before');
    return glyph.content !== 'none' && glyph.content !== 'normal' && glyph.fontFamily === 'codicon';
  })), true);
  await page.screenshot({ path: path.join(proofDir, 'desktop.png') });
  await page.locator('[data-action-id=permission]').click();
  assert.equal(await page.locator('#parameter-popover').isHidden(), true);
  assert.deepEqual(await page.evaluate(() => window.quick.openedSettings), ['agent.permissionPolicy']);
  await page.evaluate(() => {
    const { controls, state, parameters } = window.quick;
    const field = parameters.fields.find(field => field.name === 'permissionPolicy');
    field.userSettingValue = 'read-only'; controls.render(parameters);
    if (!document.querySelector('[data-action-id=permission]').title.includes('Read only')) throw new Error('Fixed setting did not refresh');
    field.userSetting = { key: 'agent.permissionPolicy', mode: 'default' }; field.userSettingValue = 'auto';
    state.values.permissionPolicy = ''; controls.render(parameters);
  });
  proof.push('Assistant follows the user setting, shows one concrete value, opens user settings directly and refreshes after a settings change.');
  await page.locator('[data-action-id=permission]').click();
  await assertPermissionMenu();
  assert.equal(await page.locator('[role=option][aria-selected=true]').count(), 1);
  assert.equal(await page.locator('[role=option][aria-selected=true] .quick-option-copy > span').innerText(), 'Auto approve');
  assert.equal(await page.locator('[role=option][aria-selected=true]').evaluate(option => document.activeElement === option), true);
  assert.ok((await page.locator('#parameter-popover').boundingBox()).width <= 292);
  await page.screenshot({ path: path.join(proofDir, 'permission-desktop.png') });
  await page.getByRole('option', { name: 'Read only', exact: false }).click();
  assert.equal(await page.locator('#parameter-popover').isHidden(), true);
  assert.equal(await page.locator('[data-action-id=permission]').getAttribute('title'), 'Permission: Read only');
  assert.equal(await page.locator('[data-action-id=permission]').evaluate(button => document.activeElement === button), true);
  await page.locator('[data-action-id=permission]').click();
  await page.locator('.quick-reset').click();
  assert.equal(await page.locator('[role=option][aria-selected=true] .quick-option-copy > span').innerText(), 'Auto approve');
  assert.equal(await page.locator('.quick-param-row, .quick-detail-heading').count(), 0);
  await page.keyboard.press('Escape');
  proof.push('Desktop Permission opens all three choices directly, highlights the current choice, closes after selection, restores focus, and resets without a submenu.');
  const expanded = await page.locator('#parameter-actions').evaluate(container => {
    const [ai, permission] = container.children;
    return { chrome: document.querySelector('main').getBoundingClientRect().width - container.clientWidth,
      ai: ai.getBoundingClientRect().width, permission: permission.getBoundingClientRect().width };
  });
  const middleWidth = expanded.chrome + expanded.ai + 4 + (32 + expanded.permission) / 2;
  await page.evaluate(width => { document.querySelector('main').style.width = width + 'px'; }, middleWidth);
  await page.waitForFunction(() => document.querySelector('[data-action-id=ai]').dataset.iconOnly === 'false'
    && document.querySelector('[data-action-id=permission]').dataset.iconOnly === 'true');
  await page.screenshot({ path: path.join(proofDir, 'right-icon.png') });
  proof.push('Rightmost Quick text collapses first while AI keeps its selected values.');
  await page.evaluate(() => { document.querySelector('main').style.width = ''; });
  for (const width of [390, 320, 240]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForFunction(() => document.querySelector('[data-action-id=permission]').dataset.iconOnly === 'true');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.locator('.composer-toolbar').evaluate(toolbar => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      groups: [...toolbar.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, children: [...button.children].filter(child => child.getClientRects().length).map(child => {
          const rect = child.getBoundingClientRect(); return { left: rect.left, right: rect.right };
        }) };
      }) }));
    assert.ok(bounds.document <= bounds.viewport, JSON.stringify(bounds));
    assert.ok(bounds.groups.every(button => button.left >= 0 && button.right <= width
      && button.children.every(child => child.left >= button.left && child.right <= button.right + 1)), JSON.stringify(bounds));
    assert.ok(bounds.groups.every((button, index) => index === 0 || bounds.groups[index - 1].right <= button.left + 1), JSON.stringify(bounds));
    await page.screenshot({ path: path.join(proofDir, `narrow-${width}.png`) });
    proof.push(`${width}px: controls fit and remain separated from the send button.`);
  }
  assert.equal(await page.locator('[data-action-id=ai]').getAttribute('data-icon-only'), 'true');
  await page.locator('[data-action-id=permission]').click();
  await assertPermissionMenu();
  const popup = await page.locator('#parameter-popover').boundingBox();
  assert.ok(popup.x >= 0 && popup.x + popup.width <= 240);
  await page.screenshot({ path: path.join(proofDir, 'permission-narrow.png') });
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[role=option]').nth(1).evaluate(option => document.activeElement === option), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#parameter-popover').isHidden(), true);
  assert.equal(await page.locator('[data-action-id=permission]').getAttribute('title'), 'Permission: Workspace');
  await page.locator('[data-action-id=ai]').click();
  assert.ok(await page.locator('.quick-param-row').count() > 1);
  assert.equal(await page.locator('[role=option]').count(), 0);
  await page.locator('.quick-param-row[data-param=model]').click();
  await page.getByRole('option', { name: 'Short', exact: true }).click();
  assert.match(await page.locator('[data-action-id=ai]').getAttribute('aria-label'), /Short/);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.waitForFunction(() => [...document.querySelectorAll('.param-action')].every(button => button.dataset.iconOnly === 'false'));
  assert.match(await page.locator('[data-action-id=ai]').innerText(), /Short/);
  assert.equal(await page.locator('[data-action-id=permission]').innerText(), 'Workspace');
  proof.push('Collapsed icons still select values, preserve tooltips, and restore text at desktop width.');
  proof.push('Narrow Permission opens direct choices and supports keyboard selection; multi-parameter AI retains its layered menu.');
  for (const language of ['en', 'zh-CN']) {
    for (const theme of ['light', 'dark']) {
      for (const width of [1280, 640, 360, 280]) {
        await page.setViewportSize({ width, height: 700 });
        await page.goto(`http://127.0.0.1:${server.address().port}/?projectLocale=${language}`);
        await page.waitForFunction(() => !!window.quick);
        await page.evaluate(theme => {
          const root = document.documentElement;
          root.style.setProperty('--vscode-editor-background', theme === 'dark' ? '#202124' : '#fff');
          root.style.setProperty('--vscode-editor-foreground', theme === 'dark' ? '#eee' : '#202124');
          root.style.setProperty('--vscode-toolbar-hoverBackground', theme === 'dark' ? '#383a3e' : '#eee');
          const { state, controls } = window.quick;
          state.values.permissionPolicy = 'workspace'; state.disabled = true; state.loading = true; controls.update();
        }, theme);
        const trigger = page.locator('[data-action-id=permission]');
        assert.match(await trigger.getAttribute('title'), /Auto approve/);
        assert.ok((await trigger.getAttribute('title')).includes(language === 'en' ? 'Change in user settings' : '在用户设置中修改'));
        assert.equal(await trigger.isEnabled(), true);
        await trigger.press('Enter');
        assert.deepEqual(await page.evaluate(() => window.quick.openedSettings), ['agent.permissionPolicy']);
        assert.equal(await page.locator('#parameter-popover').isHidden(), true);
        await page.evaluate(() => {
          const { state, controls, parameters } = window.quick;
          state.disabled = false; state.loading = false; state.values.permissionPolicy = '';
          const field = parameters.fields.find(field => field.name === 'permissionPolicy');
          field.userSetting.mode = 'default'; field.userSettingValue = 'read-only'; controls.render(parameters);
        });
        await trigger.click(); await assertPermissionMenu();
        assert.equal(await page.locator('[role=option][aria-selected=true] .quick-option-copy > span').innerText(), 'Read only');
        await page.getByRole('option', { name: 'Workspace', exact: false }).click();
        await page.evaluate(() => {
          const { controls, parameters } = window.quick;
          parameters.fields.find(field => field.name === 'permissionPolicy').userSettingValue = 'auto'; controls.update();
        });
        assert.match(await trigger.getAttribute('title'), /Workspace/);
        await trigger.click();
        assert.equal(await page.locator('.quick-reset').innerText(), language === 'en' ? 'Reset to user settings' : '恢复用户设置');
        await page.locator('.quick-reset').click();
        assert.equal(await page.evaluate(() => window.quick.state.values.permissionPolicy), '');
        assert.equal(await page.locator('[role=option][aria-selected=true] .quick-option-copy > span').innerText(), 'Auto approve');
        await page.screenshot({ path: path.join(proofDir, `binding-${language}-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        proof.push(`${language}/${theme}/${width}px: fixed policies open settings by keyboard; editable defaults retain three choices, preserve overrides, and reset to the latest user policy.`);
      }
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(proofDir, 'proof.json'), JSON.stringify({ proof, errors }, null, 2));
  console.log(JSON.stringify({ proof, errors, proofDir }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
