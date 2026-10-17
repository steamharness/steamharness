import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readFile, writeFile, cp, symlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const proofDir = path.join(root, '.studio/trace-panel'); await mkdir(proofDir, { recursive: true });
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-trace-ui-')));
const dataDir = path.join(directory, 'user'); await mkdir(path.join(dataDir, 'User'), { recursive: true });
const settingsPath = path.join(dataDir, 'User/settings.json');
const settings = theme => ({ 'workbench.colorTheme': theme, 'git.openRepositoryInParentFolders': 'never', 'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'hidden' });
await writeFile(settingsPath, JSON.stringify(settings('Light Modern')));
const ordinary = path.join(directory, 'ordinary'); await mkdir(ordinary);
const workspace = path.join(directory, 'trace.code-workspace'); await writeFile(workspace, JSON.stringify({ folders: [{ path: ordinary }] }));
const projects = [];
for (const [type, relative] of [['conversation', 'tests/fixtures/conversation-features'], ['workflow', 'examples/workflow'], ['kanban', 'examples/kanban']]) {
  const original = path.join(root, relative), folder = path.join(directory, type);
  await cp(original, folder, { recursive: true, filter: entry => !entry.split(path.sep).includes('node_modules') });
  await mkdir(path.join(folder, 'node_modules/@workflow-code'), { recursive: true });
  await symlink(await realpath(path.join(original, 'node_modules/workflow-code')), path.join(folder, 'node_modules/workflow-code'), 'dir');
  const cli = process.env.STUDIO_TRACE_CLI_DIR ?? await realpath(path.join(original, 'node_modules/@workflow-code/cli'));
  await symlink(cli, path.join(folder, 'node_modules/@workflow-code/cli'), 'dir');
  const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  if (!process.env.STUDIO_TRACE_CLI_DIR) { assert.equal(JSON.parse(await readFile(path.join(cli, 'package.json'), 'utf8')).version, manifest.devDependencies['@workflow-code/cli']); }
  projects.push({ type, folder, manifest });
}
const debug = createServer(); await new Promise(resolve => debug.listen(0, '127.0.0.1', resolve)); const port = debug.address().port; await new Promise(resolve => debug.close(resolve));
const log = await open(path.join(proofDir, 'desktop.log'), 'w');
const desktop = await desktopLocaleLaunch('zh-cn', directory);
const child = spawn(desktop.executable, [...desktop.args, '--user-data-dir', dataDir,
  '--extensions-dir', path.join(root, '.studio/desktop-extensions'), '--locale=zh-cn', '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, workspace],
  { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, WORKFLOW_SERVER_URL: '', WORKFLOW_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = { checks: [], screenshots: [], errors: [] }; let browser, page;
async function command(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('.part.titlebar').click({ position: { x: 200, y: 5 } }); await page.keyboard.press('F1');
    await page.locator('.quick-input-widget input').fill(`>${name}`);
    try { await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first().click({ timeout: 3000 }); await page.locator('.quick-input-widget').waitFor({ state: 'hidden' }); return; }
    catch (error) { if (attempt === 2) { throw error; } await page.keyboard.press('Escape'); }
  }
}
async function frameFor(selector) {
  for (let attempt = 0; attempt < 250; attempt++) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !await frame.locator(selector).first().isVisible().catch(() => false)) { continue; }
      let current = frame, visible = true;
      while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
      if (visible) { return frame; }
    } await pause(100);
  } throw new Error(`Frame unavailable: ${selector}`);
}
async function screenshot(name) { await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function panelTabs(expected) {
  const labels = await page.locator('.part.panel .composite-bar .action-label').allTextContents();
  assert.deepEqual(labels.map(label => label.trim()).sort(), [...expected].sort());
}
async function resizePanel(height) {
  const panel = await page.locator('.part.panel').boundingBox();
  for (const sash of await page.locator('.monaco-sash.horizontal').all()) {
    const box = await sash.boundingBox();
    if (!box || Math.abs(box.y - panel.y) > 6 || box.width < 100) { continue; }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, panel.y + panel.height - height, { steps: 10 }); await page.mouse.up(); return;
  }
}
async function layout(frame) {
  const boxes = await frame.evaluate(() => {
    const bounds = [...document.querySelectorAll('.trace-toolbar > :not([hidden]), .trace-controls > :not([hidden])')]
      .filter(item => item.getClientRects().length).map(item => item.getBoundingClientRect());
    return { viewport: innerWidth, width: document.documentElement.scrollWidth, outside: bounds.some(box => box.left < 0 || box.right > innerWidth),
      overlap: bounds.some((box, index) => bounds.slice(index + 1).some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) };
  }); assert.ok(boxes.width <= boxes.viewport && !boxes.outside && !boxes.overlap, JSON.stringify(boxes));
  assert.equal(await frame.locator('.trace-toolbar select').first().evaluate(element => getComputedStyle(element).borderRadius), '4px');
}
try {
  for (let attempt = 0; attempt < 250; attempt++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch {} if (child.exitCode !== null) { throw new Error('Studio exited before startup.'); } await pause(100); }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(25_000); page.on('pageerror', error => proof.errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 1000 });
  await command('Studio: New Terminal');
  const panel = page.locator('.part.panel');
  const tab = panel.locator('.composite-bar .action-label').filter({ hasText: /^\u8f68\u8ff9$/ });
  await pause(600); assert.equal(await tab.count(), 0);
  await panelTabs(['Terminal']);
  await writeFile(workspace, JSON.stringify({ folders: [{ path: ordinary }, ...projects.map(project => ({ path: project.folder }))] }));
  await tab.waitFor({ timeout: 45_000 }); await tab.click();
  let trace = await frameFor('#trace-app'); assert.equal(await trace.locator('#trace-project option').count(), 2);
  await trace.locator('#trace-connect').click();
  let conversation = await frameFor('body[data-surface=editor] #message'); await conversation.locator('#session-list .session').first().waitFor();
  await conversation.locator('#message').fill('activity'); await conversation.locator('#send:not([disabled])').click();
  await conversation.locator('.message.assistant .message-actions [aria-label="\u8f68\u8ff9"]').waitFor();
  assert.equal(await conversation.locator('.message.assistant .message-actions [aria-label="\u8fd0\u884c\u65e5\u5fd7"]').count(), 0);
  assert.equal(await conversation.locator('.message.assistant .message-actions [aria-label="\u8fd0\u884c\u8ddf\u8e2a"]').count(), 0);
  await conversation.locator('.message.assistant .message-actions [aria-label="\u8f68\u8ff9"]').click();
  trace = await frameFor('#trace-app'); await trace.locator('.trace-row[data-lane=tool]').first().waitFor();
  await trace.waitForFunction(() => document.querySelectorAll('.trace-row[data-lane=tool]').length >= 9);
  await conversation.locator('.message.assistant:not(.streaming)').waitFor();
  await trace.locator('#trace-search').fill('git status'); await trace.locator('.trace-row summary').filter({ hasText: 'git status' }).click();
  await trace.locator('.trace-row[open] pre').filter({ hasText: 'Working tree is clean' }).waitFor();
  await trace.locator('#trace-search').fill(''); await resizePanel(460); await layout(trace); await screenshot('conversation-light.png');
  await panelTabs(['Terminal', 'KV', '\u77e5\u8bc6\u5e93', '\u8f68\u8ff9']);
  proof.checks.push('ordinary folders keep only Terminal; Workflow and Conversation add Trace; Kanban is excluded; one reply action opens the live trace');
  await trace.locator('#trace-run').selectOption(''); await trace.locator('[data-mode=rounds]').click();
  await trace.locator('.trace-turn').waitFor(); await trace.locator('[data-mode=calls]').click();
  assert.equal(await trace.locator('.trace-row[data-lane=input]').count(), 0); await trace.locator('[data-mode=duration]').click();
  await conversation.locator('#message').fill('activity-stop'); await conversation.locator('#send:not([disabled])').click();
  await trace.locator('.trace-row[data-status=running]').first().waitFor();
  await conversation.getByRole('button', { name: '\u505c\u6b62', exact: true }).click();
  await trace.locator('.trace-row[data-lane=tool][data-status=stopped]').waitFor();
  await conversation.locator('.message.assistant .message-actions [aria-label="\u8f68\u8ff9"]').first().click();
  await trace.locator('.trace-row[data-lane=tool][data-status=success]').first().waitFor();
  assert.equal(await trace.locator('.trace-row[data-lane=tool][data-status=stopped]').count(), 0);
  proof.checks.push('tool details preserve arguments and results; modes, search, cancellation and historical reply targeting use the saved execution records');
  await trace.locator('#trace-project').selectOption({ label: projects[1].manifest.workflowCode.projectInfo.localizedNames['zh-CN'] });
  let workflow = await frameFor('#workflow-title'); await workflow.locator('#workflow-form[aria-busy=false]').waitFor();
  await workflow.locator('#input-mode [data-mode=raw]').click(); await workflow.locator('#raw-args').fill('["--subject","Trace first","--rounds","3","--delay","10","--review","false"]');
  await workflow.locator('#workflow-form[aria-busy=false]').waitFor(); await workflow.locator('#run:not([disabled])').click();
  await workflow.locator('#run-meta').filter({ hasText: '\u5df2\u5b8c\u6210' }).waitFor();
  await workflow.locator('#open-trace').click(); trace = await frameFor('#trace-app');
  await trace.locator('.trace-row-title').filter({ hasText: /^iteration/ }).first().waitFor();
  assert.equal(await trace.locator('.trace-row-title').filter({ hasText: /^iteration/ }).count(), 3);
  await trace.locator('#trace-search').fill('Preparing'); await trace.locator('.trace-row summary').filter({ hasText: '\u8fd0\u884c\u65e5\u5fd7' }).click();
  await trace.locator('.trace-row[open] pre').filter({ hasText: 'Preparing Trace first' }).waitFor(); await trace.locator('#trace-search').fill('');
  const first = await trace.locator('#trace-run').inputValue();
  await workflow.locator('#new').click(); await workflow.locator('#raw-args').waitFor();
  await workflow.locator('#raw-args').fill('["--subject","Trace second","--rounds","1","--delay","5","--review","false"]');
  await workflow.locator('#workflow-form[aria-busy=false]').waitFor(); await workflow.locator('#run:not([disabled])').click(); await workflow.locator('#run-output h2').filter({ hasText: 'Trace second' }).waitFor();
  await workflow.locator('#run-meta').filter({ hasText: '\u5df2\u5b8c\u6210' }).waitFor();
  await trace.locator('#trace-run').selectOption(first); await trace.locator('.trace-row-title').filter({ hasText: /^iteration/ }).nth(2).waitFor();
  assert.match(await workflow.locator('#run-output').innerText(), /Trace second/);
  assert.equal(await trace.locator('.trace-row[data-lane=tool]').count(), 0);
  proof.checks.push('Workflow shows real loop instances and logs; choosing historical traces leaves the editor run selected and project data isolated');
  await panelTabs(['Terminal', 'KV', '\u77e5\u8bc6\u5e93', '\u8f68\u8ff9']); await screenshot('workflow-light.png');
  await writeFile(settingsPath, JSON.stringify(settings('Dark Modern'))); await trace.locator('body.vscode-dark').waitFor(); await layout(trace); await screenshot('workflow-dark.png');
  await writeFile(settingsPath, JSON.stringify(settings('Default High Contrast'))); await trace.locator('body.vscode-high-contrast').waitFor(); await layout(trace); await screenshot('workflow-high-contrast.png');
  await writeFile(settingsPath, JSON.stringify(settings('Dark Modern'))); await trace.locator('body.vscode-dark').waitFor();
  await page.setViewportSize({ width: 650, height: 850 }); await layout(trace); await screenshot('workflow-narrow.png');
  proof.checks.push('VS Code light, dark and high contrast colors, rounded controls and narrow panel layout render without overflow or overlap');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await command('View: Close Editor');
  await trace.locator('#trace-project').selectOption({ label: projects[1].manifest.workflowCode.projectInfo.localizedNames['zh-CN'] });
  workflow = await frameFor('#workflow-title'); await workflow.locator('#run-meta').filter({ hasText: '\u5df2\u5b8c\u6210' }).waitFor();
  await trace.locator('#trace-run').selectOption(first); await trace.locator('.trace-row-title').filter({ hasText: /^iteration/ }).nth(2).waitFor();
  proof.checks.push('closing and reopening a project restores persisted traces through a fresh CLI connection');
  await writeFile(workspace, JSON.stringify({ folders: [{ path: ordinary }, { path: projects[2].folder }] })); await tab.waitFor({ state: 'hidden', timeout: 30_000 });
  proof.checks.push('a Kanban-only workspace hides Trace after Workflow and Conversation folders are removed');
  assert.deepEqual(proof.errors, []); await writeFile(path.join(proofDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`); console.log(JSON.stringify(proof));
} catch (error) { if (page) { await screenshot('failed.png'); const traces = []; for (const frame of page.frames()) { if (await frame.locator('#trace-app').count().catch(() => 0)) { traces.push(await frame.locator('.trace-row-title').allTextContents()); } } console.error(JSON.stringify({ checks: proof.checks, errors: proof.errors, traces })); } throw error; }
finally { await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); } await Promise.race([exited, pause(10_000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } await log.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
