import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const language = process.argv[2] || 'en';
const catalog = JSON.parse(await readFile(path.join(root, 'extensions/studio-workstation', language.startsWith('zh') ? 'package.nls.zh-cn.json' : 'package.nls.json'), 'utf8'));
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-connection-ui-')));
const proofDir = path.join(root, '.studio/connection-stability', language);
await mkdir(proofDir, { recursive: true });
const counts = { me: 0, kv: 0, knowledge: 0, avatar: 0 };
let delay = 0, unauthorized = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (request, response) => {
  const address = new URL(request.url, 'http://localhost');
  const send = data => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ errCode: 0, data })); };
  if (address.pathname === '/api/auth/login') { request.resume(); send({ authenticated: true, accessToken: 'connection-test-token', apiKey: { id: 'connection-test-key' } }); return; }
  if (request.headers.authorization !== 'Bearer connection-test-token' || unauthorized) {
    response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ errCode: 401 })); return;
  }
  if (address.pathname === '/api/auth/me') {
    counts.me++; await pause(delay);
    send({ profile: { userId: 'connection-user', email: 'connection@example.test', displayName: 'Connection Test', avatarUrl: 'https://studio-avatar.test/avatar.png' },
      principal: { apiKeyId: 'connection-test-key', expiresAt: '2099-01-01T00:00:00Z' } }); return;
  }
  if (address.pathname.endsWith('/kv/entry')) { send({ key: 'remote.state', scope: 'project', value: { stable: true } }); return; }
  if (address.pathname.endsWith('/kv')) {
    counts.kv++; send({ items: [{ key: 'remote.state', scope: 'project', valuePreview: 'stable', valueType: 'object' }], total: 1, hasMore: false }); return;
  }
  if (address.pathname.endsWith('/knowledge-documents/stable-document')) { send({ id: 'stable-document', title: 'Remote document', markdown: '# Stable content' }); return; }
  if (address.pathname.endsWith('/knowledge-documents')) {
    counts.knowledge++; send({ items: [{ id: 'stable-document', title: 'Remote document', markdownPreview: 'Stable content' }], total: 1, hasMore: false }); return;
  }
  if (address.pathname === '/api/ai/usage') { send({ balance: 0, groups: [] }); return; }
  if (address.pathname === '/api/auth/logout') { request.resume(); send({}); return; }
  response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ errCode: 404 }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;
const project = path.join(directory, 'conversation');
const original = path.join(root, 'examples/conversation');
await cp(original, project, { recursive: true, filter: entry => !entry.split(path.sep).includes('node_modules') });
await mkdir(path.join(project, 'node_modules/@steamharness'), { recursive: true });
for (const dependency of ['steamharness', '@steamharness/cli']) {
  await symlink(await realpath(path.join(original, 'node_modules', dependency)), path.join(project, 'node_modules', dependency), 'dir');
}
const manifestPath = path.join(project, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.steamHarness.projectInfo.dataStorage = { mode: 'server' };
const manifestText = JSON.stringify(manifest);
await writeFile(manifestPath, manifestText);
const userData = path.join(directory, 'user');
await mkdir(path.join(userData, 'User'), { recursive: true });
await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({ 'studio.project.serverUrl': serverUrl,
  'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Light Modern', 'git.openRepositoryInParentFolders': 'never' }));
const freePort = createServer(); await new Promise(resolve => freePort.listen(0, '127.0.0.1', resolve));
const port = freePort.address().port; await new Promise(resolve => freePort.close(resolve));
const logPath = path.join(proofDir, 'desktop.log');
const log = await open(logPath, 'w');
const desktop = await desktopLocaleLaunch(language, directory);
const child = spawn(desktop.executable, [...desktop.args, '--user-data-dir', userData, '--extensions-dir', path.join(root, '.studio/desktop-extensions'),
  `--locale=${language}`, '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, project],
{ cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const proof = { language, checks: [], counts, errors: [] };
let browser, page;

async function command(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.bringToFront(); await page.locator('.part.editor .editor-group-container').first().focus(); await page.keyboard.press('F1');
      const input = page.locator('.quick-input-widget input'); await input.fill(`>${name}`, { timeout: 3000 });
      await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: name }) }).first().click({ timeout: 3000 });
      await page.locator('.quick-input-widget').waitFor({ state: 'hidden' }); return;
    } catch (error) { if (attempt === 2) { throw error; } await page.keyboard.press('Escape'); }
  }
}
async function frameFor(selector) {
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !await frame.locator(selector).isVisible().catch(() => false)) { continue; }
      let current = frame, visible = true;
      while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
      if (visible) { return frame; }
    }
    await pause(100);
  }
  throw new Error(`Frame unavailable: ${selector}`);
}
async function watchResources(frame) {
  await frame.evaluate(() => {
    window.connectionStability = { resets: 0, loads: 0 };
    let generation;
    window.addEventListener('message', event => {
      if (event.data.type !== 'resources-state') { return; }
      if (generation !== undefined && generation !== event.data.generation) { window.connectionStability.resets++; }
      generation = event.data.generation;
    });
    const app = document.querySelector('#resources-app');
    new MutationObserver(() => { if (app.dataset.loading === 'true') { window.connectionStability.loads++; } })
      .observe(app, { attributes: true, attributeFilter: ['data-loading'] });
  });
}

try {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch {}
    if (child.exitCode !== null) { throw new Error('Studio exited before startup.'); } await pause(100);
  }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(20_000); page.on('pageerror', error => proof.errors.push(error.message));
  await page.route('https://studio-avatar.test/avatar.png', route => {
    counts.avatar++;
    return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64') });
  });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.locator('.part.titlebar .studio-workflow-run').waitFor({ timeout: 45_000 });
  await command(`SteamHarness: ${catalog['context.signIn']}`);
  const account = await frameFor('#login-app');
  await account.locator('#login-email').fill('connection@example.test'); await account.locator('#login-password').fill('test-password');
  await account.locator('#login-submit').click(); await (await frameFor('#account-app')).locator('#account-status.connected').waitFor();
  await page.waitForFunction(() => document.querySelector('.accounts-avatar')?.naturalWidth > 0);
  await page.evaluate(() => {
    window.avatarStability = { removals: 0 };
    const avatar = document.querySelector('.accounts-avatar');
    new MutationObserver(() => { if (!avatar.getAttribute('src') || avatar.style.display === 'none') { window.avatarStability.removals++; } })
      .observe(avatar, { attributes: true, attributeFilter: ['src', 'style'] });
  });
  await command('Studio: ' + catalog['command.openTerminal']);
  const panel = page.locator('.part.panel');
  await panel.locator('.composite-bar .action-label').filter({ hasText: /^KV$/ }).click();
  const kv = await frameFor('body[data-resource-kind=kv]');
  await kv.locator('.resource-row').filter({ hasText: 'remote.state' }).click();
  await kv.locator('.detail-content').filter({ hasText: '"stable": true' }).waitFor(); await watchResources(kv);
  await panel.locator('.composite-bar .action-label').filter({ hasText: catalog['view.studio.knowledge'] }).click();
  const knowledge = await frameFor('body[data-resource-kind=knowledge]');
  await knowledge.locator('.resource-row').filter({ hasText: 'Remote document' }).click(); await knowledge.locator('.markdown-body').waitFor();
  await knowledge.locator('#detail-edit').click(); await knowledge.locator('#detail-body').fill('Unsaved content survives account checks'); await watchResources(knowledge);
  const before = { ...counts }; delay = 300;
  for (let index = 0; index < 3; index++) {
    await command(`Workflow: ${catalog['command.validateProjectLogin']}`);
    await pause(450);
  }
  await writeFile(manifestPath, manifestText); await pause(1800);
  assert.equal(await knowledge.locator('#detail-body').inputValue(), 'Unsaved content survives account checks');
  assert.deepEqual(await kv.evaluate(() => window.connectionStability), { resets: 0, loads: 0 });
  assert.deepEqual(await knowledge.evaluate(() => window.connectionStability), { resets: 0, loads: 0 });
  assert.deepEqual(await page.evaluate(() => window.avatarStability), { removals: 0 });
  assert.equal(counts.me - before.me, 3); assert.equal(counts.kv, before.kv); assert.equal(counts.knowledge, before.knowledge);
  assert.equal(counts.avatar, before.avatar);
  proof.checks.push('three delayed account checks and an unchanged project rescan preserve the avatar, resource data and unsaved edits without extra requests');
  await page.screenshot({ path: path.join(proofDir, 'stable-panels.png') });
  proof.resizeWarnings = (await readFile(logPath, 'utf8')).match(/ResizeObserver loop/g)?.length ?? 0;
  assert.equal(proof.resizeWarnings, 0, 'Webviews must not continuously emit ResizeObserver loop warnings.');
  unauthorized = true;
  await command(`Workflow: ${catalog['command.validateProjectLogin']}`);
  await page.waitForFunction(() => !document.querySelector('.accounts-avatar')?.getAttribute('src'));
  await knowledge.locator('#resource-login').waitFor();
  proof.checks.push('an actual 401 clears the avatar and exposes sign-in for server resources');
  assert.deepEqual(proof.errors, []);
} catch (error) {
  proof.failure = error.message; process.exitCode = 1;
  await page?.screenshot({ path: path.join(proofDir, 'failed.png') }).catch(() => undefined);
} finally {
  await writeFile(path.join(proofDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
  await browser?.close();
  if (child.exitCode === null) { child.kill('SIGTERM'); }
  await Promise.race([exited, pause(5000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  await log.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
