import { spawn } from 'node:child_process';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BotCredentialHostResult } from '../../../../harness/src/types/bot-credential-use';
import type { StoredHttpCredential } from './bot-credential-http';
import { containsCredentialValue } from './bot-credential-network';

export const botCredentialCommandSupported = process.platform === 'darwin' || process.platform === 'linux';
const FILE_VARIABLE = 'STEAMHARNESS_BOT_CREDENTIAL_FILE';
const MAX_OUTPUT = 24 * 1024;

export type BotCredentialCommand = { program: string; args: string[] };

/** The command inherits an unlinked file, not a value in its arguments or environment. */
export async function runBotCredentialCommand(command: BotCredentialCommand, stored: StoredHttpCredential, cwd: string, signal: AbortSignal): Promise<BotCredentialHostResult> {
  if (!botCredentialCommandSupported) return { status: 'failed', reason: 'invalid-operation' };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let directory: string | undefined, writer: FileHandle | undefined, reader: FileHandle | undefined;
  try {
    deadline.throwIfAborted();
    directory = await mkdtemp(path.join(tmpdir(), 'steamharness-credential-'));
    const file = path.join(directory, 'value');
    writer = await open(file, 'wx', 0o600);
    reader = await open(file, 'r');
    // Unlink before writing, so a host crash cannot leave a named secret file.
    await rm(directory, { recursive: true });
    directory = undefined;
    const value = typeof stored === 'string' ? stored : JSON.stringify(stored);
    await writer.writeFile(value);
    await writer.close(); writer = undefined;
    deadline.throwIfAborted();
    const secrets = [value, ...(typeof stored === 'string' ? stored.split(/\r?\n/).filter(line => line.length >= 16) : Object.values(stored))];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
      && /^(?:PATH|HOME|TMPDIR|LANG|LC_[A-Z_]+)$/u.test(key)));
    env[FILE_VARIABLE] = '/dev/fd/3';
    const child = spawn(command.program, command.args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe', reader.fd] });
    return await new Promise<BotCredentialHostResult>(resolve => {
      let finished = false, bytes = 0;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const finish = (result: BotCredentialHostResult) => {
        if (finished) return;
        finished = true;
        deadline.removeEventListener('abort', abort);
        if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
        child.stdout?.destroy(); child.stderr?.destroy();
        resolve(result);
      };
      const abort = () => finish({ status: 'failed', reason: 'timeout' });
      const read = (out: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) finish({ status: 'failed', reason: 'response-too-large' });
        else out.push(chunk);
      };
      deadline.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', read(stdout)); child.stderr?.on('data', read(stderr));
      child.once('error', () => finish({ status: 'failed', reason: 'command-error' }));
      child.once('close', code => {
        const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
        if (containsCredentialValue({ out, err }, secrets)) finish({ status: 'failed', reason: 'unsafe-response' });
        else finish(code !== 0 ? { status: 'failed', reason: 'command-error' } : { status: 'ok', data: { exitCode: code, stdout: out, stderr: err } });
      });
      if (deadline.aborted) abort();
    });
  } catch { return { status: 'failed', reason: deadline.aborted ? 'timeout' : 'command-error' }; }
  finally {
    await writer?.close().catch(() => undefined);
    await reader?.close().catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
