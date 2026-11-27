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
  export { createBotCredentialTargetResolver } from './bot-credential-list';
  export { registerWebBotCredentialManagement } from './bot-credential-management';
  export { resolveBotCredentialNamespace } from './bot-credential-vault';
`, resolveDir: fileURLToPath(source), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json');" },
  plugins: [{ name: 'credential-management-vscode', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const wrap = url => ({ scheme: url.protocol.slice(0, -1), authority: url.host, query: url.search, fragment: url.hash,
        get fsPath() { return fileURLToPath(url); }, toString: () => url.href });
      export const Uri = { parse: value => wrap(new URL(value)), file: value => wrap(pathToFileURL(value)) };
      export const workspace = { get isTrusted() { return globalThis.credentialManagementFixture.trusted; } };
      export const env = { uiKind: 1 }, UIKind = { Desktop: 1 };
      export const commands = { executeCommand: (...args) => globalThis.credentialManagementFixture.command(...args),
        registerCommand: (...args) => globalThis.credentialManagementFixture.register(...args) };
    ` }));
  } }] });
const { createBotCredentialTargetResolver, registerWebBotCredentialManagement, resolveBotCredentialNamespace } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const assistantId = 'a3aca697-b086-459b-84e4-d357ad2d9fb2';
const uri = directory => pathToFileURL(directory).href;

async function writeProject(directory, id, entries) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ id, name: 'Credential fixture', version: '0.1.0', defaultEntry: 'main',
    entries: Object.entries(entries).map(([entryId, type]) => ({ entryId, type, root: '.', name: entryId, entry: `${entryId}.ts`, ...(type === 'bot' && { folderContext: true }) })) }));
}

test('project details resolves the vault scope of the selected Bot, including standalone Assistant and folder Bot instances', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-credential-target-')));
  t.after(async () => { delete globalThis.credentialManagementFixture; await rm(root, { recursive: true, force: true }); });
  const profile = path.join(root, 'profile'), source = path.join(root, 'source'), release = path.join(root, 'release');
  const projectId = randomUUID(), fragment = { instanceId: randomUUID(), directory: path.join(root, 'workdir'), projectId, entryId: 'main', projectDirectory: source, name: 'Copy' };
  const copy = uri(path.join(root, 'copy.code-workspace')), second = uri(path.join(root, 'copy-2.code-workspace'));
  const managed = new Map([[copy, fragment], [second, { ...fragment, instanceId: randomUUID() }]]);
  await writeProject(source, projectId, { main: 'bot', review: 'bot', deploy: 'workflow' });
  await writeProject(release, assistantId, { main: 'bot', 'studio-control': 'workflow' });
  await mkdir(fragment.directory);
  let deniedDirectory;
  globalThis.credentialManagementFixture = { trusted: true };
  const resolve = createBotCredentialTargetResolver({ isBuiltinProjectDirectory: directory => directory === release,
    localAssistantDirectory: async () => release, resolveManaged: async target => managed.get(target), trusted: async directory => directory !== deniedDirectory });
  const main = { projectId, entryId: 'main', projectDirectory: source };
  const selected = await resolve({ uri: uri(source), projectId, entryId: 'main' });
  const signature = await resolveBotCredentialNamespace(profile, main);
  assert.equal(await resolveBotCredentialNamespace(profile, selected.scope), signature);
  assert.equal(await selected.recheck(), true);
  assert.notEqual(await resolveBotCredentialNamespace(profile, (await resolve({ uri: uri(source), projectId, entryId: 'review' })).scope), signature);
  assert.equal((await resolve({ uri: uri(release), projectId: assistantId, entryId: 'main' })).scope.workdir, release);
  const instance = await resolve({ uri: copy, entryId: 'main' });
  assert.deepEqual(instance.scope, { ...main, instanceId: fragment.instanceId, workdir: fragment.directory });
  assert.notEqual((await resolve({ uri: second })).scope.instanceId, instance.scope.instanceId);
  for (const target of [{ uri: uri(source), entryId: 'deploy' }, { uri: uri(source), entryId: 'missing' }, { uri: uri(source), projectId: randomUUID() },
    { uri: uri(path.join(root, 'unknown.code-workspace')) }, { uri: copy, entryId: 'review' }, { uri: 'https://example.test/a' }]) {
    assert.equal(await resolve(target), undefined);
  }
  deniedDirectory = fragment.directory;
  assert.equal(await instance.recheck(), false);
  assert.equal(await resolve({ uri: copy, entryId: 'main' }), 'untrusted');
  globalThis.credentialManagementFixture.trusted = false;
  assert.equal(await resolve({ uri: uri(source) }), 'untrusted');
});

test('the browser vault receives only an authorized prefix and rejects stale account, view and trust boundaries', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-web-credential-')));
  const subscriptions = [], commands = new Map(), shown = [], dismissed = [];
  t.after(async () => { subscriptions.forEach(value => value.dispose()); delete globalThis.credentialManagementFixture; await rm(root, { recursive: true, force: true }); });
  let owner = 'owner-a', trusted = true;
  globalThis.credentialManagementFixture = { trusted: true, register: (name, handler) => {
    commands.set(name, handler); return { dispose() { commands.delete(name); } };
  }, command: async (name, ...args) => {
    if (name === 'studio.internalCanPersistWebBotCredentials') return true;
    if (name === 'studio.internalShowWebBotCredentials') { shown.push(args); return; }
    if (name === 'studio.internalDismissWebBotCredentials') { dismissed.push(args[0]); return; }
    assert.fail(`Unexpected command: ${name}`);
  } };
  const scope = { projectId: randomUUID(), projectDirectory: root, entryId: 'main' };
  const open = registerWebBotCredentialManagement({ globalStorageUri: { fsPath: root }, subscriptions }, () => owner);
  const target = { scope, name: 'Fixture Bot', recheck: async () => trusted };
  const controller = new AbortController();
  await open(target, owner, controller.signal);
  const [id, title] = shown[0]; assert.equal(title, target.name);
  const authorize = (ticket = id) => commands.get('studio.internalWebBotCredentialScope')(ticket);
  assert.equal(await authorize('unissued'), undefined);
  const first = await authorize();
  assert.match(first, /^web-bot-credentials:v1:[a-f0-9]{64}:$/);
  assert.notEqual(first, await resolveBotCredentialNamespace(root, scope));
  trusted = false;
  assert.equal(await authorize(), undefined);
  trusted = true;
  owner = 'owner-b';
  assert.equal(await authorize(), undefined);
  await open(target, owner, new AbortController().signal);
  assert.notEqual(await authorize(shown.at(-1)[0]), first);
  owner = 'owner-a';
  await open(target, owner, controller.signal);
  const current = shown.at(-1)[0];
  assert.equal(await authorize(current), first);
  controller.abort();
  assert.deepEqual(dismissed, [current]);
  assert.equal(await authorize(current), undefined);
});
