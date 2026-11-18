import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const exec = promisify(execFile);
const id = '8bd4fef2-e083-4201-a89f-6f7d0676df53';
const manifest = { id, name: 'Online workspace fixture', version: '1.0.0', defaultEntry: 'main',
  entries: [{ entryId: 'main', type: 'workflow', name: 'Main', root: '.', entry: 'index.ts' }] };
const source = 'export const executor = steamharness.defineExecutor({});\n';

async function recorder(t, caller, { transfer = false } = {}) {
  let origin, user = 'first', outcome = 'success', onPoll;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, origin);
    const auth = request.headers.authorization;
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, path: url.pathname, auth, body });
    const reply = (status, data, errMessage = '') => response.writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify({ errCode: status >= 400 ? status : 0, errMessage, data }));
    if (url.pathname === '/api/auth/device/start') return reply(200, { deviceCode: 'fixture-device', userCode: 'TEST-CODE',
      verificationUri: `${origin}/login/device`, verificationUriComplete: `${origin}/login/device?user_code=TEST-CODE`,
      intervalSeconds: 1, expiresAt: new Date(Date.now() + (outcome === 'expired' ? 500 : 30_000)).toISOString() });
    if (url.pathname === '/api/auth/device/token') {
      if (outcome === 'denied') return reply(403, undefined, 'access_denied');
      if (outcome !== 'success') { onPoll?.(); return reply(409, undefined, 'authorization_pending'); }
      return reply(200, { accessToken: `${caller}-${user}`, apiKey: { id: `key-${user}` },
        user: { userId: user, displayName: user, email: null } });
    }
    if (['/api/auth/logout', '/api/auth/device/cancel'].includes(url.pathname)) return reply(200, {});
    if (!transfer || auth !== `Bearer ${caller}-${user}`) return reply(403, undefined, 'Forbidden');
    if (request.method === 'POST' && url.pathname === `/api/projects/${id}/package`) return reply(200, { jobId: 'fixture-job' });
    if (url.pathname === `/api/projects/${id}/files`) return reply(200, { files: [
      { path: 'steamharness.json', content: JSON.stringify(manifest) },
      { path: 'package.json', content: JSON.stringify({ name: 'workspace-fixture', version: '1.0.0', type: 'module' }) },
      { path: 'index.ts', content: source },
    ] });
    return reply(404, undefined, 'Not found');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, set user(value) { user = value; }, set outcome(value) { outcome = value; }, set onPoll(value) { onPoll = value; } };
}

test('the built CLI opts into separate device logins and project transfers without crossing Servers', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-online-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await recorder(t, 'project', { transfer: true });
  const ai = await recorder(t, 'ai');
  const env = { ...process.env, HOME: root, USERPROFILE: root, STEAMHARNESS_CLI_AUTH_DIR: path.join(root, 'auth'), STEAMHARNESS_SERVICE_CHANNEL: 'dev',
    STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '', STEAMHARNESS_AI_SERVER_URL: '', STEAMHARNESS_AI_API_KEY: '' };
  const workspace = (...args) => exec(process.execPath, [cli, '--locale', 'en', 'workspace', ...args], { env, cwd: root, timeout: 8_000 });
  const json = async (...args) => JSON.parse((await workspace(...args)).stdout).data;
  const login = (origin, ...args) => workspace('login', '--server', origin, '--no-open', ...args);
  await writeFile(path.join(root, 'steamharness.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'workspace-fixture', version: '1.0.0', type: 'module' }));
  await writeFile(path.join(root, 'index.ts'), source);
  const archivePath = path.join(root, 'local.tgz');
  await login(project.origin);
  await login(ai.origin, '--ai');
  assert.equal((await json('status', '--ai')).effective.serverUrl, ai.origin);
  assert.equal((await json('status', '--ai', '--server', ai.origin)).effective.tokenSource, 'file');
  assert.equal((await json('status', '--ai', '--server', project.origin)).effective.tokenSource, 'none');
  assert.equal((await json('status', '--server', ai.origin)).effective.tokenSource, 'none');
  env.STEAMHARNESS_SERVER_URL = ai.origin;
  env.STEAMHARNESS_SERVER_ADMIN_KEY = 'unrelated-address-key';
  assert.equal((await json('status', '--server', ai.origin)).effective.tokenSource, 'env');
  assert.equal((await json('status', '--server', project.origin)).effective.tokenSource, 'file');

  const requestsBeforePack = project.requests.length + ai.requests.length;
  await workspace('pack', 'sample', '--path', root, '--output', archivePath);
  assert.equal(project.requests.length + ai.requests.length, requestsBeforePack);
  await workspace('upload', 'sample', '--path', root, '--server', project.origin, '--file', archivePath, '--no-wait');
  const write = project.requests.find(r => r.path.endsWith('/package'));
  assert.equal(write.auth, 'Bearer project-first');
  assert.deepEqual(write.body, await readFile(archivePath));
  const downloaded = path.join(root, 'download');
  await workspace('download', id, '--server', project.origin, '--target', 'draft', '--path', downloaded);
  assert.equal(await readFile(path.join(downloaded, 'index.ts'), 'utf8'), source);
  assert.ok(ai.requests.every(r => r.path.startsWith('/api/auth/')));

  ai.user = 'second';
  const switched = await login(ai.origin, '--ai');
  assert.ok(!switched.stdout.includes('ai-second'));
  assert.equal((await json('status', '--ai')).user.userId, 'second');
  assert.equal(ai.requests.find(r => r.path === '/api/auth/logout').auth, 'Bearer ai-first');
  for (const [outcome, error] of [['denied', /access_denied/], ['expired', /expired_token/]]) {
    ai.outcome = outcome;
    await assert.rejects(login(ai.origin, '--ai'), error);
    assert.equal((await json('status', '--ai')).user.userId, 'second');
  }
  ai.outcome = 'pending';
  const pending = spawn(process.execPath, [cli, 'workspace', 'login', '--ai', '--server', ai.origin, '--no-open'], { cwd: root, env, stdio: 'ignore' });
  t.after(() => { if (pending.exitCode === null && pending.signalCode === null) pending.kill('SIGKILL'); });
  const exit = once(pending, 'exit');
  ai.onPoll = () => pending.kill('SIGINT');
  const [code] = await exit;
  assert.notEqual(code, 0);
  assert.equal(ai.requests.filter(r => r.path === '/api/auth/device/cancel').length, 3);
  assert.equal((await json('status', '--ai')).user.userId, 'second');
  assert.equal(project.requests.filter(r => r.path.endsWith('/package')).length, 1, 'A login must not replay an upload');
  await workspace('logout', '--ai', '--server', ai.origin);
  assert.equal((await json('status', '--ai')).loggedIn, false);
  assert.equal((await json('status', '--server', project.origin)).loggedIn, true);
});

test('standalone resolve-params does not use inherited System AI credentials', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'resolve-params-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ai = await recorder(t, 'ai');
  await writeFile(path.join(root, 'steamharness.json'), JSON.stringify(manifest));
  const { version } = JSON.parse(await readFile(new URL('../../../harness/package.json', import.meta.url), 'utf8'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'param-fixture', version: '1.0.0', type: 'module',
    devDependencies: { steamharness: version } }));
  await writeFile(path.join(root, 'index.ts'), `
    const workflow = steamharness.defineProject({ name: 'param-fixture', run: async () => ({ errCode: 0, errMessage: '' }) });
    export const executor = steamharness.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'main', entrypoints: [
      steamharness.defineEntrypoint({ id: 'main', title: 'Main', workflow, createInput: () => ({}),
        async resolveParams() { await steamharness.getServerLLMCredentials(); return { params: {} }; } }),
    ] });
    export default workflow;
  `);
  const request = exec(process.execPath, [cli, '--locale', 'en', 'resolve-params', root], { cwd: root, timeout: 8_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, STEAMHARNESS_CLI_AUTH_DIR: path.join(root, 'auth'),
      STEAMHARNESS_AI_SERVER_URL: ai.origin, STEAMHARNESS_AI_API_KEY: 'fixture-ai' } });
  request.child.stdin.end(JSON.stringify({ draftText: '', args: [], inputMode: 'form', trigger: { kind: 'init' } }));
  await assert.rejects(request, error => {
    assert.equal(error.code, 1);
    assert.deepEqual(ai.requests, []);
    assert.match(error.stderr, /System AI requires a Server connection/);
    return true;
  });
});
