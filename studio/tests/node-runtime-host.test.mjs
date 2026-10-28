import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url), execute = promisify(execFile);
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/node-runtime-host.ts'],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });

async function host(t, env = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-node-host-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(process.execPath, local);
  const configuration = { source: undefined, nodePath: '' }, commands = new Map(), providers = new Map(), listeners = [];
  const collection = { persistent: true, mutations: [], clear() { this.mutations = []; }, prepend(...args) { this.mutations.push(args); } };
  const errors = [], notices = [];
  const disposable = () => ({ dispose() {} });
  const vscode = {
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); }, executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ inspect: () => ({ globalValue: configuration.source }), get: () => configuration.nodePath }),
      onDidChangeConfiguration: listener => { listeners.push(listener); return disposable(); } },
    debug: { registerDebugConfigurationProvider: (type, provider) => { providers.set(type, provider); return disposable(); } },
    window: { showErrorMessage: async message => { errors.push(message); }, showInformationMessage: message => { notices.push(message); } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    process: { ...process, env }, setTimeout, clearTimeout });
  const context = { subscriptions: [], globalStorageUri: { fsPath: directory }, environmentVariableCollection: collection };
  await module.exports.activateNodeRuntime(context);
  t.after(() => { for (const subscription of context.subscriptions) subscription.dispose(); });
  const change = () => listeners.forEach(listener => listener({ affectsConfiguration: key => key === 'studio.project.nodePath' }));
  return { directory, local, configuration, commands, providers, collection, errors, notices, change };
}

test('public runtime does not override terminal, task or debug defaults', async t => {
  const h = await host(t);
  assert.equal(h.collection.mutations.length, 0);
  assert.equal(await h.commands.get('studio.internalResolveNodeTask')(), undefined);
  const config = { request: 'launch', program: 'index.js' };
  assert.equal(await h.providers.get('node').resolveDebugConfigurationWithSubstitutedVariables(undefined, config), config);
});

test('local changes update new terminal/task/debug environments and preserve explicit debug runtimes', async t => {
  const h = await host(t);
  h.configuration.nodePath = h.local; h.change();
  const status = await h.commands.get('studio.internalGetNodeRuntime')();
  assert.equal(status.source, 'local'); assert.equal(status.path, h.local); assert.equal(status.version, process.version);
  // The status command and terminal update share the same cached resolution.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.collection.persistent, false);
  assert.equal(h.collection.mutations[0][0], 'PATH');
  assert.equal(h.collection.mutations[0][2].applyAtShellIntegration, true);
  assert.equal(h.notices.length, 1);
  const task = await h.commands.get('studio.internalResolveNodeTask')();
  assert.equal(task.nodePath, h.local);
  await assert.rejects(h.commands.get('studio.internalResolveNodeTask')('npm'), /has no package manager/);
  for (const provider of h.providers.values()) {
    const config = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'launch', program: 'index.js', env: { CUSTOM: 'retained' } });
    const result = await execute(config.runtimeExecutable, ['-p', 'JSON.stringify({node:process.execPath,custom:process.env.CUSTOM})'], { env: config.env });
    assert.deepEqual(JSON.parse(result.stdout), { node: h.local, custom: 'retained' });
    for (const explicit of [{ request: 'launch', runtimeExecutable: '/custom/node' }, { request: 'launch', runtimeVersion: '20' }, { request: 'attach' }]) {
      assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, explicit), explicit);
    }
  }
  h.configuration.nodePath = path.join(h.directory, 'missing'); h.change();
  assert.match((await h.commands.get('studio.internalGetNodeRuntime')()).error, /Cannot run Node/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.collection.mutations.length, 0); assert.equal(h.errors.length, 1);
});

test('zsh shell integration restores the selected Node after an nvm-style startup override', { skip: process.platform !== 'darwin' }, async t => {
  const h = await host(t), other = path.join(h.directory, 'nvm-bin'), user = path.join(h.directory, 'user');
  await mkdir(other); await mkdir(user);
  await writeFile(path.join(other, 'node'), '#!/bin/sh\necho wrong-nvm-node\n', { mode: 0o755 });
  await writeFile(path.join(user, '.zshrc'), 'export PATH="$NVM_TEST_BIN:/usr/bin:/bin"\n');
  const script = path.resolve('upstream/vscode/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh');
  const result = await execute('/bin/zsh', ['-f', '-c', 'setopt RCS; source "$INTEGRATION_SCRIPT" >/dev/null; node -p process.execPath'], {
    env: { PATH: '/usr/bin:/bin', USER_ZDOTDIR: user, ZDOTDIR: user, NVM_TEST_BIN: other, VSCODE_INJECTION: '1',
      INTEGRATION_SCRIPT: script, VSCODE_ENV_PREPEND: `PATH=${path.dirname(h.local)}\\x3a` },
  });
  assert.equal(result.stdout.trim(), h.local);
});
