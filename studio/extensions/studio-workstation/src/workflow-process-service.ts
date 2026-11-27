import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { isNonce, matches, maxFrame, overlaps, processProtocol, proof, readFrames, send, type ProcessLaunch } from './workflow-process-ipc';
import { startStudioControlBridge, type StudioControlBridge } from './studio-control-bridge';

const idleMs = 2 * 60_000, startupMs = 44_000;
type Frame = Record<string, any>;
const line = (value: Frame) => JSON.stringify(value) + '\n';
const nonce = () => randomBytes(32).toString('hex');
const controlUrl = 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', controlToken = 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN';

class WindowControl {
  private readonly lifetime = new AbortController();
  private readonly targets = new Map<Socket, { url: URL; token: string }>();
  async start(unavailable = 'Studio Control is unavailable.'): Promise<StudioControlBridge> {
    return startStudioControlBridge(async (operation, input, permissionPolicy) => {
      const target = this.targets.values().next().value;
      if (!target) throw Object.assign(new Error(unavailable), { code: 'STUDIO_CONTROL_UNAVAILABLE' });
      const response = await fetch(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(29_000)]),
        headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, input, permissionPolicy }) });
      const result = await response.json() as { ok: boolean; value?: unknown; error?: { code: string; message: string } };
      if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message ?? 'Studio Control is unavailable.'), { code: result.error?.code });
      return result.value;
    }, this.lifetime.signal);
  }
  attach(socket: Socket, env: NodeJS.ProcessEnv) {
    const token = env[controlToken];
    if (!isNonce(token) || !env[controlUrl]) return;
    const url = new URL(env[controlUrl]!);
    if (url.origin !== `http://127.0.0.1:${url.port}` || url.pathname !== '/studio-control' || url.search || url.hash || url.username || url.password) return;
    this.targets.set(socket, { url, token });
    socket.once('close', () => this.targets.delete(socket));
  }
  close() { this.lifetime.abort(); this.targets.clear(); }
}

/** Only the CLI's own current leases can prove it is idle. History-only or
 * unknown/older runtimes must not be interrupted by a time-to-live. */
async function idle(host: ProjectProcess): Promise<boolean> {
  if (!host.ready || !host.child.pid || !host.launch.projectId || host.requests.size) return false;
  const since = Date.now() - 20_000;
  const activity = await Promise.all(host.launch.activityRoots.map(async root => {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(entries.filter(item => item.isFile() && item.name.endsWith('.json')).map(async item => {
      try {
        const filename = path.join(root, item.name);
        if (lstatSync(filename).size > maxFrame) return;
        const value = JSON.parse(await readFile(filename, 'utf8'));
        if (value.version !== 1 || value.pid !== host.child.pid || value.projectId !== host.launch.projectId
          || !(value.updatedAt >= since) || !Array.isArray(value.runs)) return;
        return value as { entryId: string; queued?: number; runs: Array<{ status: string }> };
      } catch { /* Atomic replacement or a retired entry. */ }
    }))).filter(item => item !== undefined);
  }));
  const entries = activity.flat();
  return host.ready.project.entries.every((entry: Frame) => entries.some(value => value.entryId === entry.entryId))
    && entries.every(entry => !entry.queued && entry.runs.every(run => run && !['running', 'waiting_for_input'].includes(run.status)));
}

class ProjectProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  readonly clients = new Set<Socket>();
  readonly requests = new Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>();
  readonly credentials = new Map<string, Socket>();
  ready?: Frame;
  detachedAt = Date.now();
  stopping = false;
  sources: string[];
  private stderr = '';
  private webAppOwner?: Socket;
  private authOwner?: Socket;
  private auth?: Frame;
  private pendingAuth?: { socket: Socket; message: Frame };
  private readonly scheduleKey?: string;

  constructor(readonly launch: ProcessLaunch, configuration: Frame, private readonly exited: () => void, private readonly control?: WindowControl) {
    this.sources = launch.sources;
    this.scheduleKey = configuration.workflowScheduleKey;
    const child = this.child = spawn(launch.command, launch.args, { cwd: launch.directory, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => this.stop(false), startupMs);
    let force: ReturnType<typeof setTimeout> | undefined;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const bridgeSecret = launch.env[controlToken];
    child.stderr.setEncoding('utf8').on('data', (text: string) => { if (!this.ready) this.stderr = (this.stderr + text).slice(-8000 - (bridgeSecret?.length ?? 0)); });
    child.on('error', error => { if (!this.ready) this.stderr = error.message; });
    child.stdin.on('error', () => undefined);
    this.closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(force); lines.close(); this.control?.close();
      this.exited();
      for (const key of this.requests.keys()) this.removeRequest(key);
      for (const client of this.clients) {
        if (!this.ready && this.stderr) send(client, { type: 'stderr', text: bridgeSecret ? this.stderr.replaceAll(bridgeSecret, '[redacted]') : this.stderr });
        send(client, { type: 'exit', code, signal }); client.end();
      }
      resolve();
    }));
    lines.on('line', text => {
      if (text.length > maxFrame || !text.startsWith('{')) return;
      try {
        const message = JSON.parse(text);
        if (message.type === 'ready' && !this.ready) {
          const url = new URL(message.url);
          if (!Array.isArray(message.project?.entries) || !message.project.entries.length || (launch.projectId && launch.projectId !== message.project.id)
            || url.origin !== `http://127.0.0.1:${url.port}` || url.username || url.password || url.pathname !== `/entries/${launch.entryId}/` || !/^#session=[a-f0-9]{64}$/.test(url.hash)) {
            this.stop(false); return;
          }
          clearTimeout(timer); this.ready = message;
          for (const socket of this.clients) this.publishReady(socket);
        } else if (message.type === 'web-app-configuration' && this.ready) {
          this.ready.webAppConfigurations = { ...this.ready.webAppConfigurations, [message.entryId]: message.configuration };
          for (const socket of this.clients) send(socket, { type: 'stdout', line: text });
        } else if (message.type === 'web-app-login' && this.webAppOwner) {
          send(this.webAppOwner, { type: 'stdout', line: text });
        } else if (message.type === 'bot-credential-request' && typeof message.id === 'string') {
          const socket = this.clients.values().next().value;
          if (socket && send(socket, { type: 'stdout', line: text })) this.credentials.set(message.id, socket);
          else this.write({ type: 'bot-credential-result', id: message.id, status: 'unavailable' });
        } else if (message.type === 'bot-credential-cancel') {
          const socket = this.credentials.get(message.id);
          this.credentials.delete(message.id);
          if (socket) send(socket, { type: 'stdout', line: text });
        } else if (message.type === 'trace-model-request' || message.type === 'host-turn') {
          const socket = this.removeRequest(message.requestId);
          if (socket) send(socket, { type: 'stdout', line: text });
        }
      } catch { /* Project logs are not part of the process protocol. */ }
    });
    this.write(configuration);
    // Keep the forced-stop timer owned by the real CLI, never by a UI lease.
    this.terminate = () => { child.stdin.end(line({ type: 'close' })); force = setTimeout(() => child.kill('SIGKILL'), 5_000); };
  }

  private terminate: () => void;
  private write(message: Frame) {
    if (!this.stopping && this.child.stdin.writable && this.child.stdin.writableLength < maxFrame) this.child.stdin.write(line(message));
  }
  private removeRequest(id: string) {
    const request = this.requests.get(id);
    if (request) { this.requests.delete(id); clearTimeout(request.timer); return request.socket; }
  }
  private publishReady(socket: Socket) {
    send(socket, { type: 'attached', scheduleKey: this.scheduleKey });
    send(socket, { type: 'stdout', line: JSON.stringify(this.ready) });
  }
  attach(socket: Socket, env: NodeJS.ProcessEnv) {
    this.clients.add(socket);
    this.control?.attach(socket, env);
    socket.once('close', () => {
      this.clients.delete(socket);
      if (!this.clients.size) this.detachedAt = Date.now();
      if (this.webAppOwner === socket) { this.webAppOwner = undefined; this.write({ type: 'web-apps', webApps: {} }); }
      if (this.authOwner === socket) this.authOwner = undefined;
      if (this.pendingAuth?.socket === socket) this.pendingAuth = undefined;
      for (const [id, owner] of this.credentials) if (owner === socket) {
        this.credentials.delete(id); this.write({ type: 'bot-credential-result', id, status: 'unavailable' });
      }
    });
    if (this.ready) this.publishReady(socket);
  }

  input(socket: Socket, message: Frame) {
    if (!this.clients.has(socket) || !this.ready || this.stopping) return;
    switch (message.type) {
      case 'auth': {
        const same = JSON.stringify(message) === JSON.stringify(this.auth);
        if (!this.authOwner) this.authOwner = socket;
        if (this.authOwner !== socket) return;
        if (same) { this.pendingAuth = undefined; return; }
        if (!this.auth?.connection || !message.connection || JSON.stringify(this.auth.connection) === JSON.stringify(message.connection)) {
          this.auth = message; this.pendingAuth = undefined; this.write(message);
        } else {
          // A different token for the same account would stop live work in old
          // CLIs. Apply it once this CLI reports idle, not on reattachment.
          this.pendingAuth = { socket, message };
        }
        break;
      }
      case 'web-apps': this.webAppOwner = socket; this.write(message); break;
      case 'user-settings': this.write(message); break;
      case 'resource-projects': {
        if (Array.isArray(message.resourceProjects)) this.sources = [...this.launch.sources, ...message.resourceProjects.filter(item => typeof item === 'string' && path.isAbsolute(item))];
        this.write(message); break;
      }
      case 'host-turn':
      case 'trace-model-request': {
        const id = message.requestId;
        if (typeof id !== 'string' || this.requests.has(id) || this.requests.size >= 256) return;
        this.requests.set(id, { socket, timer: setTimeout(() => this.removeRequest(id), 35_000) });
        this.write(message); break;
      }
      case 'bot-credential-result':
        if (this.credentials.get(message.id) === socket) { this.credentials.delete(message.id); this.write(message); }
        break;
    }
  }
  async sweep() {
    const detached = !this.clients.size && Date.now() - this.detachedAt >= idleMs;
    const pending = this.pendingAuth;
    if ((!detached && !pending) || this.stopping || !await idle(this) || this.stopping) return;
    if (!this.clients.size && Date.now() - this.detachedAt >= idleMs) { await this.stop(false); return; }
    if (pending && this.pendingAuth === pending && this.authOwner === pending.socket) {
      this.auth = pending.message; this.pendingAuth = undefined; this.write(pending.message);
    }
  }

  stop(retire = true): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      if (retire) for (const socket of this.clients) send(socket, { type: 'retired' });
      this.terminate();
    }
    return this.closed;
  }
}

async function serve(directory: string) {
  const lockFile = path.join(directory, 'owner.sqlite');
  const existing = lstatSync(lockFile, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error('Invalid Studio process lock.');
  const lock = new DatabaseSync(lockFile, { timeout: 0 });
  try { lock.exec('BEGIN IMMEDIATE'); }
  catch (error) { lock.close(); if ((error as { errcode?: number }).errcode === 5) return; throw error; }
  const key = nonce(), file = path.join(directory, 'endpoint.json'), temporary = path.join(directory, `${key}.partial`);
  const hosts = new Map<string, ProjectProcess>();
  const starting = new Map<string, { launch: ProcessLaunch; host: Promise<ProjectProcess> }>();
  const holds = new Map<Socket, string>();
  const sockets = new Set<Socket>();
  let shuttingDown = false, stopping = 0;
  let emptySince = Date.now();
  const blocked = (launch: ProcessLaunch) => stopping > 0 || [...holds.values()].some(directory => launch.sources.some(source => overlaps(source, directory)));
  const stopMatching = async (matches: (sources: string[]) => boolean) => {
    await Promise.allSettled([...starting.values()].filter(item => matches(item.launch.sources)).map(item => item.host));
    await Promise.all([...hosts.values()].filter(item => matches(item.sources)).map(item => item.stop()));
  };
  const start = (launch: ProcessLaunch, configuration: Frame) => {
    const pending = starting.get(launch.key);
    if (pending) return pending.host;
    const host = (async () => {
      const control = launch.env[controlUrl] ? new WindowControl() : undefined;
      try {
        let env = launch.env;
        if (control) {
          const bridge = await control.start(launch.controlUnavailable);
          env = { ...env, [controlUrl]: bridge.url, [controlToken]: bridge.token };
        }
        const runtime = new ProjectProcess({ ...launch, env }, configuration, () => { hosts.delete(launch.key); emptySince = Date.now(); }, control);
        hosts.set(launch.key, runtime);
        return runtime;
      } catch (error) { control?.close(); throw error; }
    })().finally(() => starting.delete(launch.key));
    starting.set(launch.key, { launch, host });
    return host;
  };
  const server = createServer(socket => {
    if (shuttingDown || sockets.size >= 512) { socket.destroy(); return; }
    socket.setNoDelay(true); sockets.add(socket);
    const challenge = nonce(), timeout = setTimeout(() => socket.destroy(), 3000);
    let state: 'hello' | 'authenticate' | 'operation' | 'attached' | 'control' = 'hello';
    let host: ProjectProcess | undefined;
    socket.once('close', () => { clearTimeout(timeout); sockets.delete(socket); holds.delete(socket); emptySince = Date.now(); });
    readFrames(socket, value => {
      if (state === 'hello' && value.type === 'hello' && isNonce(value.nonce)) {
        state = 'authenticate';
        send(socket, { type: 'hello', nonce: challenge, proof: proof(key, 'server', value.nonce) });
      } else if (state === 'authenticate' && value.type === 'authenticate' && matches(value.proof, proof(key, 'client', challenge))) {
        state = 'operation';
      } else if (state === 'attached' && value.type === 'input' && value.message && typeof value.message === 'object') {
        host?.input(socket, value.message);
      } else if (state === 'operation') {
        clearTimeout(timeout); state = 'control';
        void (async () => {
          if (value.type === 'stop') {
            stopping++;
            try { await stopMatching(() => true); }
            finally { stopping--; }
            send(socket, { type: 'ok' });
          } else if (value.type === 'hold' && typeof value.directory === 'string' && path.isAbsolute(value.directory)) {
            holds.set(socket, value.directory);
            await stopMatching(sources => sources.some(source => overlaps(source, value.directory)));
            send(socket, { type: 'ok' });
          } else if (value.type === 'attach') {
            const launch = value.launch as ProcessLaunch, configuration = value.configuration;
            if (!launch || !isNonce(launch.key) || !path.isAbsolute(launch.command) || !path.isAbsolute(launch.directory)
              || !Array.isArray(launch.sources) || !Array.isArray(launch.activityRoots) || !Array.isArray(launch.args)
              || configuration?.type !== 'configure') throw new Error('Invalid Studio process launch.');
            host = hosts.get(launch.key);
            if (host?.stopping) { await host.closed; host = hosts.get(launch.key); }
            if (socket.destroyed || shuttingDown) return;
            if (blocked(launch)) {
              send(socket, { type: 'blocked' }); socket.end(); return;
            }
            host ??= await start(launch, configuration);
            if (socket.destroyed || shuttingDown) return;
            if (host.stopping || blocked(launch)) {
              send(socket, { type: 'blocked' }); socket.end(); return;
            }
            state = 'attached'; host.attach(socket, launch.env);
          } else socket.destroy();
        })().catch(() => socket.destroy());
      } else socket.destroy();
    });
  });
  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweep);
    await stopMatching(() => true);
    for (const socket of sockets) socket.destroy();
    server.close();
    await rm(file, { force: true });
    lock.close();
  };
  const sweep = setInterval(() => {
    if (!hosts.size && !sockets.size && Date.now() - emptySince >= 5000) void close();
    else for (const host of hosts.values()) void host.sweep().catch(() => undefined);
  }, 5000);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await writeFile(temporary, JSON.stringify({ version: processProtocol, port: (server.address() as AddressInfo).port, secret: key }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    process.once('SIGTERM', () => void close());
    process.once('SIGINT', () => void close());
  } catch (error) { await close(); throw error; }
  finally { await rm(temporary, { force: true }); }
}

void serve(process.argv[2]).catch(() => { process.exitCode = 1; });
