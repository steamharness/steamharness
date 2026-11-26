// Runs the native webview HTML and the real CLI with an isolated Bot store and an offline model.
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

const workspace = fileURLToPath(new URL('../../', import.meta.url)), core = path.join(workspace, 'harness');
const { createLocalRuntimePersistence } = await import(pathToFileURL(path.join(core, 'dist/runtime-storage.js')).href);
const coreVersion = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8')).version;
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-bot-memory-')));
const project = path.join(root, 'project'), data = path.join(root, 'data'), nested = path.join(project, 'subproject');
const aRoot = path.join(root, 'workspace-a'), bRoot = path.join(root, 'workspace-b');
const opened = [aRoot, bRoot].map(folderPath => ({ folderPath, uri: pathToFileURL(folderPath).href, name: path.basename(folderPath) }));
const scope = { projectId: randomUUID(), entryId: 'agent' }, copy = randomUUID();
const persistence = createLocalRuntimePersistence({ directory: path.join(data, 'folder-bots', copy, 'projects', scope.projectId, 'entries', scope.entryId, 'runtime') });
const store = persistence.botMemory(scope);
const pages = new Map(), children = new Set();
const server = createServer((request, response) => {
  const target = pages.get(request.url);
  if (!target) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(projectFrameHtml(target.url, 'Memory fixture', pathToFileURL(project).href, target.language === 'en' ? 'light' : 'dark', randomUUID(), target.language,
    undefined, undefined, false, false, true, undefined, { projectDetails: { version: 1, revision: randomUUID(), localUsage: true } }));
});

async function launch(instance, language = 'en', local = true, assistant) {
  const child = spawn(process.execPath, [path.join(workspace, 'cli/dist/index.js'), 'web', project, '--data-dir', data, '--entry', scope.entryId,
    '--host-stdio', '--no-open', '--json', ...(instance ? ['--folder-context'] : [])], {
    cwd: project, env: { ...process.env, HOME: root, USERPROFILE: root, STEAMHARNESS_CLI_AUTH_DIR: path.join(root, 'auth'),
      STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '', STEAMHARNESS_WEB_HOST: 'studio', STEAMHARNESS_LOCALE: language },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ended = Promise.race([once(child, 'exit'), once(child, 'error')]).catch(error => [null, String(error)]);
  const close = async () => {
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
    try { await ended; } finally { clearTimeout(timer); children.delete(close); }
  };
  children.add(close);
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4_000); });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.on('line', line => { try { const record = JSON.parse(line); if (record.type === 'ready') resolve(record); } catch { /* diagnostics */ } });
    void ended.then(() => reject(new Error(`Fixture CLI stopped: ${diagnostics}`)));
  });
  child.stdin.write(JSON.stringify({ type: 'configure', surface: assistant ? 'assistant' : 'editor', localBotArtifacts: local, localBotArtifactLabel: instance ? 'Memory copy' : 'Memory fixture',
    userSettings: { agent: { permissionPolicy: 'workspace' } },
    ...(assistant ? { assistant, assistantProjectDir: project } : {}),
    ...(instance ? { folderBot: { id: instance, projectId: scope.projectId, directory: project, background: false } } : {}) }) + '\n');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const target = await ready;
    assert.equal(target.botMemoryProtocolVersion, local ? 1 : undefined);
    const uri = `/${randomUUID()}`;
    pages.set(uri, { ...target, language });
    const url = new URL(target.url), capability = new URLSearchParams(url.hash.slice(1)).get('session');
    const endpoint = new URL('api/bot-memory', url).href;
    const call = (body, auth = true, headers = {}) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${capability}` } : {}), ...headers }, body: JSON.stringify(body) });
    return { page: `http://127.0.0.1:${server.address().port}${uri}`, call, close };
  } finally { clearTimeout(timeout); }
}

let browser;
try {
  const create = async key => (await store.execute({ action: 'save', category: 'fixture', key, title: key, properties: { status: 'original' } })).memory;
  const a = await create('A'), b = await create('B'), c = await create('C');
  for (const item of [a, b]) await store.execute({ action: 'link', sourceId: item.id, targetId: c.id, relation: 'mentions', expectedRevision: item.revision });
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await symlink(core, path.join(project, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeProjectFixture(path.join(project, 'package.json'), JSON.stringify({ id: scope.projectId, name: 'memory-fixture', type: 'module',
    devDependencies: { steamharness: coreVersion }, defaultEntry: scope.entryId,
    entries: [{ entryId: scope.entryId, name: 'Memory fixture', root: '.', type: 'bot', entry: 'index.ts', folderContext: true }] }));
  await Promise.all([nested, aRoot, bRoot].map(directory => mkdir(directory)));
  await writeFile(path.join(project, 'index.ts'), `
    import * as steamharness from 'steamharness';
    import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(pathToFileURL(path.join(core, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href)};
    const model = fauxProvider({ models: [{ id: 'fixture', contextWindow: 20000, maxTokens: 800 }] });
    const models = createModels(); models.setProvider(model.provider);
    const assistant = process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_HOST === 'vscode';
    const calls = assistant ? [fauxToolCall('memory_save', ${JSON.stringify({ category: 'fixture', key: 'B', title: 'B from assistant A', projectPath: bRoot })})] : [
      fauxToolCall('memory_update', ${JSON.stringify({ id: c.id, expectedRevision: c.revision, title: 'C Bot', properties: { status: 'bot-active' } })}),
      fauxToolCall('memory_save', ${JSON.stringify({ category: 'fixture', key: 'A', title: 'Nested project memory', projectPath: nested })})];
    model.setResponses([() => fauxAssistantMessage(calls, { stopReason: 'toolUse' }), request => {
      const results = request.messages.filter(message => message.role === 'toolResult');
      return fauxAssistantMessage(results.length === calls.length && results.every(result => !result.isError) ? 'Fixture turn complete' : 'Fixture memory tool failed');
    }]);
    export const executor = steamharness.defineBot({ engine: 'agent', agent: { models, resolvedModel: models.getModel('faux', 'fixture'), tools: [], paramOptions: { fields: { provider: false, model: false } } } });
    export default executor;
  `);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1040, height: 740 } });
  page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(projectPath => {
    if (window !== window.top) return;
    let state;
    window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = value; },
      postMessage: message => {
        if (message.type === 'workflow-frame-ready') document.body.dataset.frameReady = 'true';
        if (message.type !== 'workflow-project-usage' || message.cancel) return;
        const { requestId, revision, part } = message;
        const usage = part === 'directory' ? { state: 'ok', bytes: 4096, path: projectPath, files: 3, directories: 1, folders: [] }
          : { state: 'ok', size: { state: 'ok', bytes: 0 }, entries: [] };
        window.postMessage({ type: 'workflow-host', projectUsage: { version: 1, revision, requestId, snapshot: { part, measuredAt: Date.now(), usage } } }, location.origin);
      } });
  }, project);
  const app = await launch(copy);
  assert.equal((await app.call({ action: 'list' }, false)).status, 401);
  assert.equal((await app.call({ action: 'list' }, true, { 'X-SteamHarness-Preview-Mount': `/p/${'a'.repeat(43)}` })).status, 404);
  assert.equal((await app.call({ action: 'list', projectId: 'another' })).status, 400);
  const original = await launch(undefined);
  assert.deepEqual(await (await original.call({ action: 'list' })).json(), { memories: [] }); await original.close();
  const browserOnly = await launch(copy, 'en', false);
  assert.equal((await browserOnly.call({ action: 'list' })).status, 404); await browserOnly.close();
  const frame = page.frameLocator('#workflow-frame'), panel = frame.locator('.bot-memory-dialog'), detail = panel.locator('.bot-memory-detail');
  const bringUp = async current => { await page.goto(current.page); await page.locator('body[data-frame-ready=true]').waitFor(); await frame.locator('#message:enabled').waitFor(); };
  const openPanel = async () => { await page.evaluate(() => window.postMessage({ type: 'workflow-host', openBotMemory: true }, location.origin)); await panel.waitFor(); };
  const row = id => panel.locator(`button[data-memory-id="${id}"]`);
  await bringUp(app);
  await frame.locator('#message').fill('Update C in the fixture'); await frame.locator('#send').click();
  await frame.getByText('Fixture turn complete').waitFor();
  await frame.locator('#project-info').click();
  const description = frame.locator('#project-information-dialog[open]');
  const overview = description.locator('[data-section=overview]');
  await overview.getByText('4 KiB', { exact: true }).waitFor();
  assert.deepEqual(await overview.locator('.lp-project-details > :is(.lp-detail-facts,.lp-detail-secondary,.lp-project-usage,.lp-detail-entries)')
    .evaluateAll(nodes => nodes.map(node => node.className)), ['lp-detail-facts', 'lp-detail-secondary', 'lp-project-usage', 'lp-detail-entries']);
  assert.equal(await overview.locator('.lp-detail-facts dd').allTextContents().then(values => values.includes('Open')), true);
  const folders = overview.getByText('Folder sizes', { exact: true });
  await folders.click();
  const scroll = await overview.evaluate(element => element.scrollTop);
  const memoryAction = description.getByRole('button', { name: 'Memory management', exact: true });
  await memoryAction.click(); await panel.waitFor(); assert.equal(await description.count(), 1);
  const scrolledToAction = await overview.evaluate(element => element.scrollTop);
  await panel.locator(':scope > header').getByRole('button', { name: 'Close', exact: true }).click();
  await memoryAction.locator(':scope:focus').waitFor();
  assert.equal(await folders.evaluate(element => element.parentElement.open), true);
  assert.equal(await overview.evaluate(element => element.scrollTop), scrolledToAction);
  if (process.env.STEAMHARNESS_UI_PROOF_DIR) {
    await mkdir(process.env.STEAMHARNESS_UI_PROOF_DIR, { recursive: true });
    await overview.evaluate((element, position) => { element.scrollTop = position; }, scroll);
    await page.screenshot({ path: path.join(process.env.STEAMHARNESS_UI_PROOF_DIR, 'studio-project-overview.png') });
  }
  await description.locator(':scope > header').getByRole('button', { name: 'Close', exact: true }).click();
  await openPanel(); assert.equal(await panel.getByRole('heading', { level: 2 }).textContent(), 'Memory management');
  assert.equal(await panel.locator('.bot-memory-muted').first().textContent(), 'Bot instance: Memory copy');
  for (const source of [a, b]) {
    await row(source.id).click(); await detail.getByRole('button', { name: 'C Bot', exact: true }).waitFor(); await detail.getByText('status: "bot-active"').waitFor();
  }
  await panel.getByLabel('Project folder path').fill(nested);
  await panel.getByRole('button', { name: 'Switch memory directory' }).click();
  await panel.getByRole('button', { name: /Nested project memory/ }).click();
  await detail.getByRole('heading', { name: 'Nested project memory' }).waitFor();
  assert.equal(await row(a.id).count(), 0);
  await panel.getByLabel('Project folder path').fill(aRoot);
  await panel.getByRole('button', { name: 'Switch memory directory' }).click();
  await panel.getByText('Choose an existing project directory authorized for this Bot.').waitFor();
  assert.equal(await panel.getByRole('button', { name: 'New memory' }).isDisabled(), true);
  await panel.getByRole('button', { name: 'Use default memory directory' }).click();
  await row(a.id).waitFor();
  assert.equal(await detail.getByRole('heading', { name: 'Nested project memory' }).count(), 0);
  await panel.getByLabel('Search memories').fill('C Bot'); await panel.getByLabel('Exact properties (JSON)').fill('{"status":"bot-active"}');
  await panel.getByRole('button', { name: 'Filter memories' }).click(); await row(a.id).waitFor({ state: 'detached' });
  await row(c.id).click();
  const jump = detail.getByRole('button', { name: 'Open source conversation', exact: true });
  await jump.click(); await panel.waitFor({ state: 'hidden' });
  await openPanel(); await row(c.id).click();
  await detail.getByRole('button', { name: 'Edit memory' }).click(); await detail.getByLabel('Title').fill('Draft change');
  const current = (await store.execute({ action: 'get', id: c.id })).memory;
  await store.execute({ action: 'update', id: c.id, title: 'C Concurrent', expectedRevision: current.revision });
  await detail.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByText('Memory changed in another window or run. Refresh before editing again.').waitFor();
  assert.equal(await detail.getByLabel('Title').inputValue(), 'Draft change');
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await detail.getByRole('heading', { name: 'C Concurrent' }).waitFor();
  await detail.getByRole('button', { name: 'Edit memory' }).click(); await detail.getByLabel('Title').fill('C Manual');
  await detail.getByLabel('Structured properties (JSON)').fill('{"status":"manual"}');
  await detail.getByRole('button', { name: 'Save', exact: true }).click();
  await detail.getByRole('heading', { name: 'C Manual' }).waitFor();
  await detail.getByRole('button', { name: 'Undo memory change' }).click();
  await detail.getByRole('heading', { name: 'C Concurrent' }).waitFor();
  await detail.getByRole('button', { name: 'Forget memory' }).click();
  await panel.getByText('Other memories still reference this entry.').waitFor();
  const unlink = detail.getByRole('button', { name: 'Remove memory link' });
  await unlink.first().click(); await unlink.nth(1).waitFor({ state: 'detached' });
  await unlink.first().click(); await detail.locator('section').filter({ hasText: 'Incoming links' }).getByText('No links.', { exact: true }).waitFor();
  await detail.getByRole('button', { name: 'Forget memory' }).click();
  await frame.locator('.action-dialog').getByRole('button', { name: 'Forget memory' }).click();
  await detail.getByText('Memory forgotten.').waitFor();
  assert.equal((await store.execute({ action: 'get', id: c.id })).memory, null);
  await page.goto('about:blank'); await app.close();
  const zh = await launch(copy, 'zh-CN');
  await bringUp(zh);
  await frame.locator('#project-info').click();
  await overview.getByRole('heading', { name: '本机用量', exact: true }).waitFor();
  await overview.getByText('4 KiB', { exact: true }).waitFor();
  const memoryActionZh = overview.getByRole('button', { name: '记忆管理', exact: true });
  if (process.env.STEAMHARNESS_UI_PROOF_DIR) {
    await page.screenshot({ path: path.join(process.env.STEAMHARNESS_UI_PROOF_DIR, 'studio-project-overview-zh.png') });
  }
  await memoryActionZh.click(); await panel.waitFor();
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
  await memoryActionZh.locator(':scope:focus').waitFor();
  await description.locator(':scope > header').getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 650 });
  await openPanel();
  assert.equal(await panel.getByRole('heading', { level: 2 }).textContent(), '\u8bb0\u5fc6\u7ba1\u7406');
  await panel.getByRole('button', { name: '\u5207\u6362\u8bb0\u5fc6\u76ee\u5f55' }).waitFor();
  await row(a.id).waitFor(); assert.equal(await row(c.id).count(), 0);
  assert.ok(await panel.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }));
  await page.goto('about:blank'); await zh.close();

  const assistantA = await launch(undefined, 'en', true, { workdir: aRoot, roots: opened });
  await bringUp(assistantA);
  await frame.locator('#message').fill('Remember this fact for workspace B'); await frame.locator('#send').click();
  await frame.getByText('Fixture turn complete').waitFor();
  await openPanel(); await panel.getByText('No memories match.').waitFor();
  await panel.getByLabel('Memory project directory').selectOption(bRoot);
  await panel.getByRole('button', { name: /B from assistant A/ }).click();
  await detail.getByRole('heading', { name: 'B from assistant A' }).waitFor();
  await detail.getByRole('button', { name: 'Open source conversation' }).waitFor();
  await page.goto('about:blank'); await assistantA.close();

  const assistantB = await launch(undefined, 'en', true, { workdir: bRoot, roots: opened.slice(1) });
  await bringUp(assistantB); await openPanel();
  await panel.getByRole('button', { name: /B from assistant A/ }).click();
  await detail.getByRole('heading', { name: 'B from assistant A' }).waitFor();
  await detail.getByText('Memory changes').waitFor();
  assert.equal(await detail.getByRole('button', { name: 'Open source conversation' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('Bot memory headless smoke passed: default and scoped Bot writes, scoped management, assistant cross-root reopen, links, provenance, undo, forget, isolation, English and Chinese.');
} finally {
  await browser?.close(); await Promise.all([...children].map(close => close()));
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await persistence.close(); await rm(root, { recursive: true, force: true });
}
