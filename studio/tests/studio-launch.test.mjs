import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = ts.createSourceFile('studio.mjs', await readFile(new URL('../scripts/studio.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functions = ['build', 'main'].map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(source);
}).join('\n');

function launch(command, failure, args = []) {
  const events = [], launches = [];
  const upstream = { directory: '/source/upstream/vscode', commit: 'same-kernel-commit' };
  let output = 'old workbench without the newly applied patch';
  const context = {
    command, args, path, ROOT: '/source', npm: 'npm',
    process: { platform: 'linux', pid: 1, execPath: '/node', env: {} },
    console: { log() {} },
    prepare: async () => { events.push('prepare'); return { upstream, product: { nameShort: 'Studio', applicationName: 'studio' } }; },
    requireDependencies: async () => {},
    // Reproduce an existing build whose recorded HEAD still matches after a patch.
    buildReady: async () => true,
    exists: async () => true,
    readFile: async () => 'test-electron',
    electronVersion: async () => 'test-electron',
    electronEnvironment: async () => ({}),
    ensureDefaultExtensions: async () => {},
    resolveDesktopUserDataDir: value => value,
    resolveMonorepoRoot: async () => '/source',
    hasFlag: flag => args.some(argument => argument === flag || argument.startsWith(`${flag}=`)),
    run: async (_executable, args, directory) => {
      if (args[0] !== 'run' || args[1] !== 'build-fast') return;
      assert.equal(directory, upstream.directory);
      events.push('build-fast');
      if (failure) throw failure;
      output = 'workbench with the applied patch';
    },
    launch: async (_upstream, script, args) => {
      launches.push({ script, args });
      events.push('launch');
      assert.equal(output, 'workbench with the applied patch');
    },
  };
  return { run: () => vm.runInNewContext(`${functions}\nmain()`, context), events, launches };
}

for (const args of [['--user-data-dir', '/custom-profile'], ['--user-data-dir=/custom-profile']]) {
  test(`dev passes one user data directory when explicitly set as ${args[0]}`, async () => {
    const fixture = launch('dev', undefined, args);
    await fixture.run();
    const actual = fixture.launches[0].args;
    assert.equal(actual.filter(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir=')).length, 1);
    assert.equal(actual.some(argument => argument.includes('/custom-profile')), true);
    assert.equal(actual.some(argument => argument.includes('/.studio/desktop-user-data')), false);
  });
}

for (const command of ['dev', 'workflow', 'web', 'workflow:web']) {
  test(`${command} checks incremental build inputs after preparation even when the kernel HEAD is unchanged`, async () => {
    const fixture = launch(command);
    await fixture.run();
    assert.deepEqual(fixture.events, ['prepare', 'build-fast', 'launch']);
  });

  test(`${command} does not launch stale output when rebuilding a patch fails`, async () => {
    const failure = new Error('patch compilation failed');
    const fixture = launch(command, failure);
    await assert.rejects(fixture.run(), error => error === failure);
    assert.deepEqual(fixture.events, ['prepare', 'build-fast']);
  });
}
