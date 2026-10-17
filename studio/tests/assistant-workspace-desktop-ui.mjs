import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';
import { createAssistantTestServer } from './assistant-test-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = process.env.STUDIO_STEAMHARNESS_SOURCE || path.resolve(root, '..');
const proofDir = path.join(root, '.studio/assistant-workspace'); await mkdir(proofDir, { recursive: true });
const proof = { checks: [], screenshots: [], errors: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const language of ['en', 'zh-cn']) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-')));
  const dataDir = path.join(directory, 'u'); await mkdir(path.join(dataDir, 'User'), { recursive: true });
  const server = await createAssistantTestServer();
  await writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Light Modern', 'window.autoDetectColorScheme': false,
    'git.openRepositoryInParentFolders': 'never', 'studio.workflow.serverUrl': server.connection.serverUrl }));
  for (const folder of ['A', 'B']) {
    await mkdir(path.join(directory, folder)); await writeFile(path.join(directory, folder, 'scope.txt'), `Contents from ${folder}`);
  }
  const workspacePath = path.join(directory, 'scope.code-workspace');
  await writeFile(workspacePath, JSON.stringify({ folders: ['A', 'B'].map(folder => ({ path: path.join(directory, folder) })) }));
  const runtimeSource = path.join(directory, 'source/build-in/build-in-developer-assistant'); await mkdir(runtimeSource, { recursive: true });
  await cp(path.join(sourceRoot, 'build-in/build-in-developer-assistant/package.json'), path.join(runtimeSource, 'package.json'));
  await symlink(await realpath(path.join(sourceRoot, 'build-in/build-in-developer-assistant/node_modules')), path.join(runtimeSource, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const desktop = await desktopLocaleLaunch(language, directory);
  const template = path.join(directory, 'extensions/studio-workstation/dist/developer-assistant');
  await rm(template, { recursive: true, force: true }); await mkdir(template);
  await writeFile(path.join(template, 'package.json'), JSON.stringify({ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', name: 'Assistant test', type: 'module',
    steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } }));
  await cp(path.join(root, 'tests/fixtures/assistant-workspace/index.ts'), path.join(template, 'index.ts'));
  const helper = path.join(directory, 'test-extension'); await mkdir(helper);
  await cp(path.join(root, 'tests/assistant-workspace-desktop-extension.cjs'), path.join(helper, 'extension.cjs'));
  await writeFile(path.join(helper, 'package.json'), JSON.stringify({ name: 'assistant-workspace-test', publisher: 'studio-test', version: '0.0.1', engines: { vscode: '^1.140.0' },
    main: './extension.cjs', activationEvents: ['onStartupFinished'], contributes: { commands: [
      ...['A', 'B'].map(folder => ({ command: `studio.testFocus${folder}`, title: `Focus folder ${folder}`, category: 'Test' })),
      { command: 'studio.testOpenAccount', title: 'Open account', category: 'Test' },
      { command: 'studio.testReadClipboard', title: 'Read clipboard', category: 'Test' },
      { command: 'studio.testSaveClipboard', title: 'Save clipboard', category: 'Test' },
      { command: 'studio.testRestoreClipboard', title: 'Restore clipboard', category: 'Test' },
      { command: 'studio.testEmptyWorkspace', title: 'Empty workspace', category: 'Test' },
    ] } }));
  const debug = createServer(); await new Promise(resolve => debug.listen(0, '127.0.0.1', resolve));
  const port = debug.address().port; await new Promise(resolve => debug.close(resolve));
  const log = await open(path.join(proofDir, `${language}.log`), 'w');
  const child = spawn(desktop.executable, [...desktop.args, '--extensionDevelopmentPath', helper, '--user-data-dir', dataDir,
    '--extensions-dir', path.join(root, '.studio/desktop-extensions'), `--locale=${language}`, '--disable-workspace-trust',
    '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, workspacePath],
  { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, STUDIO_STEAMHARNESS_SOURCE: path.resolve(runtimeSource, '../..'),
    STUDIO_TEST_SCOPE_ROOT: directory, STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let browser, page, clipboardSaved = false;

  async function command(name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.bringToFront();
        await page.locator('.monaco-workbench').evaluate(element => { element.tabIndex = -1; element.focus(); });
        await page.keyboard.press('F1');
        await page.locator('.quick-input-widget input').fill(`>${name}`, { timeout: 3000 });
        await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first().click({ timeout: 3000 });
        await page.locator('.quick-input-widget').waitFor({ state: 'hidden' }); return;
      } catch (error) { if (attempt === 2) { throw error; } await page.keyboard.press('Escape'); }
    }
  }
  async function frameFor(selector, workdir) {
    for (let attempt = 0; attempt < 300; attempt++) {
      for (const frame of page.frames()) {
        if (frame.isDetached() || !await frame.locator(selector).first().isVisible().catch(() => false)) { continue; }
        if (workdir && await frame.locator('#assistant-folder').getAttribute('title').catch(() => undefined) !== workdir) { continue; }
        let current = frame, visible = true;
        while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
        if (visible) { return frame; }
      } await pause(100);
    } throw new Error(`Frame unavailable: ${selector}`);
  }
  async function assistant(folder) { return frameFor('body[data-surface=assistant] #message', path.join(directory, folder)); }
  async function clipboardText() {
    await rm(path.join(directory, 'clipboard.json'), { force: true }); await command('Test: Read clipboard');
    for (let count = 0; count < 100; count++) { try { return JSON.parse(await readFile(path.join(directory, 'clipboard.json'), 'utf8')); } catch {} await pause(50); }
    throw new Error('Native clipboard read timed out');
  }
  async function send(frame, message) {
    const count = await frame.locator('.message.assistant').count();
    await frame.locator('#message').fill(message); await frame.locator('#send:not(:disabled)').click();
    await frame.waitForFunction(count => document.querySelectorAll('.message.assistant').length > count, count);
    await frame.locator('#app[data-run-state=idle]').waitFor({ timeout: 45_000 });
    assert.equal(await frame.locator('.message-error').last().isVisible(), false);
  }
  async function screenshot(name) { await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }

  try {
    for (let count = 0; count < 300; count++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch {} if (child.exitCode !== null) { throw new Error('Studio exited early'); } await pause(100); }
    await desktop.waitUntilReady(child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    for (let count = 0; count < 100; count++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
    assert.ok(page); page.setDefaultTimeout(25_000); page.on('pageerror', error => proof.errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await command('Test: Save clipboard'); clipboardSaved = true;
    await command('Test: Open account');
    const account = await frameFor('#account-app');
    await account.locator('#server-url').fill(server.connection.serverUrl); await account.locator('#login-email').fill(server.profile.email);
    await account.locator('#login-password').fill('offline-password'); await account.locator('#login-submit').click();
    await account.locator('#display-name').filter({ hasText: server.profile.displayName }).waitFor();
    await command('Test: Focus folder A');
    let frame = await assistant('A'); await frame.locator('#parameters[aria-busy=false]').waitFor({ state: 'attached' });
    await send(frame, 'folder-A');
    const a = path.join(directory, 'A'), b = path.join(directory, 'B');
    const toolProof = JSON.parse(await readFile(path.join(a, 'tool-proof.json'), 'utf8'));
    assert.equal(toolProof.cwd, a); assert.match(toolProof.file, /Contents from A/);
    assert.equal(toolProof.workspace.roots[0].rootPath, a); assert.equal(toolProof.workspace.roots[1].rootPath, b);
    const answer = frame.locator('.message.assistant .message-content').last(); await answer.locator('pre code').waitFor();
    await frame.locator('.message.assistant .copy-message').last().click();
    await frame.locator('.message.assistant .copy-message').last().filter({ has: frame.locator('.codicon-check') }).waitFor();
    const whole = await clipboardText(); assert.match(whole, /Input: folder-A/); assert.match(whole, /```text/);
    await answer.locator('.code-toolbar button').click(); assert.equal((await clipboardText()).trim(), a);
    proof.checks.push(`${language}: actual Core bash/read tools use folder A; message and code copies match the native clipboard`);
    await screenshot(`${language}-desktop.png`);
    await page.setViewportSize({ width: 720, height: 900 });
    const bounds = await frame.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, text: document.body.innerText }));
    assert.ok(bounds.scroll <= bounds.width); assert.match(bounds.text, /folder-A/); await screenshot(`${language}-narrow.png`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await frame.locator('#message').fill('slow'); await frame.locator('#send:not(:disabled)').click();
    await frame.locator('#app[data-run-state=running]').waitFor();
    await command('Test: Focus folder B'); frame = await assistant('B');
    await frame.waitForFunction(() => !document.body.innerText.includes('folder-A'));
    await send(frame, 'folder-B');
    const other = JSON.parse(await readFile(path.join(b, 'tool-proof.json'), 'utf8'));
    assert.equal(other.cwd, b); assert.match(other.file, /Contents from B/);
    await command('Test: Focus folder A'); frame = await assistant('A');
    await frame.locator('.message.assistant .message-content').filter({ hasText: 'Input: folder-A' }).first().waitFor();
    await frame.locator('.message.assistant .copy-message').first().click();
    assert.equal(await clipboardText(), whole, 'Restored history must preserve the exact answer text.');
    assert.doesNotMatch(await frame.locator('#transcript').innerText(), /folder-B/);
    assert.equal(await frame.locator('#app').getAttribute('data-run-state'), 'idle');
    await frame.locator('.message.user .message-content').filter({ hasText: /^slow$/ }).waitFor();
    proof.checks.push(`${language}: switching folders cancels and saves the previous run, isolates histories and restores folder A`);
    await command('Test: Empty workspace');
    const empty = await frameFor('button#assistant-action');
    const label = language === 'en' ? 'Open Folder' : '\u6253\u5f00\u6587\u4ef6\u5939';
    assert.equal(await empty.locator('#assistant-action').innerText(), label); await screenshot(`${language}-empty.png`);
    proof.checks.push(`${language}: closing all folders stops the assistant and shows the localized empty state`);
  } catch (error) {
    if (page) {
      await screenshot(`${language}-failed.png`).catch(() => undefined);
      for (const current of page.frames()) {
        if (!await current.locator('body[data-surface=assistant]').count().catch(() => 0)) { continue; }
        const diagnostic = await current.evaluate(async () => {
          const response = await fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionStorage.getItem('steamharness-web-session')}` }, body: JSON.stringify({ type: 'ready' }) });
          const result = await response.json(); const project = result.messages?.find(message => message.type === 'state')?.project;
          return { project: project && { folderPath: project.folderPath, assistant: project.assistant, fields: project.fields },
            error: document.querySelector('#error')?.textContent, parameters: document.querySelector('#parameters')?.textContent };
        }).catch(failure => ({ error: failure.message }));
        console.error(JSON.stringify(diagnostic));
      }
    } throw error;
  }
  finally {
    if (clipboardSaved && page) { await command('Test: Restore clipboard').catch(() => undefined); }
    await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); }
    await Promise.race([exited, pause(5000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    await log.close(); await server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
assert.deepEqual(proof.errors, []);
await writeFile(path.join(proofDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`); console.log(JSON.stringify(proof));
