import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflowRoot = process.env.STUDIO_WORKFLOW_SOURCE || path.resolve(root, '..');
const conversationProject = process.env.STUDIO_CONVERSATION_PROJECT_DIR;
assert.ok(conversationProject && path.isAbsolute(conversationProject), 'STUDIO_CONVERSATION_PROJECT_DIR must point to a conversation project configured for the dev server.');
const env = parseEnv(await fs.readFile(path.join(workflowRoot, 'server/.env'), 'utf8'));
assert.ok(env.WORKFLOW_BOOTSTRAP_ADMIN_EMAIL && env.WORKFLOW_BOOTSTRAP_ADMIN_PASSWORD, 'Dev server test credentials are required.');
const serverUrl = `http://localhost:${env.WORKFLOW_SERVER_PORT || '7126'}`;
assert.ok((await fetch(`${serverUrl}/health`)).ok, 'Dev server must be online.');
const proofDir = path.join(root, '.studio/conversation-server-migration');
await fs.mkdir(proofDir, { recursive: true });
const dataDir = await fs.mkdtemp('/tmp/studio-conversation-server-');
await fs.mkdir(path.join(dataDir, 'User'), { recursive: true });
await fs.writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Light Modern', 'git.openRepositoryInParentFolders': 'never' }));
const freePort = createServer(); await new Promise((resolve) => freePort.listen(0, '127.0.0.1', resolve));
const port = freePort.address().port; await new Promise((resolve) => freePort.close(resolve));
const log = await fs.open(path.join(proofDir, 'electron.log'), 'w');
const desktop = await desktopLocaleLaunch('zh-cn', dataDir);
const child = spawn(desktop.executable, [...desktop.args,
  '--user-data-dir', dataDir, '--extensions-dir', path.join(root, '.studio/desktop-extensions'),
  '--locale=zh-cn', '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes',
  `--remote-debugging-port=${port}`, conversationProject,
], { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proof = { serverUrl, checks: {}, errors: [] };
let browser; let page; let loggedIn = false;
async function frameFor(selector) {
  for (let attempt = 0; attempt < 150; attempt++) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !await frame.locator(selector).first().isVisible().catch(() => false)) { continue; }
      let current = frame; let visible = true;
      while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
      if (visible) { return frame; }
    }
    await pause(100);
  }
  throw new Error(`Frame unavailable: ${selector}`);
}
async function command(name) { await page.keyboard.press('F1'); const input = page.locator('.quick-input-widget input'); await input.fill(`>${name}`); await pause(200); await input.press('Enter'); }
async function ready(frame) { await frame.locator('#parameters[aria-busy=false]').waitFor({ state: 'attached', timeout: 45000 }); }
async function conversation() {
  await page.getByRole('tab', { name: '\u5bf9\u8bdd\u52a9\u624b', exact: true }).click();
  const frame = await frameFor('#message'); await ready(frame); return frame;
}
async function account() { await command('Workflow: \u767b\u5f55\u4e0e\u7ba1\u7406\u8d26\u53f7'); return frameFor('#account-app'); }
async function credentials(frame, password) {
  await frame.locator('#server-url').fill(serverUrl);
  // Evaluate avoids including credential values in Playwright locator error logs.
  await frame.locator('#login-email').evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, env.WORKFLOW_BOOTSTRAP_ADMIN_EMAIL);
  await frame.locator('#login-password').evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, password);
  await frame.locator('#login-submit').click();
}
async function send(frame, text) {
  const count = await frame.locator('.assistant').count();
  await frame.locator('#message').fill(text); await frame.locator('#send').click();
  await frame.waitForFunction((count) => document.querySelectorAll('.assistant').length > count, count);
  await frame.locator('#app[data-run-state=idle]').waitFor({ timeout: 180000 });
  assert.equal(await frame.locator('.assistant .message-error').last().isVisible(), false);
  return frame.locator('.assistant .message-content').last().innerText();
}

try {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch { /* Wait for Electron's debug endpoint. */ }
    if (child.exitCode !== null) { throw new Error('Studio exited before startup.'); } await pause(100);
  }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(15000); page.on('pageerror', (error) => proof.errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 1000 });
  const run = page.locator('.part.titlebar .studio-workflow-run').getByRole('button', { name: '\u8fd0\u884c\u9879\u76ee', exact: true });
  await run.waitFor({ timeout: 45000 }); await run.click(); let frame = await frameFor('#message'); await ready(frame);
  await frame.locator('#message').fill('Preserve this draft through login');
  let profile = await account(); await profile.locator('#login-form').waitFor();
  await credentials(profile, 'studio-test-incorrect-password'); await profile.locator('#account-error').waitFor();
  assert.equal(await profile.locator('#profile').isVisible(), false); assert.equal(await profile.locator('#login-password').inputValue(), '');
  proof.checks.invalidPasswordRejected = true;
  await credentials(profile, env.WORKFLOW_BOOTSTRAP_ADMIN_PASSWORD); await profile.locator('#account-status.connected').waitFor({ timeout: 45000 }); loggedIn = true;
  assert.equal(await profile.locator('#login-password').inputValue(), '');
  await page.locator('.part.activitybar .accounts-avatar').waitFor();
  await page.waitForFunction(() => document.querySelector('.part.activitybar .accounts-avatar')?.naturalWidth > 0);
  const avatar = await page.locator('.part.activitybar .accounts-avatar').evaluate((image) => ({ y: image.getBoundingClientRect().bottom, width: image.naturalWidth }));
  const settingsTop = await page.locator('.part.activitybar .codicon-settings-view-bar-icon').first().evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(avatar.width > 0 && avatar.y <= settingsTop);
  proof.checks.verifiedLoginAndAvatarAboveSettings = true;
  console.log('Dev login and avatar verified.');

  frame = await conversation(); assert.equal(await frame.locator('#message').inputValue(), 'Preserve this draft through login');
  await frame.locator('[data-action-id=ai]:not(:disabled)').waitFor({ timeout: 45000 }); await ready(frame);
  await frame.locator('[data-action-id=ai]').click(); await frame.locator('.quick-param-row[data-param=provider]').click();
  proof.catalog = { providers: await frame.getByRole('option').count() }; assert.ok(proof.catalog.providers > 0);
  await frame.getByRole('option').first().click(); await ready(frame); await frame.locator('.quick-param-row[data-param=model]').click();
  const options = frame.locator('.quick-option-copy > span'); const models = await options.allTextContents(); proof.catalog.models = models.length; assert.ok(models.length > 0);
  const model = models.find((name) => /gpt-4\.1-mini|gpt-4o-mini|gpt-5-mini|haiku|flash/i.test(name)) ?? models[0];
  await frame.getByRole('option').filter({ has: frame.getByText(model, { exact: true }) }).click(); await ready(frame);
  const modelSummary = await frame.locator('[data-action-id=ai]').innerText();
  await frame.locator('#conversation-title').click();
  await frame.locator('[data-action-id=generation]').click(); await frame.locator('#param-temperature').fill('0.35'); await frame.locator('#param-temperature').press('Tab'); await ready(frame);
  await frame.getByRole('button', { name: '\u5173\u95ed\u53c2\u6570', exact: true }).click();
  proof.checks.draftPreservedAndAuthenticatedParameters = true;
  const first = await send(frame, '\u8bf7\u4ec5\u56de\u590d\uff1a\u8fc1\u79fb\u8054\u52a8\u9a8c\u8bc1\u7801 MIGRATION-724\u3002'); assert.match(first, /MIGRATION-724/);
  const second = await send(frame, '\u4e0a\u4e00\u6761\u6d88\u606f\u91cc\u7684\u9a8c\u8bc1\u7801\u662f\u4ec0\u4e48\uff1f\u8bf7\u53ea\u56de\u590d\u9a8c\u8bc1\u7801\u3002'); assert.match(second, /MIGRATION-724/);
  proof.checks.twoRealRepliesAndConversationContext = true; console.log('Two real dev model replies verified.');
  await frame.locator('#usage').click(); await frame.getByRole('button', { name: '\u5237\u65b0\u7528\u91cf', exact: true }).waitFor();
  await frame.waitForFunction(() => document.querySelector('.conversation-dialog .dialog-body').textContent.includes('\u8d26\u6237\u4f59\u989d'));
  await frame.getByRole('button', { name: '\u5237\u65b0\u7528\u91cf', exact: true }).click();
  await frame.waitForFunction(() => document.querySelector('.conversation-dialog .dialog-body').textContent.includes('\u8d26\u6237\u4f59\u989d'));
  await frame.locator('.conversation-dialog[open] header button').last().click(); proof.checks.systemAiUsageAndRefresh = true;
  await page.screenshot({ path: path.join(proofDir, 'dev-conversation.png') });
  if (await page.locator('.part.sidebar').isVisible()) { await command('View: Toggle Primary Side Bar Visibility'); }
  if (await page.locator('.part.auxiliarybar').isVisible()) { await command('View: Toggle Secondary Side Bar Visibility'); }
  proof.layouts = [];
  for (const width of [1440, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await pause(200);
    if (await frame.locator('#menu-toggle').isVisible()) { await frame.locator('#menu-toggle').click(); }
    const editorWidth = await frame.evaluate(() => window.innerWidth);
    for (const id of ['new', 'usage', 'tools']) { assert.equal(await frame.locator(`.toolbar-actions #${id}`).isVisible(), true); }
    assert.equal(await frame.locator('#project-info').isVisible(), true);
    assert.equal(await frame.locator('#source').count(), 0);
    const headers = await frame.locator('.assistant .message-header').evaluateAll((headers) => headers.map((header) => {
      const metadata = header.querySelector('.message-metadata').getBoundingClientRect(); const date = header.querySelector('.message-date').getBoundingClientRect(); const box = header.getBoundingClientRect();
      return { gap: date.left - metadata.right, dateRightOffset: Math.abs(box.right - date.right) };
    }));
    assert.ok(headers.every((header) => header.gap >= 7 && header.dateRightOffset <= 1));
    await page.screenshot({ path: path.join(proofDir, `dev-conversation-${width}.png`) });
    await frame.locator('#tools').click(); await frame.locator('.permissions-table').waitFor();
    const table = await frame.locator('.permissions-table').evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: window.innerWidth }; });
    assert.ok(table.left >= 0 && table.right <= table.width); await frame.locator('.conversation-dialog[open] header button').last().click();
    await frame.locator('#hide-menu').click();
    for (const id of ['usage', 'tools']) { assert.equal(await frame.locator(`.toolbar-actions #${id}`).isVisible(), true); }
    assert.equal(await frame.locator('#menu-toggle').isVisible(), true);
    proof.layouts.push({ width, editorWidth });
  }
  proof.checks.usageAndToolsRemainAccessibleAcrossWideAndCompactLayouts = true;
  proof.checks.realModelMetadataAndMessageDatesNeverOverlap = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await frame.locator('#message').fill('Draft restored after window reload'); await pause(500);
  await command('Developer: Reload Window'); await pause(2000); frame = await frameFor('#message'); await ready(frame);
  await frame.locator('[data-action-id=ai]:not(:disabled)').waitFor({ timeout: 45000 }); await ready(frame);
  assert.equal(await frame.locator('#message').inputValue(), 'Draft restored after window reload');
  assert.equal(await frame.locator('[data-action-id=ai]').innerText(), modelSummary);
  assert.match(await frame.locator('.assistant .message-content').last().innerText(), /MIGRATION-724/);
  await frame.locator('[data-action-id=generation]').click(); assert.equal(await frame.locator('#param-temperature').inputValue(), '0.35');
  await frame.getByRole('button', { name: '\u5173\u95ed\u53c2\u6570', exact: true }).click(); proof.checks.automaticTabLoginHistoryDraftAndParametersRestored = true;
  profile = await account(); await profile.locator('#account-status.connected').waitFor({ timeout: 45000 });
  await profile.locator('#verify-login').click(); await profile.locator('#account-status.connected').waitFor({ timeout: 45000 }); proof.checks.manualCredentialVerification = true;
  await page.screenshot({ path: path.join(proofDir, 'dev-account.png') });
  await profile.locator('#logout').click(); await profile.locator('#login-form').waitFor({ timeout: 45000 }); loggedIn = false;
  frame = await conversation(); await ready(frame); await frame.locator('#parameter-login').waitFor();
  assert.equal(await frame.locator('#message').inputValue(), 'Draft restored after window reload');
  proof.checks.logoutDisconnectsParametersAndKeepsDraft = true; assert.deepEqual(proof.errors, []);
} catch (error) {
  proof.failure = error.message; if (page) { await page.screenshot({ path: path.join(proofDir, 'failure.png') }).catch(() => undefined); } process.exitCode = 1;
} finally {
  if (loggedIn && page) {
    try { const profile = await account(); await profile.locator('#logout').click(); await profile.locator('#login-form').waitFor(); }
    catch { proof.cleanupError = 'Unable to revoke the test session in the UI.'; process.exitCode = 1; }
  }
  await fs.writeFile(path.join(proofDir, 'verification.json'), JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof));
  await browser?.close(); child.kill('SIGTERM'); await Promise.race([exited, pause(5000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  await log.close(); await fs.rm(dataDir, { recursive: true, force: true });
}
