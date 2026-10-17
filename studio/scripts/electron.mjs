import { createReadStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { assertRuntime, assertUpstream } from './distribution.mjs';
import { electronEnvironment, ensureElectronAsset } from './downloads.mjs';

await assertRuntime();
const upstream = await assertUpstream();
const require = createRequire(path.join(upstream.directory, 'package.json'));
const electron = require('@vscode/gulp-electron');
const vfs = require('vinyl-fs');
const { config } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/electron.ts')));
const { filter, jsonEditor } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/gulp/facade.ts')));
const { streamToPromise } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/util.ts')));
const product = JSON.parse(await readFile(path.join(upstream.directory, 'product.json'), 'utf8'));
const env = await electronEnvironment(upstream);
const arch = process.arch === 'arm' ? 'armv7l' : process.arch;
const filename = `electron-v${config.version.replace(/^v/, '')}-${process.platform}-${arch}.zip`;
const archive = await ensureElectronAsset(upstream, env, filename);

// Feed verified local files to the upstream packager, including its locked checksums.
const repo = async ({ fileName }) => {
  const file = fileName === filename ? archive : fileName === 'SHASUMS256.txt' ? config.checksumFile : undefined;
  if (!file) return new Response(null, { status: 404 });
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: { 'Content-Length': String((await stat(file)).size) },
  });
};
process.chdir(upstream.directory);
await rm(path.join(upstream.directory, '.build/electron'), { recursive: true, force: true });
await streamToPromise(vfs.src('package.json')
  .pipe(jsonEditor({ name: product.nameShort }))
  .pipe(electron({ ...config, repo, platform: process.platform, arch: process.arch, ffmpegChromium: false, keepDefaultApp: true }))
  .pipe(filter(['**', '!**/app/package.json']))
  .pipe(vfs.dest('.build/electron')));
console.log(`Studio Electron ${config.version} (${process.platform}-${arch}) ready.`);
