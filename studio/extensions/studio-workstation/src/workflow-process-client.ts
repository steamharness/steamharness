import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { sanitizeProjectEnvironment } from './workflow-auth-client';
import { t } from './localization';
import { isNonce, matches, processDirectory, processProtocol, proof, readFrames, send, type ProcessEndpoint, type ProcessLaunch } from './workflow-process-ipc';

async function open(directory: string, signal: AbortSignal, receive: (value: Record<string, any>) => void): Promise<Socket | undefined> {
  const file = path.join(directory, 'endpoint.json');
  let endpoint: ProcessEndpoint;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024 || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) throw new Error('Invalid Studio process endpoint.');
    endpoint = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (endpoint.version !== processProtocol || !isNonce(endpoint.secret) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error('Invalid Studio process endpoint.');
  }
  signal.throwIfAborted();
  const socket = connect(endpoint.port, '127.0.0.1');
  socket.setNoDelay(true);
  const nonce = randomBytes(32).toString('hex');
  let authenticated = false;
  return new Promise(resolve => {
    const abort = () => socket.destroy();
    const timer = setTimeout(abort, 1000);
    socket.once('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(undefined); });
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => send(socket, { type: 'hello', nonce }));
    readFrames(socket, frame => {
      if (!authenticated) {
        if (frame.type !== 'hello' || !isNonce(frame.nonce) || !matches(frame.proof, proof(endpoint.secret, 'server', nonce))) { socket.destroy(); return; }
        authenticated = true; clearTimeout(timer);
        send(socket, { type: 'authenticate', proof: proof(endpoint.secret, 'client', frame.nonce) });
        resolve(socket);
        return;
      }
      receive(frame);
    });
  });
}

/** One authenticated control connection per extension-host lease, not per iframe. */
export class ProjectProcessManager {
  constructor(private readonly data: string, private readonly service: string) {}

  private async connect(signal: AbortSignal, receive: (value: Record<string, any>) => void, start: boolean) {
    const directory = await processDirectory(this.data, start).catch(error => {
      if (!start && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    });
    if (!directory) return;
    const running = await open(directory, signal, receive);
    signal.throwIfAborted();
    if (running || !start) return running;
    // The service elects itself with an OS-released SQLite lock. Two windows
    // can request startup without ever spawning two owners for the same scope.
    const env = sanitizeProjectEnvironment(process.env);
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(process.execPath, [this.service, directory], { cwd: directory, env, detached: true, stdio: 'ignore', windowsHide: true });
    let failed: Error | undefined;
    child.once('error', error => { failed = error; });
    child.unref();
    for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
      signal.throwIfAborted();
      if (failed) break;
      const connection = await open(directory, signal, receive);
      if (connection) return connection;
      await delay(50, undefined, { signal });
    }
    throw new Error(t('Could not connect to the local project manager. Reopen the project to try again.'));
  }

  async launch(launch: ProcessLaunch, signal: AbortSignal) {
    const events = new EventEmitter<{ error: [Error]; close: [number | null, NodeJS.Signals | null]; retired: [] }>();
    const stdout = new PassThrough(), stderr = new PassThrough();
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let configure = true;
    let scheduleKey: string | undefined;
    const socket = (await this.connect(signal, frame => {
      if (frame.type === 'stdout') stdout.write(frame.line + '\n');
      else if (frame.type === 'stderr') stderr.write(frame.text);
      else if (frame.type === 'attached') scheduleKey = frame.scheduleKey;
      else if (frame.type === 'exit') exit = { code: frame.code, signal: frame.signal };
      else if (frame.type === 'retired') events.emit('retired');
      else if (frame.type === 'blocked') events.emit('error', new Error(t('This project is being upgraded. Wait for the upgrade to finish.')));
    }, true))!;
    socket.once('close', () => {
      signal.removeEventListener('abort', abort);
      stdout.end(); stderr.end();
      events.emit('close', exit?.code ?? null, exit?.signal ?? null);
    });
    const abort = () => socket.destroy();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) socket.destroy();
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        try {
          const message = JSON.parse(String(chunk));
          if (configure) { configure = false; send(socket, { type: 'attach', launch, configuration: message }); }
          else if (message.type !== 'close') send(socket, { type: 'input', message });
          callback();
        } catch (error) { callback(error as Error); }
      },
      final(callback) { socket.end(); callback(); },
    });
    return Object.assign(events, { stdin, stdout, stderr, kill: abort, getScheduleKey: () => scheduleKey });
  }

  async stop(signal: AbortSignal): Promise<void> { (await this.control({ type: 'stop' }, signal, false))?.end(); }

  async hold(directory: string, signal: AbortSignal): Promise<{ dispose(): void }> {
    const socket = await this.control({ type: 'hold', directory: await realpath(directory).catch(() => path.resolve(directory)) }, signal, true);
    return { dispose: () => socket?.end() };
  }

  private async control(frame: object, signal: AbortSignal, start: boolean) {
    let done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    const socket = await this.connect(signal, value => { if (value.type === 'ok') done(); }, start);
    if (!socket) return;
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new Error(t('The local project manager did not respond. Try again.')));
        socket.once('close', fail);
        const abort = () => socket.destroy();
        lifetime.addEventListener('abort', abort, { once: true });
        const cleanup = () => { socket.off('close', fail); lifetime.removeEventListener('abort', abort); };
        void completed.then(resolve);
        socket.once('close', cleanup);
        void completed.then(cleanup);
        if (lifetime.aborted || !send(socket, frame)) socket.destroy();
      });
      return socket;
    } catch (error) { socket.destroy(); throw error; }
  }
}
