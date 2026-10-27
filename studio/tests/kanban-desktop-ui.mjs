import { approveLocalFixtureDatabase } from './approved-database-fixture.mjs';
import { resolve } from 'import-meta-resolve';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readFile, writeFile, cp, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';
import { createKanbanTestServer } from './kanban-server-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), example = path.join(root, 'examples/kanban');
const proofDir = path.join(root, '.studio/kanban-migration'); await mkdir(proofDir, { recursive: true });
const dataDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-kanban-desktop-'))); await mkdir(path.join(dataDir, 'User'));
await writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Light Modern', 'git.openRepositoryInParentFolders': 'never' }));
const projectDir=path.join(dataDir,'kanban');
await cp(example,projectDir,{recursive:true,filter:file=>!file.split(path.sep).includes('node_modules')});
await mkdir(path.join(projectDir,'node_modules/@steamharness'),{recursive:true});
await symlink(await realpath(path.join(example,'node_modules/steamharness')),path.join(projectDir,'node_modules/steamharness'),process.platform==='win32'?'junction':'dir');
await symlink(process.env.STEAMHARNESS_UI_CLI_ENTRY?path.resolve(path.dirname(process.env.STEAMHARNESS_UI_CLI_ENTRY),'..'):await realpath(path.join(example,'node_modules/@steamharness/cli')),path.join(projectDir,'node_modules/@steamharness/cli'),process.platform==='win32'?'junction':'dir');
const core=await import(resolve('steamharness',new URL('../examples/kanban/package.json',import.meta.url).href));
await approveLocalFixtureDatabase(core,projectDir,JSON.parse(await readFile(path.join(projectDir,'package.json'),'utf8')),path.join(dataDir,'databases'));
const cliVersion = JSON.parse(await readFile(path.join(projectDir, 'node_modules/@steamharness/cli/package.json'), 'utf8')).version;
if (!process.env.STEAMHARNESS_UI_CLI_ENTRY) { assert.equal(cliVersion, JSON.parse(await readFile(path.join(example, 'package.json'), 'utf8')).devDependencies['@steamharness/cli']); }
const server = await createKanbanTestServer(), proof = { cliVersion, checks: [], screenshots: [], errors: [] };
const debug = createServer(); await new Promise(resolve => debug.listen(0, '127.0.0.1', resolve)); const port = debug.address().port; await new Promise(resolve => debug.close(resolve));
const log = await open(path.join(proofDir, 'desktop.log'), 'w');
const desktop = await desktopLocaleLaunch('zh-cn', dataDir);
const child = spawn(desktop.executable, [...desktop.args,
  '--user-data-dir', dataDir, '--extensions-dir', path.join(root, '.studio/desktop-extensions'), '--locale=zh-cn', '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, projectDir,
], { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, STEAMHARNESS_DATABASES_DIR:path.join(dataDir,'databases'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); }); const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, page;
async function frameFor(selector) { for (let attempt = 0; attempt < 200; attempt++) { for (const frame of page.frames()) { if (frame.isDetached() || !await frame.locator(selector).first().isVisible().catch(() => false)) continue;
  let current = frame, visible = true; while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); } if (visible) return frame;
} await pause(100); } throw new Error(`Frame unavailable: ${selector}`); }
async function command(name) { await page.locator('.part.titlebar').click({ position: { x: 200, y: 5 } }); await page.keyboard.press('F1'); const input = page.locator('.quick-input-widget input'); await input.fill(`>${name}`); await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first().click(); await page.locator('.quick-input-widget').waitFor({ state: 'hidden' }); }
async function ready(frame) { await frame.locator('#app[data-connection=connected]').waitFor(); await frame.locator('#preview-status').waitFor({ state: 'hidden' }); }
async function screenshot(name) { await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function assertLayout(frame) { const bounds = await frame.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('.toolbar button, .kanban-configuration-controls button')].filter(button => button.getClientRects().length).map(button => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }) })); assert.ok(bounds.width <= bounds.viewport, JSON.stringify(bounds)); assert.ok(bounds.buttons.every(button => button.left >= 0 && button.right <= bounds.viewport), JSON.stringify(bounds)); }
try {
  for (let attempt = 0; attempt < 250; attempt++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (child.exitCode !== null) throw new Error('Studio exited before startup.'); await pause(100); }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) break; await pause(100); }
  assert.ok(page); page.setDefaultTimeout(20_000); page.on('pageerror', error => proof.errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 1000 });
  const run = page.locator('.part.titlebar .studio-workflow-run').getByRole('button', { name: '\u8fd0\u884c\u9879\u76ee', exact: true }); await run.waitFor({ timeout: 45_000 }); await run.click();
  let frame = await frameFor('#kanban-title'); await ready(frame); assert.match(frame.url(), /^http:\/\/127\.0\.0\.1:/); let preview = frame.frameLocator('#kanban-preview'); await preview.locator('.task').first().waitFor();
  assert.equal(await preview.locator('.task').count(), 3); proof.checks.push('folder detection runs the project-owned CLI Kanban page in a VS Code tab');
  if (await frame.locator('#menu-toggle').isVisible()) { await frame.locator('#menu-toggle').click(); }
  await frame.locator('#workflow-param-title').fill('Desktop roadmap'); await preview.locator('#board-title').filter({ hasText: 'Desktop roadmap' }).waitFor();
  await frame.locator('#app[data-saving=false]').waitFor();
  await frame.locator('#create').click(); await frame.waitForFunction(() => document.querySelector('#configuration').options.length === 2); await ready(frame);
  const first = await frame.locator('#configuration option').first().getAttribute('value'); await frame.locator('#configuration').selectOption(first); await ready(frame); assert.equal(await frame.locator('#workflow-param-title').inputValue(), 'Desktop roadmap');
  await preview.locator('#new-task').click(); await preview.locator('#task-title').fill('Desktop task'); await preview.locator('#save-task').click(); await preview.locator('#task-dialog[open]').waitFor({ state: 'hidden' }); await preview.locator('.task h3').filter({ hasText: 'Desktop task' }).waitFor(); await screenshot('kanban-desktop-light.png');
  await command('SteamHarness: 登录'); const account = await frameFor('#login-app'); await account.locator('#server-url').fill(server.connection.serverUrl); await account.locator('#login-email').fill(server.profile.email); await account.locator('#login-password').fill('offline-password'); await account.locator('#login-submit').click(); await (await frameFor('#account-app')).locator('#display-name').filter({ hasText: server.profile.displayName }).waitFor();
  await page.getByRole('tab', { name: '\u770b\u677f\u793a\u4f8b', exact: true }).click(); frame = await frameFor('#kanban-title'); await ready(frame); preview = frame.frameLocator('#kanban-preview'); await frame.locator('#web-account').filter({ hasText: server.profile.displayName }).waitFor(); assert.ok(server.authenticatedRequests >= 2);
  await frame.locator('#usage').click(); const usage = frame.locator('.conversation-dialog[open]');
  await usage.locator('.usage-balance strong').filter({ hasText: '$10.00' }).waitFor();
  await usage.getByRole('button', { name: '\u5237\u65b0\u7528\u91cf', exact: true }).click(); await usage.locator('.usage-balance strong').filter({ hasText: '$10.00' }).waitFor();
  await usage.getByRole('button', { name: '\u5173\u95ed', exact: true }).click(); proof.checks.push('verified host login provides usage and refresh in the Kanban tab');
  await frame.locator('#methods').click(); await frame.locator('#method-name').selectOption('tasks.list'); await frame.locator('#invoke-method').click(); await frame.locator('#method-result').filter({ hasText: 'Desktop task' }).waitFor(); await frame.locator('#close-methods').click(); proof.checks.push('parameter and configuration linkage, project data, page methods and injected host login');
  await command('View: Close Editor'); await run.click(); frame = await frameFor('#kanban-title'); await ready(frame); preview = frame.frameLocator('#kanban-preview'); await preview.locator('.task h3').filter({ hasText: 'Desktop task' }).waitFor(); assert.equal(await frame.locator('#configuration option').count(), 2); assert.equal(await frame.locator('#workflow-param-title').inputValue(), 'Desktop roadmap'); proof.checks.push('closing and reopening retains configuration and task data');
  const settings = JSON.parse(await readFile(path.join(dataDir, 'User/settings.json'))); await writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ ...settings, 'workbench.colorTheme': 'Dark Modern' })); await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const artifact = await frameFor('#board'); await artifact.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(32, 33, 36)'); await screenshot('kanban-desktop-dark.png');
  for (const width of [1440, 950, 650]) { await page.setViewportSize({ width, height: 1000 }); await pause(200); await assertLayout(frame); if (await frame.locator('#hide-menu').isVisible()) await frame.locator('#hide-menu').click(); assert.equal(await frame.locator('#menu-toggle').isVisible(), true); await assertLayout(frame); await screenshot(`kanban-desktop-hidden-${width}.png`); await frame.locator('#menu-toggle').click(); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const mode of ['phone', 'tablet', 'card', 'fullscreen']) { await frame.locator(`[data-mode=${mode}]`).click(); await preview.locator(`body[data-presentation=${mode}]`).waitFor(); await assertLayout(frame); await screenshot(`kanban-desktop-${mode}.png`); }
  proof.checks.push('VS Code theme synchronization reaches the artifact, wide and narrow layout, hidden sidebar and four preview modes');
  assert.deepEqual(proof.errors, []); await writeFile(path.join(proofDir, 'desktop-proof.json'), `${JSON.stringify(proof, null, 2)}\n`); console.log(JSON.stringify(proof));
} catch (error) { if (page) { await screenshot('kanban-desktop-failed.png'); console.error(JSON.stringify({ stage: proof.checks.at(-1), commands: await page.locator('.quick-input-widget .label-name').allTextContents().catch(() => []), frames: await Promise.all(page.frames().filter(frame => !frame.isDetached()).map(async frame => ({ url: frame.url(), theme: await frame.evaluate(() => ({ theme: document.documentElement.dataset.theme, dark: matchMedia('(prefers-color-scheme: dark)').matches, scheme: getComputedStyle(document.documentElement).colorScheme, preview: document.querySelector('#kanban-preview')?.style.colorScheme })).catch(() => undefined) }))) })); } throw error;
} finally { await browser?.close(); if (child.exitCode === null) child.kill('SIGTERM'); await Promise.race([exited, pause(10_000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } await log.close(); await server.close(); }
