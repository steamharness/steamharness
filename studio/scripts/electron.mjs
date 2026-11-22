import { createReadStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { assertRuntime, assertUpstream, run } from './distribution.mjs';
import { electronEnvironment, ensureElectronAsset } from './downloads.mjs';
import { assertMacElectronNotRunning, noteDevElectronSigned } from './electron-cache.mjs';

await assertRuntime();
const upstream = await assertUpstream();
const require = createRequire(path.join(upstream.directory, 'package.json'));
const electron = require('@vscode/gulp-electron');
const vfs = require('vinyl-fs');
const { config } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/electron.ts')));
const { filter, jsonEditor } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/gulp/facade.ts')));
const { streamToPromise } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/util.ts')));
const product = JSON.parse(await readFile(path.join(upstream.directory, 'product.json'), 'utf8'));
const cache = path.join(upstream.directory, '.build/electron');
const macBundle = process.platform === 'darwin' ? path.join(cache, `${product.nameLong}.app`) : undefined;
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
if (macBundle) await assertMacElectronNotRunning(macBundle, product.nameShort);
await rm(cache, { recursive: true, force: true });
await streamToPromise(vfs.src('package.json')
  .pipe(jsonEditor({ name: product.nameShort }))
  .pipe(electron({ ...config, repo, platform: process.platform, arch: process.arch, ffmpegChromium: false, keepDefaultApp: true }))
  .pipe(filter(['**', '!**/app/package.json']))
  .pipe(vfs.dest('.build/electron')));
if (macBundle) {
  const { buildStudioNotificationPermission, studioNotificationPermissionName } = await import(pathToFileURL(path.join(upstream.directory, 'build/lib/studioNotificationPermission.ts')));
  const permissionAddon = path.join(macBundle, 'Contents/Resources', studioNotificationPermissionName);
  buildStudioNotificationPermission(permissionAddon, arch);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', permissionAddon], upstream.directory);
  // Rebranding changes the bundle identifier and invalidates the original Electron signature.
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', macBundle], upstream.directory);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', macBundle], upstream.directory);
  await noteDevElectronSigned(upstream, macBundle);
}
console.log(`Studio Electron ${config.version} (${process.platform}-${arch}) ready.`);
