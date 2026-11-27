import { spawn } from 'node:child_process';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BotCredentialHostResult } from '../../../../harness/src/types/bot-credential-use';
import type { StoredHttpCredential } from './bot-credential-http';
import { containsCredentialValue } from './bot-credential-network';

export const botCredentialFileSupported = process.platform === 'darwin' || process.platform === 'linux';
const FILE_VARIABLE = 'STEAMHARNESS_BOT_CREDENTIAL_FILE';
const MAX_OUTPUT = 24 * 1024;
const inheritedVariable = /^(?:PATH|HOME|TMP(?:DIR)?|TEMP|LANG|LC_[A-Z_]+|SYSTEMROOT|USERPROFILE|WINDIR)$/i;

export type BotCredentialCommand = { program: string; args: string[]; env?: Record<string, string | true> };

export const credentialEnvName = (name: string): boolean => /^[a-z_][a-z0-9_]{0,127}$/i.test(name)
  && !inheritedVariable.test(name) && !/^(?:steamharness_|node_|ld_|dyld_|bash_env$|env$|python(?:home|path)$)/i.test(name)
  && !['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase());

/** Use only the child environment, or the original POSIX anonymous descriptor. */
export async function runBotCredentialCommand(command: BotCredentialCommand, stored: StoredHttpCredential, cwd: string, signal: AbortSignal): Promise<BotCredentialHostResult> {
  if (!command.env && !botCredentialFileSupported) return { status: 'failed', reason: 'invalid-operation' };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let directory: string | undefined, writer: FileHandle | undefined, reader: FileHandle | undefined;
  try {
    deadline.throwIfAborted();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedVariable.test(key)));
    if (command.env) {
      for (const [variable, field] of Object.entries(command.env)) {
        if (!credentialEnvName(variable)) return { status: 'failed', reason: 'invalid-operation' };
        const value = typeof stored === 'string' ? field === true ? stored : undefined
          : typeof field === 'string' && Object.hasOwn(stored, field) ? stored[field] : undefined;
        if (value === undefined) return { status: 'missing-fields' };
        env[variable] = value;
      }
    } else {
      directory = await mkdtemp(path.join(tmpdir(), 'steamharness-credential-'));
      const file = path.join(directory, 'value');
      writer = await open(file, 'wx', 0o600);
      reader = await open(file, 'r');
      // Unlink before writing so a crash cannot leave a named secret file.
      await rm(directory, { recursive: true });
      directory = undefined;
      await writer.writeFile(typeof stored === 'string' ? stored : JSON.stringify(stored));
      await writer.close(); writer = undefined;
      env[FILE_VARIABLE] = '/dev/fd/3';
    }
    deadline.throwIfAborted();
    const secrets = typeof stored === 'string' ? [stored, ...stored.split(/\r?\n/).filter(line => line.length >= 16)] : Object.values(stored);
    const stdio: ['ignore', 'pipe', 'pipe', number?] = ['ignore', 'pipe', 'pipe'];
    if (reader) stdio.push(reader.fd);
    const group = process.platform !== 'win32';
    const child = spawn(command.program, command.args, { cwd, env, shell: false, detached: group, stdio, windowsHide: true });
    return await new Promise<BotCredentialHostResult>(resolve => {
      let finished = false, bytes = 0;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const finish = (result: BotCredentialHostResult) => {
        if (finished) return;
        finished = true;
        deadline.removeEventListener('abort', abort);
        if (child.pid) try { if (group) process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch { /* exited */ }
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
      child.once('error', (error: NodeJS.ErrnoException) => finish({ status: 'failed', reason: error.code === 'ENOENT' ? 'command-not-found' : 'command-error' }));
      child.once('close', code => {
        const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
        if (containsCredentialValue([out, err], secrets, 1)) finish({ status: 'failed', reason: 'unsafe-response' });
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
