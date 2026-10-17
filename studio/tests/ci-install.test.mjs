import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const preload = await readFile(new URL('../scripts/ci/limit-install.cjs', import.meta.url), 'utf8');
const project = '/ci/workflow/studio';
const hook = `${project}/upstream/vscode/build/npm/postinstall.ts`;

function runPreload({ platform = 'linux', env = {}, script = hook } = {}) {
  const os = { cpus: () => Array.from({ length: 8 }, () => ({})) };
  let exited = false;
  let synced = false;
  const exit = {};
  try {
    vm.runInNewContext(preload, {
      require: (name) => {
        if (name === 'node:os') return os;
        if (name === 'node:path') return path;
        if (name === 'node:module') return { syncBuiltinESMExports: () => { synced = true; } };
        throw new Error(`Unexpected module: ${name}`);
      },
      process: {
        platform, env, argv: ['node', script],
        exit: (code) => { assert.equal(code, 0); exited = true; throw exit; },
      },
      console: { log() {} },
    });
  } catch (error) {
    if (error !== exit) throw error;
  }
  return { exited, synced, cpus: os.cpus().length };
}

const ciEnv = { CI: 'true', CI_PROJECT_DIR: project, STUDIO_CI_DEFER_POSTINSTALL: '1' };

test('Linux CI defers only the root VS Code postinstall', () => {
  assert.equal(runPreload({ env: ciEnv }).exited, true);
  for (const script of [
    `${project}/upstream/vscode/node_modules/keytar/install.js`,
    `${project}/upstream/vscode/build/npm/preinstall.ts`,
    '/another/project/upstream/vscode/build/npm/postinstall.ts',
  ]) {
    assert.equal(runPreload({ env: ciEnv, script }).exited, false, script);
  }
});

test('ordinary setup never defers postinstall', () => {
  for (const options of [
    { env: {} },
    { env: { ...ciEnv, CI: '' } },
    { env: { ...ciEnv, CI_PROJECT_DIR: '' } },
    { env: { ...ciEnv, STUDIO_CI_DEFER_POSTINSTALL: '' } },
    { env: ciEnv, platform: 'darwin' },
    { env: ciEnv, platform: 'win32' },
  ]) {
    assert.equal(runPreload(options).exited, false);
  }
});

test('install concurrency remains one CPU in CommonJS and ESM', () => {
  assert.deepEqual(runPreload(), { exited: false, synced: true, cpus: 1 });
});
