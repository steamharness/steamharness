import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { ROOT, exists, readJSON, run } from './distribution.mjs';

export async function electronVersion(upstream) {
  const { getElectronVersion } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/electronVersion.ts')));
  return getElectronVersion().electronVersion;
}

export async function electronEnvironment(upstream, environment = process.env) {
  const config = await readJSON(path.join(ROOT, 'config/downloads.json'));
  const mirror = environment.ELECTRON_MIRROR ?? config.electronMirror;
  return mirror ? {
    ELECTRON_MIRROR: mirror,
    ELECTRON_CUSTOM_DIR: environment.ELECTRON_CUSTOM_DIR ?? await electronVersion(upstream),
  } : {};
}

export function electronAssetUrls(version, filename, env) {
  const official = `https://github.com/electron/electron/releases/download/v${version}/${filename}`;
  if (!env.ELECTRON_MIRROR) return [official];
  const mirror = `${env.ELECTRON_MIRROR.replace(/\/+$/, '')}/`;
  const directory = (env.ELECTRON_CUSTOM_DIR ?? version).replaceAll('{{ version }}', version).replace(/\/+$/, '');
  return [...new Set([new URL(`${directory}/${filename}`, mirror).href, official])];
}

async function checksumFor(upstream, filename) {
  const manifest = await fs.readFile(path.join(upstream.directory, 'build/checksums/electron.txt'), 'utf8');
  for (const line of manifest.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})[ \t]+\*?(.+)$/.exec(line);
    if (match?.[2] === filename) return match[1];
  }
  throw new Error(`Upstream Electron checksum is missing for ${filename}.`);
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadWithCurl(url, destination) {
  await run('curl', ['--silent', '--show-error', '--fail', '--location',
    '--retry', '3', '--retry-all-errors', '--retry-delay', '2', '--retry-max-time', '600',
    '--connect-timeout', '15', '--max-time', '300', '--output', destination, url], ROOT);
}

async function ensureElectronFile(upstream, env, filename, destination, download) {
  const checksum = await checksumFor(upstream, filename);
  if (await exists(destination) && await digest(destination) === checksum) return destination;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(destination), 'electron-download-'));
  const partial = path.join(temporary, filename);
  try {
    let lastError;
    for (const url of electronAssetUrls(await electronVersion(upstream), filename, env)) {
      try {
        console.log(`Downloading ${filename} from ${new URL(url).origin}.`);
        await download(url, partial);
        if (await digest(partial) !== checksum) {
          throw new Error(`Downloaded ${filename} does not match the upstream SHA-256.`);
        }
        await fs.rename(partial, destination);
        console.log(`Electron ${filename} downloaded and verified against the upstream SHA-256.`);
        return destination;
      } catch (error) {
        lastError = error;
        console.warn(`Electron ${filename} download failed; trying the next source if available.`);
      }
    }
    throw lastError;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureElectronTypes(upstream, env, fetcher) {
  const download = fetcher ? async (url, destination) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Electron types download returned HTTP ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  } : downloadWithCurl;
  const asset = await ensureElectronAsset(upstream, env, 'electron.d.ts', download);
  const destination = path.join(upstream.directory, '.build/typings/electron.d.ts');
  if (!await exists(destination) || await digest(destination) !== await checksumFor(upstream, 'electron.d.ts')) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(path.dirname(destination), 'electron-types-'));
    try {
      const restored = path.join(temporary, 'electron.d.ts');
      await fs.copyFile(asset, restored);
      await fs.rename(restored, destination);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function ensureElectronAsset(upstream, env, filename, download = downloadWithCurl) {
  if (path.basename(filename) !== filename) throw new Error('Electron asset must be a filename.');
  const version = await electronVersion(upstream);
  const cache = env.STUDIO_ELECTRON_CACHE_DIR ?? process.env.STUDIO_ELECTRON_CACHE_DIR ?? path.join(ROOT, '.studio/cache/electron');
  return ensureElectronFile(upstream, env, filename, path.join(cache, version, filename), download);
}
