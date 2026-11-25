import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const source = new URL('../extensions/studio-workstation/src/', import.meta.url);
const { outputFiles } = await build({ stdin: { contents: `
  export { createBotCredentialListReader } from './bot-credential-list';
  export { resolveBotCredentialNamespace } from './bot-credential-vault';
`, resolveDir: fileURLToPath(source), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json');" },
  plugins: [{ name: 'credentials-list-vscode', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const wrap = url => ({ scheme: url.protocol.slice(0, -1), authority: url.host, query: url.search, fragment: url.hash,
        get fsPath() { return fileURLToPath(url); }, toString: () => url.href });
      export const Uri = { parse: value => wrap(new URL(value)), file: value => wrap(pathToFileURL(value)) };
      export const workspace = { get isTrusted() { return globalThis.credentialListFixture.trusted; } };
      export const env = { uiKind: 1, get remoteName() { return globalThis.credentialListFixture.remoteName; } }, UIKind = { Desktop: 1 };
      export const window = {}, CancellationTokenSource = class {};
      export const commands = { executeCommand: (...args) => globalThis.credentialListFixture.command(...args) };
    ` }));
  } }] });
const { createBotCredentialListReader, resolveBotCredentialNamespace } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const assistantId = 'a3aca697-b086-459b-84e4-d357ad2d9fb2';
const uri = directory => pathToFileURL(directory).href;

async function writeProject(directory, id, entries = { main: 'bot' }) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ id, name: 'Credential fixture', version: '0.1.0', defaultEntry: 'main',
    entries: Object.keys(entries).map(root => ({ entryId: root, root })) }));
  for (const [root, type] of Object.entries(entries)) {
    await mkdir(path.join(directory, root));
    await writeFile(path.join(directory, root, 'steamharness.json'), JSON.stringify({ type, name: root, entry: 'index.ts', ...(type === 'bot' && { folderContext: true }) }));
  }
}

test('project details reads only the per-entry credential index for original Bots, the built-in release and folder instances', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-credential-list-')));
  t.after(async () => { delete globalThis.credentialListFixture; await rm(root, { recursive: true, force: true }); });
  const profile = path.join(root, 'profile'), source = path.join(root, 'source'), release = path.join(root, 'release'), other = path.join(root, 'other');
  const projectId = randomUUID(), fragment = { instanceId: randomUUID(), directory: path.join(root, 'workdir'), projectId, entryId: 'main', projectDirectory: source, name: 'Copy' };
  const managed = new Map([[uri(path.join(root, 'copy.code-workspace')), fragment],
    [uri(path.join(root, 'copy-2.code-workspace')), { ...fragment, instanceId: randomUUID() }]]);
  await writeProject(source, projectId, { main: 'bot', review: 'bot', deploy: 'workflow' });
  await writeProject(other, projectId);
  await writeProject(release, assistantId, { main: 'bot', 'studio-control': 'workflow' });
  await mkdir(fragment.directory);

  const controller = new AbortController(), keys = ['some-other-vault:test'];
  let reads = 0, protectedStorage = true, deniedDirectory;
  globalThis.credentialListFixture = { trusted: true, command: async (command, target, interactive) => {
    if (command === 'studio.internalCanPersistBotCredentials') return protectedStorage;
    assert.equal(command, 'studio.internalSidebarProjectTrust');
    assert.equal(interactive, false);
    return target !== deniedDirectory;
  } };
  const context = { globalStorageUri: { fsPath: profile }, secrets: { keys: async () => { reads++; return keys; },
    get: () => assert.fail('The listing must not read a secret value'), store: () => assert.fail('The listing must not write'), delete: () => assert.fail('The listing must not delete') } };
  const reader = createBotCredentialListReader(context, { signal: controller.signal, isBuiltinProjectDirectory: directory => directory === release,
    localAssistantDirectory: async () => release, resolveManaged: async target => managed.get(target) });
  const add = async (scope, ...records) => {
    const prefix = await resolveBotCredentialNamespace(profile, scope);
    keys.push(...records.map(record => prefix + record));
  };
  const main = { projectId, entryId: 'main', projectDirectory: source };
  assert.deepEqual(await reader({ uri: uri(source), projectId }), { status: 'ok', rows: [] });
  await add(main, 'password:zebra', 'structured:alpha', 'api-key:alpha', 'access-key-pair:legacy', 'password:unexpected:trailer', 'unknown:invalid');
  await add({ ...main, entryId: 'review' }, 'password:review-only');
  await add({ ...main, projectDirectory: other }, 'password:other-directory');
  await add({ ...main, instanceId: fragment.instanceId, workdir: fragment.directory }, 'ssh-private-key:copy-only');
  await add({ projectId: assistantId, entryId: 'main', projectDirectory: release, workdir: release }, 'structured:assistant-own-scope');
  await add({ projectId: assistantId, entryId: 'main', projectDirectory: release }, 'password:wrong-workdir');
  const selected = await reader({ uri: uri(source), projectId, entryId: 'main' });
  assert.deepEqual(selected, { status: 'ok', rows: [
    { name: 'alpha', type: 'API key or token' }, { name: 'alpha', type: 'Structured credential' },
    { name: 'legacy', type: 'Access key pair' }, { name: 'zebra', type: 'Password' },
  ] });
  assert.deepEqual(await reader({ uri: uri(source), projectId, entryId: 'review' }), { status: 'ok', rows: [{ name: 'review-only', type: 'Password' }] });
  assert.deepEqual(await reader({ uri: uri(release), projectId: assistantId, entryId: 'main' }), { status: 'ok', rows: [{ name: 'assistant-own-scope', type: 'Structured credential' }] });
  assert.deepEqual(await reader({ uri: uri(path.join(root, 'copy.code-workspace')), entryId: 'main' }), { status: 'ok', rows: [{ name: 'copy-only', type: 'SSH private key' }] });
  assert.deepEqual(await reader({ uri: uri(path.join(root, 'copy-2.code-workspace')), entryId: 'main' }), { status: 'ok', rows: [] });

  const before = reads;
  for (const target of [{ uri: uri(source), entryId: 'deploy' }, { uri: uri(source), entryId: 'missing' }, { uri: uri(source), projectId: randomUUID() },
    { uri: uri(path.join(root, 'unknown.code-workspace')) }, { uri: uri(path.join(root, 'copy.code-workspace')), entryId: 'review' }, { uri: 'https://example.test/a' }]) {
    assert.deepEqual(await reader(target), { status: 'unavailable' });
  }
  deniedDirectory = uri(fragment.directory);
  assert.deepEqual(await reader({ uri: uri(path.join(root, 'copy.code-workspace')), entryId: 'main' }), { status: 'untrusted' });
  globalThis.credentialListFixture.trusted = false;
  assert.deepEqual(await reader({ uri: uri(source) }), { status: 'untrusted' });
  globalThis.credentialListFixture.trusted = true;
  globalThis.credentialListFixture.remoteName = 'ssh-remote';
  assert.deepEqual(await reader({ uri: uri(source) }), { status: 'unavailable' });
  globalThis.credentialListFixture.remoteName = undefined;
  protectedStorage = false;
  assert.deepEqual(await reader({ uri: uri(source) }), { status: 'unavailable' });
  protectedStorage = true;
  controller.abort();
  assert.deepEqual(await reader({ uri: uri(source) }), { status: 'unavailable' });
  assert.equal(reads, before);
});
