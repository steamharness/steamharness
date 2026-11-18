// Run against a prepared Studio workbench and the built monorepo CLI/Core.
// For an enhanced build pass the same extension-layer environment as its launcher.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, glob, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertUpstream } from '../scripts/distribution.mjs';

const enhanced = process.env.STEAMHARNESS_STUDIO_INTERNAL === '1';
const language = process.env.STUDIO_OFFLINE_TEST_LANGUAGE === 'zh-cn' ? 'zh-cn' : 'en';
const upstream = await assertUpstream();
const tools = path.resolve(ROOT, '..');
const labels = language === 'zh-cn'
  ? JSON.parse(await readFile(path.join(tools, 'cli/src/web/messages.zh-cn.json'), 'utf8')) : {};
const label = english => labels[english] ?? english;
const onlineCommands = ['studio.openLogin', 'studio.openAccount', 'studio.uploadProject', 'studio.downloadProject', 'studio.connectSystemAi', 'studio.openHostedWebApp'];
const builtManifest = JSON.parse(await readFile(path.join(upstream.directory, 'extensions/studio-workstation/package.json'), 'utf8'));
for (const name of onlineCommands) assert.equal(builtManifest.contributes.commands.some(entry => entry.command === name), enhanced, `Built manifest: ${name}`);
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-offline-')));
const workspace = path.join(directory, 'projects'), home = path.join(directory, 'home');
const readyFile = path.join(directory, 'ready.json'), auth = path.join(directory, 'auth');
const token = randomBytes(24).toString('hex');
const requests = [], modelRequests = [];
const platform = createServer((request, response) => {
  requests.push(`${request.method} ${request.url}`);
  response.writeHead(503).end('{}');
});
const model = createServer(async (request, response) => {
  for await (const _ of request) {} // Drain the local model request before responding.
  modelRequests.push(request.url);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Local Bot response' }, null], [{}, 'stop']]) {
    response.write(`data: ${JSON.stringify({ id: 'offline-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
});
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const until = async (read, message, timeout = 30_000) => {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; ) {
    const result = await read(); if (result) return result;
    await delay(100);
  }
  throw new Error(message);
};
let child, browser, page, log = '';
try {
  const platformOrigin = await listen(platform), modelOrigin = await listen(model);
  const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'development', VSCODE_DEV: '1',
    STEAMHARNESS_CLI_AUTH_DIR: auth, STEAMHARNESS_DESKTOP_CONFIG_DIR: path.join(home, 'desktop'),
    STEAMHARNESS_SERVER_URL: platformOrigin, STEAMHARNESS_SERVER_ADMIN_KEY: 'fixture-env-project',
    STEAMHARNESS_AI_SERVER_URL: platformOrigin, STEAMHARNESS_AI_API_KEY: 'fixture-env-ai',
    STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL: platformOrigin,
    STEAMHARNESS_SERVICE_CHANNEL: 'dev', STUDIO_START_TEST_READY: readyFile, STUDIO_START_TEST_TOKEN: token,
    VSCODE_SKIP_BUILTIN_EXTENSIONS: 'vscode.vscode-api-tests,GitHub.copilot,GitHub.copilot-chat' };
  const junction = process.platform === 'win32' ? 'junction' : 'dir';
  const companion = path.join(directory, 'extensions/start-test');
  await mkdir(companion, { recursive: true }); await mkdir(auth); await mkdir(home);
  for (const purpose of ['', '-ai']) await writeFile(path.join(auth, `workflow-auth-dev${purpose}.json`), JSON.stringify({ serverUrl: platformOrigin, apiKey: `fixture-cache${purpose}` }));
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'studio.project.serverUrl': platformOrigin, 'workbench.startupEditor': 'none', 'git.enabled': false }));
  const modules = path.join(workspace, 'node_modules'); await mkdir(path.join(modules, '@steamharness'), { recursive: true });
  await symlink(path.join(tools, 'cli'), path.join(modules, '@steamharness/cli'), junction);
  await symlink(path.join(tools, 'harness'), path.join(modules, 'steamharness'), junction);
  await symlink(path.join(ROOT, 'node_modules/esbuild'), path.join(modules, 'esbuild'), junction);
  const linkedVersions = Object.fromEntries(await Promise.all([['steamharness', 'harness'], ['@steamharness/cli', 'cli']].map(async ([name, source]) => [
    name, JSON.parse(await readFile(path.join(tools, source, 'package.json'), 'utf8')).version,
  ])));
  for (const entry of ['workflow', 'bot', 'kanban']) {
    const project = path.join(workspace, entry);
    await cp(path.join(ROOT, 'examples', entry), project, {
      recursive: true, filter: filename => !['node_modules', 'dist', '.git', '.data'].includes(path.basename(filename)),
    });
    const manifestPath = path.join(project, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    Object.assign(manifest.devDependencies, linkedVersions);
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  await writeFile(path.join(workspace, 'bot/index.ts'), `import type { RuntimeApi } from 'steamharness/runtime-api';
  declare const steamharness: RuntimeApi;
  export const executor = steamharness.defineBot({ engine: 'agent', agent: {
    modelSource: 'project', model: 'fixture',
    tools: [], session: { compaction: { enabled: false } },
  } });
  export default executor;`);
  await writeFile(path.join(workspace, 'bot/configuration.json'), JSON.stringify({ version: 1, fields: [{
    name: 'STEAMHARNESS_AGENT_MODELS', type: 'json', control: 'ai-models', secret: true, defaultValue: [{
      id: 'fixture', name: 'Local fixture', source: 'third-party', apiKind: 'openai-completions', model: 'fixture', apiKey: 'local-model-key', baseUrl: `${modelOrigin}/v1`,
    }],
  }] }));
  const botManifestPath = path.join(workspace, 'bot/steamharness.json');
  const botManifest = JSON.parse(await readFile(botManifestPath, 'utf8'));
  botManifest.entries[0].configuration = 'configuration.json';
  await writeFile(botManifestPath, JSON.stringify(botManifest));
  // The example pins an older CLI; adapt its copied checkbox field to the current schema.
  const configurationPath = path.join(workspace, 'kanban/configuration.json');
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
  const labels = configuration.fields.find(field => field.name === 'labels');
  labels.multiple = true;
  labels.defaultValue = JSON.parse(labels.defaultValue);
  await writeFile(configurationPath, JSON.stringify(configuration));
  await run(process.execPath, ['build.mjs'], { cwd: path.join(workspace, 'kanban'), env });
  for (const type of ['workflow', 'bot', 'kanban']) {
    const project = path.join(workspace, type);
    const { stdout } = await run(process.execPath, [path.join(tools, 'cli/dist/index.js'), 'web', project, '--inspect', '--json', '--no-open'], { cwd: project, env });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.errors, []);
    assert.equal(result.projects[0]?.projectType, type);
  }
  await writeFile(path.join(companion, 'package.json'), JSON.stringify({ name: 'start-test', publisher: 'studio-test', version: '0.0.1',
    engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
  await build({ entryPoints: [path.join(ROOT, 'tests/start-page-ui-extension.mjs')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(companion, 'extension.cjs') });
  child = spawn(process.execPath, [path.join(upstream.directory, 'scripts/code-server.js'), '--host', '127.0.0.1', '--port', '0',
    '--connection-token', token, '--server-data-dir', path.join(directory, 'server'), '--extensions-dir', path.dirname(companion),
    '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'), '--disable-workspace-trust', '--force-disable-user-env', '--telemetry-level', 'off', '--default-folder', workspace],
  { cwd: upstream.directory, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString().replaceAll(token, '[redacted]'); });
  const port = await until(() => /(?:Web UI available at http:\/\/[^:/\s]+:|Extension host agent listening on )(\d+)/.exec(log)?.[1], 'Workbench did not start');
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  const context = await browser.newContext({ locale: language === 'zh-cn' ? 'zh-CN' : 'en-US', viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'vscode.nls.locale', value: language, domain: '127.0.0.1', path: '/' }]);
  await context.addInitScript(locale => { globalThis._VSCODE_NLS_LANGUAGE = locale; }, language);
  await context.route(/https:\/\/[^/]+\.vscode-cdn\.net\/.*\/webview\/browser\/pre\/(?:index\.html|fake\.html|service-worker\.js)(?:\?|$)/, async route => {
    const filename = path.posix.basename(new URL(route.request().url()).pathname);
    await route.fulfill({ path: path.join(upstream.directory, 'out/vs/workbench/contrib/webview/browser/pre', filename),
      contentType: filename.endsWith('.js') ? 'application/javascript' : 'text/html' });
  });
  page = await context.newPage(); page.setDefaultTimeout(45_000);
  page.on('pageerror', error => { log += `\n[workbench] ${error.message.replaceAll(token, '[redacted]')}`; });
  page.on('console', message => {
    if (message.type() === 'error') log += `\n[browser] ${message.text().replaceAll(token, '[redacted]')}`;
  });
  page.on('requestfailed', request => { log += `\n[request failed] ${request.url().split(/[?#]/, 1)[0]} ${request.failure()?.errorText}`; });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.pathname.startsWith('/entries/')) {
      log += `\n[entry request] ${response.status()} ${url.origin}${url.pathname}`;
      if (url.pathname.endsWith('/api/message')) void response.text().then(text => { log += `\n[entry error] ${text.slice(0, 500)}`; }, () => undefined);
    }
  });
  const workbench = `http://127.0.0.1:${port}/?${new URLSearchParams({ tkn: token, folder: workspace })}`;
  await page.goto(workbench, { waitUntil: 'commit', timeout: 60_000 });
  const bridge = await until(async () => JSON.parse(await readFile(readyFile, 'utf8').catch(() => 'null')), 'Extension did not activate', 120_000);
  assert.ok(bridge.port, bridge.error);
  assert.deepEqual(bridge.folders, [workspace]);
  const call = async input => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(60_000) });
    const body = await response.json(); assert.ok(response.ok, body.error); return body.result;
  };
  const command = (command, ...args) => call({ action: 'command', command, args });
  const names = await call({ action: 'commands' });
  for (const name of onlineCommands) {
    assert.equal(names.includes(name), enhanced, name);
  }
  await command('studio.refreshProjectView');
  await command('studio.refreshStart');
  const state = await command('studio.internalGetStartState');
  assert.equal(state.projects.length, 3, JSON.stringify(state.projects));
  assert.equal(Boolean(state.platform), enhanced);
  await command('studio.openStart');
  const start = page.locator('.studio-start:visible').last(); await start.waitFor();
  if (!enhanced) {
    const onlineLabel = /sign in|upload project|download project|登录|上传项目|下载项目/iu;
    assert.equal(await start.getByRole('button', { name: onlineLabel }).count(), 0);
    assert.equal(await page.locator('.part.titlebar').getByRole('button', { name: onlineLabel }).count(), 0);
    const palette = command('workbench.action.showCommands');
    const widget = page.locator('.quick-input-widget:visible'), input = widget.locator('input');
    await input.fill('>SteamHarness');
    await widget.locator('.monaco-list-row').first().waitFor();
    assert.equal(await widget.getByText(onlineLabel).count(), 0);
    await input.press('Escape'); await palette;
  }
  const frameFor = (projectId, selector) => until(async () => {
    for (const frame of page.frames()) {
      if (await frame.locator(`meta[name="steamharness-project"][content="projects/${projectId}/entries/main"]`).count().catch(() => 0)
        && await frame.locator(selector).first().isVisible().catch(() => false)) return frame;
    }
  }, `No visible frame for ${projectId}: ${selector}`);
  const open = async (name, selector) => {
    const project = state.projects.find(project => project.folderPath === path.join(workspace, name));
    assert.ok(project, name);
    const { id } = JSON.parse(await readFile(path.join(project.folderPath, 'steamharness.json'), 'utf8'));
    await command('studio.openProjectInTab', project.uri);
    const frame = await frameFor(id, selector);
    if (!enhanced) assert.equal(await frame.locator('#web-account:visible,#account-dialog:visible,#parameter-login:visible').count(), 0);
    return frame;
  };
  const workflow = await open('workflow', '#workflow-param-subject');
  await workflow.locator('#workflow-param-subject').fill('Local workflow proof');
  await workflow.locator('#run').click();
  await workflow.locator('.input-prompt input[type=checkbox]').check();
  await workflow.locator('.input-prompt').getByRole('button', { name: label('Resume run'), exact: true }).click();
  await workflow.locator('#run-output').getByText('workflow-result.txt').waitFor();
  const generated = [];
  for await (const file of glob('**/workflow-result.txt', { cwd: directory })) generated.push(file);
  assert.equal(generated.length, 1);
  assert.match(await readFile(path.join(directory, generated[0]), 'utf8'), /^Local workflow proof/m);
  console.log('[OK] Workflow generated a local file');
  const bot = await open('bot', '#message');
  await bot.locator('#message').fill('Local bot proof'); await bot.locator('#send').click();
  await bot.getByText('Local Bot response', { exact: true }).waitFor();
  console.log('[OK] Bot used its configured local model');
  const board = await open('kanban', '#kanban-preview');
  const preview = board.frameLocator('#kanban-preview');
  await preview.locator('#new-task').click(); await preview.locator('#task-title').fill('Local Kanban proof');
  await preview.locator('#save-task').click(); await preview.getByText('Local Kanban proof', { exact: true }).waitFor();
  console.log('[OK] Kanban created a local task');
  // The sample's tasks are transient; configuration values are persisted by CLI Web.
  await board.locator('#project-info').click();
  await board.getByRole('tab', { name: label('Project configurations'), exact: true }).click();
  const profiles = board.locator('#project-configurations-dialog');
  await profiles.locator('li[data-active="true"] .configuration-profile-link').click();
  await profiles.getByRole('textbox', { name: '\u770b\u677f\u540d\u79f0', exact: true }).fill('Local roadmap proof');
  await profiles.getByRole('button', { name: label('Save'), exact: true }).click();
  await board.locator('.project-information-dialog').getByRole('button', { name: label('Close'), exact: true }).click();
  await preview.locator('#board-title').getByText('Local roadmap proof', { exact: true }).waitFor();
  await command('workbench.action.closeAllEditors');
  await (await open('bot', '#message')).getByText('Local Bot response', { exact: true }).waitFor();
  const restored = await open('kanban', '#kanban-preview');
  await restored.frameLocator('#kanban-preview').locator('#board-title').getByText('Local roadmap proof', { exact: true }).waitFor();
  const archive = path.join(directory, 'packed.tgz');
  const pack = await run(process.execPath, [path.join(tools, 'cli/dist/index.js'), 'workspace', 'pack', 'workflow', '--path', path.join(workspace, 'workflow'), '--output', archive], { cwd: workspace, env });
  assert.equal(JSON.parse(pack.stdout).archivePath, archive);
  assert.deepEqual((await readFile(archive)).subarray(0, 2), Buffer.from([0x1f, 0x8b]));
  assert.ok(modelRequests.length > 0, 'Bot should call only its explicitly configured local model');
  assert.deepEqual(requests, [], 'Plain workbench use made a platform request');
  console.log(`[OK] ${enhanced ? 'enhanced' : 'public'} (${language}): actual workbench, three local projects, generated file, restored Bot history and Kanban configuration, workspace pack; zero platform requests`);
} catch (error) {
  if (page) {
    console.error('Workbench notifications:', await page.locator('.notification-list-item-message').allTextContents().catch(() => []));
    console.error('Workbench frames:', page.frames().map(frame => frame.url().split(/[?#]/, 1)[0]));
    for (const frame of page.frames()) {
      const url = new URL(frame.url()), isEntry = url.hostname === '127.0.0.1' && url.pathname === '/entries/main/';
      if (!isEntry) continue;
      const text = await fetch(`${url.origin}${url.pathname}`, { signal: AbortSignal.timeout(2_000) }).then(response => response.text()).catch(String);
      console.error('Entry diagnostic:', text.match(/<pre>(.*?)<\/pre>/s)?.[1] ?? text.slice(0, 320));
      console.error('Entry errors:', await frame.locator('.error:visible,[role=alert]:visible,#run-meta:visible,#run-output:visible,#run-prompt:visible').allTextContents().catch(() => []));
    }
  }
  for await (const file of glob('server/logs/**/Studio.log', { cwd: directory })) console.error((await readFile(path.join(directory, file), 'utf8')).replaceAll(token, '[redacted]'));
  console.error(log.slice(-14_000));
  console.error('Platform requests:', requests);
  console.error('Model requests:', modelRequests);
  throw error;
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await once(child, 'exit');
  }
  for (const service of [platform, model]) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
