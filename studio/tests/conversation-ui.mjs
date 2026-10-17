import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const proofDir = path.join(root, '.studio/conversation-migration');
await fs.mkdir(proofDir, { recursive: true });
const dataDir = await fs.mkdtemp('/tmp/studio-conversation-');
const parallelDir = path.join(dataDir, 'parallel-conversation');
await fs.mkdir(parallelDir);
const fixture = path.join(root, 'tests/fixtures/conversation-features');
let fixtureDir = fixture;
if (process.env.STEAMHARNESS_UI_CLI_ENTRY) {
  fixtureDir = path.join(dataDir, 'conversation-features'); await fs.mkdir(fixtureDir);
  for (const filename of ['package.json', 'index.ts']) { await fs.cp(path.join(fixture, filename), path.join(fixtureDir, filename)); }
  await fs.mkdir(path.join(fixtureDir, 'node_modules/@steamharness'), { recursive: true });
  await fs.symlink(await fs.realpath(path.join(fixture, 'node_modules/steamharness')), path.join(fixtureDir, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(path.resolve(path.dirname(process.env.STEAMHARNESS_UI_CLI_ENTRY), '..'), path.join(fixtureDir, 'node_modules/@steamharness/cli'), process.platform === 'win32' ? 'junction' : 'dir');
}
const parallelManifest = JSON.parse(await fs.readFile(path.join(fixtureDir, 'package.json'), 'utf8'));
const cliVersion = JSON.parse(await fs.readFile(path.join(fixtureDir, 'node_modules/@steamharness/cli/package.json'), 'utf8')).version;
if (!process.env.STEAMHARNESS_UI_CLI_ENTRY) { assert.equal(cliVersion, parallelManifest.devDependencies['@steamharness/cli']); }
parallelManifest.id = 'b20a7d1d-b6f5-4b0c-8589-265d56fc879a';
parallelManifest.name = 'Offline parallel conversation';
parallelManifest.steamHarness.projectInfo = { localizedNames: { 'zh-CN': '\u5bf9\u8bdd\u793a\u4f8b' }, dataStorage: { mode: 'local' } };
await fs.writeFile(path.join(parallelDir, 'package.json'), JSON.stringify(parallelManifest));
await fs.writeFile(path.join(parallelDir, 'index.ts'), await fs.readFile(path.join(fixtureDir, 'index.ts'), 'utf8'));
await fs.symlink(path.join(fixtureDir, 'node_modules'), path.join(parallelDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const workspacePath = path.join(dataDir, 'conversation-regression.code-workspace');
await fs.writeFile(workspacePath, JSON.stringify({ folders: [
  { path: fixtureDir }, { path: parallelDir },
] }));
await fs.mkdir(path.join(dataDir, 'User'), { recursive: true });
await fs.writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ 'git.openRepositoryInParentFolders': 'never', 'window.dialogStyle': 'custom', 'files.simpleDialog.enable': true, 'window.autoDetectColorScheme': false }));
const freePort = createServer(); await new Promise((resolve) => freePort.listen(0, '127.0.0.1', resolve));
const port = freePort.address().port; await new Promise((resolve) => freePort.close(resolve));
const log = await fs.open(path.join(proofDir, 'electron.log'), 'w');
const desktop = await desktopLocaleLaunch('zh-cn', dataDir);
const child = spawn(desktop.executable, [...desktop.args,
  '--user-data-dir', dataDir, '--extensions-dir', path.join(root, '.studio/desktop-extensions'),
  '--locale=zh-cn', '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes',
  `--remote-debugging-port=${port}`, workspacePath,
], { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
let browser; let page;
const proof = { cliVersion, checks: {}, layouts: [], errors: [], resourceFailures: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function frameFor(selector, projectDir = fixtureDir) {
  const projectUri = projectDir ? pathToFileURL(await fs.realpath(projectDir)).href : undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !await frame.locator(selector).first().isVisible().catch(() => false)) { continue; }
      if (projectUri && await frame.locator('#app').getAttribute('data-project-uri').catch(() => undefined) !== projectUri) { continue; }
      let current = frame; let visible = true;
      while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
      if (visible) { return frame; }
    }
    await pause(100);
  }
  throw new Error(`Frame unavailable: ${selector}`);
}
async function command(name) {
  await page.locator('.part.titlebar').click({ position: { x: 200, y: 5 } });
  await page.keyboard.press('F1'); const input = page.locator('.quick-input-widget input'); await input.fill(`>${name}`); await pause(200); await input.press('Enter');
}
async function actionDialog(frame, action, value) {
  await action(); const dialog = frame.locator('.action-dialog[open]'); await dialog.waitFor();
  if (typeof value === 'string') { await dialog.locator('input').fill(value); }
  await dialog.getByRole('button', { name: value === false ? '\u53d6\u6d88' : typeof value === 'string' ? '\u4fdd\u5b58' : '\u5220\u9664', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function ready(frame) { await frame.locator('#parameters[aria-busy=false]').waitFor({ state: 'attached' }); await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve))); }
async function send(frame, text) {
  const users = await frame.locator('.message.user').count(); const queued = await frame.locator('.queued-input').count();
  const editing = await frame.locator('#editing-queue').isVisible();
  await frame.locator('#message').fill(text); await frame.locator('#send').click(); await frame.waitForFunction(() => document.querySelector('#message').value === '');
  await frame.waitForFunction(({ users, queued, editing, text }) => document.querySelectorAll('.message.user').length > users
    || document.querySelectorAll('.queued-input').length > queued || editing && [...document.querySelectorAll('.queued-input')].some((entry) => entry.textContent.includes(text)), { users, queued, editing, text });
}
async function complete(frame) { await frame.locator('#app[data-run-state=idle]').waitFor({ timeout: 30000 }); }
async function messageChrome(frame, width) {
  await frame.locator('#message').hover(); await frame.locator('#message').focus();
  const messages = await frame.locator('.message').evaluateAll((messages) => messages.map((message) => {
    const header = message.querySelector('.message-header'); const date = message.querySelector('.message-date');
    const headerBox = header.getBoundingClientRect(); const dateBox = date.getBoundingClientRect(); const actions = message.querySelector('.message-actions'); const actionBox = actions.getBoundingClientRect();
    const contentBox = message.querySelector('.message-content').getBoundingClientRect(); const copyBox = message.querySelector('.copy-message').getBoundingClientRect();
    return {
      role: message.classList.contains('assistant') ? 'assistant' : 'user', dateInHeader: header.contains(date), dateInActions: actions.contains(date), dateRightOffset: Math.abs(headerBox.right - dateBox.right), dateTopOffset: dateBox.top - headerBox.top,
      dateOpacity: Number(getComputedStyle(date).opacity), actionsOpacity: Number(getComputedStyle(actions).opacity), revealed: message.matches(':hover') || !!message.querySelector(':focus-visible'), dateBelowContent: dateBox.top >= contentBox.bottom, dateBeforeCopy: dateBox.right <= copyBox.left - 5, dateWithinViewport: dateBox.left >= 0 && dateBox.right <= window.innerWidth,
      buttons: [...actions.querySelectorAll('button')].map((button) => { const box = button.getBoundingClientRect(); const style = getComputedStyle(button); return { title: button.ariaLabel, opacity: Number(style.opacity), visible: style.display !== 'none' && style.visibility === 'visible', withinRow: box.left >= actionBox.left - 1 && box.right <= actionBox.right + 1, width: box.width, height: box.height }; }),
    };
  }));
  assert.ok(messages.length > 0);
  for (const message of messages) {
    assert.equal(message.revealed, false); assert.equal(message.dateOpacity, 0);
    if (message.role === 'user') {
      assert.equal(message.dateInHeader, false); assert.equal(message.dateInActions, true); assert.equal(message.actionsOpacity, 0);
      assert.equal(message.dateBelowContent, true); assert.equal(message.dateBeforeCopy, true); assert.equal(message.dateWithinViewport, true);
    } else {
      assert.equal(message.dateInHeader, true); assert.ok(message.dateRightOffset <= 1); assert.ok(message.dateTopOffset >= 0); assert.equal(message.actionsOpacity, 1);
    }
    assert.equal(message.buttons.length, message.role === 'assistant' ? 4 : 1);
    for (const button of message.buttons) { assert.equal(button.visible, true); assert.ok(button.opacity >= 0.4); assert.equal(button.withinRow, true); assert.equal(button.width, 28); assert.equal(button.height, 28); }
  }
  for (const role of ['user', 'assistant']) {
    const message = frame.locator(`.message.${role}`).last();
    await message.scrollIntoViewIfNeeded(); const before = await message.boundingBox();
    await message.locator('.message-content').hover();
    assert.equal(await message.locator('.message-date').evaluate((date) => Number(getComputedStyle(date).opacity)), 1);
    assert.equal(await message.locator('.message-actions').evaluate((actions) => Number(getComputedStyle(actions).opacity)), 1);
    assert.deepEqual(await message.boundingBox(), before);
    if (width) { await page.screenshot({ path: path.join(proofDir, `conversation-${role}-hover-${width}.png`) }); }
    await message.locator('.copy-message').focus(); await page.keyboard.press('ArrowRight'); await frame.locator('#message').hover();
    assert.equal(await message.locator('.copy-message').evaluate((button) => button.matches(':focus-visible')), true);
    assert.equal(await message.locator('.message-date').evaluate((date) => Number(getComputedStyle(date).opacity)), 1);
    assert.equal(await message.locator('.message-actions').evaluate((actions) => Number(getComputedStyle(actions).opacity)), 1);
    await frame.locator('#message').focus();
    assert.equal(await message.locator('.message-date').evaluate((date) => Number(getComputedStyle(date).opacity)), 0, `${role} timestamp remains visible after moving focus`);
    assert.equal(await message.locator('.message-actions').evaluate((actions) => Number(getComputedStyle(actions).opacity)), role === 'user' ? 0 : 1, `${role} actions did not return to their resting state`);
  }
}

async function sessionMenuBounds(frame, x, y) {
  const bounds = await frame.locator('#session-menu').evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  assert.ok(bounds.left >= 8 && bounds.right <= bounds.viewportWidth - 8, JSON.stringify(bounds));
  assert.ok(bounds.top >= 8 && bounds.bottom <= bounds.viewportHeight - 8, JSON.stringify(bounds));
  const expectedLeft = Math.max(8, Math.min(x + bounds.width + 8 <= bounds.viewportWidth ? x : x - bounds.width, bounds.viewportWidth - bounds.width - 8));
  const expectedTop = Math.max(8, Math.min(y + bounds.height + 8 <= bounds.viewportHeight ? y : y - bounds.height, bounds.viewportHeight - bounds.height - 8));
  assert.ok(Math.abs(bounds.left - expectedLeft) <= 1 && Math.abs(bounds.top - expectedTop) <= 1, JSON.stringify({ x, y, bounds }));
  return bounds;
}

async function openSessionMenu(frame, row) {
  await row.scrollIntoViewIfNeeded();
  const point = await row.evaluate((button) => {
    const rect = button.getBoundingClientRect(); const offsetX = Math.min(80, rect.width / 2); const offsetY = rect.height / 2;
    return { offsetX, offsetY, x: rect.left + offsetX, y: rect.top + offsetY };
  });
  await row.click({ button: 'right', position: { x: point.offsetX, y: point.offsetY } });
  await frame.locator('#session-menu:popover-open').waitFor();
  assert.equal(await frame.locator('#session-menu [role=menuitem]').count(), 4);
  assert.equal(await page.locator('.quick-input-widget').isVisible(), false);
  return sessionMenuBounds(frame, point.x, point.y);
}

try {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) { break; } } catch { /* Electron opens the debug endpoint after startup. */ }
    if (child.exitCode !== null) { throw new Error('Studio exited before opening its window.'); } await pause(100);
  }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(15000); page.on('pageerror', (error) => proof.errors.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'image') { proof.resourceFailures.push({ url: request.url(), error: request.failure()?.errorText }); }
  });
  page.on('response', (response) => {
    if (response.request().resourceType() === 'image' && response.status() >= 400) { proof.resourceFailures.push({ url: response.url(), status: response.status() }); }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = page.locator('.part.titlebar .studio-workflow-run').getByRole('button', { name: '\u8fd0\u884c\u9879\u76ee', exact: true }); await run.waitFor({ timeout: 45000 });
  assert.equal(page.frames().some((frame) => frame.url().includes('studio.workflow')), false);
  await run.click(); let frame = await frameFor('#message'); await ready(frame);
  await frame.evaluate(() => window.addEventListener('message', (event) => { if (event.data.type === 'state') { window.__studioConversationProofState = event.data; } }));
  proof.checks.folderRecognitionAndNativeTab = true;
  assert.equal(await frame.locator('#source').count(), 0);
  assert.equal(await frame.locator('.toolbar-actions #new').count(), 1);
  assert.equal(await frame.locator('#project-menu #new').count(), 0);
  await frame.locator('#project-info').click(); await frame.locator('.project-information-name').waitFor();
  assert.equal(await frame.locator('.project-information-name').innerText(), JSON.parse(await fs.readFile(path.join(fixtureDir, 'package.json'), 'utf8')).name);
  await frame.locator('.conversation-dialog[open] header button').last().click();
  proof.checks.newConversationInToolbarAndProjectInformation = true;
  assert.equal(await frame.locator('.composer-footer, #runtime-state, #message-count').count(), 0);
  proof.checks.composerStatusAndMessageCountRemoved = true;
  await frame.locator('#new').click(); await ready(frame); await frame.locator('#new').click(); await ready(frame);
  assert.equal(await frame.locator('#session-list .session').count(), 1); proof.checks.emptyConversationReuse = true;

  await frame.locator('#message').evaluate((textarea) => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['Attachment content'], 'note.txt', { type: 'text/plain' }));
    textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await frame.locator('#draft-attachments .attachment').waitFor(); await send(frame, 'With attachment'); await complete(frame);
  assert.match(await frame.locator('.assistant .message-content').last().innerText(), /note.txt, text\/plain, bytes=18/);
  assert.equal(await frame.locator('.user .attachments .attachment').count(), 1); proof.checks.pasteUploadAndHistoricalFileReference = true;

  await send(frame, 'approval'); await frame.getByRole('button', { name: '\u6279\u51c6\u6267\u884c', exact: true }).waitFor();
  await frame.getByRole('button', { name: '\u6279\u51c6\u6267\u884c', exact: true }).click(); await complete(frame);
  assert.match(await frame.locator('.assistant .message-content').last().innerText(), /Approved tool executed/); proof.checks.toolApprovalAndResume = true;
  await send(frame, 'question'); await frame.locator('.prompt-field > label').filter({ hasText: 'Choose a format' }).waitFor();
  await frame.getByText('Full', { exact: true }).click(); await frame.locator('.prompt-field textarea').fill('Complete migration');
  await frame.getByRole('button', { name: '\u7ee7\u7eed\u8fd0\u884c', exact: true }).click(); await complete(frame);
  assert.match(await frame.locator('.assistant .message-content').last().innerText(), /Complete migration/); proof.checks.multiStepInputAndAnswerHistory = true;
  await send(frame, 'plan'); await frame.getByRole('button', { name: '\u6309\u8ba1\u5212\u6267\u884c', exact: true }).waitFor();
  await frame.locator('.plan-card summary').click(); await frame.locator('.conversation-dialog[open]').waitFor();
  assert.match(await frame.locator('.conversation-dialog[open]').innerText(), /Inspect project/); await frame.locator('.conversation-dialog[open] header button').last().click();
  await frame.getByRole('button', { name: '\u6309\u8ba1\u5212\u6267\u884c', exact: true }).click(); await complete(frame);
  assert.match(await frame.locator('[data-action-id=mode]').innerText(), /Build/); proof.checks.planReadingApprovalAndModeSync = true;
  assert.deepEqual(await frame.locator('.assistant .message-output').last().evaluate((element) => [...element.children].map((child) => child.className)), ['output-detail plan-card', 'resolved-inputs', 'message-content']);
  proof.checks.answerPositionBeforeResumedOutput = true;
  const completedInput = await frame.evaluate(() => {
    const state = window.__studioConversationProofState;
    const session = state.sessions.find((entry) => entry.id === state.activeId);
    return { projectUri: state.project.uri, sessionId: session.id, messageId: session.messages.at(-1).id };
  });
  await frame.evaluate((target) => {
    window.dispatchEvent(new MessageEvent('message', { data: { ...target, type: 'attachments', paramName: 'mode', requestId: 'obsolete-question', files: [{ id: 'wf_01234567890123456789012345678901', name: 'late.txt', mimeType: 'text/plain', kind: 'file', storage: 'local' }] } }));
    window.dispatchEvent(new MessageEvent('message', { data: { ...target, type: 'error', requestType: 'resume', requestId: 'obsolete-question', message: 'Obsolete submission error' } }));
  }, completedInput);
  await pause(200); assert.match(await frame.locator('[data-action-id=mode]').innerText(), /Build/); assert.equal(await frame.locator('#error').isVisible(), false);
  proof.checks.obsoleteQuestionRepliesDoNotChangeProjectParameters = true;

  await send(frame, 'slow'); await frame.getByRole('button', { name: '\u505c\u6b62', exact: true }).waitFor();
  await send(frame, 'Queued second'); await frame.locator('#input-queue .queued-input').waitFor();
  await frame.locator('#input-queue .queued-input button[title="\u7f16\u8f91"]').click(); await frame.waitForFunction(() => document.querySelector('#message').value === 'Queued second');
  await frame.locator('#message').fill('Edited queued message'); await frame.locator('#send').click(); await frame.waitForFunction(() => document.querySelector('#message').value === '');
  await frame.locator('#new').click(); await frame.waitForFunction(() => document.querySelectorAll('.message').length === 0); await ready(frame);
  await send(frame, 'Concurrent conversation'); await complete(frame);
  await frame.locator('#session-list .session').filter({ hasText: 'With attachment' }).click();
  await frame.waitForFunction(() => document.querySelector('#conversation-title').textContent === 'With attachment'); await ready(frame);
  await frame.waitForFunction(() => [...document.querySelectorAll('.assistant .message-content')].at(-1)?.textContent.includes('Edited queued message'), { timeout: 30000 }); await complete(frame);
  assert.match(await frame.locator('.assistant .message-content').last().innerText(), /Edited queued message/); assert.equal(await frame.locator('#input-queue').isVisible(), false);
  proof.checks.queueEditingSwitchingAndConcurrentRuns = true;

  await ready(frame); await frame.locator('#message').click(); await frame.locator('#message').press('Meta+f'); await frame.locator('.content-search input').fill('Complete migration');
  assert.ok(await frame.locator('mark').count() > 0); await frame.locator('.content-search button[title="\u5173\u95ed\u641c\u7d22"]').click(); assert.equal(await frame.locator('mark').count(), 0);
  proof.checks.contentSearch = true;
  const answerId = await frame.evaluate(() => window.__studioConversationProofState.sessions.find(session => session.id === window.__studioConversationProofState.activeId).messages.filter(message => message.role === 'assistant').at(-1).id);
  await frame.locator('.assistant .message-actions button[aria-label="\u8f68\u8ff9"]').last().click();
  const trace = await frameFor('#trace-app', null);
  await trace.waitForFunction(id => document.querySelector('#trace-run').value === id, answerId);
  await trace.locator('.trace-row').first().waitFor();
  await command('View: Toggle Panel Visibility');
  proof.checks.cliReplyTraceInNativePanel = true;
  await frame.locator('#tools').click(); await frame.locator('.permissions-table').waitFor(); assert.match(await frame.locator('.permissions-table').innerText(), /Write/);
  await frame.locator('.conversation-dialog[open] header button').last().click(); proof.checks.toolPermissionPanel = true;

  await send(frame, 'generated'); await complete(frame);
  await frame.locator('.assistant .message-content img').waitFor();
  try { await frame.waitForFunction(() => document.querySelector('.assistant .message-content img')?.naturalWidth === 96); }
  catch (error) {
    proof.generatedImages = await frame.locator('.assistant .message-content img').evaluateAll((images) => images.map((image) => ({ src: image.src, complete: image.complete, width: image.naturalWidth, fileId: image.dataset.workflowFile })));
    throw error;
  }
  await frame.locator('.assistant .message-content img').click(); await frame.locator('.conversation-dialog[open] .image-preview').waitFor();
  await frame.waitForFunction(() => document.querySelector('.conversation-dialog[open] .image-preview')?.naturalWidth === 96);
  await frame.locator('.conversation-dialog[open] header button').last().click();
  await frame.waitForFunction(() => document.querySelector('.assistant audio')?.readyState >= 1);
  assert.ok(await frame.locator('.assistant audio').evaluate((audio) => audio.duration >= 0.09));
  await frame.evaluate(() => { window.open = (url) => { window.__studioOpenedFile = String(url); return null; }; });
  await frame.getByRole('link', { name: 'Generated file', exact: true }).click();
  const generated = await frame.evaluate(async () => {
    const response = await fetch(window.__studioOpenedFile);
    return { url: window.__studioOpenedFile, status: response.status, text: await response.text() };
  });
  assert.match(generated.url, /^\/api\/file\/wf_/); assert.equal(generated.status, 200); assert.equal(generated.text, 'Core generated content');
  proof.checks.generatedImageAndAuthenticatedFileDownload = true;
  proof.checks.managedImageDialogAndAudioPreview = true;
  console.log('Generated image, audio and authenticated file download verified.');

  await send(frame, 'timer'); await complete(frame); await frame.locator('.timer-record summary').last().click();
  assert.match(await frame.locator('.timer-record').last().innerText(), /Completed timer/);
  assert.deepEqual(await frame.locator('.assistant .message-content input[type=checkbox]').evaluateAll((inputs) => inputs.map((input) => ({ checked: input.checked, disabled: input.disabled }))), [{ checked: true, disabled: true }, { checked: false, disabled: true }]);
  proof.checks.businessTimersAndGfmTasks = true;

  await send(frame, 'slow'); await frame.getByRole('button', { name: '\u505c\u6b62', exact: true }).waitFor();
  await command('Workflow: \u6253\u5f00\u672c\u5730\u5bf9\u8bdd\u6f14\u793a');
  const demoTab = page.getByRole('tab', { name: '\u5bf9\u8bdd\u793a\u4f8b', exact: true }); await demoTab.waitFor();
  const demo = await frameFor('#message', parallelDir); await ready(demo); await send(demo, 'Parallel project tab'); await complete(demo);
  assert.match(await demo.locator('.assistant .message-content').last().innerText(), /Parallel project tab/);
  await page.getByRole('tab', { name: 'Conversation migration fixture', exact: true }).click(); frame = await frameFor('#message');
  await frame.waitForFunction(() => document.querySelector('#conversation-title').textContent === 'With attachment'); await complete(frame);
  assert.match(await frame.locator('.assistant .message-content').last().innerText(), /slow/); proof.checks.independentProjectTabs = true;
  console.log('Independent project tabs verified.');

  for (let index = 1; index <= 3; index++) {
    const previousId = await frame.evaluate(() => window.__studioConversationProofState.activeId);
    await frame.locator('#new').click(); await frame.waitForFunction((id) => window.__studioConversationProofState.activeId !== id, previousId);
    await frame.waitForFunction(() => document.querySelector('#session-list .session:first-child')?.dataset.sessionId === window.__studioConversationProofState.activeId);
    await ready(frame); await send(frame, `History ${index}`); await complete(frame);
  }
  proof.checks.newConversationAppearsFirstBeforeSending = true;
  await frame.locator('#message').fill('Full-history draft');
  assert.equal(await frame.locator('#session-list .session').count(), 5);
  assert.equal(await frame.locator('#search-history').count(), 0); assert.equal(await frame.locator('#all-history').isVisible(), false);
  await frame.locator('#history-toggle').click(); await frame.locator('#history-popover:popover-open').waitFor();
  assert.equal(await frame.locator('#all-session-list .session').count(), 5);
  await frame.locator('#search-all-history').fill('missing history'); await frame.locator('#history-empty').waitFor();
  await frame.locator('#search-all-history').fill('With attachment'); assert.equal(await frame.locator('#all-session-list .session').count(), 1);
  await frame.locator('#search-all-history').press('Escape'); await frame.locator('#history-popover').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#project-menu').isVisible(), true);
  assert.equal(await frame.locator('#history-toggle').evaluate((button) => button === document.activeElement), true);
  await frame.locator('#history-toggle').click(); await frame.locator('#history-popover:popover-open').waitFor();
  assert.equal(await frame.locator('#all-session-list .session').count(), 5);
  await frame.locator('#message').click(); await frame.locator('#history-popover').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#message').inputValue(), 'Full-history draft');
  await frame.locator('#history-toggle').click(); await frame.locator('#search-all-history').fill('With attachment');
  await frame.locator('#all-session-list .session').click();
  await frame.waitForFunction(() => document.querySelector('#conversation-title').textContent === 'With attachment'); await ready(frame);
  assert.equal(await frame.locator('#session-list .session.active').getAttribute('title'), 'With attachment');
  assert.equal(await frame.evaluate(() => window.__studioConversationProofState.sessions.find((session) => session.title === 'History 3').draft.text), 'Full-history draft');
  proof.checks.searchableFullHistoryDismissalSelectionAndDraft = true;

  const activeId = await frame.evaluate(() => window.__studioConversationProofState.activeId);
  await frame.locator('#new').click(); await frame.waitForFunction((id) => window.__studioConversationProofState.activeId !== id, activeId); await ready(frame);
  const menuTargetId = await frame.evaluate(() => window.__studioConversationProofState.activeId);
  await frame.locator('#message').fill('Context menu draft');
  await frame.locator(`#session-list .session[data-session-id="${activeId}"]`).click();
  await frame.waitForFunction((id) => window.__studioConversationProofState.activeId === id, activeId); await ready(frame);
  assert.equal(await frame.evaluate((id) => window.__studioConversationProofState.sessions.find((session) => session.id === id)?.draft?.text, menuTargetId), 'Context menu draft');
  const menuTarget = frame.locator(`#session-list .session[data-session-id="${menuTargetId}"]`);
  const menu = frame.locator('#session-menu');
  await send(frame, 'slow');
  await openSessionMenu(frame, menuTarget);
  await complete(frame);
  assert.equal(await menu.evaluate((menu) => menu.matches(':popover-open')), true);
  assert.equal(await menuTarget.evaluate((button) => button.classList.contains('context-active')), true);
  await page.screenshot({ path: path.join(proofDir, 'session-menu-dark.png') });
  proof.checks.streamingRepliesPreserveContextMenuAndTargetHighlight = true;
  assert.equal(await menuTarget.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowUp'); assert.equal(await menu.locator('[data-action=delete]').evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('Home'); assert.equal(await menu.locator('[data-action=rename]').evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('End'); await page.keyboard.press('ArrowUp'); assert.equal(await menu.locator('[data-action=export]').evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
  assert.equal(await menuTarget.evaluate((button) => button === document.activeElement), true);
  assert.equal(await menuTarget.getAttribute('aria-expanded'), 'false');
  await menuTarget.press('Shift+F10'); await menu.locator('[data-action=rename]').waitFor();
  const anchor = await menuTarget.evaluate((button) => { const rect = button.getBoundingClientRect(); return { x: rect.left, y: rect.bottom }; });
  await sessionMenuBounds(frame, anchor.x, anchor.y);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await frame.waitForFunction((id) => window.__studioConversationProofState.sessions.find((session) => session.id === id)?.titleLocked === true, menuTargetId);
  assert.equal(await frame.evaluate(() => window.__studioConversationProofState.activeId), activeId);
  await openSessionMenu(frame, menuTarget); assert.equal(await menu.locator('[data-action=lock]').innerText(), '\u89e3\u9664\u6807\u9898\u9501\u5b9a');
  await menu.locator('[data-action=lock]').click();
  await frame.waitForFunction((id) => window.__studioConversationProofState.sessions.find((session) => session.id === id)?.titleLocked === false, menuTargetId);
  await openSessionMenu(frame, menuTarget);
  await actionDialog(frame, () => menu.locator('[data-action=rename]').click(), 'Context menu test');
  await frame.waitForFunction((id) => window.__studioConversationProofState.sessions.find((session) => session.id === id)?.title === 'Context menu test', menuTargetId);
  assert.equal(await frame.evaluate(() => window.__studioConversationProofState.activeId), activeId);
  const exportedPath = path.join(proofDir, 'context-menu-export.json'); await fs.rm(exportedPath, { force: true });
  await openSessionMenu(frame, menuTarget);
  const downloaded = page.waitForEvent('download'); await menu.locator('[data-action=export]').click();
  await (await downloaded).saveAs(exportedPath);
  const exported = JSON.parse(await fs.readFile(exportedPath, 'utf8'));
  assert.equal(exported.id, menuTargetId); assert.equal(exported.title, 'Context menu test');
  await openSessionMenu(frame, menuTarget);
  await actionDialog(frame, () => menu.locator('[data-action=delete]').click(), false);
  assert.equal(await menuTarget.count(), 1);
  await openSessionMenu(frame, menuTarget);
  await actionDialog(frame, () => menu.locator('[data-action=delete]').click(), true);
  await frame.waitForFunction((id) => !window.__studioConversationProofState.sessions.some((session) => session.id === id), menuTargetId);
  assert.equal(await frame.evaluate(() => window.__studioConversationProofState.activeId), activeId); assert.equal(await frame.locator('#session-list .session').count(), 5);
  proof.checks.contextMenuKeyboardNavigationAndFocusRestoration = true;
  proof.checks.contextMenuRenameLockExportAndConfirmedDeleteTargetInactiveConversation = true;
  await openSessionMenu(frame, frame.locator('#session-list .session').first());
  await frame.locator('#message').click(); await menu.waitFor({ state: 'hidden' });
  proof.checks.contextMenuOutsideClickDismissal = true;

  await frame.locator('#history-toggle').click(); await frame.locator('#search-all-history').fill('With attachment');
  const historyTarget = frame.locator('#all-session-list .session');
  const locked = await frame.evaluate(() => !!window.__studioConversationProofState.sessions.find((session) => session.id === window.__studioConversationProofState.activeId).titleLocked);
  await openSessionMenu(frame, historyTarget); assert.equal(await menu.evaluate((menu) => menu.parentElement.id), 'history-popover');
  await menu.locator('[data-action=lock]').click();
  await frame.waitForFunction((locked) => !!window.__studioConversationProofState.sessions.find((session) => session.id === window.__studioConversationProofState.activeId).titleLocked !== locked, locked);
  assert.equal(await frame.locator('#history-popover').evaluate((popover) => popover.matches(':popover-open')), true);
  await openSessionMenu(frame, historyTarget); await menu.locator('[data-action=lock]').click();
  await frame.waitForFunction((locked) => !!window.__studioConversationProofState.sessions.find((session) => session.id === window.__studioConversationProofState.activeId).titleLocked === locked, locked);
  await openSessionMenu(frame, historyTarget); await page.keyboard.press('Escape');
  assert.equal(await frame.locator('#history-popover').evaluate((popover) => popover.matches(':popover-open')), true);
  assert.equal(await historyTarget.evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('Escape'); await frame.locator('#history-popover').waitFor({ state: 'hidden' });
  proof.checks.historyContextMenuActionsAndEscapePreserveSearchPopover = true;

  await page.mouse.move(0, 0); await messageChrome(frame);
  const settingsPath = path.join(dataDir, 'User/settings.json');
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  await fs.writeFile(settingsPath, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Light Modern' }));
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'light');

  if (await page.locator('.part.sidebar').isVisible()) { await command('View: Toggle Primary Side Bar Visibility'); }
  if (await page.locator('.part.auxiliarybar').isVisible()) { await command('View: Toggle Secondary Side Bar Visibility'); }
  for (const width of [1440, 960, 720, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await pause(200);
    const toggle = frame.locator('#menu-toggle'); if (await toggle.isVisible()) { await toggle.click(); }
    const bounds = await frame.evaluate(() => { const app = document.querySelector('#app'); const menu = document.querySelector('#project-menu').getBoundingClientRect(); const main = document.querySelector('main').getBoundingClientRect(); return { width: app.clientWidth, scrollWidth: app.scrollWidth, menu: { x: menu.x, y: menu.y, right: menu.right, bottom: menu.bottom }, main: { x: main.x, y: main.y } }; });
    assert.ok(bounds.scrollWidth <= bounds.width + 1); if (bounds.width <= 680) { assert.ok(bounds.menu.bottom <= bounds.main.y + 1); } else { assert.ok(bounds.menu.right <= bounds.main.x + 1); }
    assert.equal(await frame.locator('#search-history').count(), 0);
    assert.equal(await frame.locator('#all-history').isVisible(), bounds.width <= 680);
    assert.equal(await frame.locator('#session-list .session').count(), bounds.width <= 680 ? 3 : 5);
    assert.equal(await frame.locator('.toolbar-actions #tools').isVisible(), true);
    if (bounds.width <= 680) { assert.equal(await frame.locator('.toolbar').isVisible(), true); assert.ok(bounds.menu.bottom - bounds.menu.y <= 200); }
    await page.mouse.move(0, 0); await messageChrome(frame, width);
    const tasks = await frame.locator('.assistant .message-content input[type=checkbox]').evaluateAll((inputs) => inputs.map((input) => {
      const box = input.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(input.nextSibling);
      const text = range.getBoundingClientRect(); return { width: box.width, height: box.height, centerOffset: Math.abs((box.top + box.bottom - text.top - text.bottom) / 2) };
    }));
    assert.equal(tasks.length, 2); for (const task of tasks) { assert.equal(task.width, 14); assert.equal(task.height, 14); assert.ok(task.centerOffset <= 4, JSON.stringify(task)); }
    await page.screenshot({ path: path.join(proofDir, `conversation-${width}.png`) });
    const row = frame.locator('#session-list .session').first(); await openSessionMenu(frame, row);
    await page.screenshot({ path: path.join(proofDir, `session-menu-${width}.png`) });
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    const edge = await frame.evaluate(() => ({ x: window.innerWidth - 2, y: window.innerHeight - 2 }));
    await row.evaluate((button, point) => button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y })), edge);
    await menu.locator('[data-action=rename]').waitFor();
    await sessionMenuBounds(frame, edge.x, edge.y); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    await frame.locator(bounds.width <= 680 ? '#all-history' : '#history-toggle').click(); await frame.locator('#history-popover:popover-open').waitFor();
    const popup = await frame.locator('#history-popover').evaluate((element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }; });
    assert.ok(popup.left >= 0 && popup.right <= popup.viewportWidth); assert.ok(popup.top >= 0 && popup.bottom <= popup.viewportHeight);
    await page.screenshot({ path: path.join(proofDir, `history-${width}.png`) });
    await openSessionMenu(frame, frame.locator('#all-session-list .session').last());
    await page.screenshot({ path: path.join(proofDir, `history-session-menu-${width}.png`) });
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    assert.equal(await frame.locator('#history-popover').evaluate((popover) => popover.matches(':popover-open')), true);
    await frame.locator('#search-all-history').press('Escape'); await frame.locator('#history-popover').waitFor({ state: 'hidden' });
    await frame.locator('#hide-menu').click(); assert.equal(await toggle.isVisible(), true);
    assert.equal(await frame.locator('.toolbar-actions #tools').isVisible(), true);
    proof.layouts.push({ width, editorWidth: bounds.width });
  }
  proof.checks.hoverAndKeyboardRevealMessageDatesAndUserCopyWithoutLayoutShift = true;
  proof.checks.assistantMessageActionsRemainVisible = true;
  proof.checks.compactTopListAndHistoryPopoverAcrossWidths = true;
  proof.checks.contextMenusFollowPointerAndStayWithinWideAndNarrowViewports = true;
  console.log('Wide and narrow layouts verified.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (await frame.locator('#menu-toggle').isVisible()) { await frame.locator('#menu-toggle').click(); }
  for (let index = 1; index <= 35; index++) {
    const previousId = await frame.evaluate(() => window.__studioConversationProofState.activeId);
    await frame.locator('#new').click(); await frame.waitForFunction((id) => window.__studioConversationProofState.activeId !== id, previousId);
    await frame.waitForFunction(() => document.querySelector('#session-list .session:first-child')?.dataset.sessionId === window.__studioConversationProofState.activeId);
    await ready(frame); await frame.locator('#message').fill(`Pagination draft ${index}`);
  }
  assert.equal(await frame.locator('#session-list .session').count(), 30);
  assert.equal(await frame.locator('#all-history').isVisible(), false);
  await frame.locator('#chats').evaluate((chats) => { chats.scrollTop = chats.scrollHeight; });
  await frame.waitForFunction(() => document.querySelectorAll('#session-list .session').length === 40);
  const ids = await frame.locator('#session-list .session').evaluateAll((buttons) => buttons.map((button) => button.dataset.sessionId));
  assert.equal(new Set(ids).size, 40); assert.equal(await frame.locator('#load-more-history').isVisible(), false);
  await openSessionMenu(frame, frame.locator('#session-list .session').last());
  await frame.locator('#chats').evaluate((chats) => { chats.scrollTop = 0; }); await menu.waitFor({ state: 'hidden' });
  proof.checks.scrollingHistoryDismissesContextMenu = true;
  await frame.locator('#history-toggle').click(); await frame.locator('#search-all-history').fill('With attachment');
  await frame.locator('#all-session-list .session').click();
  await frame.waitForFunction(() => document.querySelector('#conversation-title').textContent === 'With attachment'); await ready(frame);
  assert.equal(await frame.locator('#session-list .session.active').getAttribute('title'), 'With attachment');
  await frame.locator('#new').click(); await frame.waitForFunction(() => document.querySelectorAll('.message').length === 0);
  await frame.waitForFunction(() => document.querySelector('#session-list .session:first-child')?.dataset.sessionId === window.__studioConversationProofState.activeId);
  await frame.waitForFunction(() => document.querySelector('#chats').scrollTop === 0);
  const newId = await frame.evaluate(() => window.__studioConversationProofState.activeId);
  await frame.locator('#new').click(); await ready(frame);
  assert.equal(await frame.locator('#session-list .session').first().getAttribute('data-session-id'), newId);
  await frame.locator('#history-toggle').click(); await frame.locator('#search-all-history').fill('Edited queued message');
  assert.equal(await frame.locator('#all-session-list .session').count(), 1);
  await frame.locator('#all-session-list .session').click();
  await frame.waitForFunction(() => document.querySelector('#conversation-title').textContent === 'With attachment'); await ready(frame);
  proof.checks.wideHistoryPagesAppendWithoutDuplicatesAndNewResetsScroll = true;
  proof.checks.sharedSearchFindsOlderConversationByMessageContent = true;
  await command('Developer: Reload Window'); await pause(2000); await run.waitFor({ timeout: 45000 });
  await page.getByRole('tab', { name: 'Conversation migration fixture', exact: true }).click(); frame = await frameFor('#message'); await ready(frame);
  assert.match(await frame.locator('.assistant .message-content').last().innerText(), /slow/); assert.equal(await frame.locator('.user .attachments .attachment').count(), 1);
  await frame.waitForFunction(() => document.querySelector('.assistant .message-content img')?.naturalWidth === 96);
  assert.match(await frame.locator('[data-action-id=mode]').innerText(), /Build/); proof.checks.reloadRestoresHistoryParametersAndAttachments = true;

  await send(frame, 'activity');
  let activityOutput = frame.locator('.assistant .message-output').last();
  let firstActivity = activityOutput.locator('[data-item-id=activity-0]');
  await firstActivity.locator('summary').waitFor();
  assert.equal(await firstActivity.getAttribute('data-state'), 'running');
  assert.match(await firstActivity.locator('summary').innerText(), /\u6b63\u5728\u8bfb\u53d6 package.json/);
  assert.match(await frame.locator('.assistant .message-metadata').last().innerText(), /\u6b63\u5728\u8bfb\u53d6/);
  await firstActivity.locator('summary').click();
  await firstActivity.locator('.activity-section').waitFor();
  assert.match(await firstActivity.locator('.activity-body').innerText(), /package.json/);
  await firstActivity.locator('button[title="\u590d\u5236\u53c2\u6570"]').focus();
  await firstActivity.evaluate((element) => { window.__studioActivityRow = element; window.__studioActivityCopy = document.activeElement; });
  const runningDuration = await frame.locator('.assistant .message-metadata').last().innerText();
  await pause(1200);
  assert.notEqual(await frame.locator('.assistant .message-metadata').last().innerText(), runningDuration);
  await page.screenshot({ path: path.join(proofDir, 'agent-activity-running.png') });
  await complete(frame);
  assert.equal(await firstActivity.getAttribute('data-state'), 'success');
  assert.equal(await firstActivity.evaluate((element) => element === window.__studioActivityRow && element.open && document.activeElement === window.__studioActivityCopy), true);
  assert.match(await firstActivity.locator('.activity-body').innerText(), /Project: conversation-features/);
  assert.equal(await activityOutput.locator('.agent-activity-item').count(), 10);
  assert.equal(await activityOutput.locator('.resource-card').count(), 0);
  assert.equal(await activityOutput.locator('.activity-state .codicon-loading, :scope > .pending').count(), 0);
  assert.match(await activityOutput.locator('.activity-group-summary').innerText(), /10 \u9879\uff0c1 \u9879\u5931\u8d25/);
  assert.match(await activityOutput.locator('[data-item-id=activity-2] summary').innerText(), /defineExecutor\|createOutputNode/);
  assert.match(await activityOutput.locator('[data-item-id=activity-5] summary').getAttribute('title'), /rg --files.*!node_modules/);
  assert.match(await activityOutput.locator('> .message-content').last().innerText(), /defineExecutor/);
  proof.checks.liveToolDetailsPreserveExpansionFocusAndElapsedTime = true;
  const group = activityOutput.locator('.activity-group');
  assert.equal(await group.locator('.activity-list').evaluate((list) => list.scrollHeight > list.clientHeight && list.clientHeight <= 280), true);
  await firstActivity.locator('summary').click();
  const failedActivity = activityOutput.locator('[data-item-id=activity-8]');
  await failedActivity.locator('summary').click();
  await failedActivity.locator('.activity-error').waitFor();
  assert.match(await failedActivity.locator('.activity-error').innerText(), /File not found/);
  assert.match(await failedActivity.locator('.activity-body').innerText(), /missing-conversation-configuration.ts/);
  await failedActivity.locator('summary').click();
  await group.locator('> summary').click(); assert.equal(await group.locator('.activity-list').isVisible(), false);
  await group.locator('> summary').press('Enter'); assert.equal(await group.locator('.activity-list').isVisible(), true);
  await firstActivity.locator('.activity-file').click();
  await page.locator('.part.editor .view-lines').filter({ hasText: 'Conversation migration fixture' }).waitFor();
  assert.match(await page.locator('.part.editor .tab.active').getAttribute('aria-label'), /package\.json/);
  await page.getByRole('tab', { name: 'Conversation migration fixture', exact: true }).click();
  frame = await frameFor('#message'); await ready(frame);
  activityOutput = frame.locator('.assistant .message-output').last();
  proof.checks.semanticToolRowsExpandableResultsErrorsAndNativeProjectFile = true;

  for (const width of [1440, 960, 720, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await pause(200);
    if (await frame.locator('#menu-toggle').isVisible()) { await frame.locator('#menu-toggle').click(); }
    await activityOutput.evaluate((output) => { output.closest('.message').scrollIntoView({ block: 'start' }); output.querySelector('.activity-list').scrollTop = 0; });
    await frame.locator('#message').focus(); await page.mouse.move(0, 0);
    const layout = await activityOutput.evaluate((output) => {
      const app = document.querySelector('#app'); const list = output.querySelector('.activity-list');
      const group = output.querySelector('.activity-group').getBoundingClientRect(); const answer = output.querySelector(':scope > .message-content:last-child').getBoundingClientRect();
      return { width: window.innerWidth, appWidth: app.clientWidth, scrollWidth: app.scrollWidth, listWidth: list.clientWidth, listScrollWidth: list.scrollWidth, height: list.clientHeight, contentHeight: list.scrollHeight, groupBottom: group.bottom, answerTop: answer.top, rowsFit: [...output.querySelectorAll('.agent-activity-item > summary')].every((summary) => { const bounds = summary.getBoundingClientRect(); return [...summary.children].every((child) => child.getBoundingClientRect().right <= bounds.right + 1); }) };
    });
    assert.ok(layout.scrollWidth <= layout.appWidth + 1 && layout.listScrollWidth <= layout.listWidth + 1, JSON.stringify(layout));
    assert.ok(layout.rowsFit && layout.contentHeight > layout.height && layout.height <= 280, JSON.stringify(layout));
    assert.ok(layout.answerTop >= layout.groupBottom - 1, JSON.stringify(layout));
    await frame.locator('#app').screenshot({ path: path.join(proofDir, `agent-activity-${width}.png`) });
    (proof.activityLayouts ??= []).push({ width, editorWidth: layout.width });
  }
  proof.checks.toolListsScrollAndLeaveFinalAnswerVisibleAcrossWidths = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await send(frame, 'activity-wait'); await frame.getByRole('button', { name: '\u6279\u51c6\u6267\u884c', exact: true }).waitFor();
  const pendingActivity = frame.locator('.assistant .message-output').last().locator('[data-item-id=activity-pending]');
  assert.equal(await pendingActivity.getAttribute('data-state'), 'waiting');
  assert.match(await pendingActivity.locator('summary').innerText(), /\u7b49\u5f85\u786e\u8ba4\u5199\u5165 report.txt/);
  assert.equal(await pendingActivity.locator('.activity-state .codicon-loading').count(), 0);
  await frame.getByRole('button', { name: '\u6279\u51c6\u6267\u884c', exact: true }).click(); await complete(frame);
  assert.equal(await pendingActivity.getAttribute('data-state'), 'success');
  await send(frame, 'activity-fail'); await complete(frame);
  assert.equal(await frame.locator('.assistant .message-output').last().locator('[data-item-id=activity-pending]').getAttribute('data-state'), 'failed');
  assert.match(await frame.locator('.assistant').last().innerText(), /Activity fixture failed/);
  await send(frame, 'activity-stop');
  await frame.locator('.assistant .message-output').last().locator('[data-item-id=activity-pending][data-state=running]').waitFor();
  await frame.getByRole('button', { name: '\u505c\u6b62', exact: true }).click(); await complete(frame);
  assert.equal(await frame.locator('.assistant .message-output').last().locator('[data-item-id=activity-pending]').getAttribute('data-state'), 'stopped');
  assert.equal(await frame.locator('.activity-state .codicon-loading, .message-output > .pending').count(), 0);
  proof.checks.toolApprovalFailureAndCancellationLeaveNoRunningIndicators = true;
  await command('Developer: Reload Window'); await pause(2000); await run.waitFor({ timeout: 45000 });
  await page.getByRole('tab', { name: 'Conversation migration fixture', exact: true }).click(); frame = await frameFor('#message'); await ready(frame);
  assert.equal(await frame.locator('.agent-activity-item').count(), 13);
  assert.equal(await frame.locator('.agent-activity-item[data-state=stopped]').count(), 1);
  assert.equal(await frame.locator('.agent-activity-item[data-state=failed]').count(), 2);
  assert.equal(await frame.locator('.activity-state .codicon-loading, .message-output > .pending').count(), 0);
  proof.checks.reloadRestoresAgentActivityAndTerminalStates = true;
  console.log('Agent tool activity, approval, cancellation and responsive layouts verified.');
  assert.deepEqual(proof.errors, []);
} catch (error) {
  proof.failure = error.stack; if (page) { await page.screenshot({ path: path.join(proofDir, 'failure.png') }).catch(() => undefined); } process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(proofDir, 'verification.json'), JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof));
  await browser?.close(); child.kill('SIGTERM'); await Promise.race([exited, pause(5000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  await log.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
