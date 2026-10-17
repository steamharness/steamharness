import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { config, t } from '@vscode/l10n';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const language = process.env.STUDIO_TEST_UI_LANGUAGE ?? 'zh-cn';
assert.ok(['en', 'zh-cn'].includes(language));
const chinese = JSON.parse(await fs.readFile(path.join(root, 'extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json'), 'utf8'));
config({ contents: language === 'en' ? {} : chinese });
const nls = JSON.parse(await fs.readFile(path.join(root, `extensions/studio-workstation/package.nls${language === 'en' ? '' : '.zh-cn'}.json`), 'utf8'));
const proofDir = path.join(root, '.studio/project-info', language);
await fs.mkdir(proofDir, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-project-info-'));
const projects = [];
for (const type of ['workflow', 'conversation', 'kanban']) {
  const source = path.join(root, 'examples', type), directory = path.join(dataDir, 'projects-with-long-paths', 'workspace-information-layout-fixtures', type);
  await fs.cp(source, directory, { recursive: true, filter: file => !file.split(path.sep).includes('node_modules') });
  await fs.symlink(path.join(source, 'node_modules'), path.join(directory, 'node_modules'));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  manifest.id = crypto.randomUUID();
  manifest.name = `Info ${type} fixture`;
  manifest.description = 'A lightweight, extensible agent with a project description that remains readable in a narrow sidebar.'
    + (type === 'conversation' ? ' <img src=x onerror="window.injected=true">' : '');
  manifest.steamHarness.projectInfo = {
    declarations: ['multilingual', 'multiplatform', 'custom-declaration'], localizedNames: { 'zh-CN': `Info ${type}`, en: manifest.name },
    platformSupport: { mode: 'specific', platforms: ['macos', 'windows', 'web'] }, dataStorage: { mode: 'local' },
  };
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
  projects.push({ type, directory, manifest });
}
const grantToRelatedProject = { read: { mode: 'none' }, write: { mode: 'none' } };
projects[0].manifest.steamHarness.projectInfo.relatedProjects = [
  { alias: 'linked-conversation', projectId: projects[1].manifest.id, grantToRelatedProject },
  { alias: 'linked-missing', projectId: crypto.randomUUID(), grantToRelatedProject },
];
projects[1].manifest.steamHarness.projectInfo.relatedProjects = [{ alias: 'linked-workflow', projectId: projects[0].manifest.id, grantToRelatedProject }];
for (const project of projects.slice(0, 2)) {
  await fs.writeFile(path.join(project.directory, 'package.json'), JSON.stringify(project.manifest, null, 2));
}
const ordinary = path.join(dataDir, 'ordinary'); await fs.mkdir(ordinary);
const workspace = path.join(dataDir, 'info.code-workspace');
await fs.writeFile(workspace, JSON.stringify({ folders: [...projects.map(project => ({ path: project.directory })), { path: ordinary }] }));
await fs.mkdir(path.join(dataDir, 'User'), { recursive: true });
const settingsPath = path.join(dataDir, 'User/settings.json');
const settings = theme => ({ 'workbench.colorTheme': theme, 'window.autoDetectColorScheme': false,
  'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never' });
await fs.writeFile(settingsPath, JSON.stringify(settings('Light Modern')));
const freePort = createServer(); await new Promise(resolve => freePort.listen(0, '127.0.0.1', resolve));
const port = freePort.address().port; await new Promise(resolve => freePort.close(resolve));
const log = await fs.open(path.join(proofDir, 'desktop.log'), 'w');
const desktop = await desktopLocaleLaunch(language, dataDir);
const child = spawn(desktop.executable, [...desktop.args,
  '--user-data-dir', dataDir, '--extensions-dir', path.join(root, '.studio/desktop-extensions'),
  `--locale=${language}`, '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes',
  `--remote-debugging-port=${port}`, workspace,
], { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = { language, checks: [], screenshots: [], errors: [] };
let browser, page, infoFrame;
async function command(name, target = page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await target.locator('.part.titlebar').click({ position: { x: 300, y: 5 } }); await target.keyboard.press('F1');
    await target.locator('.quick-input-widget input').fill(`>${name}`);
    try {
      await target.locator('.quick-input-widget .monaco-list-row').filter({ has: target.locator('.label-name', { hasText: name }) }).first().click({ timeout: 3000 });
      await target.locator('.quick-input-widget').waitFor({ state: 'hidden' }); return;
    } catch (error) { if (attempt === 2) { throw error; } await target.keyboard.press('Escape'); }
  }
}
async function assistantReady(target = page) {
  for (let attempt = 0; attempt < 450; attempt++) {
    for (const frame of target.frames()) {
      if (!await frame.locator('body[data-surface=assistant] #session-list .session').count().catch(() => 0)) { continue; }
      await frame.locator('#message:not([disabled])').waitFor({ timeout: 45_000 }); return;
    }
    await pause(100);
  }
  throw new Error('The independent assistant did not finish loading');
}
function field(label) { return page.locator('.part.sidebar .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${label}$`) }) }); }
function infoField(id) { return infoFrame.locator(`[data-field="${id}"]`); }
async function informationReady() {
  for (let attempt = 0; attempt < 450; attempt++) {
    for (const frame of page.frames()) {
      if (await frame.locator('#info-app').isVisible().catch(() => false)) { infoFrame = frame; return; }
    }
    await pause(100);
  }
  throw new Error('Information webview did not finish loading');
}
async function select(project) {
  await page.locator('.part.sidebar').getByRole('button', { name: nls['command.selectInfoProject'], exact: true }).click();
  await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: `Info ${project.type}` }).click();
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
  await infoField('name').locator('.info-value').filter({ hasText: project.manifest.name }).waitFor();
}
async function screenshot(name) {
  await page.mouse.move(300, 20); await pause(300);
  await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name);
}
async function scrollbars() {
  await page.locator('.part.editor').hover({ position: { x: 30, y: 100 } });
  await infoFrame.waitForFunction(() => !document.documentElement.matches(':hover'));
  const hidden = await infoFrame.locator('html').evaluate(element => ({
    color: getComputedStyle(element).scrollbarColor, width: element.clientWidth, height: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.equal(hidden.color, 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
  assert.ok(hidden.scrollHeight > hidden.height, 'The Information fixture must overflow the viewport');
  await infoFrame.locator('body').hover({ position: { x: 12, y: 20 } });
  await infoFrame.waitForFunction(() => document.documentElement.matches(':hover'));
  const shown = await infoFrame.locator('html').evaluate(element => ({
    color: getComputedStyle(element).scrollbarColor, width: element.clientWidth, height: element.clientHeight,
  }));
  assert.notEqual(shown.color, hidden.color);
  assert.equal(shown.width, hidden.width); assert.equal(shown.height, hidden.height);
  await page.locator('.part.editor').hover({ position: { x: 30, y: 100 } });
  // CDP does not forward the top-level mouse leave to an out-of-process Webview.
  const session = await page.context().newCDPSession(infoFrame.parentFrame());
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -1, y: -1 });
  await session.detach();
  await infoFrame.waitForFunction(() => !document.documentElement.matches(':hover'));
  assert.equal(await infoFrame.locator('html').evaluate(element => getComputedStyle(element).scrollbarColor), hidden.color);
  proof.checks.push('Information viewport scrollbars override the Webview defaults, show only on hover, and preserve layout');
}
async function layout() {
  const result = await page.locator('.part.sidebar').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right, viewport: innerWidth, rows: [...element.querySelectorAll('.monaco-list-row')].map(row => {
      const box = row.getBoundingClientRect(); return { left: box.left, right: box.right };
    }) };
  });
  assert.ok(result.width > 0 && result.left >= 0 && result.right <= result.viewport, JSON.stringify(result));
  assert.ok(result.rows.every(row => row.left >= result.left - 1 && row.right <= result.right + 1), JSON.stringify(result));
  if (!await infoFrame?.locator('#info-app').isVisible().catch(() => false)) { return; }
  const content = await infoFrame.locator('#info-app').evaluate(element => ({
    width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    values: [...element.querySelectorAll('.info-value')].filter(value => value.getClientRects().length).map(value => {
      const rect = value.getBoundingClientRect(); return { left: rect.left, right: rect.right, overflow: value.scrollWidth - value.clientWidth };
    }),
  }));
  assert.ok(content.overflow <= 1 && content.values.length, JSON.stringify(content));
  assert.ok(content.values.every(value => value.left >= 0 && value.right <= content.width && value.overflow <= 1), JSON.stringify(content));
}
async function sidebarWidth(width) {
  const rect = await page.locator('.part.sidebar').boundingBox();
  const sashes = await page.locator('.monaco-sash.vertical:not(.disabled)').all();
  for (const sash of sashes) {
    const box = await sash.boundingBox();
    if (!box || Math.abs(box.x + box.width / 2 - rect.x - rect.width) > 6 || box.height < rect.height / 2) { continue; }
    const x = box.x + box.width / 2, y = box.y + 120;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + width - rect.width, y, { steps: 12 }); await page.mouse.up(); await pause(250);
    const resized = await page.locator('.part.sidebar').boundingBox();
    assert.ok(Math.abs(resized.width - width) < 8, JSON.stringify({ width, actual: resized.width })); return;
  }
  throw new Error('Sidebar resize sash was not found');
}
try {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch { /* Wait for Electron. */ }
    if (child.exitCode !== null) { throw new Error('Studio exited before startup'); } await pause(100);
  }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(20_000); page.on('pageerror', error => proof.errors.push(error.message));
  await page.bringToFront(); await page.setViewportSize({ width: 1440, height: 1000 });
  const activity = page.locator('.part.activitybar');
  const info = activity.getByRole('tab', { name: new RegExp(`^${t('Information')}(?:\\s|$)`) });
  await info.waitFor({ timeout: 45_000 }); await assistantReady(); await info.click();
  await informationReady(); await sidebarWidth(440);
  assert.equal(await infoFrame.locator('html').getAttribute('lang'), language);
  assert.equal(await activity.getByRole('tab', { name: /Run and Debug|\u8fd0\u884c\u548c\u8c03\u8bd5/ }).count(), 0);
  for (const project of projects) {
    await select(project);
    assert.equal(await infoField('type').locator('.info-value').innerText(), t(project.type[0].toUpperCase() + project.type.slice(1)));
    assert.equal(await infoField('uuid').locator('.info-value').innerText(), project.manifest.id);
    assert.equal(await infoField('path').locator('.info-value').innerText(), project.directory);
    assert.equal(await infoField('description').locator('.info-value').innerText(), project.manifest.description);
    assert.equal(await infoFrame.locator('#info-app img').count(), 0, 'Project descriptions must remain plain text');
    await infoField('declaration:multilingual').waitFor(); await infoField('declaration:multiplatform').waitFor(); await infoField('declaration:custom-declaration').waitFor();
    await layout();
    proof.checks.push(`${project.type}: information details display complete values and translated labels in the primary sidebar`);
  }
  await select(projects[0]);
  await screenshot('light-desktop.png');
  await page.locator('.part.sidebar').screenshot({ path: path.join(proofDir, 'info-sidebar.png') }); proof.screenshots.push('info-sidebar.png');
  await sidebarWidth(260); await page.setViewportSize({ width: 1100, height: 850 }); await layout(); await screenshot('light-narrow.png');
  await scrollbars();
  const stacked = await infoField('name').evaluate(element => element.querySelector('.info-value').getBoundingClientRect().top >= element.querySelector('dt').getBoundingClientRect().bottom);
  assert.equal(stacked, true, 'Narrow sidebars stack field labels above values');
  await writeTheme();
  await layout(); await screenshot('dark-narrow.png');
  await page.setViewportSize({ width: 1440, height: 1000 }); await sidebarWidth(440); await layout(); await screenshot('dark-desktop.png');
  await infoFrame.locator('[data-section="names"] > summary').click();
  projects[0].manifest.version = '9.9.9';
  await fs.writeFile(path.join(projects[0].directory, 'package.json'), JSON.stringify(projects[0].manifest, null, 2));
  await infoField('version').locator('.info-value').filter({ hasText: '9.9.9' }).waitFor({ timeout: 45_000 });
  assert.equal(await infoFrame.locator('[data-section="names"]').getAttribute('open'), null);
  await select(projects[1]); await select(projects[0]);
  assert.equal(await infoFrame.locator('[data-section="names"]').getAttribute('open'), null);
  proof.checks.push('manifest refresh and project switches preserve each project\'s section state');
  await page.locator('.part.sidebar').getByRole('button', { name: nls['command.openInfoProjectSource'], exact: true }).click();
  await page.locator('.part.editor .tab.active').filter({ hasText: 'package.json' }).waitFor();
  await infoField('uuid').hover();
  const copy = infoField('uuid').getByRole('button', { name: t('Copy {0}', t('Project UUID')), exact: true });
  await copy.click(); await infoField('uuid').locator('.copy-button.copied').waitFor();
  assert.equal(await infoFrame.locator('#info-announcement').innerText(), t('Copied'));
  proof.checks.push('the selected manifest opens in the native editor and copying a complete UUID receives clipboard success feedback');
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: projects[0].directory }, { path: ordinary }] }));
  await page.locator('.part.sidebar').getByRole('button', { name: nls['command.selectInfoProject'], exact: true }).waitFor({ state: 'hidden', timeout: 45_000 });
  await command('View: Show Explorer');
  const relatedHeader = page.locator('.part.sidebar .pane-header').filter({ hasText: t('Related Projects') });
  await relatedHeader.waitFor();
  if (await relatedHeader.getAttribute('aria-expanded') === 'false') { await relatedHeader.click(); }
  const headers = await page.locator('.part.sidebar .pane-header').allTextContents();
  assert.ok(headers.every(title => !/Outline|Timeline|NPM Scripts|\u5927\u7eb2|\u65f6\u95f4\u7ebf/i.test(title)), JSON.stringify(headers));
  await field('linked-conversation').locator('.label-description').filter({ hasText: projects[1].manifest.steamHarness.projectInfo.localizedNames[language === 'en' ? 'en' : 'zh-CN'] }).waitFor();
  assert.equal(await field('linked-missing').locator('.label-description').innerText(), t('Not imported'));
  await layout(); await screenshot('related-projects.png');
  proof.checks.push('Explorer replaces Outline, Timeline and NPM Scripts with related projects and retains imported projects after removing their workspace roots');
  await field('linked-missing').locator('.label-name').click();
  await page.getByText(t('Related project "{0}" has not been imported. Import it first.', 'linked-missing'), { exact: true }).waitFor();
  await page.getByRole('button', { name: t('Import Project'), exact: true }).waitFor();
  proof.checks.push('an unimported related project displays the import prompt');
  await command('Notifications: Clear All Notifications');
  const previousPages = new Set(browser.contexts()[0].pages());
  await field('linked-conversation').locator('.label-name').click();
  let opened;
  for (let attempt = 0; attempt < 100; attempt++) {
    opened = browser.contexts()[0].pages().find(candidate => !previousPages.has(candidate) && candidate.url().includes('workbench'));
    if (opened) { break; } await pause(100);
  }
  assert.ok(opened, 'A related project must open a new native Studio window');
  opened.setDefaultTimeout(45_000); opened.on('pageerror', error => proof.errors.push(error.message));
  await opened.bringToFront(); await assistantReady(opened); await command('View: Show Explorer', opened);
  const packageFile = opened.locator('.part.sidebar .monaco-list-row').filter({ has: opened.locator('.label-name', { hasText: /^package\.json$/ }) });
  await packageFile.first().dblclick();
  await opened.locator('.part.editor .view-lines').filter({ hasText: projects[1].manifest.id }).waitFor();
  assert.equal(page.isClosed(), false, 'Opening a related project must preserve the original window');
  proof.checks.push('clicking an imported related project opens the matching UUID in a new native window and preserves the source window');
  await opened.close(); await page.bringToFront();
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: ordinary }] }));
  await info.waitFor({ state: 'hidden', timeout: 45_000 });
  assert.equal(await activity.getByRole('tab', { name: /Run and Debug|\u8fd0\u884c\u548c\u8c03\u8bd5/ }).count(), 0);
  proof.checks.push('ordinary workspaces hide the information tab even while the independent assistant remains available');
  await screenshot('ordinary-workspace.png');
  assert.deepEqual(proof.errors, []);
  assert.doesNotMatch(await fs.readFile(path.join(proofDir, 'desktop.log'), 'utf8'), /No view is registered with id: npm/);
  await fs.writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof));
} catch (error) { if (page) { await page.screenshot({ path: path.join(proofDir, 'failed.png') }); } throw error; }
finally {
  await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); }
  await Promise.race([exited, pause(10_000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  await log.close(); await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
async function writeTheme() {
  await fs.writeFile(settingsPath, JSON.stringify(settings('Dark Modern'))); await page.locator('.monaco-workbench.vs-dark').waitFor(); await pause(500);
}
