import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';
import { resolveMonorepoRoot, readJSON } from '../scripts/distribution.mjs';

register();
const { getProjectCardColorContrastRatio } = await import('@steamharness/project-card-metadata');
const { installProjectDependencies, projectTemplatesRuntime } = await import('../extensions/studio-workstation/src/project-create-node.ts');

async function fixture(t, managers) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-package-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'); await mkdir(bin);
  for (const [name, script] of Object.entries(managers)) {
    const file = path.join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${script}\n`); await chmod(file, 0o755);
  }
  await writeFile(path.join(directory, 'index.ts'), 'source stays available');
  let log = '';
  return { directory, env: { ...process.env, PATH: bin }, log: message => { log += message; }, get output() { return log; } };
}

test('dependency setup prefers pnpm, logs installation, and keeps shell punctuation in cwd', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { pnpm: `console.log(process.argv.slice(2).join(' ')); if (!process.argv.includes('--version')) console.log(process.cwd());`,
    npm: 'process.exit(99);' });
  const directory = path.join(f.directory, "project ' $() &"); await mkdir(directory);
  await installProjectDependencies({ ...f, directory, signal: new AbortController().signal });
  assert.ok(f.output.includes('pnpm install')); assert.ok(f.output.includes(directory)); assert.ok(!/^npm install$/m.test(f.output));
});

test('missing pnpm falls back to npm and missing both managers reports a recoverable error', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { npm: 'console.log(process.argv.slice(2).join(" "));' });
  await installProjectDependencies({ ...f, signal: new AbortController().signal });
  assert.ok(f.output.includes('npm install')); assert.ok(f.output.includes('--no-audit --no-fund'));
  const missing = await fixture(t, {});
  await assert.rejects(installProjectDependencies({ ...missing, signal: new AbortController().signal }), { code: 'package-manager-missing' });
});

test('failed installation retains source and retries the same directory', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { pnpm: `if (!process.argv.includes('--version')) { console.error('registry unavailable'); process.exit(1); }` });
  await assert.rejects(installProjectDependencies({ ...f, signal: new AbortController().signal }), /registry unavailable/);
  assert.equal(await readFile(path.join(f.directory, 'index.ts'), 'utf8'), 'source stays available');
  await writeFile(path.join(f.directory, 'bin/pnpm'), `#!${process.execPath}\nconsole.log('ready');`);
  await installProjectDependencies({ ...f, signal: new AbortController().signal });
  assert.ok(f.output.includes('ready'));
});

test('cancellation stops lifecycle descendants before a retry can begin', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { pnpm: `
    if (process.argv.includes('--version')) { console.log('10.15.1'); }
    else {
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
      setTimeout(() => console.log('descendant:' + child.pid), 200);
      setInterval(() => {}, 1000);
    }` });
  const controller = new AbortController();
  const installing = installProjectDependencies({ ...f, signal: controller.signal });
  for (let i = 0; i < 100 && !/descendant:(\d+)/.test(f.output); i++) { await new Promise(resolve => setTimeout(resolve, 30)); }
  const pid = Number(/descendant:(\d+)/.exec(f.output)?.[1]); assert.ok(pid);
  controller.abort(); await assert.rejects(installing, { name: 'AbortError' });
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { return; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('A cancelled lifecycle script survived the installation.');
});

test('the shipped template runtime uses the host locale and exact bundled versions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-template-runtime-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = path.join(directory, 'extension'); await mkdir(path.join(extension, 'dist'), { recursive: true });
  await build({ entryPoints: ['vendor/project-templates/project-templates.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(extension, 'dist/project-templates.mjs') });
  await cp('vendor/project-templates/project-templates', path.join(extension, 'dist/project-templates'), { recursive: true });
  const monorepo = await resolveMonorepoRoot();
  const [harness, cli] = await Promise.all(['harness', 'cli'].map(name => readJSON(path.join(monorepo, name, 'package.json'))));
  await writeFile(path.join(extension, 'dist/project-template-versions.json'), JSON.stringify({ harness: harness.version, cli: cli.version }));
  const runtime = projectTemplatesRuntime(extension, 'zh-cn');
  const templates = await runtime.templates(); assert.equal(templates.length, 7); assert.equal(templates[0].name, '\u5de5\u4f5c\u6d41');
  const input = { templateId: 'workflow-starter', name: 'Created', parentDirectory: directory };
  await runtime.validate(input);
  await assert.rejects(runtime.validate({ ...input, name: '../escape' }), { code: 'invalid-name' });
  await assert.rejects(runtime.validate({ ...input, name: 'CON' }), { code: 'invalid-name' });
  await assert.rejects(runtime.validate({ ...input, parentDirectory: 'relative' }), { code: 'invalid-parent' });
  await assert.rejects(runtime.validate({ ...input, parentDirectory: path.join(directory, 'missing') }), { code: 'invalid-parent' });
  await runtime.validate({ ...input, name: "中文 & ' $()" });
  const created = await runtime.create(input);
  await assert.rejects(runtime.validate(input), { code: 'directory-exists' });
  await assert.rejects(runtime.create(input), { code: 'directory-exists' });
  const manifest = JSON.parse(await readFile(path.join(created.directory, 'steamharness.json'), 'utf8'));
  const versions = JSON.parse(await readFile(path.join(extension, 'dist/project-template-versions.json'), 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(path.join(created.directory, 'package.json'), 'utf8')).devDependencies, { 'steamharness': versions.harness, '@steamharness/cli': versions.cli });
  const card = manifest.projectCard;
  assert.equal(card.icon, 'workflow');
  assert.ok(getProjectCardColorContrastRatio(card.iconColor, card.iconBackgroundColor) >= 4.5);
  const deferred = await runtime.create({ ...input, name: 'Deferred' }, undefined,
    async () => { throw new Error('Source-window allocation must be skipped'); }, true);
  assert.equal(deferred.id, '');
  const filename = path.join(deferred.directory, 'index.ts');
  await writeFile(filename, '// Edits made in the opened project window\n');
  const assignedId = '78648759-bcde-4fd5-b3bd-9a2dd46a7192';
  assert.equal(await runtime.register(deferred.directory, new AbortController().signal, async () => assignedId), assignedId);
  assert.equal(JSON.parse(await readFile(path.join(deferred.directory, 'steamharness.json'), 'utf8')).id, assignedId);
  assert.equal(await readFile(filename, 'utf8'), '// Edits made in the opened project window\n');
});

test('the standalone snapshot matches CLI source when checked out together', async () => {
  const source = path.resolve('../cli/src');
  try { await readFile(path.join(source, 'project-templates.ts')); } catch (error) { if (error.code === 'ENOENT') { return; } throw error; }
  assert.equal(await readFile('vendor/project-templates/project-templates.ts', 'utf8'), await readFile(path.join(source, 'project-templates.ts'), 'utf8'));
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir('vendor/project-templates/project-templates', { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) { continue; }
    const relative = path.relative(path.resolve('vendor/project-templates/project-templates'), path.join(name.parentPath, name.name));
    assert.equal(await readFile(path.join(name.parentPath, name.name), 'utf8'), await readFile(path.join(source, 'project-templates', relative), 'utf8'), relative);
  }
});
