import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { electronAssetUrls, electronEnvironment, ensureElectronAsset, ensureElectronTypes } from '../scripts/downloads.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-download-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = 'verified Electron types\n';
  const checksum = createHash('sha256').update(content).digest('hex');
  await fs.mkdir(path.join(directory, 'build/checksums'), { recursive: true });
  await fs.mkdir(path.join(directory, 'build/lib'), { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  const filename = 'electron-v43.7.7-linux-x64.zip';
  await fs.writeFile(path.join(directory, 'build/checksums/electron.txt'),
    `${checksum} *electron.d.ts\n${checksum} *${filename}\n`);
  await fs.writeFile(path.join(directory, 'build/lib/electronVersion.ts'),
    'export function getElectronVersion() { return { electronVersion: "43.7.7" }; }\n');
  return {
    upstream: { directory }, content, filename,
    env: { ...mirror, STUDIO_ELECTRON_CACHE_DIR: path.join(directory, 'cache') },
    destination: path.join(directory, '.build/typings/electron.d.ts'),
  };
}

const mirror = { ELECTRON_MIRROR: 'https://mirror.example.invalid/', ELECTRON_CUSTOM_DIR: '43.7.7' };

test('Electron types are saved only after matching the upstream checksum', async (t) => {
  const { upstream, content, destination, env } = await fixture(t);
  const requested = [];
  await ensureElectronTypes(upstream, env, async (url) => {
    requested.push(url);
    return new Response(content);
  });
  assert.deepEqual(requested, ['https://mirror.example.invalid/43.7.7/electron.d.ts']);
  assert.equal(await fs.readFile(destination, 'utf8'), content);
  await ensureElectronTypes(upstream, env, () => { throw new Error('Verified cache should be reused.'); });
  await fs.rm(path.join(upstream.directory, '.build'), { recursive: true });
  await ensureElectronTypes(upstream, env, () => { throw new Error('Persistent cache should survive checkout cleanup.'); });
  assert.equal(await fs.readFile(destination, 'utf8'), content);
});

test('a corrupt cached type file is repaired from verified content', async (t) => {
  const { upstream, content, destination, env } = await fixture(t);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, 'corrupt cache');
  await ensureElectronTypes(upstream, env, async () => new Response(content));
  assert.equal(await fs.readFile(destination, 'utf8'), content);
});

test('bad checksums fall back to the official source and never write invalid bytes', async (t) => {
  const { upstream, destination, env } = await fixture(t);
  const requested = [];
  await assert.rejects(ensureElectronTypes(upstream, env, async (url) => {
    requested.push(url);
    return new Response('wrong content');
  }), /SHA-256/);
  assert.deepEqual(requested, [
    'https://mirror.example.invalid/43.7.7/electron.d.ts',
    'https://github.com/electron/electron/releases/download/v43.7.7/electron.d.ts',
  ]);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('project mirror is the default and environment overrides can disable it', async (t) => {
  const { upstream } = await fixture(t);
  assert.deepEqual(await electronEnvironment(upstream, {}), {
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/', ELECTRON_CUSTOM_DIR: '43.7.7',
  });
  assert.deepEqual(await electronEnvironment(upstream, { ELECTRON_MIRROR: '' }), {});
  assert.deepEqual(await electronEnvironment(upstream, {
    ELECTRON_MIRROR: 'https://internal.example.invalid/electron/', ELECTRON_CUSTOM_DIR: 'v{{ version }}',
  }), { ELECTRON_MIRROR: 'https://internal.example.invalid/electron/', ELECTRON_CUSTOM_DIR: 'v{{ version }}' });
});

test('asset URLs preserve mirror paths and custom version directories', () => {
  assert.deepEqual(electronAssetUrls('43.7.7', 'electron.d.ts', {
    ELECTRON_MIRROR: 'https://mirror.example.invalid/electron', ELECTRON_CUSTOM_DIR: 'v{{ version }}/',
  }), [
    'https://mirror.example.invalid/electron/v43.7.7/electron.d.ts',
    'https://github.com/electron/electron/releases/download/v43.7.7/electron.d.ts',
  ]);
  assert.deepEqual(electronAssetUrls('43.7.7', 'electron.d.ts', {}), [
    'https://github.com/electron/electron/releases/download/v43.7.7/electron.d.ts',
  ]);
});

test('curl retries temporary HTTP failures, follows redirects and repairs corrupt cache', async (t) => {
  const { upstream, content, filename, env } = await fixture(t);
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/archive') {
      response.end(content);
    } else if (++requests === 1) {
      response.writeHead(503).end('temporarily unavailable');
    } else {
      response.writeHead(302, { location: '/archive' }).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  env.ELECTRON_MIRROR = `http://127.0.0.1:${server.address().port}/electron/`;
  const asset = await ensureElectronAsset(upstream, env, filename);
  assert.equal(await fs.readFile(asset, 'utf8'), content);
  assert.equal(requests, 2);
  await ensureElectronAsset(upstream, env, filename, () => { throw new Error('Verified cache should be reused.'); });
  await fs.writeFile(asset, 'corrupt cache');
  await ensureElectronAsset(upstream, env, filename);
  assert.equal(await fs.readFile(asset, 'utf8'), content);
  assert.equal(requests, 3);
});

for (const failure of ['network', 'checksum']) {
  test(`binary ${failure} failure falls back to official verified content`, async (t) => {
    const { upstream, content, filename, env } = await fixture(t);
    const requested = [];
    const asset = await ensureElectronAsset(upstream, env, filename, async (url, destination) => {
      requested.push(url);
      if (requested.length === 1 && failure === 'network') throw new Error('Connection reset');
      await fs.writeFile(destination, requested.length === 1 ? 'wrong content' : content);
    });
    assert.deepEqual(requested, electronAssetUrls('43.7.7', filename, env));
    assert.equal(await fs.readFile(asset, 'utf8'), content);
    assert.deepEqual(await fs.readdir(path.dirname(asset)), [filename]);
  });
}

test('invalid archives from all sources are discarded', async (t) => {
  const { upstream, filename, env } = await fixture(t);
  await assert.rejects(ensureElectronAsset(upstream, env, filename,
    async (_url, destination) => fs.writeFile(destination, 'wrong content')), /SHA-256/);
  assert.deepEqual(await fs.readdir(path.join(env.STUDIO_ELECTRON_CACHE_DIR, '43.7.7')), []);
});

test('assets missing from the pinned checksum manifest are never downloaded', async (t) => {
  const { upstream, env } = await fixture(t);
  let downloaded = false;
  await assert.rejects(ensureElectronAsset(upstream, env, 'unknown.zip', async () => { downloaded = true; }), /checksum is missing/);
  assert.equal(downloaded, false);
});
