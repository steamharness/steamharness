import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './distribution.mjs';

// v0.26 dropped the traditional "_" directory replacement used when versioned
// updates are disabled. v0.23 retains that path; its caller must pass an
// extended-length executable path so nested file operations avoid MAX_PATH.
export const LEGACY_WINDOWS_UPDATER = Object.freeze({
  version: '0.23.0',
  sourceCommit: '9fddeff5003cbbd63241ee5d19f5c9481648e354',
  sha256: '0d3a87ca85b514db1f068401409ca5390f6da6d7ce35ce45bfad044394a50b48',
  size: 609280,
  url: 'https://raw.githubusercontent.com/microsoft/vscode/9fddeff5003cbbd63241ee5d19f5c9481648e354/build/win32/inno_updater.exe',
});

export const windowsUpdaterAsset = product => product.win32VersionedUpdate === false ? LEGACY_WINDOWS_UPDATER : undefined;

async function matches(file, asset) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size !== asset.size) return false;
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex') === asset.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function download(url, destination) {
  await promisify(execFile)(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    '--silent', '--show-error', '--fail', '--location', '--retry', '3', '--retry-all-errors',
    '--retry-delay', '2', '--connect-timeout', '15', '--max-time', '300', '--output', destination, url,
  ], { windowsHide: true });
}

export async function ensurePinnedWindowsUpdater(asset, cacheDirectory, fetchFile = download) {
  if (!/^\d+\.\d+\.\d+$/.test(asset.version) || !/^[a-f0-9]{40}$/.test(asset.sourceCommit)
      || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || new URL(asset.url).protocol !== 'https:') throw new Error('Invalid pinned Windows updater descriptor.');
  const directory = path.join(cacheDirectory, `${asset.version}-${asset.sha256.slice(0, 16)}`);
  const destination = path.join(directory, 'inno_updater.exe');
  if (await matches(destination, asset)) return destination;
  await fs.mkdir(directory, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(directory, 'download-'));
  try {
    const partial = path.join(temporary, 'inno_updater.exe');
    await fetchFile(asset.url, partial);
    if (!await matches(partial, asset)) throw new Error('Windows updater does not match its pinned size and SHA-256.');
    await fs.rename(partial, destination);
    return destination;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureWindowsInnoUpdater(product, options = {}) {
  const asset = windowsUpdaterAsset(product);
  if (!asset) return undefined;
  const cache = options.cacheDirectory ?? process.env.STUDIO_INNO_UPDATER_CACHE_DIR ?? path.join(ROOT, '.studio/cache/inno-updater');
  return { ...asset, file: await ensurePinnedWindowsUpdater(asset, cache, options.download) };
}
