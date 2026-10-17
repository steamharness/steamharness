import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readFile, writeFile, cp, symlink, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(path.join(root, 'extensions/studio-workstation/package.nls.zh-cn.json'), 'utf8'));
const core = await import(resolve('workflow-code', new URL('../examples/conversation/package.json', import.meta.url).href));
const proofDir = path.join(root, '.studio/resources-panel'); await mkdir(proofDir, { recursive: true });
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-resource-ui-')));
const dataDir = path.join(directory, 'user'); await mkdir(path.join(dataDir, 'User'), { recursive: true });
const settingsPath = path.join(dataDir, 'User/settings.json');
await writeFile(settingsPath, JSON.stringify({ 'workbench.colorTheme': 'Light Modern', 'git.openRepositoryInParentFolders': 'never', 'workbench.startupEditor': 'none' }));
const ordinary = path.join(directory, 'ordinary'); await mkdir(ordinary);
await writeFile(path.join(ordinary, 'notes.txt'), 'Ordinary folder');
const workspace = path.join(directory, 'resources.code-workspace');
const folders = [{ path: ordinary }]; await writeFile(workspace, JSON.stringify({ folders }));
const projects = [];
const storageDir = path.join(dataDir, 'User/globalStorage/studio.studio-workstation/workflow/web');
for (const type of ['conversation', 'workflow', 'kanban']) {
  const original = path.join(root, 'examples', type), folder = path.join(directory, type);
  await cp(original, folder, { recursive: true, filter: entry => !entry.split(path.sep).includes('node_modules') });
  await mkdir(path.join(folder, 'node_modules/@workflow-code'), { recursive: true });
  await symlink(await realpath(path.join(original, 'node_modules/workflow-code')), path.join(folder, 'node_modules/workflow-code'), 'dir');
  await symlink(await realpath(path.join(original, 'node_modules/@workflow-code/cli')), path.join(folder, 'node_modules/@workflow-code/cli'), 'dir');
  const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  const data = path.join(storageDir, createHash('sha256').update(folder).digest('hex').slice(0, 24));
  const kv = core.createWorkflowKVContext({ projectId: manifest.id, store: core.createLocalWorkflowKVStore({ rootDir: path.join(data, 'kv') }) });
  await kv.setValue(`${type}.state`, { type, active: true, count: 7 });
  for (let index = 0; index < 31; index++) { await kv.setValue(`item.${String(index).padStart(2, '0')}`, index); }
  const values = core.createWorkflowPersistentValueContext({ projectId: manifest.id, store: core.createLocalWorkflowKVStore({ rootDir: path.join(data, 'values'), storageKind: 'persistent_value' }) });
  await core.createKnowledgeDocument({ persistentValue: values }, { title: `${type} notes`, markdown: `# ${type}\n\nPanel resource evidence.\n\n- First item\n- Second item` });
  projects.push({ type, folder, manifest, kv, values });
}
const debug = createServer(); await new Promise(resolve => debug.listen(0, '127.0.0.1', resolve)); const port = debug.address().port; await new Promise(resolve => debug.close(resolve));
const log = await open(path.join(proofDir, 'desktop.log'), 'w');
const desktop = await desktopLocaleLaunch('zh-cn', directory);
const child = spawn(desktop.executable, [...desktop.args, '--user-data-dir', dataDir,
  '--extensions-dir', path.join(root, '.studio/desktop-extensions'), '--locale=zh-cn', '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, workspace],
  { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, WORKFLOW_SERVER_URL: '', WORKFLOW_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = { checks: [], screenshots: [], errors: [] };
let browser, page;
async function command(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.bringToFront(); await page.locator('.part.editor .editor-group-container').first().focus(); await page.keyboard.press('F1');
      await page.locator('.quick-input-widget input').fill(`>${name}`, { timeout: 3000 });
      await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first().click({ timeout: 3000 });
      await page.locator('.quick-input-widget').waitFor({ state: 'hidden' }); return;
    } catch (error) { if (attempt === 2) { throw error; } await page.keyboard.press('Escape'); }
  }
}
async function frameFor(kind) {
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !await frame.locator(`body[data-resource-kind=${kind}]`).count()) { continue; }
      let current = frame, visible = true;
      while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
      if (visible) { return frame; }
    }
    await pause(100);
  }
  throw new Error(`Resource frame unavailable: ${kind}`);
}
async function snapshot(name) { await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function stable(frame) { await frame.locator('#resources-app[data-loading=false]').waitFor(); }
async function layout(frame) {
  const result = await frame.evaluate(() => {
    const boxes = [...document.querySelectorAll('.resource-toolbar > .select-control, .resource-search, .resource-toolbar-actions, .detail-toolbar button, .detail-title, #detail-dirty')]
      .filter(item => item.getClientRects().length).map(item => item.getBoundingClientRect());
    return { viewport: innerWidth, width: document.documentElement.scrollWidth,
      outside: boxes.some(box => box.left < 0 || box.right > innerWidth),
      overlap: boxes.some((box, index) => boxes.slice(index + 1).some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) };
  });
  assert.ok(result.width <= result.viewport && !result.outside && !result.overlap, JSON.stringify(result));
}
try {
  for (let attempt = 0; attempt < 250; attempt++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch {} if (child.exitCode !== null) { throw new Error('Studio exited before startup.'); } await pause(100); }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(20_000); page.on('pageerror', error => proof.errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 980 });
  await command(`Studio: ${catalog['command.openTerminal']}`);
  const panel = page.locator('.part.panel'); await panel.waitFor();
  await pause(500);
  const tabLabels = () => panel.locator('.composite-bar .action-label').allTextContents();
  const initial = (await tabLabels()).map(value => value.toLowerCase());
  assert.ok(initial.some(value => value.includes('terminal')), JSON.stringify(initial));
  assert.ok(!initial.some(value => /problems|output|debug|ports|knowledge|\bkv\b/.test(value)), JSON.stringify(initial));
  proof.checks.push('an ordinary folder has only the Terminal panel; Problems, Output, Debug Console and Ports are absent');
  await writeFile(workspace, JSON.stringify({ folders: [...folders, ...projects.map(project => ({ path: project.folder }))] }));
  const kvTab = panel.locator('.composite-bar .action-label').filter({ hasText: /^KV$/ }); await kvTab.waitFor({ timeout: 45_000 }); await kvTab.click();
  let kv = await frameFor('kv'); await kv.locator('.resource-row').first().waitFor(); await stable(kv);
  assert.equal(await kv.locator('#resource-project option').count(), 3);
  await kv.locator('#resource-project').selectOption({ label: projects[0].manifest.workflowCode.projectInfo.localizedNames['zh-CN'] });
  await stable(kv); await kv.locator('#resource-search').fill('conversation.state'); await kv.locator('.resource-row').filter({ hasText: 'conversation.state' }).click();
  await kv.locator('.detail-content').filter({ hasText: '"count": 7' }).waitFor();
  await snapshot('kv-light.png'); await layout(kv);
  await kv.locator('#detail-edit').click(); await kv.locator('#detail-body').fill('{"type":"conversation","count":9}'); await kv.locator('#detail-save').click();
  await kv.locator('.detail-content').filter({ hasText: '"count": 9' }).waitFor(); assert.equal((await projects[0].kv.getValue('conversation.state')).count, 9);
  await kv.locator('#resource-search').fill(''); await stable(kv); await kv.locator('#resource-next:not([disabled])').waitFor(); await kv.locator('#resource-next').click(); await stable(kv); assert.equal(await kv.locator('.resource-row').count(), 2);
  await kv.locator('#resource-previous').click(); await stable(kv); assert.equal(await kv.locator('.resource-row').count(), 30);
  proof.checks.push('all three project types expose resources; local KV edits and paginated lists share Core runtime data');
  const knowledgeTab = panel.locator('.composite-bar .action-label').filter({ hasText: /^\u77e5\u8bc6\u5e93$/ }); await knowledgeTab.click();
  let knowledge = await frameFor('knowledge'); await knowledge.locator('.resource-row').first().waitFor(); await stable(knowledge);
  await knowledge.locator('.resource-row').filter({ hasText: 'conversation notes' }).click(); await knowledge.locator('.markdown-body h1').filter({ hasText: 'conversation' }).waitFor(); await snapshot('knowledge-light.png');
  await knowledge.locator('#resource-search').fill('evidence'); await knowledge.locator('.row-meta').filter({ hasText: 'L3' }).waitFor();
  await knowledge.locator('#resource-new').click(); await knowledge.locator('#detail-title-input').fill('Created from panel'); await knowledge.locator('#detail-body').fill('# Created\n\nNew evidence'); await knowledge.locator('#detail-save').click();
  await knowledge.locator('.markdown-body h1').filter({ hasText: 'Created' }).waitFor();
  assert.ok((await core.listKnowledgeDocuments({ persistentValue: projects[0].values })).some(document => document.title === 'Created from panel'));
  proof.checks.push('knowledge Markdown preview, full-text search and document creation work in the bottom panel');
  await writeFile(settingsPath, JSON.stringify({ 'workbench.colorTheme': 'Dark Modern', 'git.openRepositoryInParentFolders': 'never' }));
  await knowledge.locator('body.vscode-dark').waitFor(); await snapshot('knowledge-dark.png');
  await writeFile(settingsPath, JSON.stringify({ 'workbench.colorTheme': 'Default High Contrast', 'git.openRepositoryInParentFolders': 'never' }));
  await knowledge.locator('body.vscode-high-contrast').waitFor(); await layout(knowledge); await snapshot('knowledge-high-contrast.png');
  await writeFile(settingsPath, JSON.stringify({ 'workbench.colorTheme': 'Dark Modern', 'git.openRepositoryInParentFolders': 'never' }));
  await knowledge.locator('body.vscode-dark').waitFor();
  await page.setViewportSize({ width: 650, height: 850 }); await layout(knowledge); await snapshot('knowledge-narrow.png');
  await knowledge.locator('#detail-back').click(); await knowledge.locator('#resource-project').selectOption({ label: projects[2].manifest.workflowCode.projectInfo.localizedNames['zh-CN'] });
  await knowledge.locator('.resource-row').filter({ hasText: 'kanban notes' }).waitFor(); await stable(knowledge);
  assert.equal(await knowledge.locator('.resource-row').filter({ hasText: 'conversation notes' }).count(), 0);
  await kvTab.click(); kv = await frameFor('kv'); await kv.locator('#resource-search').fill('kanban.state'); await kv.locator('.resource-row').filter({ hasText: 'kanban.state' }).waitFor();
  await layout(kv); await snapshot('kv-narrow.png');
  proof.checks.push('light/dark/high-contrast themes, narrow panels and synchronized project selection preserve layout and data isolation');
  await writeFile(workspace, JSON.stringify({ folders })); await kvTab.waitFor({ state: 'hidden', timeout: 30_000 }); await knowledgeTab.waitFor({ state: 'hidden' });
  proof.checks.push('removing the Workflow folders hides both resource tabs');
  assert.deepEqual(proof.errors, []); await writeFile(path.join(proofDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`); console.log(JSON.stringify(proof));
} catch (error) { if (page) { await snapshot('failed.png'); console.error(JSON.stringify({ checks: proof.checks, errors: proof.errors, frames: page.frames().map(frame => frame.url()) })); } throw error; }
finally { await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); } await Promise.race([exited, pause(10_000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } await log.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
