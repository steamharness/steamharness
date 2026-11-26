import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileFunction } from 'node:vm';
import { buildStudioNode as build } from '../scripts/node-extension-build.mjs';

const compiled = await build({ stdin: { contents: `
export { inspectRuntimeDependencies, replaceRuntimeDependencies } from './extensions/studio-workstation/src/project-runtime-dependencies-node';
export { createRuntimeNpmLatest } from './extensions/studio-workstation/src/project-runtime-npm-node';
export { installProjectDependencies } from './extensions/studio-workstation/src/project-create-node';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
compileFunction(compiled.outputFiles[0].text, ['module', 'exports', 'require'])(module, module.exports, createRequire(import.meta.url));
const { inspectRuntimeDependencies, replaceRuntimeDependencies, installProjectDependencies, createRuntimeNpmLatest } = module.exports;
const ready = command => spawnSync(command, ['--version'], { windowsHide: true, stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
const packages = [
  { key: 'core', name: 'steamharness', file: 'steamharness.tgz' },
  { key: 'cli', name: '@steamharness/cli', file: 'steamharness-cli.tgz' },
];
const missing = async file => assert.rejects(readFile(file), { code: 'ENOENT' });

async function fixture(t, oldVersion = '0.2.0', newVersion = '0.2.6', legacy = true) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-runtime-update-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const workspace = path.join(root, 'workspace'), directory = path.join(workspace, 'pinned project'), bundle = path.join(root, 'studio-bundle');
  const local = path.join(directory, 'vendor', 'steamharness');
  const staging = path.join(root, 'archive-source', 'package');
  await Promise.all([local, bundle, staging].map(dir => mkdir(dir, { recursive: true })));
  const signal = new AbortController().signal;
  const json = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  const specs = { steamharness: 'file:./vendor/steamharness/steamharness.tgz', '@steamharness/cli': 'file:vendor/steamharness/steamharness-cli.tgz' };
  const manifest = {
    name: 'pinned-project', version: '1.0.0', private: true,
    scripts: { postinstall: 'node postinstall.cjs' },
    ...(legacy && { steamharnessRuntime: { version: oldVersion } }), devDependencies: { ...specs, 'studio-fixture-helper': 'file:./vendor/steamharness/helper.tgz' },
  };
  const declaration = { id: randomUUID(), name: 'Fixture', version: '1.0.0', defaultEntry: 'main', entries: [{ entryId: 'main', name: 'Fixture', type: 'bot', root: '.', entry: 'index.ts' }] };
  const archive = async (file, pkg) => {
    await json(path.join(staging, 'package.json'), pkg);
    await writeFile(path.join(staging, 'index.js'), JSON.stringify(pkg.description));
    execFileSync('tar', ['-czf', file, '-C', path.dirname(staging), 'package'], { windowsHide: true });
    return createHash('sha256').update(await readFile(file)).digest('hex');
  };
  await json(path.join(directory, 'package.json'), manifest);
  await json(path.join(directory, 'steamharness.json'), declaration);
  await writeFile(path.join(directory, 'index.ts'), 'export {};\n');
  await writeFile(path.join(directory, 'postinstall.cjs'), "require('node:fs').writeFileSync('unexpected-script', 'ran');\n");
  await archive(path.join(local, 'helper.tgz'), { name: 'studio-fixture-helper', version: '3.1.0', description: 'preserve me' });
  const bundled = {};
  for (const { key, name, file } of packages) {
    const pkg = (version, description) => ({ name, version, description, ...(key === 'cli' && { peerDependencies: { steamharness: version } }) });
    await archive(path.join(local, file), pkg(oldVersion, 'previous build'));
    bundled[key] = { version: newVersion, sha256: await archive(path.join(bundle, file), pkg(newVersion, 'Studio build')) };
  }
  await json(path.join(bundle, 'runtime-packages.json'), { schemaVersion: 2, packages: bundled });
  const candidate = { directory, workspace };
  const env = { ...process.env, npm_config_offline: 'true' };
  return { directory, local, candidate, bundle, signal, manifest, declaration, json,
    inspect: npmLatest => inspectRuntimeDependencies(candidate, bundle, signal, npmLatest),
    install: (root, manager) => installProjectDependencies({ directory: root, signal, log() {}, env, runtimeReplacement: manager }),
    options: (revision, install, beforeReplace = async () => {}) => ({ candidate, bundle, revision, signal, install, beforeReplace }),
  };
}

const oldVersion = '0.2.0';
for (const [manager, targetVersion] of [['pnpm', oldVersion], ['npm', oldVersion], ['npm', '0.2.6']]) test(
  `installs the Studio build over ${manager} file references (${oldVersion} to ${targetVersion})`, { skip: !ready(manager), timeout: 30_000 }, async t => {
  const f = await fixture(t, oldVersion, targetVersion);
  // The screenshot case: Core matches already, but the CLI is a different build of the same version.
  const sameVersion = targetVersion === oldVersion;
  if (sameVersion) await copyFile(path.join(f.bundle, 'steamharness.tgz'), path.join(f.local, 'steamharness.tgz'));
  await f.install(f.directory, manager);
  const manifestPath = path.join(f.directory, 'package.json');
  const previous = await f.inspect();
  assert.equal(previous.manager, manager);
  assert.equal(previous.bundleVersion, targetVersion);
  assert.equal(previous.matches, false);
  assert.ok(previous.packages.every(pkg => pkg.version === oldVersion && pkg.installedVersion === oldVersion));
  assert.deepEqual(previous.packages.map(pkg => pkg.sameArchive), [sameVersion, false]);
  const cli = previous.packages[1];
  const digest = async directory => createHash('sha256').update(await readFile(path.join(directory, 'steamharness-cli.tgz'))).digest('hex');
  assert.equal(cli.projectSha256, await digest(f.local));
  assert.equal(cli.studioSha256, await digest(f.bundle));
  assert.notEqual(cli.projectSha256, cli.studioSha256);

  const stages = [];
  const result = await replaceRuntimeDependencies(f.options(previous.revision, async (directory, chosen) => {
    stages.push('install'); assert.equal(chosen, manager); await f.install(directory, chosen);
  }, async directory => { assert.equal(directory, f.directory); stages.push('close'); }));
  assert.deepEqual(stages, ['close', 'install']);
  assert.equal(result, targetVersion);
  const next = await f.inspect();
  assert.equal(next.matches, true);
  assert.notEqual(next.revision, previous.revision);
  for (const pkg of next.packages) {
    const installed = JSON.parse(await readFile(path.join(f.directory, 'node_modules', pkg.name, 'package.json'), 'utf8'));
    assert.deepEqual([pkg.version, pkg.installedVersion, installed.description, pkg.sameArchive], [targetVersion, targetVersion, 'Studio build', true]);
  }
  const { steamharnessRuntime: _legacy, ...expectedManifest } = f.manifest;
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), expectedManifest);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'node_modules/studio-fixture-helper/package.json'), 'utf8')).version, '3.1.0');
  assert.equal(await readFile(path.join(f.directory, 'index.ts'), 'utf8'), 'export {};\n');
  await missing(path.join(f.directory, 'unexpected-script'));
  assert.ok(!(await readdir(f.directory)).some(name => name.startsWith('.studio-runtime-update-') || name.endsWith('.lock')));
});

test('repairs a missing installation without rewriting matching archives', { skip: !ready('pnpm'), timeout: 30_000 }, async t => {
  const f = await fixture(t, oldVersion, oldVersion, false);
  const manifestPath = path.join(f.directory, 'package.json'), before = await readFile(manifestPath);
  const files = packages.map(pkg => path.join(f.local, pkg.file));
  for (const { file } of packages) await copyFile(path.join(f.bundle, file), path.join(f.local, file));
  const archiveStats = await Promise.all(files.map(file => stat(file)));
  const inspection = await f.inspect();
  assert.ok(inspection.packages.every(pkg => pkg.sameArchive));
  assert.equal(inspection.matches, false);
  await replaceRuntimeDependencies(f.options(inspection.revision, f.install));
  const after = await Promise.all(files.map(file => stat(file)));
  assert.deepEqual(after.map(info => info.mtimeMs), archiveStats.map(info => info.mtimeMs));
  assert.deepEqual(await readFile(manifestPath), before);
  assert.equal((await f.inspect()).matches, true);
});

test('an installation failure restores the previous archives, manifest, lockfile and node_modules', async t => {
  const f = await fixture(t, oldVersion, oldVersion);
  const lock = path.join(f.directory, 'pnpm-lock.yaml'); await writeFile(lock, 'original integrity\n');
  await mkdir(path.join(f.directory, 'node_modules')); await writeFile(path.join(f.directory, 'node_modules/previous'), 'original modules');
  const protectedFiles = [...packages.map(item => path.join(f.local, item.file)), path.join(f.directory, 'package.json'), lock];
  const before = await Promise.all(protectedFiles.map(file => readFile(file)));
  const inspection = await f.inspect();
  await assert.rejects(replaceRuntimeDependencies(f.options(inspection.revision, async directory => {
    await mkdir(path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, 'node_modules/partial'), 'failed installer');
    await f.json(path.join(directory, 'package.json'), { ...f.manifest, description: 'partially updated manifest' });
    await writeFile(lock, 'partially updated integrity\n');
    throw new Error('fixture install failure');
  })), /fixture install failure/);
  assert.deepEqual(await Promise.all(protectedFiles.map(file => readFile(file))), before);
  assert.equal(await readFile(path.join(f.directory, 'node_modules/previous'), 'utf8'), 'original modules');
  await missing(path.join(f.directory, 'node_modules/partial'));
  assert.equal((await f.inspect()).revision, inspection.revision);
});

test('does not install from stale, escaping, shared, release, symlinked or damaged bundles', async t => {
  const f = await fixture(t);
  const packageFile = path.join(f.directory, 'package.json'), core = path.join(f.local, packages[0].file);
  const snapshot = await f.inspect();
  const failInstall = async () => assert.fail('The installer should not run.');
  await assert.rejects(replaceRuntimeDependencies(f.options(snapshot.revision, failInstall, async () => {
    await f.json(packageFile, { ...f.manifest, description: 'changed after confirmation' });
  })), /changed/);
  assert.equal((await f.inspect()).packages[0].version, '0.2.0');
  await f.json(packageFile, { ...f.manifest, devDependencies: { ...f.manifest.devDependencies, steamharness: 'file:../escape.tgz' } });
  assert.equal(await f.inspect(), undefined);
  await f.json(packageFile, { ...f.manifest, devDependencies: { ...f.manifest.devDependencies, alias: f.manifest.devDependencies.steamharness } });
  assert.equal((await f.inspect()).manager, undefined);
  await f.json(packageFile, f.manifest);
  await f.json(path.join(f.directory, 'steamharness.json'), { ...f.declaration, distribution: { kind: 'release', version: 1 } });
  assert.equal(await f.inspect(), undefined);
  await f.json(path.join(f.directory, 'steamharness.json'), f.declaration);

  if (process.platform !== 'win32') {
    const original = `${core}.backup`; await copyFile(core, original); await rm(core); await symlink(original, core);
    assert.equal(await f.inspect(), undefined);
    await rm(core); await copyFile(original, core);
  }
  await writeFile(path.join(f.bundle, packages[0].file), 'fake archive');
  assert.equal((await f.inspect()).bundleVersion, undefined);
});

test('reports pinned npm upgrades separately from stale installs within the declared range', async t => {
  const f = await fixture(t);
  const packageFile = path.join(f.directory, 'package.json');
  const manifest = { ...f.manifest, dependencies: { steamharness: '0.2.9' }, devDependencies: { '@steamharness/cli': '^0.2.0', other: '1.0.0' } };
  await f.json(packageFile, manifest);
  for (const { name } of packages) {
    const directory = path.join(f.directory, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await f.json(path.join(directory, 'package.json'), { name, version: '0.2.9' });
  }
  const latest = async () => '0.2.10';
  assert.deepEqual(await f.inspect(latest), { kind: 'npm', updates: [
    { name: 'steamharness', group: 'dependencies', spec: '0.2.9', installedVersion: '0.2.9', latestVersion: '0.2.10', kind: 'declaration' },
    { name: '@steamharness/cli', group: 'devDependencies', spec: '^0.2.0', installedVersion: '0.2.9', latestVersion: '0.2.10', kind: 'installation' },
  ] });
  assert.deepEqual(JSON.parse(await readFile(packageFile, 'utf8')), manifest);
  await missing(path.join(f.directory, 'package-lock.json'));
  await missing(path.join(f.directory, 'pnpm-lock.yaml'));

  await f.json(packageFile, { ...manifest, dependencies: { steamharness: '0.2.10' }, devDependencies: { '@steamharness/cli': '^0.3.0' } });
  await f.json(path.join(f.directory, 'node_modules/steamharness/package.json'), { name: 'steamharness', version: '0.2.10' });
  assert.equal(await f.inspect(latest), undefined);
  await f.json(packageFile, { ...manifest, dependencies: { steamharness: '^0.2.0' }, devDependencies: {} });
  await rm(path.join(f.directory, 'node_modules/steamharness'), { recursive: true });
  assert.equal(await f.inspect(latest), undefined);
});

test('leaves archive comparison offline and queries only SteamHarness npm versions in mixed projects', async t => {
  const f = await fixture(t);
  const queries = [];
  const latest = async name => { queries.push(name); return '0.2.10'; };
  assert.equal((await f.inspect(latest)).kind, 'archive');
  assert.deepEqual(queries, []);

  const file = path.join(f.directory, 'package.json');
  await f.json(file, { ...f.manifest, devDependencies: { ...f.manifest.devDependencies, '@steamharness/cli': '~0.1.0' } });
  assert.deepEqual((await f.inspect(latest)).updates.map(update => update.name), ['@steamharness/cli']);
  assert.deepEqual(queries.splice(0), ['@steamharness/cli']);
  assert.equal(await f.inspect(async () => undefined), undefined);

  await f.json(file, { ...f.manifest, devDependencies: { steamharness: 'workspace:*', '@steamharness/cli': 'next', unrelated: '0.1.0' } });
  assert.equal(await f.inspect(latest), undefined);
  assert.deepEqual(queries, []);

  await f.json(file, { ...f.manifest, devDependencies: { steamharness: '0.2.0' } });
  await f.json(path.join(f.directory, 'steamharness.json'), { ...f.declaration, distribution: { kind: 'release', version: 1 } });
  assert.equal(await f.inspect(latest), undefined);
  assert.deepEqual(queries, []);
});

test('reads only public npm latest tags, coalesces requests and backs off on unavailable releases', async () => {
  const calls = [], controller = new AbortController();
  let now = 0, cliVersion = '0.2.11-dev.1', coreVersion = '0.2.10';
  const latest = createRuntimeNpmLatest(controller.signal, async (address, options) => {
    calls.push(address);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (address === 'https://registry.npmjs.org/steamharness/latest') return Response.json({ name: 'steamharness', version: coreVersion });
    assert.equal(address, 'https://registry.npmjs.org/%40steamharness%2Fcli/latest');
    return Response.json({ name: '@steamharness/cli', version: cliVersion });
  }, () => now);
  const first = latest('steamharness');
  assert.equal(latest('steamharness'), first);
  assert.equal(await first, '0.2.10');
  assert.equal(await latest('@steamharness/cli'), undefined);
  cliVersion = '0.2.10';
  coreVersion = '0.2.11';
  assert.equal(await latest('@steamharness/cli'), undefined);
  assert.equal(calls.length, 2);
  now += 60_000;
  assert.equal(await latest('@steamharness/cli'), '0.2.10');
  assert.equal(await latest('steamharness'), '0.2.10');
  now += 15 * 60_000;
  assert.equal(await latest('steamharness'), '0.2.11');
  assert.equal(calls.length, 4);
  controller.abort();
  assert.equal(await latest('steamharness'), undefined);
  assert.equal(calls.length, 4);
});
