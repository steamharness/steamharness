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
const registryFile = path.join(data, 'instance.json');
const caseFile = path.join(directory, 'fixture-case.txt');
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const availablePort = async () => { const server = http.createServer(); const port = await listen(server, '127.0.0.1'); await close(server); return port; };
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

function reverseProxy(tls, port) {
  const sockets = new Set();
  const server = https.createServer(tls, (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
    });
    upstream.on('error', () => res.destroy()); res.once('close', () => upstream.destroy()); req.pipe(upstream);
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
  return { server, close: async () => { for (const socket of sockets) socket.destroy(); await close(server); } };
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
      await vscode.commands.executeCommand('studio.openSettings',{section:'remote-access'});
      const name=await fs.readFile(${JSON.stringify(caseFile)},'utf8').catch(()=>'');
      if(!['proxy','lan'].includes(name))return;
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
      '--builtin-extensions-dir', await webBuiltins(data, upstream.directory, path.join(ROOT, 'extensions/studio-workstation')), '--default-workspace', workspaceFile],
  }) }).catch(error => { startupError = error; });
  await until(async () => { if (startupError) throw startupError; return readJson(registryFile).catch(() => undefined); }, 'Studio Web did not start.');
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true,
    env: browserEnvironment,
    proxy: browserProxy ? { server: browserProxy, bypass: '.example.test,localhost,127.0.0.1' } : undefined,
    args: [...(liveWebviews ? [] : ['--no-proxy-server']), '--host-resolver-rules=MAP *.example.test 127.0.0.1'] });
  const localContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  if (!liveWebviews) await serveLocalWebviewAssets(localContext, upstream);
  const localPage = await localContext.newPage();
  if (liveWebviews) localPage.on('requestfailed', request => {
    if (request.url().includes('.vscode-cdn.net/')) console.error('Webview asset request failed:', new URL(request.url()).pathname, request.failure()?.errorText);
  });
  await localPage.goto(local, { waitUntil: 'domcontentloaded' });
  const settings = await until(async () => {
    for (const frame of localPage.frames()) {
      if (await frame.getByRole('button', { name: 'Generate pairing code' }).isVisible().catch(() => false)) return frame;
    }
  }, 'The local workbench did not open Remote Access settings.', 60_000);
  let botFailure;
  for (const [index, origin] of remote.entries()) {
    const zh = index === 1;
    const name = zh ? 'lan' : 'proxy';
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: zh ? 'zh-CN' : 'en-US', viewport: { width: 1280, height: 900 } });
    if (!liveWebviews) await serveLocalWebviewAssets(context, upstream);
    try {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: zh ? '配对 SteamHarness Studio' : 'Pair with SteamHarness Studio' }).waitFor();
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
      } else await page.getByLabel('Pairing code').fill(code);
      await writeFile(caseFile, name);
      await page.getByRole('button', { name: zh ? '确认配对' : 'Confirm pairing' }).click();
      await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
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
  await rm(directory, { recursive: true, force: true });
}
