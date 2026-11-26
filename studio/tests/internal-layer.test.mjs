import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

async function fixture(t, source, env = { uiKind: 1 }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-layer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });
  delete process.env.STEAMHARNESS_STUDIO_INTERNAL;
  delete process.env.STEAMHARNESS_STUDIO_INTERNAL_MODULE;
  delete process.env.STEAMHARNESS_STUDIO_NODE_RUNTIME;
  if (source) {
    const layer = path.join(directory, 'layer.mjs');
    await writeFile(layer, source);
    process.env.STEAMHARNESS_STUDIO_INTERNAL = '1';
    process.env.STEAMHARNESS_STUDIO_INTERNAL_MODULE = pathToFileURL(layer).href;
  }
  const entry = path.resolve('extensions/studio-workstation/src/extension-node.ts');
  const stubs = {
    './localization-host': '',
    './extension': 'export function activate() { return process.env.STEAMHARNESS_STUDIO_NODE_RUNTIME; }',
    './workflow-runtime-node': 'export function createProjectRuntime() { return {}; }',
    './workflow-auth': 'export async function activateProjectAccount(context, ...options) { context.usesLocalSessions = !!options.at(-1); return {}; }',
    './user-models-node': 'export function withUserModelWriteLock() {}',
    './node-runtime-host': `export async function activateNodeRuntime() {
      if (process.env.STEAMHARNESS_STUDIO_INTERNAL === '1' && process.env.STEAMHARNESS_STUDIO_NODE_RUNTIME !== 'prepared') throw new Error('Runtime resolved before preparation');
    }`,
  };
  const outfile = path.join(directory, 'entry.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', plugins: [{
    name: 'host-fixture', setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
      builder.onResolve({ filter: /^\.\// }, args => {
        if (args.path === './project-upload-extension') return { path: 'uploads', namespace: 'fixture' };
        if (args.importer === entry && args.path in stubs) return { path: args.path, namespace: 'fixture' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'uploads'
        ? 'export function registerProjectUploadProvider() {}' : args.path === 'vscode'
          ? `export const env = ${JSON.stringify(env)}; export const UIKind = { Desktop: 1 }; export class EventEmitter {} export const commands = {};`
          : stubs[args.path] ?? '' }));
    },
  }] });
  return { directory, host: await import(pathToFileURL(outfile).href) };
}

test('optional layer preparation completes before desktop runtime initialization', async t => {
  const { host } = await fixture(t, `export async function prepare() { await Promise.resolve(); process.env.STEAMHARNESS_STUDIO_NODE_RUNTIME = 'prepared'; }`);
  assert.equal(await host.activate({}), 'prepared');
});

test('public desktop initialization stays independent of optional layers and bundled Node', async t => {
  const { host } = await fixture(t);
  assert.equal(await host.activate({}), undefined);
  assert.equal(process.env.STEAMHARNESS_STUDIO_NODE_RUNTIME, undefined);
});

for (const [label, env, expectLocal] of [
  ['local desktop', { uiKind: 1 }, true],
  ['browser with Node host', { uiKind: 2 }, false],
  ['remote desktop workspace', { uiKind: 1, remoteName: 'ssh-remote' }, false],
]) {
  test(`${label} uses the expected account session backend`, async t => {
    const { host, directory } = await fixture(t, 'export const platform = true; export function prepare() { process.env.STEAMHARNESS_STUDIO_NODE_RUNTIME = "prepared"; }', env);
    const context = { globalStorageUri: { scheme: 'vscode-userdata', fsPath: directory }, subscriptions: [] };
    await host.activate(context);
    assert.equal(context.usesLocalSessions, expectLocal);
  });
}

test('a failing layer preparation cannot silently start projects with the host runtime', async t => {
  const { host } = await fixture(t, `export async function prepare() { throw new Error('Runtime preparation failed'); }`);
  await assert.rejects(host.activate({}), /Runtime preparation failed/);
});
