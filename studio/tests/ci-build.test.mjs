import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'studio-ci-build-'));
after(() => rm(fixture, { recursive: true, force: true }));
const kernel = path.join(fixture, 'vscode');
await mkdir(kernel);
const upstream = JSON.parse(await readFile(path.join(ROOT, 'config/upstream.json'), 'utf8'));
const files = ['build/next/build-fast.ts', 'build/gulpfile.extensions.ts'];
execFileSync('git', ['init', '-q'], { cwd: kernel });
for (const file of files) {
  const source = execFileSync('git', ['show', `${upstream.commit}:${file}`], { cwd: path.join(ROOT, upstream.path) });
  await mkdir(path.dirname(path.join(kernel, file)), { recursive: true });
  await writeFile(path.join(kernel, file), source);
}
execFileSync('git', ['add', '--', ...files], { cwd: kernel });
execFileSync('git', ['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', `core.hooksPath=${path.join(fixture, 'hooks')}`, 'commit', '--quiet', '-m', 'pinned kernel fixture'], { cwd: kernel });
await mkdir(path.join(fixture, 'patches'));
for (const patch of ['0014-studio-ci-serial-build.patch', '0015-studio-ci-stale-build-lock.patch']) {
  await fs.promises.copyFile(path.join(ROOT, 'patches', patch), path.join(fixture, 'patches', patch));
}
await applyPatches(fixture, kernel);
await applyPatches(fixture, kernel);
const source = ts.createSourceFile(files[0], await readFile(path.join(kernel, files[0]), 'utf8'), ts.ScriptTarget.Latest, true);
const scheduler = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'waitForTasks');
assert.ok(scheduler);
const code = ts.transpileModule(scheduler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function schedule(tasks, serial) {
  const run = vm.runInNewContext(`${code}\nwaitForTasks`, { process: { env: { STUDIO_CI_SERIAL_BUILD: serial ? '1' : '' } } });
  return run(tasks);
}

async function peakConcurrency(serial) {
  let active = 0;
  let peak = 0;
  const finished = [];
  await schedule([0, 1, 2].map(id => async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    finished.push(id);
    active--;
  }), serial);
  return { peak, finished };
}

const lockNames = new Set(['acquireLock', 'isFreshLock', 'readLockOwner', 'isProcessRunning',
  'isPathMissing', 'isAlreadyExists', 'isNoSuchProcess']);
const lockSource = source.statements.filter(node => ts.isFunctionDeclaration(node) && lockNames.has(node.name?.text))
  .map(node => node.getText(source)).join('\n');
const lockCode = ts.transpileModule(lockSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function acquireBuildLock(env) {
  return vm.runInNewContext(`${lockCode}\nacquireLock`, {
    fs, Error, LOCK_STALE_AFTER_MS: 30_000,
    process: { env, pid: process.pid, kill: process.kill.bind(process) },
  });
}

const exitedOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
await new Promise((resolve, reject) => {
  exitedOwner.once('error', reject);
  exitedOwner.once('exit', resolve);
});
assert.throws(() => process.kill(exitedOwner.pid, 0), { code: 'ESRCH' });
const ciBuildEnv = { CI: 'true', STUDIO_CI_SERIAL_BUILD: '1' };

test('the pinned kernel patch runs CI build stages one at a time', async () => {
  assert.deepEqual(await peakConcurrency(true), { peak: 1, finished: [0, 1, 2] });
});

test('ordinary build stages retain parallel execution', async () => {
  assert.deepEqual(await peakConcurrency(false), { peak: 3, finished: [0, 1, 2] });
});

test('the extension compiler selects serial execution only when requested', async () => {
  const extensions = ts.createSourceFile(files[1], await readFile(path.join(kernel, files[1]), 'utf8'), ts.ScriptTarget.Latest, true);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(extensions) === 'compileExtensionsTask') declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(extensions);
  assert.ok(declaration?.initializer);
  const create = vm.runInNewContext(`(task, tasks, process) => ${declaration.initializer.getText(extensions)}`);
  const task = {
    define: (name, result) => { assert.equal(name, 'compile-extensions'); return result; },
    series: (...tasks) => ({ mode: 'serial', tasks }),
    parallel: (...tasks) => ({ mode: 'parallel', tasks }),
  };
  const tasks = [{ compileTask: 'first' }, { compileTask: 'second' }];
  for (const [flag, mode] of [['1', 'serial'], ['', 'parallel']]) {
    assert.deepEqual(create(task, tasks, { env: { STUDIO_CI_SERIAL_BUILD: flag } }), { mode, tasks: ['first', 'second'] });
  }
});

test('serial failures stop later stages while parallel failures await running stages', async () => {
  const failure = new Error('build failed');
  let finished = false;
  const stages = [async () => { throw failure; }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    finished = true;
  }];
  await assert.rejects(schedule(stages, true), error => error === failure);
  assert.equal(finished, false);
  await assert.rejects(schedule(stages, false), error => error === failure);
  assert.equal(finished, true);
});

test('serial CI builds recover a lock left by an exited process', async () => {
  const filename = path.join(fixture, 'stale.lock');
  await writeFile(filename, String(exitedOwner.pid));
  const lock = await acquireBuildLock(ciBuildEnv)(filename);
  assert.equal(await readFile(filename, 'utf8'), String(process.pid));
  await lock.dispose();
  await assert.rejects(fs.promises.stat(filename), { code: 'ENOENT' });
});

test('serial CI builds preserve locks belonging to an active process', async () => {
  const filename = path.join(fixture, 'active.lock');
  await writeFile(filename, String(process.pid));
  await assert.rejects(acquireBuildLock(ciBuildEnv)(filename), /already running/);
  assert.equal(await readFile(filename, 'utf8'), String(process.pid));
});

test('serial CI builds preserve a fresh incomplete lock and recover an old one', async () => {
  const filename = path.join(fixture, 'incomplete.lock');
  await writeFile(filename, '');
  await assert.rejects(acquireBuildLock(ciBuildEnv)(filename), /acquiring the build lock/);
  assert.equal(await readFile(filename, 'utf8'), '');
  const past = new Date(Date.now() - 60_000);
  await fs.promises.utimes(filename, past, past);
  const lock = await acquireBuildLock(ciBuildEnv)(filename);
  assert.equal(await readFile(filename, 'utf8'), String(process.pid));
  await lock.dispose();
});

test('stale lock recovery requires both CI and the serial build flag', async () => {
  const filename = path.join(fixture, 'ordinary.lock');
  await writeFile(filename, String(exitedOwner.pid));
  for (const env of [{ CI: 'true' }, { STUDIO_CI_SERIAL_BUILD: '1' }, {}]) {
    await assert.rejects(acquireBuildLock(env)(filename), /stale build-fast lock/);
    assert.equal(await readFile(filename, 'utf8'), String(exitedOwner.pid));
  }
});
