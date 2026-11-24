import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { buildChildEnv, ROOT } from '../distribution.mjs';
import { equalSecret, isSecret, secret, writePrivate } from './sessions.mjs';
import { json, listen, readJson, startGateway } from './gateway.mjs';

const launchScript = fileURLToPath(new URL('../studio.mjs', import.meta.url));
const excludedExtensions = 'vscode.vscode-api-tests,GitHub.copilot,GitHub.copilot-chat';
const send = (endpoint, action, signal) => fetch(`http://127.0.0.1:${endpoint.port}/manage`, {
  method: 'POST', signal, headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(action),
});

export async function webBuiltins(directory, upstream, studioExtension) {
  const source = path.join(upstream, 'extensions'), target = path.join(directory, 'builtins');
  await rm(target, { recursive: true, force: true });
  await mkdir(target);
  const entries = (await readdir(source, { withFileTypes: true })).filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'studio-workstation');
  await Promise.all([...entries.map(entry => [entry.name, path.join(source, entry.name)]), ['studio-workstation', studioExtension]].map(async ([name, from]) => {
    await symlink(await realpath(from), path.join(target, name), process.platform === 'win32' ? 'junction' : 'dir');
  }));
  return target;
}

// Only non-network Code OSS options are exposed through the wrapper.
export function workspaceArgs(args) {
  const serverArgs = [], seen = new Set();
  let port;
  for (let i = 0; i < args.length; i++) {
    const [flag, ...parts] = args[i].split('=');
    if (!['--host', '--port', '--default-folder', '--default-workspace'].includes(flag) || seen.has(flag)) throw new Error(`Unsupported Studio Web argument: ${flag}.`);
    seen.add(flag);
    const value = parts.length ? parts.join('=') : args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--host' && !['127.0.0.1', 'localhost'].includes(value)) throw new Error('Configure HTTPS for remote access. --host only accepts 127.0.0.1 or localhost.');
    if (flag === '--port') port = value;
    if (flag.startsWith('--default-')) serverArgs.push(`${flag}=${path.resolve(value)}`);
  }
  return { port, serverArgs };
}

function processRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function claim(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'owner.lock'), recovery = `${file}.recovery`;
  const create = async () => {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
  };
  try { await create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const busy = new Error('Studio Web is already running or starting. Stop the existing instance first.');
    const previous = Number(await readFile(file, 'utf8').catch(() => ''));
    if (previous <= 0 || processRunning(previous)) throw busy;
    const guard = await open(recovery, 'wx', 0o600).catch(() => { throw busy; });
    try {
      if (Number(await readFile(file, 'utf8').catch(() => '')) !== previous) throw busy;
      await rm(file); await create();
    } finally { await guard.close(); await rm(recovery, { force: true }); }
  }
  return () => rm(file, { force: true });
}

function codeServer(upstream, args, environment) {
  const child = spawn(process.execPath, [path.join(upstream, 'out/server-main.js'), ...args], {
    cwd: upstream, stdio: ['ignore', 'pipe', 'inherit', 'ipc'], env: buildChildEnv({
      NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CWD: ROOT,
      VSCODE_SKIP_BUILTIN_EXTENSIONS: [process.env.VSCODE_SKIP_BUILTIN_EXTENSIONS, excludedExtensions].filter(Boolean).join(','),
      // The managed web host cannot use the desktop-only management capability.
      STEAMHARNESS_STUDIO_WEB_DESKTOP_CONTROL: undefined, ...environment,
    }),
  });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(1)); });
  return { child, exited };
}

async function terminate({ child, exited }) {
  if (child.connected) child.disconnect();
  else if (child.exitCode === null && child.signalCode === null) child.kill();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  try { await exited; } finally { clearTimeout(timeout); }
}

export async function runManagedWeb({ directory, storage, config, prepare }) {
  const release = await claim(directory);
  const descriptor = path.join(directory, 'instance.json'), registry = path.join(directory, 'previews.json');
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) process.once(event, stop);
  let upstream, gateway;
  try {
    const settings = await prepare();
    controller.signal.throwIfAborted();
    const proof = secret();
    upstream = codeServer(settings.upstream, [...settings.args, '--host=127.0.0.1', '--port=0', '--without-connection-token', '--force-disable-user-env'], {
      STEAMHARNESS_STUDIO_WEB_BACKEND_KEY: proof, STEAMHARNESS_STUDIO_WEB_REGISTRY: registry,
      STEAMHARNESS_STUDIO_PROJECT_WEB_DATA_DIR: storage,
    });
    const port = await new Promise((resolve, reject) => {
      const lines = createInterface({ input: upstream.child.stdout });
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', interrupted); };
      const fail = error => { done(); reject(error); };
      const interrupted = () => fail(new Error('Studio Web startup stopped.'));
      const timer = setTimeout(() => fail(new Error('Studio Web backend did not start.')), 60_000).unref();
      controller.signal.addEventListener('abort', interrupted, { once: true });
      upstream.exited.then(() => fail(new Error('Studio Web backend exited.')));
      lines.on('line', line => {
        const match = /^Extension host agent listening on (\d+)$/.exec(line);
        if (match) { done(); resolve(Number(match[1])); }
        else if (!/^(Web UI available at|Server bound to)/.test(line)) console.log(line);
      });
    });
    const direct = await fetch(`http://127.0.0.1:${port}/version`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    await direct.body?.cancel();
    if (direct.status !== 403) throw new Error('Studio Web backend is missing gateway protection. Rebuild the VS Code kernel.');
    const webviewDirectory = path.join(settings.upstream, 'out/vs/workbench/contrib/webview/browser/pre');
    gateway = await startGateway({ config, directory, workbench: port, webviewDirectory, proof, stop });
    controller.signal.throwIfAborted();
    await writePrivate(registry, gateway.registry);
    await writePrivate(descriptor, gateway.admin);
    const status = gateway.getStatus();
    console.log(`Studio Web: ${status.localUrls.join(' · ')}`);
    for (const url of status.remoteUrls) console.log(`Studio Web (pairing required): ${url}`);
    if (process.connected) process.send({ type: 'ready' });
    if (!controller.signal.aborted) {
      const ended = await Promise.race([upstream.exited.then(() => 'backend'), new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))]);
      if (ended === 'backend' && !controller.signal.aborted) throw new Error('Studio Web backend exited.');
    }
  } finally {
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) process.off(event, stop);
    await gateway?.close();
    if (upstream) await terminate(upstream);
    await Promise.all([rm(descriptor, { force: true }), rm(registry, { force: true })]);
    await release();
    if (process.connected) process.disconnect();
  }
}

export async function desktopWebControl({ directory, storage }) {
  const key = secret(), sockets = new Set();
  let owned, start, port, closed = false;
  const unavailable = { running: false, mode: 'desktop', devices: [], localUrls: [], remoteUrls: [] };
  const control = async action => {
    let descriptor;
    try { descriptor = JSON.parse(await readFile(path.join(directory, 'instance.json'), 'utf8')); } catch { return; }
    if (!Number.isInteger(descriptor.port) || !isSecret(descriptor.key)) return;
    return send(descriptor, action, AbortSignal.timeout(4000)).catch(() => undefined);
  };
  const startWeb = () => start ??= (async () => {
    if ((await control({ action: 'status' }))?.ok) return;
    if (closed) return;
    const child = spawn(process.execPath, [launchScript, 'web'], {
      cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: buildChildEnv({ STEAMHARNESS_STUDIO_PROJECT_WEB_DATA_DIR: storage }),
    });
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(1)); });
    const service = owned = { child, exited };
    void exited.then(() => { if (owned === service) owned = undefined; });
    const ready = new Promise(resolve => child.on('message', message => { if (message?.type === 'ready') resolve(true); }));
    if (!await Promise.race([ready, exited.then(() => false)])) throw new Error('The Studio Web process did not start.');
  })().finally(() => { start = undefined; });
  const server = http.createServer({ requestTimeout: 10_000 }, (req, res) => {
    void (async () => {
      if (req.url !== '/manage' || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined || req.method !== 'POST' ||
          req.headers['content-type'] !== 'application/json' || !equalSecret(req.headers.authorization, `Bearer ${key}`)) return json(res, 403, { error: 'origin' });
      let input = await readJson(req);
      if (input.action === 'start') { await startWeb(); input = { action: 'status' }; }
      const upstream = await control(input);
      if (upstream) return json(res, upstream.status, await upstream.json());
      return input.action === 'status' ? json(res, 200, unavailable) : json(res, 409, { error: 'unavailable' });
    })().catch(() => { if (!res.headersSent && !res.destroyed) json(res, 409, { error: 'unavailable' }); else res.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  port = await listen(server, '127.0.0.1');
  return { env: { STEAMHARNESS_STUDIO_WEB_DESKTOP_CONTROL: JSON.stringify({ port, key }) }, async close() {
    closed = true;
    const cleanup = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    if (owned) await terminate(owned);
    await cleanup;
  } };
}
