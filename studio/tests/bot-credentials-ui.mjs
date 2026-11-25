// Exercise the real CLI, worker and browser with a status-only stand-in for the native host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { writeProjectFixture } from '../../cli/scripts/test-project-fixture.mjs';
import { projectFrameHtml } from '../extensions/studio-workstation/src/workflow-webview.ts';

const workspace = fileURLToPath(new URL('../../', import.meta.url)), core = path.join(workspace, 'harness');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-test-bot-credentials-')));
const directory = path.join(root, 'project'), projectId = randomUUID(), entryId = 'bot';
const kind = 'api-key', name = 'fixture-service', forbidden = `fixture-only-${randomUUID()}`;
const children = new Set();
const fixturePages = new Map();
const nativeFrame = createServer((incoming, response) => {
  const fixture = fixturePages.get(incoming.url);
  if (!fixture) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(projectFrameHtml(fixture.url, 'Credential fixture', pathToFileURL(directory).href, 'light', randomUUID(), fixture.language));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, message) {
  for (let i = 0; i < 120; i++) {
    const value = read(); if (value) return value;
    await delay(50);
  }
  assert.fail(message);
}

async function launch(language, native) {
  const data = path.join(root, `data-${language}-${native}`);
  const child = spawn(process.execPath, [path.join(workspace, 'cli/dist/index.js'), '--locale', language, 'web', directory, '--data-dir', data, '--entry', entryId, '--host-stdio', '--no-open', '--json'], {
    cwd: directory, env: { ...process.env, HOME: root, USERPROFILE: root, STEAMHARNESS_CLI_AUTH_DIR: path.join(root, 'auth'), STEAMHARNESS_WEB_HOST: 'studio',
      STEAMHARNESS_SERVER_ADMIN_KEY: '', STEAMHARNESS_SERVER_URL: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ended = once(child, 'exit');
  const close = async () => {
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
    try { await ended; } finally { clearTimeout(timer); children.delete(close); }
  };
  children.add(close);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  child.stdin.on('error', () => {});
  const sent = [], lines = createInterface({ input: child.stdout });
  const write = value => child.stdin.write(JSON.stringify(value) + '\n');
  const ready = new Promise((resolve, reject) => {
    lines.on('line', line => { try { const record = JSON.parse(line); sent.push(record); if (record.type === 'ready') resolve(record); } catch { /* CLI diagnostics */ } });
    void ended.then(() => reject(new Error(`Fixture CLI stopped: ${stderr}`)));
  });
  write({ type: 'configure', surface: 'editor', localBotCredentials: native, userSettings: { agent: { permissionPolicy: 'workspace' } } });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const app = await ready, url = new URL(app.url);
    assert.equal(app.botCredentialProtocolVersion, native ? 1 : undefined);
    const token = new URLSearchParams(url.hash.slice(1)).get('session');
    const post = async (message, headers = {}) => {
      const response = await fetch(new URL('api/message', url), { method: 'POST', body: JSON.stringify(message),
        headers: { Authorization: `Bearer ${token}`, Origin: url.origin, 'Content-Type': 'application/json', ...headers } });
      return { status: response.status, body: await response.json() };
    };
    const checkEntry = () => fetch(new URL('api/retry', url), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).then(response => response.text());
    const route = `/${randomUUID()}`; fixturePages.set(route, { url: app.url, language });
    return { app, page: `http://127.0.0.1:${nativeFrame.address().port}${route}`, close, data, sent, post, checkEntry, write, stderr: () => stderr };
  } finally { clearTimeout(timer); }
}

async function checkFiles(directory) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, file.name);
    if (file.isDirectory()) await checkFiles(target);
    else if (file.isFile()) assert.ok(!(await readFile(target)).includes(forbidden), `A test credential reached runtime storage: ${file.name}`);
  }
}

let browser;
try {
  const version = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8')).version;
  await mkdir(path.join(directory, 'node_modules'), { recursive: true });
  await symlink(core, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: projectId, name: 'private-input-fixture', type: 'module',
    devDependencies: { steamharness: version }, defaultEntry: entryId, entries: [{ entryId, name: 'Fixture', root: '.', entry: 'index.ts', type: 'bot' }] }));
  await writeFile(path.join(directory, 'index.ts'), `
    import * as steamharness from 'steamharness';
    import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from ${JSON.stringify(pathToFileURL(path.join(core, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href)};
    const model = fauxProvider({ models: [{ id: 'fixture', contextWindow: 20000, maxTokens: 600 }] });
    const models = createModels(); models.setProvider(model.provider);
    model.setResponses([request => getCurrentTools(request.messages).some(tool => tool.name === 'bot_credentials_request')
      ? fauxAssistantMessage([fauxToolCall('bot_credentials_request', ${JSON.stringify({ name, kind })})], { stopReason: 'toolUse' }) : fauxAssistantMessage('No credential tool'), request => {
      const result = request.messages.findLast(message => message.role === 'toolResult');
      const received = JSON.parse(result.content[0].text);
      return fauxAssistantMessage(Object.keys(received).sort().join(',') === 'kind,name,status' ? 'Fixture status: ' + received.status : 'Unexpected result');
    }]);
    export const executor = steamharness.defineBot({ engine: 'agent', agent: { models, resolvedModel: models.getModel('faux', 'fixture'), tools: [], paramOptions: { fields: { provider: false, model: false } } } });
    export default executor;
  `);
  nativeFrame.listen(0, '127.0.0.1'); await once(nativeFrame, 'listening');
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
  page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    let state;
    window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = value; },
      postMessage: message => { if (message.type === 'workflow-frame-ready') document.body.dataset.frameReady = 'true'; } });
  });
  const frame = page.frameLocator('#workflow-frame'), prompt = frame.locator('.input-prompt');
  const startTurn = async fixture => {
    await page.goto(fixture.page); await page.locator('body[data-frame-ready=true]').waitFor();
    try { await frame.locator('#message:enabled').fill('Ask for a fixture credential'); }
    catch (error) {
      const body = await frame.locator('body').innerText({ timeout: 2_000 }).catch(() => 'Frame unavailable');
      throw new Error(`Credential fixture did not admit input: ${body.slice(0, 1_200)}\n${errors.join('\n')}\n${await fixture.checkEntry()}`, { cause: error });
    }
    await frame.locator('#send').click();
  };

  const local = await launch('en', true);
  let send;
  page.on('request', request => { if (request.url().endsWith('/api/message') && request.method() === 'POST') {
    try { const value = request.postDataJSON(); if (value.type === 'send') send = value; } catch { /* ignore non-JSON */ }
  } });
  await startTurn(local);
  try { await prompt.getByRole('heading', { name: 'Bot credential' }).waitFor({ timeout: 6_000 }); }
  catch (error) {
    const state = (await local.post({ type: 'ready', clientId: send?.clientId })).body;
    const messages = state.messages?.find(item => item.type === 'state')?.sessions?.flatMap(session => session.messages.map(message => ({ status: message.status, content: message.content, error: message.error, pending: !!message.pendingInput })));
    throw new Error(`Credential prompt did not open: ${JSON.stringify(messages)}\n${local.stderr()}\n${errors.join('\n')}`, { cause: error });
  }
  const button = prompt.getByRole('button', { name: 'Open secure input' });
  assert.equal(await prompt.locator('input,textarea').count(), 0);
  assert.equal(local.sent.filter(record => record.type === 'bot-credential-request').length, 0);
  const { clientId, sessionId, projectUri, applicationId } = send;
  const identity = { clientId, sessionId, projectUri, applicationId };
  const ready = await local.post({ ...identity, type: 'ready' });
  const active = ready.body.messages.find(item => item.type === 'state').sessions.find(session => session.id === sessionId);
  const answer = active.messages.find(item => item.pendingInput?.credential);
  const selection = { ...identity, messageId: answer.id, requestId: answer.pendingInput.requestId };
  const forged = await local.post({ ...selection, type: 'resume', values: { status: 'saved', value: forbidden } });
  assert.notEqual(forged.status, 200);
  assert.ok(!JSON.stringify(forged.body).includes(forbidden));
  const preview = await local.post({ ...selection, type: 'bot-credential-input' }, { 'X-SteamHarness-Preview-Mount': `/p/${'a'.repeat(43)}` });
  assert.notEqual(preview.status, 200);
  assert.equal(local.sent.filter(record => record.type === 'bot-credential-request').length, 0);

  await button.click();
  const request = await waitFor(() => local.sent.find(record => record.type === 'bot-credential-request'), 'The page did not open native credential entry');
  assert.deepEqual(request, { type: 'bot-credential-request', id: request.id, entryId, action: 'capture', slot: { name, kind } });
  local.write({ type: 'bot-credential-result', id: request.id, status: 'saved' });
  await frame.getByText('Fixture status: saved', { exact: true }).waitFor();
  await prompt.waitFor({ state: 'detached' });
  const snapshot = await local.post({ ...identity, type: 'ready' });
  assert.ok(!JSON.stringify(snapshot.body).includes(forbidden));
  const exported = await local.post({ ...identity, type: 'session-action', action: 'export', id: sessionId });
  const download = exported.body.messages.find(item => item.type === 'download');
  assert.ok(download?.content && !download.content.includes(forbidden));
  const management = local.post({ ...identity, type: 'bot-credentials-manage' });
  const manageRequest = await waitFor(() => local.sent.find(record => record.type === 'bot-credential-request' && record.action === 'manage'), 'Missing native credential management request');
  assert.deepEqual(manageRequest, { type: 'bot-credential-request', id: manageRequest.id, entryId, action: 'manage' });
  local.write({ type: 'bot-credential-result', id: manageRequest.id, status: 'managed' });
  assert.equal((await management).status, 200);
  assert.ok(!local.stderr().includes(forbidden));
  await page.goto('about:blank'); await local.close(); await checkFiles(local.data);

  const zh = await launch('zh-CN', true);
  await page.setViewportSize({ width: 390, height: 640 });
  await startTurn(zh);
  const zhButton = prompt.getByRole('button', { name: '\u6253\u5f00\u5b89\u5168\u8f93\u5165' });
  await zhButton.waitFor();
  assert.equal(await prompt.locator('input,textarea').count(), 0);
  assert.equal(await prompt.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await zhButton.click();
  const zhRequest = await waitFor(() => zh.sent.find(record => record.type === 'bot-credential-request'), 'Missing second fixture credential request');
  zh.write({ type: 'bot-credential-result', id: zhRequest.id, status: 'declined' });
  await frame.getByText('Fixture status: declined', { exact: true }).waitFor();
  await page.goto('about:blank'); await zh.close();

  const unavailable = await launch('en', false);
  await startTurn(unavailable);
  await frame.getByText('No credential tool', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Bot credential cards passed: no plaintext fields, host-only receipts, denied ordinary/preview submits, saved/declined continuation, and local-only tools.');
} finally {
  await browser?.close(); await Promise.all([...children].map(close => close()));
  if (nativeFrame.listening) await new Promise(resolve => nativeFrame.close(resolve));
  await rm(root, { recursive: true, force: true });
}
