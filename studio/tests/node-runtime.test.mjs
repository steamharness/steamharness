import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { resolveNodeRuntime, nodeRuntimeEnvironment } = await import('../extensions/studio-workstation/src/node-runtime.ts');
const { installProjectDependencies } = await import('../extensions/studio-workstation/src/project-create-node.ts');
const { configureLocalization } = await import('../extensions/studio-workstation/src/localization.ts');
const execute = promisify(execFile);

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "Studio 中文 & '$ runtime-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const node = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  await mkdir(path.dirname(path.join(directory, node)), { recursive: true });
  await copyFile(process.execPath, path.join(directory, node));
  const manager = `console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}));`;
  await writeFile(path.join(directory, 'npm.mjs'), manager);
  await writeFile(path.join(directory, 'pnpm.mjs'), manager);
  const file = path.join(directory, 'runtime.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, nodeVersion: process.versions.node, node, npm: 'npm.mjs', pnpm: 'pnpm.mjs', bin: path.dirname(node) }));
  return { directory, file, node: path.join(directory, node) };
}

test('public Studio uses its host without a bundled manifest or download', async () => {
  const runtime = await resolveNodeRuntime({ env: {} });
  assert.equal(runtime.source, 'host');
  assert.equal(runtime.nodePath, process.execPath);
  assert.deepEqual(runtime.pathEntries, []);
  assert.equal(runtime.pnpmCli, undefined);
});

test('bundled processes and package lifecycle children work without system Node', async t => {
  const f = await fixture(t);
  const runtime = await resolveNodeRuntime({ manifestPath: f.file, env: { PATH: '', ELECTRON_RUN_AS_NODE: '1' } });
  const env = nodeRuntimeEnvironment(runtime, { PATH: '', ELECTRON_RUN_AS_NODE: '1', STEAMHARNESS_STUDIO_NODE_RUNTIME: f.file });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.STEAMHARNESS_STUDIO_NODE_RUNTIME, undefined);
  const result = await execute(runtime.nodePath, ['-e', `const {execFileSync}=require('node:child_process');console.log(execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim())`], { env });
  assert.equal(result.stdout.trim(), f.node);
  let log = '';
  await installProjectDependencies({ directory: f.directory, runtime, env: { PATH: '' }, signal: new AbortController().signal, log: text => { log += text; } });
  assert.ok(log.includes(f.node));
  assert.ok(log.includes('pnpm install'));
});

test('local selection honours legacy paths and original PATH while using the selected Node for managers', async t => {
  const f = await fixture(t);
  const local = path.join(f.directory, 'local', path.basename(f.node));
  await mkdir(path.dirname(local)); await copyFile(process.execPath, local);
  const runtime = await resolveNodeRuntime({ nodePath: local, manifestPath: f.file, storageDirectory: path.join(f.directory, 'storage') });
  assert.equal(runtime.source, 'local'); assert.equal(runtime.nodePath, local);
  const discovered = await resolveNodeRuntime({ source: 'local', manifestPath: f.file, originalPath: path.dirname(local), env: { PATH: path.dirname(f.node) } });
  assert.equal(discovered.nodePath, local); assert.notEqual(runtime.identity, (await resolveNodeRuntime({ source: 'auto', nodePath: local, manifestPath: f.file })).identity);
  if (process.platform !== 'win32') {
    const result = await execute(path.join(runtime.pathEntries[0], 'pnpm'), ['install'], { env: nodeRuntimeEnvironment(runtime, { PATH: '/usr/bin:/bin' }) });
    assert.equal(JSON.parse(result.stdout).node, local);
  } else {
    const result = await execute(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', 'pnpm install'], { env: nodeRuntimeEnvironment(runtime) });
    assert.equal(JSON.parse(result.stdout).node, local);
    assert.ok([...await readFile(path.join(runtime.pathEntries[0], 'pnpm.cmd'))].every(byte => byte < 128));
  }
});

test('a local executable alias keeps child processes on the resolved Node installation', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), aliases = path.join(f.directory, 'aliases');
  await mkdir(aliases);
  await symlink(f.node, path.join(aliases, 'selected-node'));
  await writeFile(path.join(aliases, 'node'), '#!/bin/sh\necho wrong-node\n', { mode: 0o755 });
  const runtime = await resolveNodeRuntime({ source: 'local', nodePath: path.join(aliases, 'selected-node'), manifestPath: f.file });
  const result = await execute(runtime.nodePath, ['-e', `console.log(require('node:child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim())`],
    { env: nodeRuntimeEnvironment(runtime, { PATH: aliases }) });
  assert.equal(result.stdout.trim(), f.node);
});

test('missing and corrupt bundles fail explicitly while local mode remains available for repair', async t => {
  const f = await fixture(t);
  await rm(path.join(f.directory, 'pnpm.mjs'));
  await assert.rejects(resolveNodeRuntime({ manifestPath: f.file }), /missing or damaged/);
  assert.equal((await resolveNodeRuntime({ source: 'local', nodePath: process.execPath, manifestPath: f.file })).source, 'local');
  await assert.rejects(resolveNodeRuntime({ source: 'local', env: { PATH: '' } }), /No local Node/);
  await assert.rejects(resolveNodeRuntime({ nodePath: 'relative/node', env: {} }), /absolute path/);
  await assert.rejects(resolveNodeRuntime({ nodePath: path.join(f.directory, 'missing'), env: {} }), /Cannot run Node/);
  if (process.platform !== 'win32') {
    const old = path.join(f.directory, 'old-node'); await writeFile(old, '#!/bin/sh\necho v18.20.0\n'); await chmod(old, 0o755);
    await assert.rejects(resolveNodeRuntime({ nodePath: old, env: {} }), /22.19.0 or newer/);
  }
});

test('bundled manifests cannot escape their installation directory', async t => {
  const f = await fixture(t), manifest = JSON.parse(await readFile(f.file, 'utf8'));
  manifest.node = '../outside-node'; await writeFile(f.file, JSON.stringify(manifest));
  await assert.rejects(resolveNodeRuntime({ manifestPath: f.file }), /missing or damaged/);
});

test('bundled manifests reject symlinks to executables outside the installation', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rm(f.node); await symlink(process.execPath, f.node);
  await assert.rejects(resolveNodeRuntime({ manifestPath: f.file }), /missing or damaged/);
});

test('a standalone local Node without package managers never installs through a different system Node', async t => {
  const f = await fixture(t);
  const runtime = await resolveNodeRuntime({ nodePath: f.node, env: {} });
  assert.equal(runtime.npmCli, undefined); assert.equal(runtime.pnpmCli, undefined);
  await assert.rejects(installProjectDependencies({ directory: f.directory, runtime, signal: new AbortController().signal, log() {} }), /has no package manager/);
});

test('bundled entrypoint checksums detect corruption and errors follow the display language', async t => {
  const f = await fixture(t), manifest = JSON.parse(await readFile(f.file, 'utf8'));
  manifest.hashes = Object.fromEntries(await Promise.all([manifest.node, manifest.npm, manifest.pnpm].map(async file =>
    [file, createHash('sha256').update(await readFile(path.join(f.directory, file))).digest('hex')])));
  await writeFile(f.file, JSON.stringify(manifest));
  assert.equal((await resolveNodeRuntime({ manifestPath: f.file })).source, 'bundled');
  await writeFile(path.join(f.directory, manifest.pnpm), 'damaged');
  for (const [locale, message] of [['en', /missing or damaged/], ['zh-cn', /内置 Node.js 运行时缺失或损坏/]]) {
    const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${locale === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
    configureLocalization(bundle, locale);
    await assert.rejects(resolveNodeRuntime({ manifestPath: f.file }), message);
  }
  configureLocalization({}, 'en');
});

test('bundled integrity checks cover package manager dependencies as well as entrypoints', async t => {
  const f = await fixture(t), dependency = path.join(f.directory, 'manager-dependency.cjs');
  await writeFile(dependency, 'module.exports = 1;');
  const manifest = JSON.parse(await readFile(f.file, 'utf8'));
  manifest.hashes = Object.fromEntries(await Promise.all([manifest.node, manifest.npm, manifest.pnpm, path.basename(dependency)].map(async file =>
    [file, createHash('sha256').update(await readFile(path.join(f.directory, file))).digest('hex')])));
  await writeFile(f.file, JSON.stringify(manifest));
  assert.equal((await resolveNodeRuntime({ manifestPath: f.file })).source, 'bundled');
  await rm(dependency);
  await assert.rejects(resolveNodeRuntime({ manifestPath: f.file }), /missing or damaged/);
});
