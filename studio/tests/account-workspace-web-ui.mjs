// Run after building Core, CLI, the Studio extension and the Code OSS workbench.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertUpstream } from '../scripts/distribution.mjs';
import { webConfig } from '../scripts/web/config.mjs';
import { listen } from '../scripts/web/gateway.mjs';
import { runManagedWeb, webBuiltins } from '../scripts/web/launcher.mjs';

const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-account-workspace-ui-')));
const home = path.join(temp, 'home'), state = path.join(temp, 'web'), project = path.join(temp, 'workflow');
const root = path.dirname(ROOT), studioExtension = path.join(ROOT, 'extensions/studio-workstation');
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const until = async (read, message) => {
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    const result = await read(); if (result) return result;
    await delay(100);
  }
  throw new Error(message);
};
const popup = async (page, click) => (await Promise.all([page.waitForEvent('popup'), click()]))[0];
let origin, browser, desktop, runner, startupError, selectedUser = 'A';
const logins = new Map(), credentials = new Map();
const profile = userId => ({ userId, displayName: `Fixture ${userId}`, email: null });
let serverOrigin;
const issuer = http.createServer((request, response) => {
  request.resume();
  const { pathname, searchParams } = new URL(request.url, serverOrigin);
  const json = (data, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  const ok = data => json({ errCode: 0, data });
  if (pathname === '/api/auth/device/start') {
    const deviceCode = randomUUID(); logins.set(deviceCode, { user: selectedUser });
    return ok({ deviceCode, userCode: 'ABCD-1234', verificationUriComplete: `${serverOrigin}/login/device?device=${deviceCode}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 1 });
  }
  if (pathname === '/login/device') {
    const login = logins.get(searchParams.get('device'));
    if (login && request.method === 'POST') {
      login.token = randomUUID(); credentials.set(login.token, login.user);
    }
    return response.writeHead(200, { 'Content-Type': 'text/html' }).end(login?.token ? 'Approved' : '<form method="post"><button>Approve fixture</button></form>');
  }
  if (pathname === '/api/auth/device/token') {
    // Each test login completes before the next begins.
    const login = [...logins.values()].at(-1);
    return login?.token ? ok({ accessToken: login.token, user: profile(login.user), apiKey: { id: login.token } }) : json({ errCode: 409, errMessage: 'authorization_pending' }, 409);
  }
  const token = String(request.headers.authorization ?? '').replace(/^Bearer /, ''), user = credentials.get(token);
  if (!user) return json({ errCode: 401 }, 401);
  if (pathname === '/api/auth/me') return ok({ profile: profile(user), principal: { apiKeyId: token } });
  if (pathname === '/api/auth/logout') { credentials.delete(token); return ok({ revoked: true }); }
  return json({ errCode: 404 }, 404);
});

try {
  serverOrigin = `http://127.0.0.1:${await listen(issuer, '127.0.0.1')}`;
  const { directory: kernel } = await assertUpstream();
  const layer = path.join(temp, 'layer.mjs'), storeFile = path.join(temp, 'store.mjs');
  await writeFile(layer, `export const platform = true;
    export function activate({ vscode, context }) {
      for (const [name, value] of Object.entries({ getLaunchpadInbox: { connection: 'connected', items: [] },
        getSocialSnapshot: { people: [], notices: [], favorites: [] }, hasUnreadNotices: false, markAllNoticesRead: true })) {
        context.subscriptions.push(vscode.commands.registerCommand('studio.' + name, () => value));
      }
    }`);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    STEAMHARNESS_STUDIO_INTERNAL: '1', STEAMHARNESS_STUDIO_INTERNAL_MODULE: pathToFileURL(layer).href,
    STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL: serverOrigin });
  await mkdir(home);
  await build({ entryPoints: [path.join(studioExtension, 'src/account-workspace-data-node.ts')], bundle: true, platform: 'node', format: 'esm', outfile: storeFile });
  const { NodeAccountWorkspace } = await import(pathToFileURL(storeFile).href);
  const store = new NodeAccountWorkspace(createHash('sha256').update(JSON.stringify([serverOrigin, 'A'])).digest('hex'));
  await cp(path.join(ROOT, 'examples/workflow'), project, { recursive: true, filter: file => !['node_modules', '.data', 'dist'].includes(path.basename(file)) });
  const manifestFile = path.join(project, 'steamharness.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  Object.assign(manifest, { id: randomUUID(), name: 'Shared Workflow', projectInfo: { ...manifest.projectInfo, localizedNames: { en: 'Shared Workflow', 'zh-CN': '共享工作流' } } });
  await writeFile(manifestFile, JSON.stringify(manifest));
  const dependencies = path.join(project, 'node_modules');
  await mkdir(path.join(dependencies, '@steamharness'), { recursive: true });
  const packageFile = path.join(project, 'package.json'), packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  for (const [target, folder] of [['@steamharness/cli', 'cli'], ['steamharness', 'harness'], ['esbuild', 'studio/node_modules/esbuild']]) {
    await symlink(path.join(root, folder), path.join(dependencies, target), process.platform === 'win32' ? 'junction' : 'dir');
    if (target !== 'esbuild') packageJson.devDependencies[target] = JSON.parse(await readFile(path.join(root, folder, 'package.json'), 'utf8')).version;
  }
  await writeFile(packageFile, JSON.stringify(packageJson));
  store.prepare();
  store.updateHistory(history => ({ ...history, recent: [{ uri: pathToFileURL(project).href, label: 'Shared Workflow', kind: 'folder', lastOpened: Date.now() }] }));
  const notice = { id: `${Date.now()}-${randomUUID()}`, title: 'Desktop run receipt', read: false };
  store.inbox({ kind: 'add', notice });
  desktop = spawn(process.execPath, [path.join(root, 'cli/dist/index.js'), 'web', project, '--entry', 'main', '--data-dir', store.runs, '--no-open', '--host-stdio', '--json'],
    { env: { ...process.env, STEAMHARNESS_CLI_AUTH_DIR: path.join(temp, 'cli-auth'), STEAMHARNESS_WEB_HOST: 'studio' }, stdio: ['pipe', 'pipe', 'inherit'] });
  desktop.stdin.write(`${JSON.stringify({ type: 'configure', surface: 'editor', platform: true })}\n`);
  const cli = createInterface({ input: desktop.stdout });
  let ready;
  cli.on('line', line => { try { const value = JSON.parse(line); if (value.type === 'ready') ready = value; } catch { /* Ignore log lines. */ } });
  await until(() => ready || (desktop.exitCode !== null && Promise.reject(new Error(`Desktop CLI exited: ${desktop.exitCode}`))), 'Desktop CLI failed to start.');
  const endpoint = new URL(ready.url), token = new URLSearchParams(endpoint.hash.slice(1)).get('session');
  const message = async (type, input = {}) => {
    const response = await fetch(new URL('/entries/main/api/message', endpoint), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...input }) });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      const retry = await fetch(new URL('/entries/main/api/retry', endpoint), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      throw new Error(`Workflow entry failed to start: ${await retry.text()}`);
    }
    const payload = await response.json(); assert.ok(response.ok, JSON.stringify(payload)); return payload.messages;
  };
  await message('workflow-run', { entrypointId: 'echo', params: { subject: 'From desktop' } });
  const first = await until(async () => (await message('ready'))[0].runs.find(run => run.status === 'success'), 'Desktop Workflow did not persist its output.');
  const listener = http.createServer(), port = await listen(listener, '127.0.0.1'); await close(listener);
  origin = `http://127.0.0.1:${port}`;
  runner = runManagedWeb({ directory: state, storage: path.join(temp, 'signed-out-runs'), config: await webConfig({}, port),
    prepare: async () => ({ upstream: kernel, bundleClient: true, args: ['--server-data-dir', state, '--extensions-dir', path.join(temp, 'extensions'),
      '--disable-workspace-trust', '--telemetry-level', 'off', '--builtin-extensions-dir', await webBuiltins(state, kernel, studioExtension)] }) })
    .catch(error => { startupError = error; });
  await until(async () => { if (startupError) throw startupError; return (await fetch(origin).catch(() => undefined))?.ok; }, 'Studio Web failed to start.');
  browser = await chromium.launch({ headless: true, executablePath: process.env.STUDIO_START_TEST_BROWSER_PATH, args: ['--no-proxy-server'] });
  const open = async () => {
    const context = await browser.newContext({ locale: 'en-US' });
    await context.route(/^https:\/\/[^/]+\.vscode-cdn\.net\//u, route => route.abort());
    const page = await context.newPage(); await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('.studio-launchpad').getByRole('tab', { name: 'Library', exact: true }).waitFor({ timeout: 60_000 });
    return page;
  };
  const launchpad = page => page.locator('.studio-launchpad');
  const card = page => launchpad(page).locator('.lp-library-card').filter({ hasText: 'Shared Workflow' }).first();
  const login = async (page, user) => {
    selectedUser = user;
    await launchpad(page).getByRole('button', { name: 'Studio account', exact: true }).click();
    const view = launchpad(page).locator('#lp-page-profile');
    const approval = await popup(page, () => view.getByRole('button', { name: 'Sign in', exact: true }).click());
    await approval.getByRole('button', { name: 'Approve fixture' }).click();
    await view.getByText(`Fixture ${user}`, { exact: true }).waitFor(); await approval.close();
    return view;
  };
  const page = await open();
  const view = await login(page, 'A');
  await view.getByRole('tab', { name: 'Notifications', exact: true }).click();
  const row = view.getByRole('button', { name: /Desktop run receipt/ }).first();
  await row.click();
  await until(() => store.inbox({ kind: 'list' }).notices.find(item => item.id === notice.id)?.read, 'Web did not persist the desktop notice acknowledgement.');
  store.inbox({ kind: 'clear', ids: [notice.id] });
  await row.waitFor({ state: 'detached', timeout: 20_000 });
  console.log('[OK] The Web inbox reads, acknowledges and observes deletion of a desktop notice.');
  await page.keyboard.press('Escape');
  await launchpad(page).getByRole('tab', { name: 'Library', exact: true }).click();
  await card(page).click();
  const details = launchpad(page).locator('.lp-project-details');
  const tab = await popup(page, () => details.getByRole('button', { name: 'Run project', exact: true }).click());
  const frame = await until(async () => {
    for (const candidate of tab.frames()) {
      if (await candidate.locator('#app[data-connection="connected"] #run-list .session').first().isVisible().catch(() => false)) return candidate;
    }
  }, 'The Web project did not display the existing desktop Workflow history.');
  await frame.getByRole('heading', { name: 'From desktop' }).waitFor();
  await frame.locator('#new').click();
  const echo = frame.locator('.workflow-entry[data-entrypoint="echo"]');
  if (!await echo.isVisible()) await frame.locator('.workflow-group').filter({ has: echo }).locator('summary').first().click();
  await echo.locator('summary').click();
  await echo.locator('input[type="text"]').fill('From Web');
  await frame.locator('#run').click();
  await frame.getByRole('heading', { name: 'From Web' }).waitFor();
  const runs = await until(async () => {
    const runs = (await message('ready'))[0].runs;
    return runs.length === 2 && runs.every(run => run.status === 'success') && runs;
  }, 'The desktop runner did not see the completed Web run.');
  assert.equal(runs[1].id, first.id);
  console.log('[OK] Both Studio CLI hosts stayed open and saw completed runs written from Web and desktop.');
  store.inbox({ kind: 'add', notice: { ...notice, id: `${Date.now()}-${randomUUID()}` } });
  const other = await open(); const otherView = await login(other, 'B');
  await otherView.getByRole('tab', { name: 'Notifications', exact: true }).click();
  assert.equal(await otherView.getByText('Desktop run receipt', { exact: true }).count(), 0);
  await launchpad(other).getByRole('tab', { name: 'Library', exact: true }).click();
  await launchpad(other).locator('.lp-library-loading').waitFor({ state: 'hidden' });
  assert.equal(await card(other).count(), 0);
  console.log('[OK] A separate account cannot see the shared project or notification.');
} finally {
  await browser?.close();
  if (desktop && desktop.exitCode === null && desktop.signalCode === null) {
    const exited = once(desktop, 'exit'); desktop.stdin.end();
    const kill = setTimeout(() => desktop.kill(), 5000);
    try { await exited; } finally { clearTimeout(kill); }
  }
  if (origin) await fetch(`${origin}/_studio/web/manage`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => undefined);
  await runner;
  await close(issuer);
  await rm(temp, { recursive: true, force: true });
}
