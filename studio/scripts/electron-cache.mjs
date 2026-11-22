import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { exists } from './distribution.mjs';

const exec = promisify(execFile);
const signatureFile = bundle => path.join(path.dirname(bundle), 'studio-notifications-ready');

async function signatureStamp(upstream) {
  const hash = createHash('sha256').update('studio-dev-signing-v1\0');
  for (const source of ['build/lib/studioNotificationPermission.ts', 'src/vs/platform/native/electron-main/studioNotificationPermission.mm']) {
    hash.update(await readFile(path.join(upstream.directory, source)));
  }
  return hash.digest('hex');
}

export async function devElectronIsSigned(upstream, bundle) {
  const stamp = await readFile(signatureFile(bundle), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  return !!stamp && await exists(path.join(bundle, 'Contents/Resources/studio-notification-permission.node')) && stamp === await signatureStamp(upstream);
}

export async function noteDevElectronSigned(upstream, bundle) {
  await writeFile(signatureFile(bundle), await signatureStamp(upstream));
}

export async function assertMacElectronNotRunning(bundle, name) {
  const executable = path.join(bundle, 'Contents/MacOS', name);
  if (!await exists(executable)) return;
  const pids = await exec('/usr/sbin/lsof', ['-t', '--', executable]).catch(error => {
    if (error.code !== 1 || error.stderr) throw error;
    return { stdout: '' };
  });
  if (pids.stdout.trim()) throw new Error(`Quit ${name} before refreshing its development Electron bundle.`);
}
