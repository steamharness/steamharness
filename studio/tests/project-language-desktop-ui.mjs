import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const names = { en: 'Deltaforce Agent', 'zh-CN': '\u4e09\u89d2\u6d32\u5f3a\u529b\u4ee3\u7406' };
const languages = process.env.STUDIO_TEST_UI_LANGUAGES?.split(',') ?? ['en', 'zh-cn'];
assert.ok(languages.every(language => ['en', 'zh-cn'].includes(language)));
for (const language of languages) { await verify(language); }

async function verify(language) {
  const normalized = language === 'en' ? 'en' : 'zh-CN', expected = names[normalized];
  const proofDir = path.join(root, '.studio/project-language', language);
  await fs.mkdir(proofDir, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pl-')));
  const folder = path.join(directory, 'deltaforce-agent');
  const source = path.join(root, 'tests/fixtures/conversation-features');
  await fs.cp(source, folder, { recursive: true, filter: file => !file.split(path.sep).includes('node_modules') });
  await fs.symlink(path.join(source, 'node_modules'), path.join(folder, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  manifest.id = crypto.randomUUID(); manifest.name = 'deltaforce-agent';
  manifest.steamHarness.projectInfo = { localizedNames: names, dataStorage: { mode: 'local' } };
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify(manifest, null, 2));
  const profile = path.join(directory, 'u'); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Light Modern',
    'window.autoDetectColorScheme': false, 'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never' }));
  const freePort = createServer(); await new Promise(resolve => freePort.listen(0, '127.0.0.1', resolve));
  const port = freePort.address().port; await new Promise(resolve => freePort.close(resolve));
  const nls = JSON.parse(await fs.readFile(path.join(root, 'extensions/studio-workstation',
    language === 'en' ? 'package.nls.json' : 'package.nls.zh-cn.json'), 'utf8'));
  const extension = JSON.parse(await fs.readFile(path.join(root, 'extensions/studio-workstation/package.json'), 'utf8'));
  const panelLabel = id => {
    const title = extension.contributes.viewsContainers.panel.find(panel => panel.id === id).title;
    return title.startsWith('%') ? nls[title.slice(1, -1)] : title;
  };
  // In source mode the Chinese OS/locale request resolves to an English workbench.
  const desktop = await desktopLocaleLaunch(language, directory, { sourceMode: language === 'en' });
  const log = await fs.open(path.join(proofDir, 'desktop.log'), 'w');
  const child = spawn(desktop.executable, [...desktop.args, '--user-data-dir', profile,
    '--extensions-dir', path.join(root, '.studio/desktop-extensions'), '--locale=zh-cn', '--disable-workspace-trust',
    '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, folder],
  { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8',
    STEAMHARNESS_LOCALE: 'zh-CN', STEAMHARNESS_RUNTIME_LOCALE: 'zh-CN', STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' },
    stdio: ['ignore', log.fd, log.fd] });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const proof = { language, name: expected, checks: [], screenshots: [], errors: [] };
  let browser, page;
  const exact = value => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  async function command(name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator('.part.titlebar').click({ position: { x: 200, y: 5 } }); await page.keyboard.press('F1');
      try {
        const input = page.locator('.quick-input-widget input'); await input.waitFor({ timeout: 3000 });
        await input.fill(`>${name}`);
        await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first().click({ timeout: 3000 });
        await page.locator('.quick-input-widget').waitFor({ state: 'hidden' }); return;
      } catch (error) { if (attempt === 2) { throw error; } await page.keyboard.press('Escape'); }
    }
  }
  async function frameFor(selector) {
    for (let attempt = 0; attempt < 450; attempt++) {
      for (const frame of page.frames()) { if (await frame.locator(selector).first().isVisible().catch(() => false)) { return frame; } }
      await pause(100);
    }
    throw new Error(`Frame unavailable: ${selector}`);
  }
  async function screenshot(name) {
    await page.mouse.move(300, 20); await pause(250);
    await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name);
  }
  async function panel(name, selector) {
    const tab = page.locator('.part.panel').getByRole('tab', { name: exact(name) });
    if (!await tab.isVisible()) { await command('View: Toggle Panel Visibility'); }
    await tab.click(); return frameFor(selector);
  }
  try {
    for (let attempt = 0; attempt < 250; attempt++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch {}
      if (child.exitCode !== null) { throw new Error('Studio exited during startup'); } await pause(100);
    }
    await desktop.waitUntilReady(child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(page => page.url().includes('workbench')); if (page) { break; } await pause(100); }
    assert.ok(page); page.setDefaultTimeout(30_000); page.on('pageerror', error => proof.errors.push(error.message));
    await page.bringToFront(); await page.setViewportSize({ width: 1440, height: 1000 });
    const activity = page.locator('.part.activitybar');
    await activity.getByRole('tab', { name: exact('Studio') }).click();
    const project = page.locator('.part.sidebar .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${expected}$`) }) });
    await project.locator('.label-name').click();
    const conversation = await frameFor('body[data-surface=editor] #message');
    await conversation.locator('#conversation-title').filter({ hasText: expected }).waitFor();
    await conversation.locator('#message:not([disabled])').waitFor();
    assert.equal(await conversation.locator('html').getAttribute('lang'), normalized);
    assert.equal(await conversation.locator('#conversation-title').innerText(), expected);
    assert.equal(await conversation.locator('#send').getAttribute('aria-label'), language === 'en' ? 'Send' : '\u53d1\u9001');
    await page.locator('.part.editor .tab.active').filter({ hasText: expected }).waitFor();
    assert.ok((await page.title()).includes(expected));
    assert.ok((await page.locator('.part.statusbar').innerText()).includes(expected));
    proof.checks.push('Tree, editor tab, window title, status bar and Conversation follow the resolved host language');
    await activity.getByRole('tab', { name: exact(nls['container.studio-info']) }).click();
    const info = await frameFor('#info-app');
    await info.locator('[data-field=name] .info-value').filter({ hasText: manifest.name }).waitFor();
    assert.equal(await info.locator('html').getAttribute('lang'), language);
    if (await info.locator('[data-section=names]').getAttribute('open') === null) { await info.locator('[data-section=names] > summary').click(); }
    for (const name of Object.values(names)) { await info.getByText(name, { exact: true }).waitFor(); }
    proof.checks.push('Information preserves the default name and both author-provided localized names');
    for (const [name, selector, select] of [
      ['KV', 'body[data-resource-kind=kv] #resources-app', '#resource-project'],
      [panelLabel('studio-knowledge'), 'body[data-resource-kind=knowledge] #resources-app', '#resource-project'],
      [panelLabel('studio-trace'), '#trace-app', '#trace-project'],
    ]) {
      const frame = await panel(name, selector);
      await frame.locator(`${select} option:checked`).filter({ hasText: expected }).waitFor({ state: 'attached' });
      assert.equal(await frame.locator(`${select} option:checked`).innerText(), expected);
    }
    proof.checks.push('KV, Knowledge and Trace project selectors use the same localized project name');
    await conversation.locator('#message').fill('\u4fdd\u7559\u4e2d\u6587\u7528\u6237\u5185\u5bb9');
    await conversation.locator('#send').click();
    await conversation.locator('.message.assistant:not(.streaming) .message-content').filter({ hasText: '\u4fdd\u7559\u4e2d\u6587\u7528\u6237\u5185\u5bb9' }).waitFor();
    await conversation.locator('#conversation-title').filter({ hasText: '\u4fdd\u7559\u4e2d\u6587\u7528\u6237\u5185\u5bb9' }).waitFor();
    assert.equal(await conversation.locator('#project-name').innerText(), expected);
    assert.equal(await conversation.locator('#conversation-title').innerText(), '\u4fdd\u7559\u4e2d\u6587\u7528\u6237\u5185\u5bb9');
    proof.checks.push('Chinese conversation titles, input and output remain unchanged in either host language');
    await screenshot('desktop.png');
    await page.setViewportSize({ width: 1100, height: 850 }); await screenshot('narrow.png');
    assert.deepEqual(proof.errors, []);
    await fs.writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify(proof));
  } catch (error) { if (page && !page.isClosed()) { await screenshot('failed.png'); } throw error; }
  finally {
    await browser?.close().catch(() => undefined);
    child.kill('SIGTERM'); await Promise.race([exited, pause(10_000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await log.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}
