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
import { build } from 'esbuild';
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
const openTab = async (page, open) => (await Promise.all([page.waitForEvent('popup', { timeout: 30_000 }), open()]))[0];

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

async function checkLibraryReload(page, zh = false) {
  await page.emulateMedia({ reducedMotion: zh ? 'reduce' : 'no-preference' });
  // Observe from before workbench startup so even a single frame with a plain folder or empty shelf is caught.
  await page.addInitScript(({ name, folder }) => {
    const phases = window.studioTestLibraryPhases = [];
    window.studioTestLibraryAnimated = false;
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'lp-library-pulse') window.studioTestLibraryAnimated = true;
    });
    new MutationObserver(() => {
      const library = document.querySelector('.lp-library');
      if (!library) return;
      const card = [...library.querySelectorAll('.lp-library-card')].find(card =>
        [name, folder].includes(card.querySelector('.lp-caption strong')?.textContent));
      const loading = library.querySelector('.lp-library-loading:not([hidden]) [role="status"]');
      const empty = library.querySelector('.lp-empty');
      const phase = loading ? (library.querySelector('.lp-library-card') || empty ? 'Premature content' : loading.textContent)
        : card ? (card.querySelector('.lp-card-tags small')?.textContent === 'Bot' ? 'Bot' : 'Unrecognized project') : empty ? 'Empty library' : undefined;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }, { name: importedBot.name, folder: path.basename(importedSource) });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const card = page.locator('.lp-library-card[data-key^="all:"]').filter({ hasText: importedBot.name });
  await card.getByText('Bot', { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(await card.locator('.lp-art-stack img').first().isVisible(), true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // Allow the debounced focus refresh to run without replacing the visible library with placeholders.
  await delay(250);
  assert.deepEqual(await page.evaluate(() => ({ phases: window.studioTestLibraryPhases, animated: window.studioTestLibraryAnimated })),
    { phases: [zh ? '正在加载项目…' : 'Loading projects…', 'Bot'], animated: !zh });
  assert.equal(await page.locator('.lp-library-loading').isVisible(), false);
  await page.getByRole('button', { name: zh ? '源码' : 'Source', exact: true }).click();
  await card.click();
  await checkImportedBot(page, zh);
}

// Exercise the real account controller with a fixture for the private social commands.
async function registerPlatformProfile(vscode) {
  const { registerCommand, executeCommand } = vscode.commands;
  const chats = [{ id: 'fixture-chat', name: 'Fixture chat', group: true, unread: 0, preview: 'Hello' },
    { id: 'another-chat', name: 'Another chat', unread: 0, preview: 'Hi' }];
  registerCommand('studio.getLaunchpadInbox', () => ({ connection: 'connected', items: chats }));
  registerCommand('studio.getSocialSnapshot', () => ({ people: [{ id: 'friend', name: 'Fixture friend', relation: 'friend' }], favorites: [{ id: 'favorite', title: 'Fixture favorite' }], notices: [] }));
  registerCommand('studio.getLaunchpadDirectory', () => ({ groups: [], conversations: [] }));
  registerCommand('studio.hasUnreadNotices', () => false);
  registerCommand('studio.openLaunchpadInbox', async (requestId, conversation) => {
    const chat = chats.find(item => item.id === conversation);
    if (!chat) return 'Unexpected conversation';
    if (!await executeCommand('studio.internalPrepareLaunchpadApp', 'fixture', {})) return 'Unable to prepare the fixture';
    return executeCommand('studio.internalShowLaunchpadApp', 'fixture', requestId, { id: conversation, title: chat.name,
      html: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-fixture'; script-src 'nonce-fixture'">
      <style nonce="fixture">body{margin:0;padding:0;height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto}main{overflow:auto}</style>
      <h1>${chat.name}</h1><main>${chat.preview}</main><footer><textarea aria-label="Message"></textarea></footer>
      <script nonce="fixture">acquireVsCodeApi().postMessage({type:'studio-launchpad-ready'});</script>`,
    });
  });
  await executeCommand('studio.internalUpdateStartState', { version: 1, platform: true, labels: {}, hasWorkspace: false, projects: [], recent: [], pending: [], canCreate: false, busy: false });
}

async function openProfile(page) {
  await page.locator('.studio-launchpad').getByRole('tab', { name: 'My Studio', exact: true }).click({ timeout: 60_000 });
  return page.locator('#lp-page-profile');
}

async function checkPlatformProfile(page, issuer) {
  const signIn = profile => profile.getByRole('button', { name: 'Sign in', exact: true });
  let profile = await openProfile(page);
  const approval = await openTab(page, () => signIn(profile).click({ timeout: 60_000 }));
  await approval.getByRole('button', { name: 'Approve test sign-in' }).click();
  await profile.getByText('Fixture account', { exact: true }).waitFor();
  await approval.close();
  const verified = issuer.verified;
  await page.reload({ waitUntil: 'domcontentloaded' });
  profile = await openProfile(page);
  await profile.getByText('Fixture account', { exact: true }).waitFor();
  assert.ok(issuer.verified > verified, 'Reload must verify the saved account, not only repaint its name');
  assert.equal(issuer.started, 1);

  const other = await page.context().newPage();
  await other.goto(page.url(), { waitUntil: 'domcontentloaded' });
  const otherProfile = await openProfile(other);
  await otherProfile.getByText('Fixture account', { exact: true }).waitFor();
  await profile.getByRole('tab', { name: 'Contacts & friends', exact: true }).click();
  await profile.getByText('Fixture friend', { exact: true }).waitFor();
  await profile.getByRole('tab', { name: 'Favorites', exact: true }).click();
  await profile.getByText('Fixture favorite', { exact: true }).waitFor();
  await profile.getByRole('tab', { name: 'Recent chats', exact: true }).click();
  const chat = profile.getByRole('button', { name: 'Fixture chat Hello' });
  const url = page.url();
  const webview = tab => tab.locator('.studio-chat-window > iframe.webview');
  const content = tab => webview(tab).contentFrame().frameLocator('#active-frame');
  const fillsViewport = tab => webview(tab).evaluate(frame => {
    const bounds = frame.getBoundingClientRect();
    const { innerWidth, innerHeight } = frame.ownerDocument.defaultView;
    return bounds.left === 0 && bounds.top === 0 && bounds.width === innerWidth && bounds.height === innerHeight;
  });
  const waitForChat = async (tab, title) => {
    // The preview runs inside the webview, not in the Launchpad document or a navigated URL.
    await tab.locator(`.studio-chat-window[aria-label="${title}"]`).waitFor();
    await content(tab).getByRole('heading', { name: title, exact: true }).waitFor();
    await until(async () => (await tab.title()) === title, `The IM tab did not take the title ${title}.`);
    assert.equal(tab.url(), 'about:blank');
    await until(() => fillsViewport(tab), `The IM tab did not fill the browser viewport: ${title}.`, 5_000);
  };
  const first = await openTab(page, () => chat.click());
  await waitForChat(first, 'Fixture chat');
  const narrow = { width: 420, height: 680 };
  await first.setViewportSize(narrow);
  await until(async () => await fillsViewport(first) && await content(first).locator('footer').evaluate((composer, height) =>
    composer.getBoundingClientRect().bottom === height && composer.previousElementSibling.getBoundingClientRect().height > 0, narrow.height),
  'The message area and composer did not follow the resized IM tab.', 5_000);
  const second = await openTab(page, () => profile.getByRole('button', { name: 'Another chat Hi' }).click());
  await waitForChat(second, 'Another chat');
  assert.equal(await first.locator('.studio-chat-window[aria-label="Fixture chat"]').isVisible(), true);
  assert.equal(page.url(), url);
  assert.equal(await chat.isVisible(), true);
  await first.close();
  assert.equal(await second.locator('.studio-chat-window').isVisible(), true);
  const reopened = await openTab(page, () => chat.click());
  await waitForChat(reopened, 'Fixture chat');
  console.log('[OK] IM group chat fills its tab and resizes · separate conversations · Launchpad stays open');
  const closed = Promise.all([second.waitForEvent('close'), reopened.waitForEvent('close')]);
  await writeFile(path.join(directory, 'profile-commands.json'), 'logout');
  await closed;
  await Promise.all([signIn(profile).waitFor(), signIn(otherProfile).waitFor({ timeout: 10_000 })]);
  assert.equal(await chat.count(), 0);
  await other.close();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await signIn(await openProfile(page)).waitFor();
  assert.equal(issuer.revoked, true);
  console.log('[OK] Platform account · device approval · restore on reload and new tab · shared sign-out · two IM tabs');
}

async function runProfileIssuer() {
  const profile = { userId: 'account-fixture', displayName: 'Fixture account', email: null };
  const accessToken = randomUUID(), apiKeyId = 'fixture-api-key';
  const issuer = { started: 0, verified: 0, revoked: false, origin: '', close: () => close(server) };
  let approved = false;
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, issuer.origin).pathname;
    req.resume();
    const json = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const success = data => json({ errCode: 0, data });
    if (route === '/login/device') {
      if (req.method === 'POST') approved = true;
      return res.writeHead(200, { 'Content-Type': 'text/html' }).end(approved ? 'Approved' : '<form method="post"><button>Approve test sign-in</button></form>');
    }
    if (route === '/api/auth/device/start') {
      issuer.started++;
      return success({ deviceCode: 'fixture-device', userCode: 'ABCD-1234', verificationUriComplete: `${issuer.origin}/login/device`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 1 });
    }
    if (route === '/api/auth/device/token') {
      return approved ? success({ accessToken, apiKey: { id: apiKeyId }, user: profile }) : json({ errCode: 409, errMessage: 'authorization_pending' }, 409);
    }
    if (req.headers.authorization !== `Bearer ${accessToken}` || issuer.revoked) return json({ errCode: 401 }, 401);
    if (route === '/api/auth/me') {
      issuer.verified++;
      return success({ profile, principal: { apiKeyId } });
    }
    if (route === '/api/auth/logout') {
      issuer.revoked = true;
      return success({ revoked: true });
    }
    return json({ errCode: 404 }, 404);
  });
  issuer.origin = `http://127.0.0.1:${await listen(server, '127.0.0.1')}`;
  return issuer;
}

async function runPlatformProfile(context) {
  const state = path.join(directory, 'profile-server');
  const extensions = path.join(state, 'extensions');
  const fixture = path.join(extensions, 'studio.studio-workstation-999.0.0');
  await mkdir(fixture, { recursive: true });
  // Override the built-in extension only in this isolated server profile.
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'studio-workstation', publisher: 'studio', version: '999.0.0',
    engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
  const issuer = await runProfileIssuer();
  const registry = path.join(state, 'instance.json');
  let startupError, runner, page, origin;
  try {
    await build({ stdin: { resolveDir: ROOT, contents: `
      import * as vscode from 'vscode';
      import { unlink } from 'node:fs/promises';
      import { createHash } from 'node:crypto';
      import { activateProjectAccount } from './extensions/studio-workstation/src/workflow-auth.ts';
      export async function activate(context) {
        await activateProjectAccount(context, undefined, true, ${JSON.stringify(issuer.origin)}, value => createHash('sha256').update(value).digest('hex'));
        await (${registerPlatformProfile.toString()})(vscode);
        const signal = ${JSON.stringify(path.join(directory, 'profile-commands.json'))};
        const timer = setInterval(async () => {
          try { await unlink(signal); } catch { return; }
          await vscode.commands.executeCommand('studio.logout');
        }, 100);
        context.subscriptions.push({ dispose: () => clearInterval(timer) });
      }` }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(fixture, 'extension.cjs') });
    const port = await availablePort(); origin = `http://127.0.0.1:${port}`;
    runner = runManagedWeb({ directory: state, storage: path.join(state, 'runs'),
      config: await webConfig({}, port), prepare: async () => ({ upstream: upstream.directory, args: [
        '--server-data-dir', state, '--extensions-dir', extensions, '--disable-workspace-trust', '--telemetry-level', 'off',
      ] }) }).catch(error => { startupError = error; });
    page = await context.newPage();
    await until(async () => { if (startupError) throw startupError; return readJson(registry).catch(() => undefined); }, 'Profile fixture did not start.');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await checkPlatformProfile(page, issuer).catch(async error => {
      const screen = await page.locator('body').innerText().catch(() => '');
      throw new Error(`Platform profile failed: ${screen.slice(0, 1500)}`, { cause: error });
    });
  } finally {
    await page?.close();
    if (await readJson(registry).catch(() => undefined)) await post(origin, 'manage', { action: 'stop' }).catch(() => undefined);
    await runner;
    await issuer.close();
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
    // The fixture maps the HTTPS workbench and preview origins onto loopback.
    args: [...(liveWebviews ? [] : ['--no-proxy-server', '--disable-features=LocalNetworkAccessChecks']), '--host-resolver-rules=MAP *.example.test 127.0.0.1'] });
  const localContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  if (!liveWebviews) await serveLocalWebviewAssets(localContext, upstream);
  await runPlatformProfile(localContext);
  const localPage = await localContext.newPage();
  const aliasPage = await localContext.newPage();
  await aliasPage.goto(local.replace('127.0.0.1', 'localhost'), { waitUntil: 'domcontentloaded' });
  await aliasPage.locator('.studio-launchpad').getByRole('tab', { name: 'Library' }).waitFor({ timeout: 60_000 });
  // A direct folder link uses the workbench and does not mount a Launchpad over it.
  await aliasPage.goto(new URL(`/?folder=${encodeURIComponent(workspace)}`, local).href, { waitUntil: 'domcontentloaded' });
  await aliasPage.locator('.monaco-workbench:not(.studio-launchpad-window)').waitFor({ timeout: 60_000 });
  await waitForBrowserExtensionHost(aliasPage);
  const aliasLaunchpad = await openTab(aliasPage, () => aliasPage.locator('[id="studio.showLaunchpad"] a').click());
  await aliasLaunchpad.locator('.studio-launchpad').getByRole('tab', { name: 'Library' }).waitFor({ timeout: 60_000 });
  const appDetails = aliasLaunchpad.locator('.lp-project-details');
  const recent = aliasLaunchpad.locator('.lp-library-card').filter({ hasText: path.basename(workspace) }).first();
  await recent.click();
  const launchpadUrl = aliasLaunchpad.url();
  const projectTab = await openTab(aliasLaunchpad, () => appDetails.getByRole('button', { name: 'Open in workbench' }).click());
  await projectTab.waitForURL(url => url.searchParams.get('folder') === workspace);
  await projectTab.locator('[id="studio.showLaunchpad"] a').click();
  assert.equal(aliasLaunchpad.url(), launchpadUrl);
  assert.equal(await appDetails.getByRole('button', { name: 'Open in workbench' }).isVisible(), true);
  assert.equal(new URL(aliasPage.url()).searchParams.get('folder'), workspace);
  await projectTab.close();
  await aliasPage.close();
  await aliasLaunchpad.close();
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
  await checkLibraryReload(localPage);
  console.log('[OK] Import without opening · source Bot details and icon · plain folder · first-load transition');
  assert.equal(await localPage.locator('.studio-mode-toggle').isVisible(), false);
  await localPage.locator('.studio-launchpad').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = await until(async () => {
    for (const frame of localPage.frames()) {
      if (await frame.getByRole('button', { name: 'Remote Access', exact: true }).isVisible().catch(() => false)) return frame;
    }
  }, 'The local Launchpad did not open Settings.', 60_000);
  await settings.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await settings.getByRole('button', { name: 'Generate pairing code' }).waitFor();
  console.log('[OK] 127.0.0.1 and localhost home · project opens in a new tab · Launchpad Settings');
  let botFailure;
  for (const [index, origin] of remote.entries()) {
    const zh = index === 1;
    const name = zh ? 'lan' : 'proxy';
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: zh ? 'zh-CN' : 'en-US', viewport: { width: 1280, height: 900 } });
    if (!liveWebviews) await serveLocalWebviewAssets(context, upstream);
    try {
      const launchpad = await context.newPage();
      await launchpad.goto(origin, { waitUntil: 'domcontentloaded' });
      await launchpad.getByRole('heading', { name: zh ? '配对 SteamHarness Studio' : 'Pair with SteamHarness Studio' }).waitFor();
      await launchpad.goto(new URL(`/?workspace=${encodeURIComponent(workspaceFile)}`, origin).href, { waitUntil: 'domcontentloaded' });
      assert.equal(new URL(launchpad.url()).pathname, '/pair');
      await settings.getByRole('combobox', { name: 'Remote address' }).selectOption(origin);
      await settings.getByRole('button', { name: 'Generate pairing code' }).click();
      const qr = settings.getByRole('img', { name: 'Pairing QR code' });
      await qr.waitFor();
      assert.match(await qr.getAttribute('src'), /^data:image\/gif;base64,/);
      const code = await settings.locator('.remote-code').innerText();
      const link = await settings.locator('[data-pair] code').last().innerText();
      assert.equal(link, `${origin}/pair#code=${code}`);
      if (zh) {
        await launchpad.setViewportSize({ width: 390, height: 844 });
        await launchpad.goto(link, { waitUntil: 'domcontentloaded' });
        await until(async () => await launchpad.getByLabel('配对码').inputValue() === code, 'The pairing link did not fill the code.');
        assert.equal(new URL(launchpad.url()).hash, '');
        assert.equal((await context.cookies()).some(cookie => cookie.name === '__Host-steamharness-studio'), false);
        assert.equal(await launchpad.evaluate(() => document.documentElement.scrollWidth), 390);
        await launchpad.setViewportSize({ width: 1280, height: 900 });
      } else {
        const input = launchpad.getByLabel('Pairing code');
        await input.fill(`${code[0] === 'A' ? 'B' : 'A'}${code.slice(1)}`);
        await launchpad.getByRole('button', { name: 'Confirm pairing' }).click();
        await launchpad.getByText('The code is incorrect, used, or expired.', { exact: false }).waitFor();
        assert.equal(new URL(launchpad.url()).pathname, '/pair');
        await input.fill(code);
      }
      await writeFile(caseFile, name);
      await launchpad.getByRole('button', { name: zh ? '确认配对' : 'Confirm pairing' }).click();
      const home = launchpad.locator('.studio-launchpad');
      await home.getByRole('tab', { name: zh ? '仓库' : 'Library' }).waitFor({ timeout: 60_000 });
      assert.equal(new URL(launchpad.url()).pathname, '/');
      await waitForBrowserExtensionHost(launchpad);
      await launchpad.reload({ waitUntil: 'domcontentloaded' });
      await home.getByRole('tab', { name: zh ? '仓库' : 'Library' }).waitFor({ timeout: 60_000 });
      await checkLocalProfile(home, zh);
      console.log(`[OK] ${name}: paired, reached Launchpad and restored session on reload`);
      await importFolder(launchpad, importedSource, zh);
      await checkImportedBot(launchpad, zh);
      console.log(`[OK] ${name}: imported unopened folder as a source Bot`);
      if (zh) {
        await checkLibraryReload(launchpad, zh);
        await launchpad.setViewportSize({ width: 390, height: 844 });
        assert.ok(await home.evaluate(element => element.scrollWidth <= element.clientWidth));
        await launchpad.setViewportSize({ width: 1280, height: 900 });
      }
      await home.getByRole('button', { name: zh ? '打开项目…' : 'Open project…' }).click();
      await home.getByRole('button', { name: zh ? '打开工作区…' : 'Open workspace…' }).click();
      const picker = launchpad.locator('.quick-input-widget');
      const input = picker.locator('input').first();
      await picker.locator('.quick-input-list .monaco-list-row').first().waitFor();
      await input.fill(path.dirname(workspaceFile) + path.sep);
      const launchpadUrl = launchpad.url();
      const page = await openTab(launchpad, () => picker.getByText(path.basename(workspaceFile), { exact: true }).click({ timeout: 10_000 })).catch(async error => {
        throw new Error(`Workspace picker value: ${await input.inputValue()}\n${(await picker.innerText()).slice(0, 2000)}`, { cause: error });
      });
      const loadErrors = [];
      page.on('pageerror', error => loadErrors.push(error.message));
      page.on('requestfailed', request => {
        if (['document', 'script'].includes(request.resourceType())) {
          loadErrors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);
        }
      });
      await page.waitForURL(url => url.searchParams.get('workspace') === workspaceFile);
      await page.locator('.monaco-workbench:not(.studio-launchpad-window)').waitFor({ timeout: 60_000 }).catch(async error => {
        const body = await page.locator('body').innerText();
        throw new Error(`Workspace failed to load: ${body.slice(0, 1000)}\n${loadErrors.slice(-20).join('\n')}`, { cause: error });
      });
      assert.equal(launchpad.url(), launchpadUrl);
      await checkImportedBot(launchpad, zh);
      await waitForBrowserExtensionHost(page);
      const persistedCookie = (await context.cookies()).find(cookie => cookie.name === '__Host-steamharness-studio');
      assert.ok(persistedCookie?.secure && persistedCookie.httpOnly);
      await home.getByRole('tab', { name: zh ? '仓库' : 'Library', exact: true }).click();
      await importFolder(launchpad, workspace, zh);
      const details = home.locator('.lp-project-details');
      const run = details.getByRole('button', { name: zh ? /^打开入口:/ : 'Run project', exact: !zh });
      const runTab = await openTab(launchpad, () => run.click());
      try {
        await runTab.waitForURL(url => url.searchParams.get('folder') === workspace);
        await until(async () => {
          for (const frame of runTab.frames()) {
            if (frame.url().startsWith(previews[index] + '/p/') && frame.url().includes('/entries/main/') &&
                await frame.locator(workflowReady).isVisible().catch(() => false)) return frame;
          }
        }, 'The project entry did not connect in the new tab.');
        assert.equal(launchpad.url(), launchpadUrl);
        assert.equal(await run.isVisible(), true);
      } finally { await runTab.close(); }
      console.log(`[OK] ${name}: ${zh ? 'selected entry' : 'default project entry'} ran in a new tab without replacing Launchpad`);
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
