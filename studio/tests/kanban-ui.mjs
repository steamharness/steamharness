import { approveLocalFixtureDatabase } from './approved-database-fixture.mjs';
import { resolve } from 'import-meta-resolve';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { createKanbanTestServer } from './kanban-server-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), example = path.join(root,'examples/kanban');
const projectDir = path.join(await mkdtemp(path.join(os.tmpdir(),'studio-kanban-project-')),'board');
await cp(example,projectDir,{recursive:true,filter:file=>!file.split(path.sep).includes('node_modules')});
await symlink(await realpath(path.join(example,'node_modules')),path.join(projectDir,'node_modules'),process.platform==='win32'?'junction':'dir');
const cliEntry = process.env.STEAMHARNESS_UI_CLI_ENTRY ?? path.join(projectDir, 'node_modules/@steamharness/cli/dist/index.js');
const data = await mkdtemp(path.join(os.tmpdir(), 'studio-kanban-ui-')), proofDir = path.join(root, '.studio/kanban-migration'); await mkdir(proofDir, { recursive: true });
const cliVersion = JSON.parse(await readFile(path.join(path.dirname(cliEntry), '../package.json'), 'utf8')).version;
if (!process.env.STEAMHARNESS_UI_CLI_ENTRY) { assert.equal(cliVersion, JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')).devDependencies['@steamharness/cli']); }
const core=await import(resolve('steamharness',new URL('../examples/kanban/package.json',import.meta.url).href));
const localManifest=JSON.parse(await readFile(path.join(projectDir,'package.json'),'utf8'));
await approveLocalFixtureDatabase(core,projectDir,localManifest,path.join(data,'databases'));
const server = await createKanbanTestServer(), proof = { cliVersion, checks: [], screenshots: [], errors: [] };
let child, browser, context, page, launch;
async function start(directory = projectDir, embedded = true) {
  child = spawn(process.execPath, [cliEntry, '--locale', 'zh-CN', 'web', directory, '--no-open', '--json', '--data-dir', data, ...(embedded ? ['--host-stdio'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, STEAMHARNESS_DATABASES_DIR:path.join(data,'databases'), STEAMHARNESS_CLI_AUTH_DIR: path.join(data, 'auth'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' } });
  if (embedded) { child.stdin.write(`${JSON.stringify({ type: 'configure', surface: 'editor', connection: server.connection })}\n`); }
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Kanban startup timed out: ${errors}`)), 30_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${errors}`)); });
    child.stdout.on('data', chunk => { output += chunk; for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.type === 'ready') { clearTimeout(timer); resolve(value); return; } } catch {} } });
  });
}
async function stop() { if (!child || child.exitCode !== null) return; const old = child, exited = new Promise(resolve => old.once('exit', resolve)); old.kill('SIGTERM'); const timer = setTimeout(() => old.kill('SIGKILL'), 10_000); await exited; clearTimeout(timer); }
async function ready() { await page.locator('#app[data-connection=connected]').waitFor(); await page.locator('#preview-status').waitFor({ state: 'hidden' }); }
async function saved() { await page.locator('#app[data-saving=false]').waitFor(); }
async function board() { return page.frameLocator('#kanban-preview'); }
async function screenshot(name) { await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function api(message) { const response = await context.request.post(`${new URL(launch.url).origin}/api/message`, { headers: { Authorization: `Bearer ${new URL(launch.url).hash.slice('#session='.length)}` }, data: message }); assert.equal(response.status(), 200, await response.text()); return (await response.json()).messages; }
async function assertLayout() { const result = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('.toolbar button, .kanban-configuration-controls button')].filter(button => button.getClientRects().length).map(button => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }) })); assert.ok(result.width <= result.viewport, JSON.stringify(result)); assert.ok(result.buttons.every(button => button.left >= 0 && button.right <= result.viewport), JSON.stringify(result)); }
try {
  launch = await start(); assert.equal(launch.project.projectType, 'kanban'); assert.equal(launch.hostProtocolVersion, 1);
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' }); page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', error => proof.errors.push(error.message));
  await page.goto(launch.url); await ready(); const preview = await board(); await preview.locator('.task').first().waitFor();
  assert.equal(await page.locator('#web-account').innerText(), server.profile.displayName); assert.equal(await preview.locator('.task').count(), 3);
  await page.locator('#project-info').click(); await page.locator('.project-information-name').waitFor();
  assert.equal(await page.locator('.project-information-name').innerText(), launch.project.name);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.conversation-dialog[open] header button').last().click();
  await page.locator('.project-information-name').waitFor({ state: 'hidden' });
  proof.checks.push('project information opens from the left toolbar');
  assert.equal(await page.locator('#kanban-fields [data-param]').count(), 8); assert.equal(await page.locator('#kanban-fields input[type=checkbox]:checked').count(), 4);
  const rootStyle = await preview.locator('body').evaluate(element => getComputedStyle(element).backgroundColor); assert.equal(rootStyle, 'rgb(255, 255, 255)');
  await screenshot('kanban-light-1280.png'); proof.checks.push('project artifact, declared controls, initial typed parameters and host login');
  await page.locator('#usage').click();
  const usage = page.locator('.conversation-dialog[open]');
  await usage.locator('.usage-balance strong').filter({ hasText: '$10.00' }).waitFor();
  const failUsage = async route => { if (route.request().postDataJSON().type === 'usage') { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary usage failure' }) }); } else { await route.continue(); } };
  await page.route('**/api/message', failUsage); await usage.getByRole('button', { name: '\u5237\u65b0\u7528\u91cf', exact: true }).click();
  await usage.locator('.dialog-body').filter({ hasText: 'Temporary usage failure' }).waitFor(); assert.equal(await page.locator('#error').isVisible(), false); await page.unroute('**/api/message', failUsage);
  await usage.getByRole('button', { name: '\u5237\u65b0\u7528\u91cf', exact: true }).click(); await usage.locator('.usage-balance strong').filter({ hasText: '$10.00' }).waitFor();
  await screenshot('kanban-usage.png'); await usage.getByRole('button', { name: '\u5173\u95ed', exact: true }).click();
  proof.checks.push('usage dialog, refresh, recoverable request failure and authoritative balance');
  await page.locator('#workflow-param-title').fill('Browser roadmap'); await preview.locator('#board-title').filter({ hasText: 'Browser roadmap' }).waitFor(); await saved();
  let rejectSave = true;
  const failSave = async route => { const message = route.request().postDataJSON(); if (rejectSave && message.type === 'kanban-configuration' && message.action === 'save') { rejectSave = false; await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary save failure' }) }); } else { await route.continue(); } };
  await page.route('**/api/message', failSave); await page.locator('#workflow-param-title').fill('Retry roadmap'); await page.locator('#save-error').filter({ hasText: 'Temporary save failure' }).waitFor();
  assert.equal(await page.locator('#workflow-param-title').inputValue(), 'Retry roadmap'); await page.locator('#retry-save').click(); await preview.locator('#board-title').filter({ hasText: 'Retry roadmap' }).waitFor(); await page.locator('#save-error').waitFor({ state: 'hidden' }); await page.unroute('**/api/message', failSave);
  await page.locator('#workflow-param-title').fill('Browser roadmap'); await preview.locator('#board-title').filter({ hasText: 'Browser roadmap' }).waitFor(); await saved(); proof.checks.push('failed saves retain the draft and retry the declared parameters');
  await page.locator('#workflow-param-priority').selectOption('high'); await preview.locator('#board-summary').filter({ hasText: '3' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#app').dataset.saving === 'false'); await preview.locator('.task[data-priority=normal]').waitFor({ state: 'hidden' });
  await page.locator('#workflow-param-priority').selectOption('all'); await preview.locator('.task[data-priority=normal]').waitFor();
  await page.locator('[data-param=density] input[value=compact]').check(); await preview.locator('body[data-density=compact]').waitFor();
  await page.locator('[data-param=showCompleted] input').uncheck(); await preview.locator('.column[data-status=done]').waitFor({ state: 'hidden' });
  await page.locator('[data-param=showCompleted] input').check(); await preview.locator('.column[data-status=done]').waitFor();
  const chooser = page.waitForEvent('filechooser'); await page.locator('[data-param=files] .param-file-button').click(); await (await chooser).setFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Kanban brief') });
  await page.locator('.param-file-summary').filter({ hasText: 'brief.txt' }).waitFor(); await saved();
  const fileResult = await preview.locator('body').evaluate(async () => { const api = window.steamHarnessKanban, file = api.getConfiguration().params.files[0]; const result = await api.databases.get('data').files.readFile(file.id); return new TextDecoder().decode(result.buffer); }); assert.equal(fileResult, 'Kanban brief');
  const downloadEvent = page.waitForEvent('download'); await page.locator('.param-file-download').click(); const download = await downloadEvent; assert.equal(download.suggestedFilename(), 'brief.txt'); assert.equal(await readFile(await download.path(), 'utf8'), 'Kanban brief');
  await page.locator('.param-file-remove').click(); await page.locator('.param-file-row').waitFor({ state: 'hidden' }); await saved(); assert.deepEqual(await preview.locator('body').evaluate(() => window.steamHarnessKanban.getConfiguration().params.files), []);
  proof.checks.push('live parameter injection, filters, radio and boolean controls, file upload and server-managed readback');
  const original = await page.locator('#configuration').inputValue(); await page.locator('#create').click(); await page.locator('#configuration').waitFor(); await page.waitForFunction(id => document.querySelector('#configuration').value !== id, original); await ready();
  assert.equal(await page.locator('#workflow-param-title').inputValue(), '\u9879\u76ee\u8ba1\u5212'); await page.locator('#configuration').selectOption(original); await ready(); assert.equal(await page.locator('#workflow-param-title').inputValue(), 'Browser roadmap');
  await page.locator('#configuration-actions').click(); await page.locator('#configuration-dialog').getByRole('button', { name: '\u590d\u5236', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#configuration').options.length === 3); await ready(); assert.equal(await page.locator('#workflow-param-title').inputValue(), 'Browser roadmap');
  await page.locator('#configuration-actions').click(); await page.locator('#configuration-dialog').getByRole('button', { name: '\u91cd\u547d\u540d', exact: true }).click();
  await page.locator('.action-dialog input').fill('Review board'); await page.locator('.action-dialog').getByRole('button', { name: '\u4fdd\u5b58', exact: true }).click(); await page.locator('#configuration option:checked').filter({ hasText: 'Review board' }).waitFor({ state: 'attached' });
  await page.locator('#configuration-actions').click(); await page.locator('#configuration-dialog').getByRole('button', { name: '\u5220\u9664', exact: true }).click(); await page.locator('.action-dialog').getByRole('button', { name: '\u53d6\u6d88', exact: true }).click(); assert.equal(await page.locator('#configuration option').count(), 3);
  await page.locator('#configuration-actions').click(); await page.locator('#configuration-dialog').getByRole('button', { name: '\u5220\u9664', exact: true }).click(); await page.locator('.action-dialog').getByRole('button', { name: '\u5220\u9664', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#configuration').options.length === 2); await ready();
  proof.checks.push('configuration create, duplicate, rename, select, delete and embedded confirmation');
  await preview.locator('#new-task').click(); await preview.locator('#task-title').fill('Browser task'); await preview.locator('#save-task').click(); await preview.locator('#task-dialog[open]').waitFor({ state: 'hidden' }); await preview.locator('.task h3').filter({ hasText: 'Browser task' }).waitFor();
  await page.reload(); await ready(); await preview.locator('.task h3').filter({ hasText: 'Browser task' }).waitFor(); assert.equal(await page.locator('#workflow-param-title').inputValue(), 'Browser roadmap');
  await page.locator('#methods').click(); await page.locator('#method-name').selectOption('tasks.list'); await page.locator('#invoke-method').click(); await page.locator('#method-result').filter({ hasText: 'Browser task' }).waitFor(); await page.locator('#close-methods').click();
  const [catalog] = await api({ type: 'kanban-methods', action: 'list' }); const instance = catalog.value.find(item => item.ready && item.methods.some(method => method.name === 'tasks.create')); assert.ok(instance);
  const [invoked] = await api({ type: 'kanban-methods', action: 'invoke', call: { instanceId: instance.instanceId, configurationId: instance.configurationId, method: 'tasks.create', args: { title: 'RPC task' } } }); assert.equal(invoked.value.count, 5); await preview.locator('.task h3').filter({ hasText: 'RPC task' }).waitFor();
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await ready(); await preview.locator('.task h3').filter({ hasText: 'RPC task' }).waitFor();
  await page.locator('#methods:not([disabled])').waitFor();
  const [restored] = await api({ type: 'kanban-methods', action: 'list' });
  const restoredInstance = restored.value.find(item => item.ready && item.methods.some(method => method.name === 'tasks.list'));
  assert.ok(restoredInstance); assert.notEqual(restoredInstance.instanceId, instance.instanceId);
  const [restoredList] = await api({ type: 'kanban-methods', action: 'invoke', call: { instanceId: restoredInstance.instanceId, configurationId: restoredInstance.configurationId, method: 'tasks.list', args: {} } });
  assert.ok(JSON.stringify(restoredList.value).includes('RPC task'));
  proof.checks.push('browser history lifecycle restores the preview, event connection and exact page method instance');
  const exportEvent = page.waitForEvent('download'); await preview.locator('#export-board').click(); const exported = await exportEvent;
  assert.equal(exported.suggestedFilename(), 'kanban.json'); const exportedTasks = JSON.parse(await readFile(await exported.path(), 'utf8'));
  assert.equal(exportedTasks.length, 5); assert.ok(exportedTasks.some(task => task.title === 'Browser task')); assert.ok(exportedTasks.some(task => task.title === 'RPC task'));
  proof.checks.push('project artifact exports its persisted task list through the sandbox');
  proof.checks.push('project KV persistence, refresh, registered page methods and authenticated instance RPC');
  const content = await preview.locator('#board').innerText(); await context.setOffline(true); await page.locator('#app[data-connection=disconnected]').waitFor(); assert.equal(await preview.locator('#board').innerText(), content); assert.equal(await page.locator('#create').isDisabled(), true); await screenshot('kanban-disconnected.png'); await context.setOffline(false); await ready();
  for (const width of [1280, 760, 390]) { await page.setViewportSize({ width, height: 900 }); await assertLayout(); await screenshot(`kanban-light-${width}.png`); if (await page.locator('#hide-menu').isVisible()) await page.locator('#hide-menu').click(); await assertLayout(); assert.equal(await page.locator('#menu-toggle').isVisible(), true); await screenshot(`kanban-hidden-${width}.png`); await page.locator('#menu-toggle').click(); }
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'); await screenshot('kanban-dark-390.png');
  assert.equal(await preview.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(32, 33, 36)');
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const mode of ['phone', 'tablet', 'card', 'fullscreen']) { await page.locator(`[data-mode=${mode}]`).click(); await preview.locator(`body[data-presentation=${mode}]`).waitFor(); await assertLayout(); await screenshot(`kanban-preview-${mode}.png`); }
  await page.locator('[data-mode=phone]').click(); await page.locator('#dimensions').click(); await page.locator('#preview-width').fill('420'); await page.locator('#preview-height').fill('780'); await page.locator('#dimensions-dialog').getByRole('button', { name: '\u5e94\u7528', exact: true }).click(); assert.equal(await page.locator('#kanban-preview').evaluate(element => element.style.width), '420px');
  proof.checks.push('disconnection content retention, automatic dark theme in parent and artifact, responsive sidebar and preview dimensions');
  await stop(); launch = await start(projectDir, false); await page.goto(launch.url); await ready(); await preview.locator('.task h3').filter({ hasText: 'RPC task' }).waitFor(); assert.equal(await page.locator('#workflow-param-title').inputValue(), 'Browser roadmap');
  proof.checks.push('standalone browser and CLI restart retain configurations and project data');
  await stop(); const serverProject=path.join(data,'server-board');
  await cp(projectDir,serverProject,{recursive:true,filter:file=>!file.split(path.sep).includes('node_modules')});
  await symlink(await realpath(path.join(projectDir,'node_modules')),path.join(serverProject,'node_modules'),process.platform==='win32'?'junction':'dir');
  const serverDatabase=await server.registerProject(serverProject);
  launch = await start(serverProject); await page.goto(launch.url); await ready(); await preview.locator('.task').first().waitFor(); await preview.locator('#new-task').click(); await preview.locator('#task-title').fill('Server task'); await preview.locator('#save-task').click(); await preview.locator('#task-dialog[open]').waitFor({ state: 'hidden' }); await preview.locator('.task h3').filter({ hasText: 'Server task' }).waitFor(); assert.ok((await serverDatabase.kv.getValue('studio-kanban:tasks')).some(task => task.title === 'Server task')); proof.checks.push('server-declared storage uses verified CLI login and Server data');
  assert.deepEqual(proof.errors, []); await writeFile(path.join(proofDir, 'browser-proof.json'), `${JSON.stringify(proof, null, 2)}\n`); console.log(JSON.stringify(proof));
} catch (error) { if (page) { await screenshot('kanban-failed.png'); console.error(JSON.stringify({ stage: proof.checks.at(-1), artifact: await page.frameLocator('#kanban-preview').locator('body').innerText().catch(() => ''), error: await page.locator('#error').innerText().catch(() => '') })); } throw error;
} finally { await context?.close(); await browser?.close(); await stop(); await server.close(); }
