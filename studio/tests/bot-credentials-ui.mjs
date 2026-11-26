// Exercise the real CLI, worker and browser with an isolated stand-in for the native host.
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
const named = { kind: 'structured', name: 'fixture-sso', fields: ['tenant', 'client-id', 'client.secret'] };
const other = { kind: 'structured', name: 'fixture-other' };
const use = { name: named.name, connector: 'alibaba-cloud-dns', operation: 'list-domains',
  fields: { accessKeyId: 'client-id', accessKeySecret: 'client.secret' }, page: 1 };
const queryResult = { status: 'ok', page: 1, total: 1, rows: [{ domain: 'example.com' }] };
const records = { ...use, operation: 'list-records', domain: 'example.com', page: 2 };
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

async function launch(language, native, structured = native, useEnabled = structured, permissionPolicy = 'workspace', permissionSupport = useEnabled) {
  const data = path.join(root, `data-${language}-${native}-${permissionPolicy}-${permissionSupport}`);
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
  write({ type: 'configure', surface: 'editor', localBotCredentials: native, localBotCredentialStructured: structured, localBotCredentialUse: useEnabled,
    localBotCredentialConversationApproval: useEnabled, localBotCredentialPermissionPolicy: permissionSupport,
    userSettings: { agent: { permissionPolicy } } });
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
    const readReceipt = result => {
      const value = JSON.parse(result.content[0].text);
      if (Object.keys(value).sort().join(',') !== 'kind,name,status') throw new Error('Unexpected credential result');
      return value;
    };
    const query = (request, args = ${JSON.stringify(use)}) => getCurrentTools(request.messages).some(tool => tool.name === 'bot_credentials_use')
      ? fauxAssistantMessage([fauxToolCall('bot_credentials_use', args)], { stopReason: 'toolUse' }) : fauxAssistantMessage('No credential use support');
    const readQuery = request => {
      const result = JSON.parse(request.messages.findLast(message => message.role === 'toolResult').content[0].text);
      return fauxAssistantMessage('Fixture query: ' + (result.status === 'ok' ? result.rows[0].domain ?? result.rows[0].value : result.status));
    };
    model.setResponses([request => JSON.stringify(request.messages.findLast(message => message.role === 'user')).includes('Use in the new conversation') ? query(request)
      : getCurrentTools(request.messages).some(tool => tool.name === 'bot_credentials_request')
      ? fauxAssistantMessage([fauxToolCall('bot_credentials_request', ${JSON.stringify({ name, kind })})], { stopReason: 'toolUse' }) : fauxAssistantMessage('No credential tool'), request => {
      const result = request.messages.findLast(message => message.role === 'toolResult');
      return result.toolName === 'bot_credentials_use' ? readQuery(request) : fauxAssistantMessage('Fixture status: ' + readReceipt(result).status);
    }, request => {
      const tool = getCurrentTools(request.messages).find(tool => tool.name === 'bot_credentials_request');
      const schema = JSON.stringify(tool?.parameters ?? {});
      return schema.includes('structured') && schema.includes('"fields"') && !schema.includes('access-key-pair')
        ? fauxAssistantMessage([fauxToolCall('bot_credentials_request', ${JSON.stringify(named)}), fauxToolCall('bot_credentials_request', ${JSON.stringify(other)})], { stopReason: 'toolUse' })
        : fauxAssistantMessage('No structured credential support');
    }, request => {
      const receipts = request.messages.filter(message => message.role === 'toolResult').slice(-2).map(readReceipt);
      return fauxAssistantMessage('Fixture follow-up: ' + receipts.map(({ name, status }) => name + '=' + status).join(', '));
    }, request => query(request), readQuery, request => query(request), readQuery, request => query(request, ${JSON.stringify(records)}), readQuery, fauxAssistantMessage('Fixture can continue')]);
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
  const startTurn = async (fixture, text = 'Ask for a fixture credential') => {
    await page.goto(fixture.page); await page.locator('body[data-frame-ready=true]').waitFor();
    try { await frame.locator('#message:enabled').fill(text); }
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

  await frame.locator('#message:enabled').fill('Save two credential records'); await frame.locator('#send').click();
  await prompt.getByText(`Structured credential: ${named.name}`, { exact: true }).waitFor();
  await prompt.getByText(`Fields: ${named.fields.join(', ')}`, { exact: true }).waitFor();
  assert.equal(await prompt.locator('input,textarea').count(), 0);
  await button.click();
  const namedRequest = await waitFor(() => local.sent.find(record => record.type === 'bot-credential-request' && record.slot?.name === named.name), 'Missing the structured credential request');
  assert.deepEqual(namedRequest, { type: 'bot-credential-request', id: namedRequest.id, entryId, action: 'capture', slot: named });
  local.write({ type: 'bot-credential-result', id: namedRequest.id, status: 'saved' });
  await prompt.getByText(`Structured credential: ${other.name}`, { exact: true }).waitFor();
  assert.equal(await prompt.getByText(/^Fields:/).count(), 0);
  await button.click();
  const otherRequest = await waitFor(() => local.sent.find(record => record.type === 'bot-credential-request' && record.slot?.name === other.name), 'Missing the second request on the same reply');
  assert.deepEqual(otherRequest, { type: 'bot-credential-request', id: otherRequest.id, entryId, action: 'capture', slot: other });
  local.write({ type: 'bot-credential-result', id: otherRequest.id, status: 'saved' });
  await frame.getByText(`Fixture follow-up: ${named.name}=saved, ${other.name}=saved`, { exact: true }).waitFor();
  await prompt.waitFor({ state: 'detached' });
  assert.equal(await frame.locator('.resolved-inputs .pending').count(), 0);

  const review = prompt.getByRole('button', { name: 'Review credential use' });
  const requestQuery = async () => {
    await frame.locator('#message:enabled').fill('List domains with the saved credential'); await frame.locator('#send').click();
    try { await prompt.getByText(`Credential: ${named.name} · List Alibaba Cloud DNS domains · Page 1`, { exact: true }).waitFor(); }
    catch (error) {
      const state = (await local.post({ ...identity, type: 'ready' })).body.messages?.find(item => item.type === 'state');
      const replies = state?.sessions?.find(session => session.id === sessionId)?.messages.map(message => [message.status, message.content, message.error, message.pendingInput?.nodeName]);
      throw new Error(`Fixture did not show the query confirmation: ${JSON.stringify(replies)}\n${local.stderr()}`, { cause: error });
    }
    assert.equal(await prompt.locator('input,textarea').count(), 0);
  };
  await requestQuery();
  const pendingState = (await local.post({ ...identity, type: 'ready' })).body.messages.find(item => item.type === 'state');
  const pending = pendingState.sessions.find(session => session.id === sessionId).messages.find(item => item.pendingInput?.credentialUse);
  const forgedUse = await local.post({ ...identity, type: 'resume', messageId: pending.id, requestId: pending.pendingInput.requestId, values: queryResult });
  assert.notEqual(forgedUse.status, 200);
  const forgedApproval = await local.post({ ...identity, type: 'bot-credential-input', messageId: pending.id, requestId: pending.pendingInput.requestId, approval: { scopeId: randomUUID(), mode: 'reuse' } });
  assert.notEqual(forgedApproval.status, 200);
  assert.equal(local.sent.filter(record => record.action === 'use').length, 0);
  await review.click();
  const approvedQuery = await waitFor(() => local.sent.find(record => record.action === 'use'), 'Missing native credential use request');
  const { scopeId } = approvedQuery.approval;
  assert.match(scopeId, /^[a-f0-9-]{36}$/);
  assert.notEqual(scopeId, sessionId);
  assert.deepEqual(approvedQuery, { type: 'bot-credential-request', id: approvedQuery.id, entryId, action: 'use', use, approval: { scopeId, mode: 'prompt' } });
  local.write({ type: 'bot-credential-result', id: approvedQuery.id, result: queryResult });
  await frame.getByText('Fixture query: example.com', { exact: true }).waitFor();
  await prompt.waitFor({ state: 'detached' });
  const domainCard = frame.locator('.result-card[aria-label="Alibaba Cloud DNS domains"]');
  await domainCard.getByRole('cell', { name: 'example.com', exact: true }).waitFor();
  assert.match(await domainCard.innerText(), /Completed[\s\S]*Credential alias[\s\S]*fixture-sso[\s\S]*Page/);
  assert.equal(await domainCard.getByRole('columnheader', { name: 'Domain' }).count(), 1);

  await frame.locator('#message:enabled').fill('List domains again'); await frame.locator('#send').click();
  const miss = await waitFor(() => local.sent.find(record => record.approval?.mode === 'reuse'), 'Missing one-time approval lookup');
  assert.deepEqual(miss.approval, { scopeId, mode: 'reuse' });
  assert.equal(await prompt.count(), 0);
  local.write({ type: 'bot-credential-result', id: miss.id, status: 'approval-required' });
  await review.waitFor();
  await review.click();
  const grant = await waitFor(() => local.sent.find(record => record.approval?.mode === 'prompt' && record.id !== approvedQuery.id), 'Missing second use request');
  assert.deepEqual(grant.approval, { scopeId, mode: 'prompt' });
  local.write({ type: 'bot-credential-result', id: grant.id, result: { ...queryResult, rows: [{ domain: 'second.example.com' }] } });
  await frame.getByText('Fixture query: second.example.com', { exact: true }).waitFor();
  await prompt.waitFor({ state: 'detached' });

  await frame.locator('#message:enabled').fill('List records on page 2'); await frame.locator('#send').click();
  const reuse = await waitFor(() => local.sent.find(record => record.approval?.mode === 'reuse' && record.use?.operation === 'list-records'), 'Missing automatic credential use on the next turn');
  assert.deepEqual(reuse, { type: 'bot-credential-request', id: reuse.id, entryId, action: 'use', use: records, approval: { scopeId, mode: 'reuse' } });
  assert.equal(await prompt.count(), 0);
  const longRecord = 'record-content-'.repeat(32);
  local.write({ type: 'bot-credential-result', id: reuse.id, result: { status: 'ok', page: 2, total: 25, rows: [
    { name: '@', type: 'A', value: '192.0.2.42', ttl: 600 }, { name: 'verification', type: 'TXT', value: longRecord, ttl: 3600 },
  ] } });
  await frame.getByText('Fixture query: 192.0.2.42', { exact: true }).waitFor();
  await prompt.waitFor({ state: 'detached' });
  const recordsCard = frame.locator('.result-card[aria-label="Alibaba Cloud DNS records"]');
  await recordsCard.getByRole('cell', { name: '192.0.2.42', exact: true }).waitFor();
  assert.deepEqual(await recordsCard.getByRole('columnheader').allTextContents(), ['Record name', 'Type', 'Record value', 'TTL (seconds)']);
  assert.match(await recordsCard.innerText(), /Page\s*2\s*Rows on this page\s*2\s*Total rows\s*25/);
  await page.setViewportSize({ width: 390, height: 640 });
  assert.equal(await recordsCard.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  assert.equal(await recordsCard.getByRole('cell', { name: longRecord, exact: true }).count(), 1);
  await page.setViewportSize({ width: 960, height: 700 });
  await frame.locator('#message:enabled').fill('Continue after saving'); await frame.locator('#send').click();
  await frame.getByText('Fixture can continue', { exact: true }).waitFor();

  const snapshot = await local.post({ ...identity, type: 'ready' });
  assert.ok(!JSON.stringify(snapshot.body).includes(forbidden));
  const settled = snapshot.body.messages.find(item => item.type === 'state').sessions.find(session => session.id === sessionId);
  const followUp = settled.messages.find(item => item.role === 'assistant' && item.content.includes('Fixture follow-up:'));
  assert.equal(followUp.status, 'success');
  assert.equal(followUp.pendingInput, undefined);
  assert.equal(followUp.submittingInput, undefined);
  assert.deepEqual(followUp.resolvedInputs.map(input => input.request.credential), [named, other]);
  const queryReply = settled.messages.find(item => item.role === 'assistant' && item.content === 'Fixture query: example.com');
  assert.equal(queryReply.status, 'success');
  assert.deepEqual(queryReply.resolvedInputs.map(input => input.values), [{ status: 'ok' }]);
  const reusedReply = settled.messages.find(item => item.role === 'assistant' && item.content === 'Fixture query: 192.0.2.42');
  assert.deepEqual(reusedReply.resolvedInputs.map(input => input.values), [{ status: 'ok' }]);
  const exported = await local.post({ ...identity, type: 'session-action', action: 'export', id: sessionId });
  const download = exported.body.messages.find(item => item.type === 'download');
  assert.ok(download?.content && !download.content.includes(forbidden) && !download.content.includes(scopeId));
  const management = local.post({ ...identity, type: 'bot-credentials-manage' });
  const manageRequest = await waitFor(() => local.sent.find(record => record.type === 'bot-credential-request' && record.action === 'manage'), 'Missing native credential management request');
  assert.deepEqual(manageRequest, { type: 'bot-credential-request', id: manageRequest.id, entryId, action: 'manage' });
  local.write({ type: 'bot-credential-result', id: manageRequest.id, status: 'managed' });
  assert.equal((await management).status, 200);
  await frame.locator('#new').click();
  await frame.getByText('Fixture can continue', { exact: true }).waitFor({ state: 'detached' });
  await frame.locator('#message:enabled').fill('Use in the new conversation'); await frame.locator('#send').click();
  await review.waitFor();
  assert.equal(local.sent.filter(record => record.approval?.mode === 'reuse').length, 2);
  await review.click();
  const newScope = await waitFor(() => local.sent.find(record => record.approval?.mode === 'prompt' && record.approval.scopeId !== scopeId), 'New conversation did not request its own approval');
  local.write({ type: 'bot-credential-result', id: newScope.id, result: { status: 'declined' } });
  await frame.getByText('Fixture query: declined', { exact: true }).waitFor();
  await domainCard.getByText('Credential use declined', { exact: true }).waitFor();
  assert.equal(await domainCard.getByRole('table').count(), 0);
  await frame.locator('#message:enabled').waitFor();
  assert.ok(!local.stderr().includes(forbidden));
  await page.goto('about:blank'); await local.close(); await checkFiles(local.data);

  const zh = await launch('zh-CN', true, false);
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
  await frame.locator('#message:enabled').fill('Check capability on the old host'); await frame.locator('#send').click();
  await frame.getByText('No structured credential support', { exact: true }).waitFor();
  await page.goto('about:blank'); await zh.close();

  const unavailable = await launch('en', false);
  await startTurn(unavailable);
  await frame.getByText('No credential tool', { exact: true }).waitFor();
  await page.goto('about:blank'); await unavailable.close();

  const automatic = await launch('zh-CN', true, true, true, 'auto');
  await startTurn(automatic, 'Use in the new conversation');
  const autoRequest = await waitFor(() => automatic.sent.find(record => record.approval?.mode === 'auto'), 'Auto approve did not submit a native query');
  assert.deepEqual(autoRequest, { type: 'bot-credential-request', id: autoRequest.id, entryId, action: 'use', use, approval: { mode: 'auto' } });
  assert.equal(await prompt.count(), 0);
  automatic.write({ type: 'bot-credential-result', id: autoRequest.id, result: queryResult });
  await frame.getByText('Fixture query: example.com', { exact: true }).waitFor();
  const localizedCard = frame.locator('.result-card[aria-label="阿里云 DNS 域名列表"]');
  await localizedCard.getByText('已完成', { exact: true }).waitFor();
  await localizedCard.getByRole('columnheader', { name: '域名' }).waitFor();
  await localizedCard.getByRole('cell', { name: 'example.com', exact: true }).waitFor();
  assert.equal(await prompt.count(), 0);
  await page.goto('about:blank'); await automatic.close(); await checkFiles(automatic.data);

  const readOnly = await launch('en', true, true, true, 'read-only');
  await startTurn(readOnly, 'Use in the new conversation');
  await frame.getByText('No credential use support', { exact: true }).waitFor();
  assert.equal(await prompt.count(), 0);
  assert.equal(readOnly.sent.some(record => record.type === 'bot-credential-request'), false);
  await page.goto('about:blank'); await readOnly.close();

  const legacyAuto = await launch('en', true, true, true, 'auto', false);
  await startTurn(legacyAuto, 'Use in the new conversation');
  await review.waitFor();
  assert.equal(legacyAuto.sent.some(record => record.type === 'bot-credential-request'), false);
  await review.click();
  const legacyRequest = await waitFor(() => legacyAuto.sent.find(record => record.action === 'use'), 'Legacy host did not receive the manual query');
  assert.equal(legacyRequest.approval?.mode, 'prompt');
  legacyAuto.write({ type: 'bot-credential-result', id: legacyRequest.id, result: { status: 'declined' } });
  await frame.getByText('Fixture query: declined', { exact: true }).waitFor();
  await page.goto('about:blank'); await legacyAuto.close();
  assert.deepEqual(errors, []);
  console.log('Bot credentials passed: read-only blocks, workspace prompts, auto approve runs silently, and older hosts still require approval.');
} finally {
  await browser?.close(); await Promise.all([...children].map(close => close()));
  if (nativeFrame.listening) await new Promise(resolve => nativeFrame.close(resolve));
  await rm(root, { recursive: true, force: true });
}
