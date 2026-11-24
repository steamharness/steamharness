// Run after building the Studio extension, CLI, Core and Code OSS workbench.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertUpstream } from '../scripts/distribution.mjs';
import { webConfig } from '../scripts/web/config.mjs';
import { listen } from '../scripts/web/gateway.mjs';
import { runManagedWeb, webBuiltins } from '../scripts/web/launcher.mjs';
import { serveLocalWebviewAssets } from './local-webview-assets.mjs';

const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sh-web-ui-')));
const upstream = await assertUpstream(), publicRoot = path.dirname(ROOT), data = path.join(directory, 'server');
const workspace = path.join(directory, 'workflow'), companion = path.join(directory, 'extensions/remote-fixture');
const workspaceFile = path.join(directory, 'remote.code-workspace');
const importedSource = path.join(directory, 'imported source folder'), importedPlain = path.join(directory, 'imported plain folder');
const importedBot = { id: randomUUID(), name: 'Imported Bot', version: '0.8.1', defaultEntry: 'main',
  entries: [{ entryId: 'main', type: 'bot', name: 'Chat', root: '.', entry: 'index.ts' }] };
const registryFile = path.join(data, 'instance.json');
const caseFile = path.join(directory, 'fixture-case.txt');
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const availablePort = async () => { const server = http.createServer(); const port = await listen(server, '127.0.0.1'); await close(server); return port; };
const waitForBrowserExtensionHost = page => page.frameLocator('iframe.web-worker-ext-host-iframe')
  .locator('meta[http-equiv="Content-Security-Policy"]').waitFor({ state: 'attached', timeout: 30_000 });
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const until = async (read, description, timeout = 45_000) => {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await read(); if (value) return value;
    await delay(100);
  }
  throw new Error(description);
};
const post = (origin, route, body) => fetch(`${origin}/_studio/web/${route}`, { method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function checkLocalProfile(home, zh = false) {
  await home.getByRole('tab', { name: zh ? '我的' : 'My Studio', exact: true }).click();
  const profile = home.locator('#lp-page-profile');
  await profile.getByText(zh ? '本机用户' : 'Local profile', { exact: true }).waitFor();
  await profile.getByRole('tab', { name: zh ? '通知' : 'Notifications', exact: true }).waitFor();
  assert.equal(await profile.getByRole('button', { name: zh ? '登录' : 'Sign in', exact: true }).count(), 0);
  await home.getByRole('tab', { name: zh ? '仓库' : 'Library', exact: true }).click();
}

async function importFolder(page, folder, zh = false) {
  await page.locator('.studio-launchpad').getByRole('button', { name: zh ? '导入项目' : 'Import project', exact: true }).click();
  const picker = page.locator('.quick-input-widget');
  await picker.locator('.quick-input-list .monaco-list-row').first().waitFor();
  const input = picker.locator('input').first();
  await input.fill(path.dirname(folder) + path.sep);
  await picker.getByText(path.basename(folder), { exact: true }).click();
  await picker.getByRole('button', { name: zh ? '导入' : 'Import', exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
}

async function checkImportedBot(page, zh = false) {
  const details = page.locator('.studio-launchpad .lp-project-details');
  await details.getByRole('heading', { name: importedBot.name, exact: true }).waitFor();
  const facts = details.locator('.lp-detail-facts');
  for (const value of [zh ? '源码 · IDE' : 'Source · IDE', 'Bot', importedBot.version, importedBot.id]) {
    assert.equal(await facts.getByText(value, { exact: true }).isVisible(), true, `Missing project metadata: ${value}`);
  }
  assert.equal(await details.locator('.lp-detail-mark img').isVisible(), true);
  assert.equal(await details.locator('.lp-detail-entries').getByText('Chat', { exact: true }).isVisible(), true);
}

// Simulate the platform commands, without using a real account or the private extension.
async function registerPlatformProfile(vscode) {
  const { registerCommand, executeCommand } = vscode.commands;
  const account = signedIn => signedIn
    ? { status: 'authenticated', hasAccount: true, name: 'Fixture account', scopeKey: 'a'.repeat(64) }
    : { status: 'signed-out', hasAccount: false, name: 'Not signed in' };
  let current = account(false);
  const publish = signedIn => executeCommand('studio.internalUpdateAccountMenuState', current = account(signedIn));
  registerCommand('studio.internalGetAccountMenuState', () => current);
  registerCommand('studio.launchpadSignIn', () => publish(true));
  registerCommand('studio-test.profile.signOut', () => publish(false));
  registerCommand('studio.getLaunchpadInbox', () => ({ connection: 'connected', items: [{ id: 'fixture-chat', name: 'Fixture chat', unread: 0, preview: 'Hello' }] }));
  registerCommand('studio.getSocialSnapshot', () => ({ people: [{ id: 'friend', name: 'Fixture friend', relation: 'friend' }], favorites: [{ id: 'favorite', title: 'Fixture favorite' }], notices: [] }));
  registerCommand('studio.getLaunchpadDirectory', () => ({ groups: [], conversations: [] }));
  registerCommand('studio.hasUnreadNotices', () => false);
  registerCommand('studio.openLaunchpadInbox', async (requestId, conversation) => {
    if (conversation !== 'fixture-chat') return 'Unexpected conversation';
    if (!await executeCommand('studio.internalPrepareLaunchpadApp', 'fixture', {})) return 'Unable to prepare the fixture';
    return executeCommand('studio.internalShowLaunchpadApp', 'fixture', requestId, { id: conversation, title: 'Fixture chat',
      html: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-fixture'"><h1>Fixture conversation</h1>
      <script nonce="fixture">acquireVsCodeApi().postMessage({type:'studio-launchpad-ready'});</script>`,
    });
  });
  await executeCommand('studio.internalUpdateStartState', { version: 1, platform: true, labels: {}, hasWorkspace: false, projects: [], recent: [], pending: [], canCreate: false, busy: false });
  await publish(false);
}

async function checkPlatformProfile(page) {
  const profile = page.locator('#lp-page-profile');
  await page.locator('.studio-launchpad').getByRole('tab', { name: 'My Studio', exact: true }).click({ timeout: 60_000 });
  await profile.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: 60_000 });
  await profile.getByText('Fixture account', { exact: true }).waitFor();
  await profile.getByRole('tab', { name: 'Contacts & friends', exact: true }).click();
  await profile.getByText('Fixture friend', { exact: true }).waitFor();
  await profile.getByRole('tab', { name: 'Favorites', exact: true }).click();
  await profile.getByText('Fixture favorite', { exact: true }).waitFor();
  await profile.getByRole('tab', { name: 'Recent chats', exact: true }).click();
  const chat = profile.getByRole('button', { name: 'Fixture chat Hello' });
  await chat.click();
  const surface = page.locator('.studio-launchpad-settings[aria-label="Fixture chat"]');
  await surface.waitFor();
  const back = page.getByRole('button', { name: 'Back to Launchpad', exact: true });
  await back.click();
  await chat.waitFor();
  await chat.click();
  await surface.waitFor();
  await writeFile(path.join(directory, 'profile-commands.json'), JSON.stringify('studio-test.profile.signOut'));
  await surface.waitFor({ state: 'detached' });
  await profile.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await chat.count(), 0);
  console.log('[OK] Platform profile sign-in state · contacts · favorites · open/back · sign-out cleanup');
}

async function runPlatformProfile(context) {
  const state = path.join(directory, 'profile-server');
  const extensions = path.join(state, 'extensions');
  const fixture = path.join(extensions, 'studio.studio-workstation-999.0.0');
  await mkdir(fixture, { recursive: true });
  // Override the built-in extension only in this isolated server profile.
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'studio-workstation', publisher: 'studio', version: '999.0.0',
    engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
  await writeFile(path.join(fixture, 'extension.cjs'), `const vscode=require('vscode'), fs=require('node:fs/promises');
    exports.activate=async(context)=>{
      await (${registerPlatformProfile.toString()})(vscode);
      const signal=${JSON.stringify(path.join(directory, 'profile-commands.json'))};
      const timer=setInterval(async()=>{
        try{await fs.unlink(signal);}catch{return;}
        await vscode.commands.executeCommand('studio-test.profile.signOut');
      },100);
      context.subscriptions.push({dispose:()=>clearInterval(timer)});
    };`);
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  let startupError;
  const runner = runManagedWeb({ directory: state, storage: path.join(state, 'runs'),
    config: await webConfig({}, port), prepare: async () => ({ upstream: upstream.directory, args: [
      '--server-data-dir', state, '--extensions-dir', extensions, '--disable-workspace-trust', '--telemetry-level', 'off',
    ] }) }).catch(error => { startupError = error; });
  const registry = path.join(state, 'instance.json');
  const page = await context.newPage();
  try {
    await until(async () => { if (startupError) throw startupError; return readJson(registry).catch(() => undefined); }, 'Profile fixture did not start.');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await checkPlatformProfile(page).catch(async error => {
      const screen = await page.locator('body').innerText().catch(() => '');
      throw new Error(`Platform profile failed: ${screen.slice(0, 1500)}`, { cause: error });
    });
  } finally {
    await page.close();
    if (await readJson(registry).catch(() => undefined)) await post(origin, 'manage', { action: 'stop' }).catch(() => undefined);
    await runner;
  }
}

function reverseProxy(tls, port) {
  const sockets = new Set();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 6 });
  const server = https.createServer(tls, (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers, agent }, incoming => {
      incoming.on('error', () => res.destroy());
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, headers: req.headers });
    upstream.on('upgrade', (incoming, peer, bytes) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${incoming.rawHeaders.flatMap((name, i, raw) => i % 2 ? [] : [`${name}: ${raw[i + 1]}`]).join('\r\n')}\r\n\r\n`);
      if (bytes.length) socket.write(bytes);
      if (head.length) peer.write(head);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy()); socket.once('close', () => peer.destroy());
      peer.pipe(socket); socket.pipe(peer);
    });
    upstream.on('response', incoming => { incoming.destroy(); socket.destroy(); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  return { server, close: async () => { agent.destroy(); for (const socket of sockets) socket.destroy(); await close(server); } };
}

let model, proxy, runner, browser, local, startupError;
const liveWebviews = process.env.STEAMHARNESS_TEST_LIVE_WEBVIEW_ASSETS === '1';
const browserProxy = process.env.STEAMHARNESS_TEST_BROWSER_PROXY;
const browserEnvironment = { ...process.env };
const examples = ['workflow', 'bot', 'kanban'];
const workflowReady = '#app[data-connection=connected]';
const subject = 'Browser pairing regression';
let modelRequests = 0;
try {
  // Core persists configurations by project ID under the OS user's home directory.
  const home = path.join(directory, 'home');
  await mkdir(home);
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  });
  const cliManifest = await readJson(path.join(publicRoot, 'cli/package.json'));
  const coreManifest = await readJson(path.join(publicRoot, 'harness/package.json'));
  await mkdir(path.join(directory, 'node_modules/@steamharness'), { recursive: true });
  const junction = process.platform === 'win32' ? 'junction' : 'dir';
  for (const [name, source] of [['@steamharness/cli', path.join(publicRoot, 'cli')], ['steamharness', path.join(publicRoot, 'harness')], ['esbuild', path.join(ROOT, 'node_modules/esbuild')]]) {
    await symlink(source, path.join(directory, 'node_modules', name), junction);
  }
  for (const example of examples) {
    const project = path.join(directory, example);
    await cp(path.join(ROOT, 'examples', example), project, { recursive: true, filter: file => !['node_modules', '.data', 'dist'].includes(path.basename(file)) });
    const manifestFile = path.join(project, 'package.json'), manifest = await readJson(manifestFile);
    Object.assign(manifest.devDependencies, { steamharness: coreManifest.version, '@steamharness/cli': cliManifest.version });
    await writeFile(manifestFile, JSON.stringify(manifest));
    const declarationFile = path.join(project, 'steamharness.json'), declaration = await readJson(declarationFile);
    await writeFile(declarationFile, JSON.stringify({ ...declaration, id: randomUUID() }));
  }
  await mkdir(importedPlain);
  await mkdir(importedSource);
  // This folder is never opened. Import reads the declaration and does not run the entry.
  await writeFile(path.join(importedSource, 'steamharness.json'), JSON.stringify(importedBot));
  await writeFile(path.join(importedSource, 'index.ts'), `throw new Error('Import must not execute the project');`);
  await writeFile(workspaceFile, JSON.stringify({ folders: examples.map(name => ({ path: name })), settings: { 'git.enabled': false, 'workbench.startupEditor': 'none' } }));
  // Record only the disposable Workflow CLI process so recovery can be exercised without touching other sessions.
  const workflowCli = path.join(workspace, 'node_modules/@steamharness/cli');
  await mkdir(workflowCli, { recursive: true });
  await writeFile(path.join(workflowCli, 'package.json'), JSON.stringify({ name: cliManifest.name, version: cliManifest.version, bin: './fixture.mjs' }));
  await writeFile(path.join(workflowCli, 'fixture.mjs'), `import { readFile, writeFile } from 'node:fs/promises';
    import { main } from ${JSON.stringify(pathToFileURL(path.join(publicRoot, 'cli/dist/index.js')).href)};
    if (process.argv.includes('--host-stdio') && process.argv.includes('--theme')) {
      const name = await readFile(${JSON.stringify(caseFile)}, 'utf8');
      if (name === 'proxy') await writeFile(${JSON.stringify(path.join(directory, 'workflow.pid'))}, String(process.pid));
    }
    process.exitCode = await main();`);
  model = http.createServer(async (req, res) => {
    for await (const _ of req) { /* Wait for the completed model request. */ }
    modelRequests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Paired Bot response' }, null], [{}, 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'remote-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const modelPort = await listen(model, '127.0.0.1');
  await writeFile(path.join(directory, 'bot/index.ts'), `export const executor = steamharness.defineBot({
    engine: 'llm', llm: { modelSource: 'project', model: 'fixture' },
  }); export default executor;`);
  const botFile = path.join(directory, 'bot/steamharness.json'), bot = await readJson(botFile);
  bot.entries[0].configuration = 'configuration.json';
  await writeFile(botFile, JSON.stringify(bot));
  await writeFile(path.join(directory, 'bot/configuration.json'), JSON.stringify({ version: 1, fields: [{
    name: 'STEAMHARNESS_AGENT_MODELS', type: 'json', control: 'ai-models', secret: true, defaultValue: [{
      id: 'fixture', name: 'Paired fixture', source: 'third-party', apiKind: 'openai-completions', model: 'fixture', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${modelPort}/v1`,
    }],
  }] }));
  const kanbanFile = path.join(directory, 'kanban/configuration.json'), kanban = await readJson(kanbanFile);
  const labels = kanban.fields.find(field => field.name === 'labels');
  labels.multiple = true; labels.defaultValue = JSON.parse(labels.defaultValue);
  await writeFile(kanbanFile, JSON.stringify(kanban));
  execFileSync(process.execPath, ['build.mjs'], { cwd: path.join(directory, 'kanban') });
  for (const name of ['proxy', 'lan']) await writeFile(path.join(workspace, `${name}-edit.txt`), '');
  await mkdir(companion, { recursive: true });
  await writeFile(path.join(companion, 'package.json'), JSON.stringify({ name: 'remote-fixture', publisher: 'studio-test', version: '0.0.1',
    engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
  await writeFile(path.join(companion, 'extension.cjs'), `const vscode=require('vscode'), fs=require('node:fs/promises');
    exports.activate=async()=>{try{
      await vscode.extensions.getExtension('studio.studio-workstation').activate();
      const name=await fs.readFile(${JSON.stringify(caseFile)},'utf8').catch(()=>'');
      if(!['proxy','lan'].includes(name)||!vscode.workspace.workspaceFile)return;
      const folder=name=>vscode.workspace.workspaceFolders.find(entry=>entry.name===name).uri;
      const root=folder('workflow');
      for(const project of ${JSON.stringify(examples)}) vscode.commands.registerCommand('studio-test.open.'+project,()=>vscode.commands.executeCommand('studio.internalRunProjectEntry',{uri:folder(project).toString(),entryId:'main'}));
      const uri=vscode.Uri.joinPath(root,name+'-edit.txt'),editor=await vscode.window.showTextDocument(uri,{preview:false});
      await editor.edit(edit=>edit.insert(new vscode.Position(0,0),name+'-workbench'));await editor.document.save();
      const terminal=vscode.window.createTerminal({name:'Remote test',cwd:root});
      terminal.sendText((process.platform==='win32'?'echo ':'printf ')+name+'-pty > '+name+'-pty.txt');
      const signal=require('node:path').join(${JSON.stringify(directory)},name+'-commands.json');
      const timer=setInterval(async()=>{let action;try{action=JSON.parse(await fs.readFile(signal,'utf8'));await fs.unlink(signal);}catch{return;}
        try{await vscode.commands.executeCommand(action);}catch(error){await fs.writeFile(signal+'.error',String(error));}},250);timer.unref();
    }catch(error){await fs.writeFile(${JSON.stringify(path.join(directory, 'fixture-error.txt'))},String(error));}};`);
  const cert = path.join(directory, 'cert.pem'), key = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=studio-lan.example.test', '-out', cert, '-keyout', key], { stdio: 'ignore' });
  const localPort = await availablePort(), proxyPort = await availablePort(), lanPort = await availablePort();
  const tls = { cert: await readFile(cert), key: await readFile(key) };
  proxy = reverseProxy(tls, proxyPort);
  const externalPort = await listen(proxy.server, '127.0.0.1');
  const remote = [`https://studio-proxy.example.test:${externalPort}`, `https://studio-lan.example.test:${lanPort}`];
  const previews = [`https://preview-proxy.example.test:${externalPort}`, `https://preview-lan.example.test:${lanPort}`];
  local = `http://127.0.0.1:${localPort}`;
  const config = await webConfig({ STEAMHARNESS_STUDIO_WEB_LOCAL_PORT: String(localPort), STEAMHARNESS_STUDIO_WEB_PROXY_PORT: String(proxyPort),
    STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: remote[0], STEAMHARNESS_STUDIO_WEB_PROXY_PREVIEW_ORIGIN: previews[0], STEAMHARNESS_STUDIO_WEB_LAN_HOST: '0.0.0.0',
    STEAMHARNESS_STUDIO_WEB_LAN_ORIGIN: remote[1], STEAMHARNESS_STUDIO_WEB_LAN_PREVIEW_ORIGIN: previews[1],
    STEAMHARNESS_STUDIO_WEB_TLS_CERT_FILE: cert, STEAMHARNESS_STUDIO_WEB_TLS_KEY_FILE: key });
  runner = runManagedWeb({ directory: data, storage: path.join(directory, 'runs'), config, prepare: async () => ({ upstream: upstream.directory,
    args: ['--server-data-dir', data, '--extensions-dir', path.dirname(companion), '--disable-workspace-trust', '--telemetry-level', 'off',
      '--builtin-extensions-dir', await webBuiltins(data, upstream.directory, path.join(ROOT, 'extensions/studio-workstation'))],
  }) }).catch(error => { startupError = error; });
  await until(async () => { if (startupError) throw startupError; return readJson(registryFile).catch(() => undefined); }, 'Studio Web did not start.');
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true,
    env: browserEnvironment,
    proxy: browserProxy ? { server: browserProxy, bypass: '.example.test,localhost,127.0.0.1' } : undefined,
    args: [...(liveWebviews ? [] : ['--no-proxy-server']), '--host-resolver-rules=MAP *.example.test 127.0.0.1'] });
  const localContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  if (!liveWebviews) await serveLocalWebviewAssets(localContext, upstream);
  const localPage = await localContext.newPage();
  const aliasPage = await localContext.newPage();
  await aliasPage.goto(local.replace('127.0.0.1', 'localhost'), { waitUntil: 'domcontentloaded' });
  await aliasPage.locator('.studio-launchpad').getByRole('tab', { name: 'Library' }).waitFor({ timeout: 60_000 });
  // A direct folder link uses the workbench and does not mount a Launchpad over it.
  await aliasPage.goto(new URL(`/?folder=${encodeURIComponent(workspace)}`, local).href, { waitUntil: 'domcontentloaded' });
  await aliasPage.locator('.monaco-workbench:not(.studio-launchpad-window)').waitFor({ timeout: 60_000 });
  await waitForBrowserExtensionHost(aliasPage);
  await aliasPage.locator('[id="studio.showLaunchpad"] a').click();
  await aliasPage.locator('.studio-launchpad').getByRole('tab', { name: 'Library' }).waitFor({ timeout: 60_000 });
  const recent = aliasPage.locator('.lp-library-card').filter({ hasText: path.basename(workspace) }).first();
  await recent.click();
  await aliasPage.getByRole('button', { name: 'Open in workbench' }).click();
  await aliasPage.waitForURL(url => url.searchParams.get('folder') === workspace);
  await aliasPage.close();
  if (liveWebviews) localPage.on('requestfailed', request => {
    if (request.url().includes('.vscode-cdn.net/')) console.error('Webview asset request failed:', new URL(request.url()).pathname, request.failure()?.errorText);
  });
  await localPage.goto(local, { waitUntil: 'domcontentloaded' });
  await waitForBrowserExtensionHost(localPage);
  await localPage.locator('.studio-launchpad').getByRole('tab', { name: 'Library' }).waitFor({ timeout: 60_000 });
  await checkLocalProfile(localPage.locator('.studio-launchpad'));
  await importFolder(localPage, importedPlain);
  const plain = localPage.locator('.lp-project-details');
  await plain.getByRole('heading', { name: path.basename(importedPlain), exact: true }).waitFor();
  assert.equal(await plain.locator('.lp-detail-facts').getByText('Folder', { exact: true }).isVisible(), true);
  await localPage.getByRole('tab', { name: 'Library', exact: true }).click();
  await importFolder(localPage, importedSource);
  await checkImportedBot(localPage);
  await localPage.reload({ waitUntil: 'domcontentloaded' });
  await localPage.locator('.studio-launchpad').getByRole('button', { name: 'Source', exact: true }).click({ timeout: 60_000 });
  await localPage.locator('.lp-library-card[data-key^="all:"]').filter({ hasText: importedBot.name }).click({ timeout: 60_000 });
  await checkImportedBot(localPage);
  console.log('[OK] Import without opening · source Bot details and icon · plain folder · reload');
  await runPlatformProfile(localContext);
  assert.equal(await localPage.locator('.studio-mode-toggle').isVisible(), false);
  await localPage.locator('.studio-launchpad').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = await until(async () => {
    for (const frame of localPage.frames()) {
      if (await frame.getByRole('button', { name: 'Remote Access', exact: true }).isVisible().catch(() => false)) return frame;
    }
  }, 'The local Launchpad did not open Settings.', 60_000);
  await settings.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await settings.getByRole('button', { name: 'Generate pairing code' }).waitFor();
  console.log('[OK] 127.0.0.1 and localhost home · folder URL · recent project · Launchpad Settings');
  let botFailure;
  for (const [index, origin] of remote.entries()) {
    const zh = index === 1;
    const name = zh ? 'lan' : 'proxy';
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: zh ? 'zh-CN' : 'en-US', viewport: { width: 1280, height: 900 } });
    if (!liveWebviews) await serveLocalWebviewAssets(context, upstream);
    try {
      const page = await context.newPage();
      const loadErrors = [];
      page.on('pageerror', error => loadErrors.push(error.message));
      page.on('requestfailed', request => {
        if (['document', 'script'].includes(request.resourceType())) {
          loadErrors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);
        }
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: zh ? '配对 SteamHarness Studio' : 'Pair with SteamHarness Studio' }).waitFor();
      await page.goto(new URL(`/?workspace=${encodeURIComponent(workspaceFile)}`, origin).href, { waitUntil: 'domcontentloaded' });
      assert.equal(new URL(page.url()).pathname, '/pair');
      await settings.getByRole('combobox', { name: 'Remote address' }).selectOption(origin);
      await settings.getByRole('button', { name: 'Generate pairing code' }).click();
      const qr = settings.getByRole('img', { name: 'Pairing QR code' });
      await qr.waitFor();
      assert.match(await qr.getAttribute('src'), /^data:image\/gif;base64,/);
      const code = await settings.locator('.remote-code').innerText();
      const link = await settings.locator('[data-pair] code').last().innerText();
      assert.equal(link, `${origin}/pair#code=${code}`);
      if (zh) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(link, { waitUntil: 'domcontentloaded' });
        await until(async () => await page.getByLabel('配对码').inputValue() === code, 'The pairing link did not fill the code.');
        assert.equal(new URL(page.url()).hash, '');
        assert.equal((await context.cookies()).some(cookie => cookie.name === '__Host-steamharness-studio'), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
        await page.setViewportSize({ width: 1280, height: 900 });
      } else {
        const input = page.getByLabel('Pairing code');
        await input.fill(`${code[0] === 'A' ? 'B' : 'A'}${code.slice(1)}`);
        await page.getByRole('button', { name: 'Confirm pairing' }).click();
        await page.getByText('The code is incorrect, used, or expired.', { exact: false }).waitFor();
        assert.equal(new URL(page.url()).pathname, '/pair');
        await input.fill(code);
      }
      await writeFile(caseFile, name);
      await page.getByRole('button', { name: zh ? '确认配对' : 'Confirm pairing' }).click();
      const home = page.locator('.studio-launchpad');
      await home.getByRole('tab', { name: zh ? '仓库' : 'Library' }).waitFor({ timeout: 60_000 });
      assert.equal(new URL(page.url()).pathname, '/');
      await waitForBrowserExtensionHost(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await home.getByRole('tab', { name: zh ? '仓库' : 'Library' }).waitFor({ timeout: 60_000 });
      await checkLocalProfile(home, zh);
      console.log(`[OK] ${name}: paired, reached Launchpad and restored session on reload`);
      await importFolder(page, importedSource, zh);
      await checkImportedBot(page, zh);
      console.log(`[OK] ${name}: imported unopened folder as a source Bot`);
      if (zh) {
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await home.evaluate(element => element.scrollWidth <= element.clientWidth));
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      await home.getByRole('button', { name: zh ? '打开项目…' : 'Open project…' }).click();
      await home.getByRole('button', { name: zh ? '打开工作区…' : 'Open workspace…' }).click();
      const picker = page.locator('.quick-input-widget');
      const input = picker.locator('input').first();
      await picker.locator('.quick-input-list .monaco-list-row').first().waitFor();
      await input.fill(path.dirname(workspaceFile) + path.sep);
      await picker.getByText(path.basename(workspaceFile), { exact: true }).click({ timeout: 10_000 }).catch(async error => {
        throw new Error(`Workspace picker value: ${await input.inputValue()}\n${(await picker.innerText()).slice(0, 2000)}`, { cause: error });
      });
      await page.waitForURL(url => url.searchParams.get('workspace') === workspaceFile);
      await page.locator('.monaco-workbench:not(.studio-launchpad-window)').waitFor({ timeout: 60_000 }).catch(async error => {
        const body = await page.locator('body').innerText();
        throw new Error(`Workspace failed to load: ${body.slice(0, 1000)}\n${loadErrors.slice(-20).join('\n')}`, { cause: error });
      });
      await waitForBrowserExtensionHost(page);
      const persistedCookie = (await context.cookies()).find(cookie => cookie.name === '__Host-steamharness-studio');
      assert.ok(persistedCookie?.secure && persistedCookie.httpOnly);
      await until(async () => (await readFile(path.join(workspace, `${name}-pty.txt`), 'utf8').catch(() => '')).includes(`${name}-pty`), 'Remote terminal did not write to the host.');
      assert.equal(await readFile(path.join(workspace, `${name}-edit.txt`), 'utf8'), `${name}-workbench`);
      const projectFrame = (selector, exclude) => until(async () => {
        const error = await readFile(path.join(directory, `${name}-commands.json.error`), 'utf8').catch(() => '');
        if (error) throw new Error(error);
        for (const frame of page.frames()) {
          if (frame.url() !== exclude && frame.url().startsWith(previews[index] + '/p/') && frame.url().includes('/entries/main/')
            && await frame.locator(selector).isVisible().catch(() => false)) return frame;
        }
      }, `No ready project frame on the preview origin: ${selector}.`);
      const open = async (project, selector) => {
        await writeFile(path.join(directory, `${name}-commands.json`), JSON.stringify(`studio-test.open.${project}`));
        return projectFrame(selector);
      };
      const frame = await open('workflow', workflowReady);
      const previewUrl = frame.url();
      const activePreviews = [previewUrl];
      const checkRevoked = async urls => {
        const revoked = await context.newPage();
        try { for (const url of urls) assert.equal((await revoked.goto(url)).status(), 404); }
        finally { await revoked.close(); }
      };
      if (!zh) {
        await frame.locator('#input-mode [data-mode=raw]').click();
        await frame.locator('#raw-args').fill(JSON.stringify(['--subject', subject, '--review', 'false', '--delay', '1']));
        await frame.locator('#run').click();
        await frame.locator('#run-output h2').filter({ hasText: subject }).waitFor();
        await frame.locator('#app[data-run-state=idle]').waitFor();
        await frame.locator('#tab-result').click();
        const download = page.waitForEvent('download', { timeout: 15_000 });
        await frame.locator('#export-run').click();
        const record = await readJson(await (await download).path());
        assert.equal(record.status, 'success');
        assert.ok(record.files.some(file => file.name === 'workflow-result.txt'));
        const pid = Number(await readFile(path.join(directory, 'workflow.pid'), 'utf8'));
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        process.kill(pid, 'SIGTERM');
        const recovered = await projectFrame(workflowReady, previewUrl);
        assert.notEqual(new URL(recovered.url()).pathname, new URL(previewUrl).pathname);
        await checkRevoked([previewUrl]);
        await recovered.locator('#run-output h2').filter({ hasText: subject }).waitFor();
        console.log('[OK] Workflow run, browser export and CLI recovery');
        const board = await open('kanban', '#kanban-preview');
        const preview = board.frameLocator('#kanban-preview');
        await preview.locator('#new-task').click();
        await preview.locator('#task-title').fill('Paired device task');
        await preview.locator('#save-task').click();
        await preview.getByText('Paired device task', { exact: true }).waitFor();
        console.log('[OK] Kanban task');
        const botFrame = await open('bot', '#message:not([disabled])');
        const botPath = new URL(botFrame.url()).pathname, botEvents = [];
        page.on('pageerror', error => botEvents.push(error.message));
        page.on('response', response => {
          if (!response.url().includes(`${botPath}api/message`)) return;
          const action = response.request().postDataJSON()?.type;
          if (action) botEvents.push(`${action}: ${response.status()}`);
        });
        try {
          await botFrame.getByText('Paired fixture', { exact: true }).first().waitFor();
          await botFrame.locator('#new').click();
          const composer = botFrame.locator('#message');
          await composer.fill('Remote Bot test');
          assert.equal(await composer.inputValue(), 'Remote Bot test');
          await composer.press('Enter');
          await botFrame.getByText('Paired Bot response', { exact: true }).waitFor();
          assert.equal(modelRequests, 1);
          console.log('[OK] Bot streamed response');
        } catch (error) {
          const text = await botFrame.locator('body').innerText().catch(() => '');
          const composer = await botFrame.locator('#message').inputValue().catch(() => '');
          botFailure = new Error(`The fixture Bot did not respond (${modelRequests} model requests): ${text.slice(-1000)}\nComposer: ${composer}\n${botEvents.join('\n')}`, { cause: error });
        }
        activePreviews.splice(0, 1, recovered.url(), botFrame.url(), board.url());
      } else {
        await frame.locator('#new').click();
        await frame.locator('#input-mode [data-mode=form]').click();
        await frame.locator('#workflow-param-subject').waitFor();
      }
      await settings.getByRole('button', { name: 'Revoke device' }).click();
      await settings.getByText('No paired devices.').waitFor();
      await checkRevoked(activePreviews);
      await page.reload();
      await page.getByLabel(zh ? '配对码' : 'Pairing code').waitFor();
      console.log(`[OK] ${zh ? 'LAN HTTPS · zh-CN · fragment and confirmation' : 'HTTPS proxy · en · manual pairing'} · editor · terminal · Workflow · revocation`);
    } finally { await context.close(); }
  }
  if (botFailure) throw botFailure;
} catch (error) {
  const fixtureError = await readFile(path.join(directory, 'fixture-error.txt'), 'utf8').catch(() => '');
  if (fixtureError) console.error(fixtureError);
  throw error;
} finally {
  await browser?.close();
  if (runner && await readJson(registryFile).catch(() => undefined)) await post(local, 'manage', { action: 'stop' }).catch(() => undefined);
  if (runner) await runner;
  await proxy?.close();
  if (model) await close(model);
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
