import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readFile, writeFile, cp, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = path.join(root, 'examples/workflow');
const proofDir = path.join(root, '.studio/workflow-migration');
await mkdir(proofDir, { recursive: true });
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'studio-workflow-desktop-'));
await mkdir(path.join(dataDir, 'User'));
await writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Light Modern', 'git.openRepositoryInParentFolders': 'never' }));
let projectDir = example;
if (process.env.STEAMHARNESS_UI_CLI_ENTRY) {
  projectDir = path.join(dataDir, 'workflow'); await mkdir(projectDir);
  for (const filename of ['package.json', 'index.ts']) { await cp(path.join(example, filename), path.join(projectDir, filename)); }
  await mkdir(path.join(projectDir, 'node_modules/@steamharness'), { recursive: true });
  await symlink(await realpath(path.join(example, 'node_modules/steamharness')), path.join(projectDir, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.resolve(path.dirname(process.env.STEAMHARNESS_UI_CLI_ENTRY), '..'), path.join(projectDir, 'node_modules/@steamharness/cli'), process.platform === 'win32' ? 'junction' : 'dir');
}
const cliVersion = JSON.parse(await readFile(path.join(projectDir, 'node_modules/@steamharness/cli/package.json'), 'utf8')).version;
if (!process.env.STEAMHARNESS_UI_CLI_ENTRY) { assert.equal(cliVersion, JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')).devDependencies['@steamharness/cli']); }
const proof = { cliVersion, checks: [], screenshots: [], errors: [], authenticatedRequests: 0 };
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/auth/login') {
    request.resume(); response.end(JSON.stringify({ errCode: 0, data: { authenticated: true, accessToken: 'offline-desktop-identity', apiKey: { id: 'desktop-key' } } }));
  } else if (request.url === '/api/auth/me') {
    assert.equal(request.headers.authorization, 'Bearer offline-desktop-identity'); proof.authenticatedRequests++;
    response.end(JSON.stringify({ errCode: 0, data: { profile: { userId: 'desktop-user', email: 'desktop@example.com', displayName: 'Workflow Desktop' }, principal: { apiKeyId: 'desktop-key', expiresAt: '2030-01-01T00:00:00Z' } } }));
  } else if (request.url === '/api/ai/usage') { response.end(JSON.stringify({ errCode: 0, data: { balance: 10, groups: [] } })); }
  else if (request.url === '/api/auth/logout') { request.resume(); response.end(JSON.stringify({ errCode: 0, data: {} })); }
  else { response.writeHead(404); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;
const debugServer = createServer(); await new Promise(resolve => debugServer.listen(0, '127.0.0.1', resolve));
const port = debugServer.address().port; await new Promise(resolve => debugServer.close(resolve));
const log = await open(path.join(proofDir, 'desktop.log'), 'w');
const desktop = await desktopLocaleLaunch('zh-cn', dataDir);
const child = spawn(desktop.executable, [...desktop.args,
  '--user-data-dir', dataDir, '--extensions-dir', path.join(root, '.studio/desktop-extensions'),
  '--locale=zh-cn', '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes',
  `--remote-debugging-port=${port}`, projectDir,
], { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, page;
async function frameFor(selector) {
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !await frame.locator(selector).first().isVisible().catch(() => false)) { continue; }
      let current = frame, visible = true;
      while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
      if (visible) { return frame; }
    }
    await pause(100);
  }
  throw new Error(`Frame unavailable: ${selector}`);
}
async function command(name) {
  await page.locator('.part.titlebar').click({ position: { x: 200, y: 5 } });
  await page.keyboard.press('F1'); const input = page.locator('.quick-input-widget input');
  await input.fill(`>${name}`); await pause(200); await input.press('Enter');
}
async function ready(frame) { await frame.locator('#app[data-connection=connected]').waitFor(); }
async function formReady(frame) { await frame.locator('#workflow-form[aria-busy=false]').waitFor(); }
async function screenshot(name) { await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function assertLayout(frame) {
  const bounds = await frame.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
    buttons: [...document.querySelectorAll('.toolbar button, .menu-actions button, .run-heading button')].filter(button => button.getClientRects().length).map(button => {
      const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right };
    }) }));
  assert.ok(bounds.width <= bounds.viewport, JSON.stringify(bounds));
  assert.ok(bounds.buttons.every(button => button.left >= 0 && button.right <= bounds.viewport), JSON.stringify(bounds));
}
try {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch { /* Wait for the Electron debug endpoint. */ }
    if (child.exitCode !== null) { throw new Error('Studio exited before startup.'); } await pause(100);
  }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(20_000); page.on('pageerror', error => proof.errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const runProject = page.locator('.part.titlebar .studio-workflow-run').getByRole('button', { name: '\u8fd0\u884c\u9879\u76ee', exact: true });
  await runProject.waitFor({ timeout: 45_000 }); await runProject.click();
  let frame = await frameFor('#workflow-title'); await ready(frame); await formReady(frame);
  assert.match(frame.url(), /^http:\/\/127\.0\.0\.1:/);
  assert.equal(await frame.locator('.workflow-entry[open]').getAttribute('data-entrypoint'), 'report');
  proof.checks.push('folder detection opens the project-owned CLI page in a native VS Code tab');
  await command('Workflow: \u767b\u5f55\u4e0e\u7ba1\u7406\u8d26\u53f7');
  const account = await frameFor('#account-app'); await account.locator('#server-url').fill(serverUrl);
  await account.locator('#login-email').fill('desktop@example.com'); await account.locator('#login-password').fill('offline-password');
  await account.locator('#login-submit').click(); await account.locator('#display-name').filter({ hasText: 'Workflow Desktop' }).waitFor();
  await page.getByRole('tab', { name: '\u5de5\u4f5c\u6d41\u793a\u4f8b', exact: true }).click();
  frame = await frameFor('#workflow-title'); await ready(frame); await formReady(frame);
  await frame.locator('#web-account').filter({ hasText: 'Workflow Desktop' }).waitFor();
  assert.ok(proof.authenticatedRequests >= 2); proof.checks.push('VS Code login is injected and verified by the project CLI');
  await frame.locator('#input-mode [data-mode=raw]').click();
  await frame.locator('#raw-args').fill('["--subject","Desktop report","--review","true","--delay","5","--rounds","3"]');
  await formReady(frame); await frame.locator('#run').click(); await frame.locator('#app[data-run-state=waiting]').waitFor();
  await frame.locator('#new').click(); await frame.locator('#entrypoints').waitFor(); assert.equal(await frame.locator('#run').isDisabled(), true);
  await frame.locator('#show-active').click(); await frame.locator('.input-prompt').waitFor();
  await command('View: Close Editor'); await runProject.click();
  frame = await frameFor('#workflow-title'); await ready(frame); await frame.locator('.input-prompt').waitFor();
  await frame.locator('#web-account').filter({ hasText: 'Workflow Desktop' }).waitFor();
  assert.match(await frame.locator('#run-meta').innerText(), /\u5df2\u4e2d\u65ad/);
  await frame.getByRole('button', { name: '\u7ee7\u7eed\u8fd0\u884c', exact: true }).click();
  await frame.locator('#app[data-run-state=idle]').waitFor(); assert.equal(await frame.locator('#run-list .session').count(), 1);
  assert.equal(await frame.locator('#run-output h2').count(), 1); assert.match(await frame.locator('#run-meta').innerText(), /\u5df2\u5b8c\u6210/);
  proof.checks.push('history browsing preserves the task slot and closing/reopening retains recoverable input in the same record');
  await screenshot('workflow-desktop-result-light.png');
  await frame.locator('#tab-flow').click(); assert.equal(await frame.locator('.graph-node').filter({ hasText: /^iteration/ }).count(), 3);
  await screenshot('workflow-desktop-flow.png'); await frame.locator('#tab-result').click();
  const settings = JSON.parse(await readFile(path.join(dataDir, 'User/settings.json'), 'utf8'));
  await writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ ...settings, 'workbench.colorTheme': 'Dark Modern' }));
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await frame.locator('#web-account').innerText(), 'Workflow Desktop');
  await screenshot('workflow-desktop-result-dark.png');
  for (const width of [1440, 950, 650]) {
    await page.setViewportSize({ width, height: 1000 }); await pause(200); await assertLayout(frame);
    if (await frame.locator('#hide-menu').isVisible()) { await frame.locator('#hide-menu').click(); }
    assert.equal(await frame.locator('#menu-toggle').isVisible(), true); await assertLayout(frame);
    await screenshot(`workflow-desktop-hidden-${width}.png`); await frame.locator('#menu-toggle').click();
    await frame.locator('#history-toggle').click(); await frame.locator('#search-history').fill('Desktop report');
    await frame.locator('#search-results .session').waitFor(); await frame.locator('#close-history').click();
  }
  proof.checks.push('Dagre runtime instances, wide and narrow views, hidden sidebar, shared search and VS Code theme synchronization');
  await frame.locator('#delete-run').click();
  await frame.locator('.action-dialog[open]').getByRole('button', { name: '\u53d6\u6d88', exact: true }).click();
  assert.equal(await frame.locator('#run-list .session').count(), 1);
  await frame.locator('#delete-run').click();
  await frame.locator('.action-dialog[open]').getByRole('button', { name: '\u5220\u9664', exact: true }).click();
  await frame.waitForFunction(() => document.querySelectorAll('#run-list .session').length === 0);
  proof.checks.push('record deletion uses an embedded confirmation and preserves records when cancelled');
  assert.deepEqual(proof.errors, []); await writeFile(path.join(proofDir, 'desktop-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
} finally {
  await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); }
  await Promise.race([exited, pause(10_000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  await log.close(); await new Promise(resolve => server.close(resolve));
}
