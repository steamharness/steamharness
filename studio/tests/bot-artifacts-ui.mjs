// Exercises the native Studio webview HTML, CLI worker and Core with an offline model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { writeProjectFixture } from '../../cli/scripts/test-project-fixture.mjs';
import { projectFrameHtml } from '../extensions/studio-workstation/src/workflow-webview.ts';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const core = path.join(workspace, 'harness'), cli = path.join(workspace, 'cli', 'dist');
const coreVersion = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8')).version;
const { createLocalRuntimePersistence } = await import(pathToFileURL(path.join(core, 'dist/runtime-storage.js')).href);
const agentLibrary = pathToFileURL(path.join(core, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href;
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-bot-artifacts-')));
const project = path.join(root, 'project'), data = path.join(root, 'data');
const projectId = randomUUID(), entryId = 'main', copyId = randomUUID(), filename = 'fixture-report.md';
const source = `artifacts/2026-11-24/${filename}`, original = 'Bot artifact test: original report\n';
const copyRuntime = path.join(data, 'folder-bots', copyId, 'projects', projectId, 'entries', entryId, 'runtime');
const projects = new Map(), children = new Set();
const parent = createServer((request, response) => {
  const view = projects.get(request.url);
  if (!view) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(projectFrameHtml(view.url, 'Artifact fixture', pathToFileURL(project).href, view.theme, randomUUID(), view.locale));
});

async function launch(instance, locale, theme = 'light') {
  const child = spawn(process.execPath, [path.join(cli, 'index.js'), 'web', project, '--entry', entryId, '--data-dir', data,
    '--host-stdio', '--no-open', '--json', ...(instance ? ['--folder-context'] : [])], {
    cwd: project, env: { ...process.env, HOME: root, USERPROFILE: root, STEAMHARNESS_CLI_AUTH_DIR: path.join(root, 'auth'),
      STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '', STEAMHARNESS_WEB_HOST: 'studio', STEAMHARNESS_LOCALE: locale },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const close = async () => {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 4_000);
    try { await exited; } finally { clearTimeout(kill); children.delete(close); }
  };
  children.add(close);
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.on('line', line => {
      try { const record = JSON.parse(line); if (record.type === 'ready') resolve(record); } catch { /* Diagnostic output. */ }
    });
    void exited.then(() => reject(new Error(`Fixture CLI stopped: ${diagnostics}`)));
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.stdin.on('error', () => undefined);
  child.stdin.write(JSON.stringify({ type: 'configure', surface: 'editor', localBotArtifacts: true,
    localBotArtifactLabel: instance ? 'Fixture copy' : 'Artifact fixture', userSettings: { agent: { permissionPolicy: 'workspace' } },
    ...(instance ? { folderBot: { id: instance, projectId, directory: project, background: false } } : {}) }) + '\n');
  try {
    const record = await ready;
    assert.equal(record.botArtifactProtocolVersion, 1);
    const route = `/${randomUUID()}`; projects.set(route, { ...record, locale, theme });
    return { ...record, page: `http://127.0.0.1:${parent.address().port}${route}`, close, diagnostics: () => diagnostics };
  } finally { clearTimeout(deadline); }
}

let browser;
try {
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await symlink(core, path.join(project, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeProjectFixture(path.join(project, 'package.json'), JSON.stringify({ id: projectId, name: 'artifact-fixture', devDependencies: { steamharness: coreVersion },
    type: 'module', defaultEntry: entryId, entries: [{ entryId, name: 'Artifact fixture', root: '.', type: 'bot', entry: 'index.ts', folderContext: true }] }));
  await writeFile(path.join(project, 'index.ts'), `
    import * as steamharness from 'steamharness';
    import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from ${JSON.stringify(agentLibrary)};
    const provider = fauxProvider({ models: [{ id: 'artifact-fixture', contextWindow: 10000, maxTokens: 1000 }] });
    const models = createModels(); models.setProvider(provider.provider);
    const ref = ${JSON.stringify(source)};
    const tool = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
    const result = request => request.messages.findLast(message => message.role === 'toolResult');
    const failure = (name, message) => fauxAssistantMessage('Fixture ' + name + ' failed: ' + JSON.stringify(message));
    provider.setResponses([
      request => {
        if (!getCurrentTools(request.messages).some(item => item.name === 'bot_files_publish')) throw new Error('Publish was not offered');
        return tool('bot_files_write', { path: ref, text: ${JSON.stringify(original)} });
      },
      request => result(request)?.isError === false
        ? tool('bot_files_publish', { path: ref, title: 'Fixture delivery' }) : failure('write', result(request)),
      request => result(request)?.isError === false && result(request)?.details?.botArtifact
        ? fauxAssistantMessage('Fixture turn finished') : failure('publish', result(request)),
    ]);
    export const executor = steamharness.defineBot({ engine: 'agent', memory: { enabled: false },
      agent: { models, resolvedModel: models.getModel('faux', 'artifact-fixture'), tools: [],
        paramOptions: { fields: { provider: false, model: false } } } });
    export default executor;
  `);
  parent.listen(0, '127.0.0.1'); await once(parent, 'listening');
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 740 }, acceptDownloads: true });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    let state;
    window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = value; },
      postMessage: message => { if (message.type === 'workflow-frame-ready') document.body.dataset.frameReady = 'true'; } });
  });
  const frame = page.frameLocator('#workflow-frame');
  const modal = frame.locator('.bot-artifact-library');
  const card = frame.locator('.bot-artifact-card');
  const bringUp = async app => { await page.goto(app.page); await page.locator('body[data-frame-ready=true]').waitFor(); await frame.locator('#message:enabled').waitFor(); };
  const openLibrary = async () => {
    await page.evaluate(() => window.postMessage({ type: 'workflow-host', openBotArtifacts: true }, location.origin));
    await modal.waitFor();
  };
  const download = async button => {
    const [item] = await Promise.all([page.waitForEvent('download'), button.click()]);
    assert.equal(item.suggestedFilename(), filename);
    assert.equal(await readFile(await item.path(), 'utf8'), original);
    await item.delete();
  };

  const copy = await launch(copyId, 'en');
  await bringUp(copy);
  await frame.locator('#message').fill('Deliver the fixture report');
  await frame.locator('#send').click();
  try { await card.getByRole('button', { name: 'Download' }).waitFor(); }
  catch (cause) {
    const transcript = await frame.locator('body').innerText();
    throw new Error(`Fixture did not publish a visible download.\n${transcript}\n${copy.diagnostics()}\n${errors.join('\n')}`, { cause });
  }
  const id = await card.getAttribute('data-bot-artifact');
  assert.match(id, /^ba_[0-9a-f]{32}$/u);
  await download(card.getByRole('button', { name: 'Download' }));
  const persistence = createLocalRuntimePersistence({ directory: copyRuntime });
  try { await persistence.botFiles({ projectId, entryId }).write(source, 'Replaced after delivery.\n', true); }
  finally { await persistence.close(); }
  await frame.locator('#new').click();
  await card.waitFor({ state: 'detached' });
  await frame.locator('#project-info').click();
  const details = frame.locator('#project-information-dialog[open]');
  const artifactAction = details.getByRole('button', { name: 'Artifact library', exact: true });
  await artifactAction.click(); await modal.waitFor();
  assert.equal(await details.count(), 1);
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  await artifactAction.locator(':scope:focus').waitFor();
  await details.locator(':scope > header').getByRole('button', { name: 'Close', exact: true }).click();
  await openLibrary();
  assert.match(await modal.locator('.bot-artifact-identity').innerText(), /Bot instance: Fixture copy/u);
  const row = modal.locator('.bot-artifact-row');
  await row.getByText('Fixture delivery', { exact: true }).waitFor();
  await row.getByRole('button', { name: 'Open artifact' }).click();
  assert.equal(await modal.locator('pre').textContent(), original);
  await download(row.getByRole('button', { name: 'Download' }));
  await row.getByRole('button', { name: 'Open source conversation' }).click();
  await card.waitFor();
  assert.equal(await card.getAttribute('data-bot-artifact'), id);
  await card.locator(':scope:focus').waitFor();
  await page.goto('about:blank'); await copy.close();

  for (const instance of [undefined, randomUUID()]) {
    const other = await launch(instance, 'en');
    await bringUp(other); await openLibrary();
    if (!instance) assert.equal(await modal.locator('.bot-artifact-identity').textContent(), 'Original Bot: Artifact fixture');
    await modal.getByText('No artifacts delivered yet.').waitFor();
    const url = new URL(other.url), token = new URLSearchParams(url.hash.slice(1)).get('session');
    assert.equal((await fetch(`${url.origin}${url.pathname.replace(/\/$/u, '')}/api/bot-artifacts/${id}/content`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    await page.goto('about:blank'); await other.close();
  }

  await page.setViewportSize({ width: 390, height: 640 });
  const restarted = await launch(copyId, 'zh-CN', 'dark');
  await bringUp(restarted); await openLibrary();
  assert.equal(await modal.getByRole('heading').textContent(), 'Bot \u4ea7\u7269\u5e93');
  assert.match(await modal.locator('.bot-artifact-identity').innerText(), /Bot \u5206\u8eab\uff1aFixture copy/u);
  assert.ok(await modal.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }));
  await download(row.getByRole('button', { name: '\u4e0b\u8f7d', exact: true }));
  await row.getByRole('button', { name: '\u6253\u5f00\u6765\u6e90\u4f1a\u8bdd' }).click();
  await card.locator(':scope:focus').waitFor();
  assert.equal(await card.getAttribute('data-bot-artifact'), id);
  await openLibrary();
  const confirm = frame.locator('.action-dialog'), remove = '\u79fb\u9664\u4ea4\u4ed8\u4ef6';
  await row.getByRole('button', { name: remove }).click();
  await confirm.getByRole('button', { name: '\u53d6\u6d88' }).click();
  await row.getByText('Fixture delivery', { exact: true }).waitFor();
  await row.getByRole('button', { name: remove }).click();
  await confirm.getByRole('button', { name: remove }).click();
  await modal.getByText('\u8fd8\u6ca1\u6709\u4ea4\u4ed8\u8fc7\u4ea7\u7269\u3002').waitFor();
  await modal.getByRole('button', { name: '\u5173\u95ed', exact: true }).click();
  await card.getByText('\u4ea7\u7269\u5df2\u79fb\u9664').waitFor();
  const readBack = createLocalRuntimePersistence({ directory: copyRuntime });
  try { assert.equal((await readBack.botFiles({ projectId, entryId }).read(source, 0)).text, 'Replaced after delivery.\n'); }
  finally { await readBack.close(); }
  await page.goto('about:blank'); await restarted.close();

  assert.deepEqual(errors, []);
  console.log('Bot artifact headless smoke passed: real publish, sandboxed download, snapshot, source jump, restart, confirmed removal, instance isolation, en/zh-CN.');
} finally {
  await browser?.close();
  await Promise.all([...children].map(close => close()));
  if (parent.listening) await new Promise(resolve => parent.close(resolve));
  await rm(root, { recursive: true, force: true });
}
