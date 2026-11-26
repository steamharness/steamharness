import { createHash } from 'node:crypto';
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2';
import type { BotCredentialHostResult } from '../../../../harness/src/types/bot-credential-use';
import { resolveCredentialAddress } from './bot-credential-network';
import type { BotCredentialSshRequest } from './bot-credential-operations';

const MAX_ENTRIES = 100;

function statusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
}

async function listDirectory(sftp: SFTPWrapper, path: string, signal: AbortSignal): Promise<BotCredentialHostResult> {
  const handle = await new Promise<Buffer>((resolve, reject) => sftp.opendir(path, (error, handle) => error ? reject(error) : resolve(handle)));
  const entries: { name: string; type: string }[] = [];
  try {
    // A handle requests one server batch at a time, unlike readdir(path).
    for (let packet = 0; packet < 16 && entries.length < MAX_ENTRIES; packet++) {
      signal.throwIfAborted();
      const batch = await new Promise<FileEntryWithStats[]>((resolve, reject) => sftp.readdir(handle, (error, items) => {
        if (!error) resolve(items);
        else if (statusCode(error) === 1) resolve([]); // SFTP EOF
        else reject(error);
      }));
      if (!batch.length) return { status: 'ok', data: { authenticated: true, entries, truncated: false } };
      for (const { filename, attrs } of batch) {
        if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(filename) || filename === '.' || filename === '..') continue;
        entries.push({ name: filename, type: attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : attrs.isSymbolicLink() ? 'link' : 'other' });
        if (entries.length === MAX_ENTRIES) break;
      }
    }
    return { status: 'ok', data: { authenticated: true, entries, truncated: true } };
  } finally { sftp.close(handle, () => undefined); }
}

/** Authenticate in-process. No private key file, SSH agent, shell, or port forwarding. */
export async function runBotCredentialSshQuery(use: BotCredentialSshRequest, privateKey: string, passphrase: string | undefined, signal: AbortSignal,
  resolveAddress = resolveCredentialAddress): Promise<BotCredentialHostResult> {
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const { default: ssh } = await import('ssh2');
    const { address } = await resolveAddress(use.host, deadline);
    deadline.throwIfAborted();
    return await new Promise<BotCredentialHostResult>(resolve => {
      const client = new ssh.Client();
      let finished = false;
      let verified = false;
      const finish = (value: BotCredentialHostResult) => {
        if (finished) return;
        finished = true;
        deadline.removeEventListener('abort', abort);
        client.destroy();
        resolve(value);
      };
      const abort = () => finish({ status: 'failed' });
      deadline.addEventListener('abort', abort, { once: true });
      client.on('error', error => finish({ status: verified && error.level === 'client-authentication' ? 'denied' : 'failed' }));
      client.once('close', abort);
      client.once('ready', () => {
        if (!verified || deadline.aborted) { abort(); return; }
        if (use.operation === 'authenticate') { finish({ status: 'ok', data: { authenticated: true } }); return; }
        client.sftp((error, sftp) => {
          if (error) { abort(); return; }
          void listDirectory(sftp, use.path, deadline).then(finish, error => finish({ status: statusCode(error) === 3 ? 'denied' : 'failed' }));
        });
      });
      try {
        client.connect({ host: address, port: use.port, username: use.username, privateKey, passphrase, authHandler: ['publickey'],
          hostVerifier: (key: Buffer) => (verified = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === use.fingerprint) });
      } catch { abort(); }
    });
  } catch { return { status: 'failed' }; }
}
