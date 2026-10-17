import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const projectDir = path.join(root, 'examples/workflow');
const cliEntry = process.env.STEAMHARNESS_UI_CLI_ENTRY ?? path.join(projectDir, 'node_modules/@steamharness/cli/dist/index.js');
const data = await mkdtemp(path.join(os.tmpdir(), 'studio-workflow-ui-'));
const proofDir = path.join(root, '.studio/workflow-migration'); await mkdir(proofDir, { recursive: true });
const cliVersion = JSON.parse(await readFile(path.join(path.dirname(cliEntry), '../package.json'), 'utf8')).version;
if (!process.env.STEAMHARNESS_UI_CLI_ENTRY) {
  assert.equal(cliVersion, JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')).devDependencies['@steamharness/cli']);
}
const proof = { cliVersion, checks: [], screenshots: [], errors: [] };
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/auth/me') { response.end(JSON.stringify({ errCode: 0, data: { profile: { userId: 'ui-user', email: 'ui@example.com', displayName: 'Workflow UI' }, principal: { expiresAt: '2030-01-01T00:00:00Z' } } })); }
  else if (request.url === '/api/ai/usage') { response.end(JSON.stringify({ errCode: 0, data: { balance: 10, groups: [] } })); }
  else { response.writeHead(404); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const connection = { serverUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'offline-ui-identity' };
let child, browser, context, page, hostStdio;
async function start(embedded = true) {
  hostStdio = embedded;
  child = spawn(process.execPath, [cliEntry, '--locale', 'zh-CN', 'web', projectDir, '--no-open', '--json', ...(embedded ? ['--host-stdio'] : []), '--data-dir', data], {
    env: { ...process.env, STEAMHARNESS_CLI_AUTH_DIR: path.join(data, 'auth'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (embedded) { child.stdin.write(`${JSON.stringify({ type: 'configure', surface: 'editor', connection })}\n`); }
  let output = '', error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI startup timed out: ${error}`)), 30_000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CLI exited ${code}: ${error}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.type === 'ready') { clearTimeout(timeout); resolve(value); return; } } catch { /* Wait for a complete startup line. */ }
      }
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) { return; }
  const previous = child;
  const exit = new Promise(resolve => previous.once('exit', resolve));
  if (hostStdio) { previous.stdin.end(); } else { previous.kill('SIGTERM'); }
  const timer = setTimeout(() => previous.kill('SIGKILL'), 10_000); await exit; clearTimeout(timer);
}
async function ready() { await page.locator('#app[data-connection=connected]').waitFor(); }
async function formReady() { await page.locator('#workflow-form[aria-busy=false]').waitFor(); await page.locator('#run').waitFor({ state: 'visible' }); }
async function screenshot(name) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function assertLayout() {
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
    buttons: [...document.querySelectorAll('.toolbar button, .menu-actions button, #run, .run-heading button')].filter(button => button.getClientRects().length).map(button => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }) }));
  assert.ok(bounds.width <= bounds.viewport, JSON.stringify(bounds));
  assert.ok(bounds.buttons.every(button => button.left >= 0 && button.right <= bounds.viewport), JSON.stringify(bounds));
}
try {
  let launch = await start(); assert.equal(launch.project.projectType, 'workflow'); assert.equal(launch.hostProtocolVersion, 1);
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' }); page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.goto(launch.url); await ready(); await formReady();
  assert.equal(await page.locator('#web-account').innerText(), 'Workflow UI');
  await page.locator('#project-info').click(); await page.locator('.project-information-name').waitFor();
  assert.equal(await page.locator('.project-information-name').innerText(), launch.project.name);
  await page.locator('.conversation-dialog[open] header button').last().click();
  proof.checks.push('project information opens from the left toolbar');
  await page.locator('#usage').click(); const usage = page.locator('.conversation-dialog[open]');
  await usage.locator('.usage-balance strong').filter({ hasText: '$10.00' }).waitFor();
  const failUsage = async route => { if (route.request().postDataJSON().type === 'usage') { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary usage failure' }) }); } else { await route.continue(); } };
  await page.route('**/api/message', failUsage);
  await usage.getByRole('button', { name: '\u5237\u65b0\u7528\u91cf', exact: true }).click();
  await usage.locator('.usage-status[role=alert]').filter({ hasText: 'Temporary usage failure' }).waitFor();
  assert.equal(await page.locator('#error').isVisible(), false);
  await page.unroute('**/api/message', failUsage);
  await usage.getByRole('button', { name: '\u5237\u65b0\u7528\u91cf', exact: true }).click();
  await usage.locator('.usage-balance strong').filter({ hasText: '$10.00' }).waitFor();
  await usage.getByRole('button', { name: '\u5173\u95ed', exact: true }).click();
  proof.checks.push('usage request correlation, isolated errors and successful refresh');
  assert.equal(await page.locator('.workflow-entry[open]').getAttribute('data-entrypoint'), 'report');
  await screenshot('workflow-entries-light-1280.png');
  await page.locator('#workflow-param-subject').fill('Browser report'); await formReady();
  await page.locator('[data-action-id=style]').click();
  await page.locator('.quick-param-row').first().click(); await page.getByRole('option', { name: '\u8be6\u7ec6', exact: true }).click();
  await page.locator('#workflow-title').click(); await formReady();
  assert.match(await page.locator('[data-action-id=style]').innerText(), /\u8be6\u7ec6/);
  await page.locator('[data-action-id=execution]').click();
  const popup = await page.locator('#parameter-popover').boundingBox(), anchor = await page.locator('[data-action-id=execution]').boundingBox();
  assert.ok(popup.y + popup.height <= anchor.y, JSON.stringify({ popup, anchor }));
  await page.evaluate(() => {
    window.__workflowDraftRounds = '';
    window.addEventListener('message', event => {
      if (event.data?.type === 'state') { window.__workflowDraftRounds = event.data.drafts?.report?.values.rounds; }
    });
  });
  await page.locator('#workflow-param-rounds').fill('3');
  await page.waitForFunction(() => window.__workflowDraftRounds === '3');
  assert.equal(await page.locator('[data-action-id=execution]').getAttribute('aria-expanded'), 'true', 'Draft updates must keep the parameter panel open');
  await page.locator('#workflow-param-delay').fill('5');
  proof.checks.push('draft updates retain the parameter panel for consecutive edits');
  await page.locator('#workflow-title').click(); await formReady();
  const picker = page.waitForEvent('filechooser'); await page.locator('[data-param=files] button').click();
  await (await picker).setFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('Input file') });
  await page.locator('.param-file-summary').filter({ hasText: 'source.txt' }).waitFor(); await formReady();
  await page.locator('#run').click(); await page.locator('#app[data-run-state=waiting]').waitFor();
  await page.locator('.input-prompt').waitFor(); assert.match(await page.locator('#run-output').innerText(), /Browser report/);
  await page.reload(); await ready(); await page.locator('.input-prompt').waitFor();
  assert.equal(await page.locator('#run-list .session').count(), 1); proof.checks.push('streaming, file parameters and refresh retain the waiting record');
  const outputText = await page.locator('#run-output').innerText();
  await context.setOffline(true); await page.locator('#app[data-connection=disconnected]').waitFor();
  assert.equal(await page.locator('#run-output').innerText(), outputText); assert.equal(await page.locator('#stop-active').isDisabled(), true);
  await screenshot('workflow-disconnected.png'); await context.setOffline(false); await ready();
  await page.getByRole('button', { name: '\u7ee7\u7eed\u8fd0\u884c', exact: true }).click(); await page.locator('#app[data-run-state=idle]').waitFor();
  assert.match(await page.locator('#run-meta').innerText(), /\u5df2\u5b8c\u6210/);
  assert.equal(await page.locator('#run-output h2').count(), 1); assert.equal(await page.locator('#run-files button').count(), 2);
  proof.checks.push('reconnection, same-record replay, authoritative output and managed export');
  await page.locator('#tab-flow').click(); await page.locator('.graph-node[data-execution-id]:not([data-execution-id=""])').first().waitFor();
  const ids = await page.locator('.graph-node[data-execution-id]:not([data-execution-id=""])').evaluateAll(nodes => nodes.map(node => node.dataset.executionId));
  assert.equal(new Set(ids).size, ids.length); assert.ok(ids.length >= 6);
  assert.equal(await page.locator('.graph-node').filter({ hasText: /^prepare/ }).count(), 1);
  assert.equal(await page.locator('.graph-node[data-execution-id]:not([data-execution-id=""])').filter({ hasText: /^iteration/ }).count(), 3);
  assert.ok(await page.locator('.graph-branch').count() > 0); assert.ok(await page.locator('.graph-loop').count() > 0);
  await page.locator('#fit-graph').click(); await screenshot('workflow-flow-light.png');
  await page.locator('.graph-node').first().click(); assert.ok(await page.locator('#node-detail').innerText()); await page.locator('#close-node').click();
  await page.locator('#tab-logs').click(); assert.match(await page.locator('#logs-view').innerText(), /Preparing/);
  await page.locator('#tab-result').click();
  const exported = page.waitForEvent('download'); await page.locator('#export-run').click(); const exportPath = await (await exported).path();
  const record = JSON.parse(await readFile(exportPath, 'utf8')); assert.equal(record.status, 'success'); assert.equal(record.params.subject, 'Browser report');
  const file = record.files.find(file => file.name === 'workflow-result.txt');
  const fileResponse = await context.request.get(`${new URL(launch.url).origin}/api/file/${file.id}`);
  assert.equal(fileResponse.status(), 200); assert.match(await fileResponse.text(), /Browser report/);
  proof.checks.push('Dagre branches and loops, execution instances, node detail, logs and record export');
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 900 }); await assertLayout(); await screenshot(`workflow-result-light-${width}.png`);
    if (await page.locator('#hide-menu').isVisible()) { await page.locator('#hide-menu').click(); }
    await assertLayout(); assert.equal(await page.locator('#menu-toggle').isVisible(), true); await screenshot(`workflow-hidden-${width}.png`); await page.locator('#menu-toggle').click();
  }
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'); await screenshot('workflow-result-dark-390.png');
  await page.locator('#history-toggle').click(); await page.locator('#search-history').fill('Browser report');
  await page.locator('#search-results .session').waitFor(); await page.locator('#close-history').click();
  await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#new').click(); await formReady();
  await page.locator('.workflow-group').last().locator('summary').first().click(); await page.locator('[data-entrypoint=echo] > summary').click(); await formReady();
  assert.equal(await page.locator('#workflow-param-subject').inputValue(), '\u6d41\u5f0f\u8f93\u51fa');
  await page.locator('[data-entrypoint=report] > summary').click(); await formReady(); assert.equal(await page.locator('#workflow-param-subject').inputValue(), 'Browser report');
  await page.locator('#input-mode [data-mode=raw]').click(); await page.locator('#raw-args').fill('["--subject","Restart report","--review","true","--delay","1"]'); await formReady();
  await page.locator('#run').click(); await page.locator('#app[data-run-state=waiting]').waitFor();
  await stop(); await page.locator('#app[data-connection=disconnected]').waitFor();
  launch = await start(); await page.goto(launch.url); await ready(); await page.locator('.input-prompt').waitFor();
  assert.match(await page.locator('#run-meta').innerText(), /\u5df2\u4e2d\u65ad/);
  await page.getByRole('button', { name: '\u7ee7\u7eed\u8fd0\u884c', exact: true }).click(); await page.locator('#app[data-run-state=idle]').waitFor();
  await page.locator('#rerun').click(); await page.locator('#app[data-run-state=waiting]').waitFor();
  child.stdin.write(`${JSON.stringify({ type: 'auth', connection: { ...connection, accessToken: 'changed-ui-identity' } })}\n`);
  await page.locator('#app[data-run-state=idle]').waitFor(); assert.match(await page.locator('#run-meta').innerText(), /\u5df2\u505c\u6b62/);
  proof.checks.push('wide and narrow layouts, hidden sidebar, search, auto dark theme, entry drafts, raw args, restart recovery, rerun and identity cancellation');
  await stop(); launch = await start(false); await page.goto(launch.url); await ready();
  await page.locator('#new').click(); await formReady();
  await page.locator('#input-mode [data-mode=raw]').click();
  await page.locator('#raw-args').fill('["--subject","Standalone report","--review","false","--delay","5","--rounds","3"]');
  await formReady(); await page.locator('#run').click();
  await page.locator('#run-meta').filter({ hasText: '\u5df2\u5b8c\u6210' }).waitFor();
  assert.equal(await page.locator('#run-output h2').count(), 1);
  await page.locator('#tab-flow').click(); assert.equal(await page.locator('.graph-node').filter({ hasText: /^iteration/ }).count(), 3);
  await page.locator('#tab-result').click(); await screenshot('workflow-standalone-result.png');
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'); await assertLayout();
  await screenshot('workflow-standalone-dark-390.png');
  proof.checks.push('standalone CLI without host injection, declared parameters, offline report, loop instances and automatic dark theme');
  await page.locator('#new').click(); await formReady();
  await page.locator('#raw-args').fill('["--subject","Failure report","--review","false","--fail","true","--delay","1"]'); await formReady();
  await page.locator('#run').click(); await page.locator('#run-meta').filter({ hasText: '\u5931\u8d25' }).waitFor();
  assert.match(await page.locator('#run-error').innerText(), /Offline failure example/);
  await page.locator('#new').click(); await formReady();
  await page.locator('#raw-args').fill('["--subject","Stopped report","--review","false","--delay","1000","--rounds","10"]'); await formReady();
  await page.locator('#run').click(); await page.locator('#app[data-run-state=running]').waitFor();
  await page.locator('#stop-active').click(); await page.locator('#run-meta').filter({ hasText: '\u5df2\u505c\u6b62' }).waitFor();
  const count = await page.locator('#run-list .session').count();
  await page.locator('#delete-run').click(); await page.locator('.action-dialog[open]').getByRole('button', { name: '\u53d6\u6d88', exact: true }).click();
  assert.equal(await page.locator('#run-list .session').count(), count);
  await page.locator('#delete-run').click(); await page.locator('.action-dialog[open]').getByRole('button', { name: '\u5220\u9664', exact: true }).click();
  await page.waitForFunction(count => document.querySelectorAll('#run-list .session').length === count - 1, count);
  proof.checks.push('declared failure switch, explicit stop, cancelled deletion and confirmed record deletion');
  assert.deepEqual(proof.errors, []); await writeFile(path.join(proofDir, 'browser-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify({ checks: proof.checks, screenshots: proof.screenshots, errors: proof.errors }));
} finally { await context?.close(); await browser?.close(); await stop(); await new Promise(resolve => server.close(resolve)); }
