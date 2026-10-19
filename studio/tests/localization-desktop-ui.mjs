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
const proofRoot = path.join(root, '.studio/localization');
const chinese = await fs.readFile(path.join(root, 'extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json'), 'utf8');
const nlsEnglish = JSON.parse(await fs.readFile(path.join(root, 'extensions/studio-workstation/package.nls.json'), 'utf8'));
const nlsChinese = JSON.parse(await fs.readFile(path.join(root, 'extensions/studio-workstation/package.nls.zh-cn.json'), 'utf8'));
const nativeChinese = Object.fromEntries(Object.entries(nlsEnglish).map(([key, value]) => [value, nlsChinese[key]]));
const cliChinese = { 'Send': '\u53d1\u9001', 'Refresh Kanban': '\u5237\u65b0\u770b\u677f',
  'New configuration': '\u65b0\u5efa\u914d\u7f6e', 'Phone': '\u624b\u673a', 'Page methods': '\u9875\u9762\u65b9\u6cd5' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const languages = process.env.STUDIO_TEST_UI_LANGUAGES?.split(',') ?? ['en', 'zh-cn'];
assert.ok(languages.every(language => ['en', 'zh-cn'].includes(language)));
for (const language of languages) { await verify(language); }

async function verify(language) {
  config({ contents: language === 'en' ? {} : { ...cliChinese, ...JSON.parse(chinese), ...nativeChinese } });
  const proofDir = path.join(proofRoot, language); await fs.mkdir(proofDir, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sl-')));
  const profile = path.join(directory, 'u'); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Light Modern',
    'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never' }));
  const projects = [];
  for (const [type, relative] of [['workflow', 'examples/workflow'], ['conversation', 'tests/fixtures/conversation-features'], ['kanban', 'examples/kanban']]) {
    const source = path.join(root, relative), folder = path.join(directory, type);
    await fs.cp(source, folder, { recursive: true, filter: file => !file.split(path.sep).includes('node_modules') });
    await fs.mkdir(path.join(folder, 'node_modules/@steamharness'), { recursive: true });
    await fs.symlink(await fs.realpath(path.join(source, 'node_modules/steamharness')), path.join(folder, 'node_modules/steamharness'), 'dir');
    const cli = process.env.STUDIO_TEST_CLI_DIR ?? await fs.realpath(path.join(source, 'node_modules/@steamharness/cli'));
    await fs.symlink(cli, path.join(folder, 'node_modules/@steamharness/cli'), 'dir');
    const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
    manifest.description = '\u539f\u59cb\u9879\u76ee\u63cf\u8ff0';
    manifest.steamHarness.projectInfo = { ...manifest.steamHarness.projectInfo, declarations: ['multilingual', 'multiplatform'],
      dataStorage: { mode: 'local' }, relatedProjects: type === 'workflow' ? [{ alias: 'linked-missing', projectId: crypto.randomUUID() }] : [] };
    await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify(manifest, null, 2)); projects.push({ type, folder, manifest });
  }
  const workspace = path.join(directory, 'localized.code-workspace');
  await fs.writeFile(workspace, JSON.stringify({ folders: projects.map(project => ({ path: project.folder })) }));
  const freePort = createServer(); await new Promise(resolve => freePort.listen(0, '127.0.0.1', resolve));
  const port = freePort.address().port; await new Promise(resolve => freePort.close(resolve));
  const log = await fs.open(path.join(proofDir, 'desktop.log'), 'w');
  const desktop = await desktopLocaleLaunch(language, directory);
  const child = spawn(desktop.executable, [...desktop.args, '--user-data-dir', profile,
    '--extensions-dir', path.join(root, '.studio/desktop-extensions'), `--locale=${language}`, '--disable-workspace-trust',
    '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, workspace],
  { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const proof = { language, checks: [], screenshots: [], errors: [] }; let browser, page;
  const exact = value => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  async function frameFor(selector) {
    for (let attempt = 0; attempt < 450; attempt++) {
      for (const frame of page.frames()) { if (await frame.locator(selector).first().isVisible().catch(() => false)) { return frame; } }
      await pause(100);
    }
    throw new Error(`Frame unavailable: ${selector}`);
  }
  async function command(name) {
    await page.locator('.part.titlebar').click({ position: { x: 200, y: 5 } }); await page.keyboard.press('F1');
    await page.locator('.quick-input-widget input').fill(`>${name}`);
    await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first().click();
    await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
  }
  function field(label) { return page.locator('.part.sidebar .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${label}$`) }) }); }
  async function screenshot(name) { await page.mouse.move(300, 20); await pause(250); await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
  async function panel(name, selector) {
    const tab = page.locator('.part.panel').getByRole('tab', { name: exact(name) });
    if (!await tab.isVisible()) { await command('View: Toggle Panel Visibility'); }
    await tab.click(); return frameFor(selector);
  }
  try {
    for (let attempt = 0; attempt < 250; attempt++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch {} if (child.exitCode !== null) { throw new Error('Studio exited during startup'); } await pause(100); }
    await desktop.waitUntilReady(child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(page => page.url().includes('workbench')); if (page) { break; } await pause(100); }
    assert.ok(page); page.setDefaultTimeout(30_000); page.on('pageerror', error => proof.errors.push(error.message));
    await page.bringToFront(); await page.setViewportSize({ width: 1440, height: 1000 });
    const assistant = await frameFor('body[data-surface=assistant] #message');
    await assistant.locator('#message:not([disabled])').waitFor();
    assert.equal(await assistant.locator('html').getAttribute('lang'), language === 'en' ? 'en' : 'zh-CN');
    assert.equal(await assistant.locator('#send').getAttribute('aria-label'), t('Send'));
    assert.equal(await assistant.locator('#history-toggle').getAttribute('title'), t('Search conversations'));
    proof.checks.push('Assistant controls and document language follow VS Code');
    await page.locator('.part.activitybar').getByRole('tab', { name: exact(t('Information')) }).click();
    const information = await frameFor('#info-app');
    assert.equal(await information.locator('html').getAttribute('lang'), language);
    for (const project of projects) {
      await page.locator('.part.sidebar').getByRole('button', { name: t('Select Project'), exact: true }).click();
      await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: project.folder }).click();
      await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
      await information.locator('[data-field="uuid"] .info-value').filter({ hasText: project.manifest.id }).waitFor();
      assert.equal(await information.locator('[data-field="description"] .info-value').innerText(), project.manifest.description);
      assert.equal(await information.locator('[data-field="type"] .info-value').innerText(), t(project.type[0].toUpperCase() + project.type.slice(1)));
      await information.getByText(t('Multiple languages'), { exact: true }).waitFor(); await information.getByText(t('Multiple platforms'), { exact: true }).waitFor();
    }
    await screenshot('information-assistant.png'); proof.checks.push('Workflow, Conversation and Kanban information labels are translated; manifest content is preserved');
    await command('View: Show Explorer');
    const related = page.locator('.part.sidebar .pane-header').filter({ hasText: t('Related Projects') }); await related.waitFor();
    if (await related.getAttribute('aria-expanded') === 'false') { await related.click(); }
    await field('linked-missing').locator('.label-description').filter({ hasText: t('Not imported') }).waitFor();
    await field('linked-missing').locator('.label-name').click();
    await page.getByText(t('Related project "{0}" has not been imported. Import it first.', 'linked-missing'), { exact: true }).waitFor();
    await page.getByRole('button', { name: t('Import Project'), exact: true }).waitFor();
    await screenshot('related-projects.png'); await command('Notifications: Clear All Notifications');
    proof.checks.push('Related project state, import notification and action are translated');
    projects[0].manifest.steamHarness.projectInfo.relatedProjects = [];
    await fs.writeFile(path.join(projects[0].folder, 'package.json'), JSON.stringify(projects[0].manifest, null, 2));
    const runButton = page.locator('.part.titlebar .studio-workflow-run .action-label');
    assert.ok((await runButton.getAttribute('aria-label'))?.includes(t('Run Project')));
    await runButton.click();
    const projectFrame = await frameFor('#workflow-title'); await projectFrame.locator('#workflow-form[aria-busy=false]').waitFor();
    assert.equal((await projectFrame.locator('#run').innerText()).trim(), t('Run'));
    await projectFrame.locator('#input-mode [data-mode=raw]').click();
    await projectFrame.locator('#raw-args').fill(JSON.stringify(['--subject', '\u4e2d\u6587\u6267\u884c\u53c2\u6570', '--rounds', '2', '--delay', '5', '--review', 'false']));
    await projectFrame.locator('#run:not([disabled])').click(); await projectFrame.locator('#run-meta').filter({ hasText: t('Completed') }).waitFor();
    await projectFrame.locator('#open-trace').click();
    const trace = await frameFor('#trace-app');
    assert.equal(await trace.locator('#trace-search').getAttribute('placeholder'), t('Search trace'));
    assert.equal(await trace.locator('[data-mode=duration] span:last-child').innerText(), t('Duration'));
    await trace.locator('.trace-row[data-lane=log] summary').click();
    await trace.locator('.trace-row[open] pre').filter({ hasText: '\u4e2d\u6587\u6267\u884c\u53c2\u6570' }).waitFor();
    await screenshot('run-trace.png'); proof.checks.push('Run icon tooltip, execution controls and trace labels are translated; actual logs stay intact');
    const kv = await panel('KV', '#resources-app');
    assert.equal(await kv.locator('#resource-search').getAttribute('placeholder'), t('Search keys or values'));
    await kv.locator('#resource-new:not([disabled])').click();
    await kv.locator('#detail-title-input').fill('i18n/sample'); await kv.locator('#detail-body').fill(JSON.stringify('\u4e2d\u6587\u539f\u6587'));
    await kv.locator('#detail-save').click(); await kv.locator('.detail-content pre').filter({ hasText: '\u4e2d\u6587\u539f\u6587' }).waitFor();
    await screenshot('kv.png');
    const knowledge = await panel(t('Knowledge'), 'body[data-resource-kind=knowledge] #resources-app');
    assert.equal(await knowledge.locator('#resource-search').getAttribute('placeholder'), t('Search document content'));
    await knowledge.locator('#resource-new:not([disabled])').click();
    await knowledge.locator('#detail-title-input').fill('\u4e2d\u6587\u6587\u6863'); await knowledge.locator('#detail-body').fill('# \u539f\u6587\n\n\u4fdd\u6301\u4e2d\u6587\u5185\u5bb9');
    await knowledge.locator('#detail-save').click(); await knowledge.locator('.markdown-body').filter({ hasText: '\u4fdd\u6301\u4e2d\u6587\u5185\u5bb9' }).waitFor();
    await screenshot('knowledge.png'); proof.checks.push('KV and knowledge controls follow VS Code and preserve saved content');
    await page.setViewportSize({ width: 1100, height: 850 }); await screenshot('narrow.png');
    const dimensions = await knowledge.locator('body').evaluate(body => ({ width: body.clientWidth, scroll: body.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.part.activitybar').getByRole('tab', { name: exact('Studio') }).click();
    for (const label of ['New File', 'New Terminal', 'Run Task', 'Source Control', 'Extensions', 'Settings']) { await field(t(label)).waitFor(); }
    proof.checks.push('Studio tools use the host language even without a source-mode language pack');
    const projectName = project => project.manifest.steamHarness.projectInfo.localizedNames?.[language === 'en' ? 'en' : 'zh-CN'] ?? project.manifest.name;
    await field(projectName(projects[1])).locator('.label-name').click();
    const conversation = await frameFor('body[data-surface=editor] #message');
    await conversation.locator('#message:not([disabled])').waitFor();
    assert.equal(await conversation.locator('#send').getAttribute('aria-label'), t('Send'));
    assert.equal(await conversation.locator('#history-toggle').getAttribute('title'), t('Search conversations'));
    await conversation.locator('#message').fill('\u5bf9\u8bdd\u539f\u6587'); await conversation.locator('#send').click();
    await conversation.locator('.message.assistant:not(.streaming) .message-content').filter({ hasText: '\u5bf9\u8bdd\u539f\u6587' }).waitFor();
    await conversation.getByRole('button', { name: t('Trace'), exact: true }).click();
    const conversationTrace = await frameFor('#trace-app');
    await conversationTrace.locator('.trace-row[data-lane=input]').filter({ hasText: '\u5bf9\u8bdd\u539f\u6587' }).waitFor();
    await screenshot('conversation-trace.png'); proof.checks.push('Conversation controls and trace action follow VS Code; reply and input keep their original language');
    await field(projectName(projects[2])).locator('.label-name').click();
    const kanban = await frameFor('#kanban-title');
    await kanban.locator('#preview-status').waitFor({ state: 'hidden' });
    assert.equal(await kanban.locator('#refresh').getAttribute('title'), t('Refresh Kanban'));
    assert.equal(await kanban.locator('#create').getAttribute('title'), t('New configuration'));
    assert.equal(await kanban.locator('[data-mode=phone]').getAttribute('title'), t('Phone'));
    await kanban.locator('#methods').click();
    assert.equal(await kanban.locator('#methods-dialog h2').innerText(), t('Page methods'));
    await kanban.locator('#close-methods').click(); await screenshot('kanban.png');
    proof.checks.push('Kanban host controls and dialogs follow VS Code; project-owned board content is preserved');
    await command(`Workflow: ${t('Sign In and Manage Account')}`);
    const account = await frameFor('#account-app');
    assert.equal(await account.locator('h1').innerText(), t('SteamHarness Account'));
    assert.equal(await account.locator('#show-password').getAttribute('title'), t('Show password'));
    assert.equal(await account.locator('#login-submit span:last-child').textContent(), t('Sign in'));
    await screenshot('account.png'); proof.checks.push('Account page headings, labels and password controls follow VS Code');
    assert.deepEqual(proof.errors, []);
    await fs.writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof));
  } catch (error) {
    if (page && !page.isClosed()) {
      await screenshot('failed.png');
      console.error(JSON.stringify({ panes: await page.locator('.part.sidebar .pane-header').evaluateAll(panes => panes.map(pane => ({ text: pane.textContent, html: pane.outerHTML }))) }));
    }
    console.error(JSON.stringify(proof)); throw error;
  }
  finally {
    await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); }
    await Promise.race([exited, pause(10_000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    await log.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
