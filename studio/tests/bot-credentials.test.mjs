import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildStudioNode as build } from '../scripts/node-extension-build.mjs';

const source = new URL('../extensions/studio-workstation/src/bot-credential-vault.ts', import.meta.url);
const { outputFiles } = await build({ entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm', platform: 'node', write: false });
const { botCredentialNamespace, resolveBotCredentialNamespaces, createBotCredentialVault, describeBotCredential, parseBotCredentialAction, parseStructuredCredential, readPickedSshKey } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

function memoryStore(values) {
  return { async keys() { return [...values.keys()]; }, async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
}

test('the native store isolates entries, projects, assistants, and folder Bot instances, with explicit rotation and deletion', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-vault-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = new Map(), storage = memoryStore(values);
  let protectedStorage = true;
  const vault = (entry = 'main', instance, folder, sourcePath = path.join(root, 'project')) => createBotCredentialVault(storage, root, botCredentialNamespace(root, 'project-id', entry, sourcePath, instance, folder), async () => protectedStorage);
  const slot = { name: 'deploy', kind: 'api-key' };
  const editor = vault();
  assert.equal((await editor.write(slot, 'fixture-first')).status, 'saved');
  assert.equal((await editor.write(slot, 'fixture-unapproved-overwrite')).status, 'existing');
  assert.deepEqual([...values.values()], ['fixture-first']);
  const bound = path.join(root, 'target');
  for (const other of [vault('other'), vault('main', 'copy-1', bound), vault('main', 'copy-2', bound), vault('main', undefined, bound), vault('main', undefined, undefined, path.join(root, 'other-project'))]) {
    assert.deepEqual(await other.list(), []);
    assert.equal(await other.inspect(slot), 'missing');
  }
  assert.deepEqual(await vault().list(), [slot]);
  const { revision } = await editor.snapshot(slot);
  await editor.write(slot, 'fixture-rotated', revision);
  assert.deepEqual([...values.values()], ['fixture-rotated']);
  await assert.rejects(editor.remove(slot, undefined, revision), { code: 'BOT_CREDENTIAL_CHANGED' });
  const cancelled = AbortSignal.abort();
  await assert.rejects(editor.write(slot, 'fixture-cancelled', revision, cancelled), { name: 'AbortError' });
  protectedStorage = false;
  await assert.rejects(editor.write(slot, 'fixture-unprotected', revision), /unavailable/);
  assert.deepEqual([...values.values()], ['fixture-rotated']);
  protectedStorage = true;
  const unreadable = createBotCredentialVault({ ...storage, get: async () => undefined }, root, botCredentialNamespace(root, 'project-id', 'main', path.join(root, 'project')), async () => true);
  await assert.rejects(unreadable.write(slot, 'do-not-overwrite'), /Cannot read/);
  assert.deepEqual([...values.values()], ['fixture-rotated']);
  await vault().remove(slot); assert.equal(values.size, 0);
});

test('managed Assistant rebuilds share only their verified project and workspace credential scope', async t => {
  const profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-assistant-credentials-')));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const projectId = 'a3aca697-b086-459b-84e4-d357ad2d9fb2';
  const managed = path.join(profile, 'projects', projectId, 'builds');
  const old = path.join(managed, '1'.repeat(24), 'project'), next = path.join(managed, '2'.repeat(24), 'project');
  const lookalike = path.join(managed, '3'.repeat(24), 'project'), external = path.join(profile, 'external-assistant');
  const workspaces = [path.join(profile, 'workspace-a'), path.join(profile, 'workspace-b')];
  for (const directory of [old, next, lookalike, external, ...workspaces]) await mkdir(directory, { recursive: true });
  for (const directory of [old, next, external]) await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ id: projectId }));
  await writeFile(path.join(lookalike, 'steamharness.json'), JSON.stringify({ id: randomUUID() }));
  const values = new Map(), store = memoryStore(values), allow = async () => true;
  const slot = { name: 'gitlab-fixture', kind: 'api-key' };
  const legacy = (directory, workdir) => botCredentialNamespace(profile, projectId, 'main', directory, undefined, workdir);
  const primary = (projectDirectory, workdir) => resolveBotCredentialNamespaces(profile, { projectId, entryId: 'main', projectDirectory, workdir });
  await createBotCredentialVault(store, profile, await primary(old, old), allow).write(slot, 'fixture-only-token');
  await createBotCredentialVault(store, profile, legacy(lookalike, lookalike), allow).write({ ...slot, name: 'other-project' }, 'fixture-other');
  await createBotCredentialVault(store, profile, await primary(old, workspaces[0]), allow).write({ ...slot, name: 'workspace-only' }, 'fixture-workspace');
  const scope = { projectId, entryId: 'main', projectDirectory: next, workdir: next };
  const namespaces = await resolveBotCredentialNamespaces(profile, scope);
  assert.equal(namespaces[0], (await resolveBotCredentialNamespaces(profile, { ...scope, projectDirectory: old, workdir: old }))[0]);
  const vault = createBotCredentialVault(store, profile, namespaces, allow);
  const listOnly = createBotCredentialVault({ ...store, get: () => assert.fail('Listing must not read any value') }, profile, namespaces, allow);
  assert.deepEqual(await listOnly.list(), [slot]);
  assert.equal(await vault.readForUse(slot, new AbortController().signal), 'fixture-only-token');
  assert.equal((await vault.write(slot, 'not-an-overwrite')).status, 'existing');
  for (const other of [{ ...scope, entryId: 'other' }, { ...scope, instanceId: 'copy' },
    { ...scope, workdir: workspaces[1] }, { ...scope, projectDirectory: external, workdir: external }]) {
    assert.deepEqual(await createBotCredentialVault(store, profile, await resolveBotCredentialNamespaces(profile, other), allow).list(), []);
  }
  assert.deepEqual(await createBotCredentialVault(store, profile,
    await resolveBotCredentialNamespaces(profile, { ...scope, workdir: workspaces[0] }), allow).list(), [{ ...slot, name: 'workspace-only' }]);
  assert.equal((await vault.write(slot, 'fixture-rotation', (await vault.snapshot(slot)).revision)).status, 'saved');
  assert.equal(values.has(`${legacy(old, old)}api-key:${slot.name}`), false);
  assert.equal(await vault.readForUse(slot, new AbortController().signal), 'fixture-rotation');
  await vault.remove(slot);
  assert.deepEqual(await vault.list(), []);
});

test('concurrent vault writes wait without overwriting; a cancelled waiter never edits storage', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-vault-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = new Map(), storage = memoryStore(values), prefix = botCredentialNamespace(root, 'fixture-project', 'main', root);
  const acquired = Promise.withResolvers(), release = Promise.withResolvers();
  const first = createBotCredentialVault({ ...storage, async store(key, value) { acquired.resolve(); await release.promise; await storage.store(key, value); } }, root, prefix, async () => true);
  const second = createBotCredentialVault(storage, root, prefix, async () => true);
  const slot = { name: 'shared-fixture', kind: 'api-key' };
  const writing = first.write(slot, 'first-fixture');
  try {
    await acquired.promise;
    const concurrent = second.write(slot, 'second-fixture');
    const showedNoError = assert.doesNotReject(concurrent);
    const abort = new AbortController();
    const cancelled = assert.rejects(second.remove(slot, abort.signal), { name: 'AbortError' });
    await tick();
    abort.abort();
    await cancelled;
    release.resolve();
    await showedNoError;
    assert.deepEqual(await concurrent, { status: 'existing', structure: { format: 'hidden' } });
    assert.deepEqual([...values.values()], ['first-fixture']);
  } finally { release.resolve(); await writing; }
});

test('SSH capture checks file safety and size but defers key format checks until use', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-vault-ssh-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture');
  const fixture = '-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZQ==\n-----END OPENSSH PRIVATE KEY-----\n';
  await writeFile(file, fixture);
  assert.equal(await readPickedSshKey(file), fixture);
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'symlink'); await symlink(file, alias);
    await assert.rejects(readPickedSshKey(alias));
  }
  await writeFile(file, 'x');
  const values = new Map(), prefix = botCredentialNamespace(root, 'fixture-project', 'main', root);
  const vault = createBotCredentialVault(memoryStore(values), root, prefix, async () => true);
  const slot = { name: 'deploy', kind: 'ssh-private-key' };
  assert.equal((await vault.write(slot, await readPickedSshKey(file))).status, 'saved');
  assert.equal(await vault.readForUse(slot, new AbortController().signal), null);
  await assert.rejects(readPickedSshKey(root), /Invalid Bot credential/);
  await writeFile(file, Buffer.alloc(65537));
  await assert.rejects(readPickedSshKey(file), { code: 'BOT_CREDENTIAL_TOO_LARGE' });
  const host = { type: 'bot-credential-request', id: 'id', entryId: 'agent', action: 'capture', slot };
  assert.deepEqual(parseBotCredentialAction(host), { action: 'capture', slot });
  for (const input of [{ ...host, file }, { ...host, value: fixture }, { ...host, slot: { ...slot, name: '../other' } }]) assert.equal(parseBotCredentialAction(input), undefined);
});

test('structured credentials preserve arbitrary input and expose a bounded value-free shape', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-vault-pair-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = new Map(), prefix = botCredentialNamespace(root, 'project-id', 'main', root);
  const vault = createBotCredentialVault(memoryStore(values), root, prefix, async () => true);
  const slot = { name: 'fixture-sso', kind: 'structured', fields: ['tenant', 'client-id', 'client.secret'] };
  const first = { tenant: 'fixture-tenant', 'client-id': 'fixture-id', 'client.secret': 'fixture-secret' };
  const varied = [
    '{"tenant":', '{}', JSON.stringify({ tenant: first.tenant }),
    JSON.stringify({ ...first, tenant: 123 }), JSON.stringify({ ...first, 'client.secret': ' ' }),
    JSON.stringify({ ...first, 'client.secret': 'broken\nvalue' }), JSON.stringify({ ...first, extra: 'extra' }), JSON.stringify([first]),
    JSON.stringify({ ...first, 'client.secret': 'x'.repeat(16 * 1024) }), 'x', '',
  ];
  const capture = { type: 'bot-credential-request', action: 'capture', slot };
  assert.deepEqual(parseBotCredentialAction(capture), { action: 'capture', slot });
  for (const fields of [['tenant', 'tenant'], ['__proto__'], ['constructor'], [{ name: 'secret', value: 'fixture-value' }], { tenant: 'fixture-value' }, ['secret\n']]) {
    assert.equal(parseBotCredentialAction({ ...capture, slot: { ...slot, fields } }), undefined);
  }
  assert.equal(parseBotCredentialAction({ ...capture, slot: { ...slot, kind: 'api-key' } }), undefined);
  for (const value of varied) {
    assert.equal((await vault.write(slot, value)).status, 'saved');
    assert.deepEqual([...values.values()], [value]);
    await vault.remove(slot);
  }
  assert.equal(values.size, 0);
  assert.equal((await vault.write(slot, JSON.stringify(first))).status, 'saved');
  assert.deepEqual(await vault.list(), [{ name: slot.name, kind: slot.kind }]);
  assert.equal(values.size, 1);
  const next = { ...first, 'client.secret': 'next-fixture-secret' };
  assert.equal(await vault.inspect({ ...slot, fields: [...slot.fields].reverse() }), 'existing');
  assert.equal(await vault.inspect({ ...slot, fields: ['user', 'password'] }), 'existing');
  const { structure, revision } = await vault.snapshot(slot);
  assert.deepEqual(await vault.write({ ...slot, fields: ['token'] }, '{"token":"fixture-another"}'), { status: 'existing', structure });
  assert.equal((await vault.write(slot, JSON.stringify(next))).status, 'existing');
  await assert.rejects(vault.write(slot, 'x'.repeat(65_537), revision), { code: 'BOT_CREDENTIAL_TOO_LARGE' });
  assert.deepEqual([...values.values()].map(value => JSON.parse(value)), [first]);
  assert.equal((await vault.write(slot, JSON.stringify(next), revision)).status, 'saved');
  assert.deepEqual([...values.values()].map(value => JSON.parse(value)), [next]);
  await vault.remove(slot);
  assert.deepEqual(await vault.list(), []);
  const untyped = { name: 'fixture-document', kind: 'structured' };
  const pair = { AccessKeyId: 'fixture-id', AccessKeySecret: 'fixture-secret' };
  assert.equal((await vault.write(untyped, JSON.stringify(pair))).status, 'saved');
  assert.deepEqual([...values.values()].map(value => JSON.parse(value)), [pair]);
  assert.equal(parseStructuredCredential('{"__proto__":"invalid"}'), undefined);
  assert.equal(parseStructuredCredential('{"token":{"nested":"unsupported"}}'), undefined);
  assert.deepEqual(parseStructuredCredential('{"name":"fixture","other":123,"empty":" ","control":"bad\\r\\ntext"}'), { name: 'fixture' });
  const oversizedShape = JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`field-${index}`, 'fixture'])));
  assert.equal(describeBotCredential(untyped, oversizedShape).fields.length, 16);
  assert.equal(describeBotCredential(untyped, oversizedShape).partial, true);
  assert.deepEqual(describeBotCredential(untyped, 'q'), { format: 'hidden' });
  const mixed = '{"accessKeyId":" fixture-id","AccessKeySecret":"fixture-secret","Extra":{"secret-inner":"hidden-inner"},"other":9,"fixture-secret":true,"__proto__":"test"}';
  const description = describeBotCredential(untyped, mixed);
  assert.deepEqual(description, { format: 'object', fields: [
    { name: 'accessKeyId', type: 'string' }, { name: 'AccessKeySecret', type: 'string' }, { name: 'Extra', type: 'object' }, { name: 'other', type: 'number' },
  ], partial: true });
  assert.doesNotMatch(JSON.stringify(description), /fixture-id|fixture-secret|secret-inner|hidden-inner/);
  const deep = '{"AccessKeyId":" fixture-id", "nested":' + '['.repeat(8000) + '{"child":"  nested-fixture  ","n":73529}' + ']'.repeat(8000) + ',"prefix-nested-fixture":null,"73529":0}';
  const safe = { format: 'object', fields: [{ name: 'AccessKeyId', type: 'string' }, { name: 'nested', type: 'array' }], partial: true };
  assert.deepEqual(describeBotCredential(untyped, deep), safe);
  assert.deepEqual(describeBotCredential(untyped, '{"fixture":["fixture"]}'), { format: 'hidden' });
  assert.deepEqual(describeBotCredential(untyped, '{"accessKeyId":"a","a":0}'),
    { format: 'object', fields: [{ name: 'accessKeyId', type: 'string' }], partial: true });
  await vault.remove(untyped);
  // Old entries stay in the original key space. Only the user can replace or delete them.
  const legacy = { name: 'fixture-legacy', kind: 'access-key-pair' };
  const legacyKey = `${prefix}${legacy.kind}:${legacy.name}`;
  values.set(legacyKey, JSON.stringify(pair));
  assert.deepEqual(await vault.list(), [legacy]);
  const signal = new AbortController().signal;
  assert.equal(await vault.readForUse({ ...legacy, kind: 'structured' }, signal), undefined);
  assert.deepEqual(await vault.readForUse(legacy, signal), pair);
  const sameAlias = { name: legacy.name, kind: 'structured' };
  await vault.write(sameAlias, '{"otherField":"fixture"}');
  assert.deepEqual(await vault.readForUse(sameAlias, signal), { otherField: 'fixture' });
  assert.deepEqual(await vault.readForUse(legacy, signal), pair);
  await vault.remove(sameAlias);
  assert.equal(values.size, 1, 'reading the legacy alias does not migrate it');
  assert.equal(parseBotCredentialAction({ ...capture, slot: legacy }), undefined);
  assert.equal((await vault.write(legacy, JSON.stringify({ ...pair, AccessKeySecret: 'rotated-fixture' }), (await vault.snapshot(legacy)).revision)).status, 'saved');
  assert.equal(JSON.parse(values.get(legacyKey)).AccessKeySecret, 'rotated-fixture');
  await vault.remove(legacy);
  assert.equal(values.size, 0);
});

function fixtureEvent() {
  const listeners = new Set();
  return {
    on(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

function fixtureInputBox(show) {
  const change = fixtureEvent(), accept = fixtureEvent(), hide = fixtureEvent();
  return {
    value: '',
    onDidChangeValue: change.on, onDidAccept: accept.on, onDidHide: hide.on,
    show() { show(this); },
    hide() { hide.emit(); },
    dispose() { this.disposed = true; this.hide(); },
    changeValue(value) { if (this.value !== value) { this.value = value; change.emit(value); } },
    accept() { accept.emit(); },
  };
}

test('native input accepts any shape, supports secure replacement, and checks usability only during use', { timeout: 8000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-vault-prompts-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = new URL('../extensions/studio-workstation/src/bot-credentials.ts', import.meta.url);
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(native)], bundle: true, format: 'esm', platform: 'node', write: false,
    banner: { js: "import { createRequire } from 'node:module'; const __dirname = process.cwd(); const require = createRequire(__dirname + '/package.json');" },
    plugins: [{ name: 'credentials-vscode', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const workspace = { isTrusted: true, getConfiguration: () => ({ inspect: () => ({ globalValue: globalThis.botCredentialTest.policy() }) }) }, UIKind = { Desktop: 1 }, env = { uiKind: 1 };
        export const commands = { executeCommand: () => true };
        export const CancellationTokenSource = globalThis.botCredentialTest.CancellationTokenSource;
        export const window = {
          createInputBox: () => globalThis.botCredentialTest.createInputBox(),
          showQuickPick: (items, options) => globalThis.botCredentialTest.pick(items, options),
          showWarningMessage: message => globalThis.botCredentialTest.warn(message),
        };
      ` }));
    } }] });
  const values = new Map(), prompts = [], warnings = [];
  let typed, onShow, duringQuery, approve = true, policy = 'workspace';
  const approvals = [], httpCalls = [];
  globalThis.botCredentialTest = { policy: () => policy, createInputBox: () => fixtureInputBox(input => {
    prompts.push(input);
    if (onShow) onShow(input);
    else { input.changeValue(typed); input.accept(); }
  }), CancellationTokenSource: class {
    event = fixtureEvent();
    token = { isCancellationRequested: false, onCancellationRequested: this.event.on };
    cancel() { this.token.isCancellationRequested = true; this.event.emit(); }
    dispose() {}
  },
    pick: (items, options) => { approvals.push({ items, options }); return approve === 'conversation' ? items[1] : approve ? items[0] : undefined; }, warn: message => warnings.push(message) };
  t.after(() => { prompts.at(-1)?.hide(); delete globalThis.botCredentialTest; });
  const { createBotCredentialInteraction } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
  const store = memoryStore(values);
  let reads = 0;
  const interaction = createBotCredentialInteraction({ globalStorageUri: { fsPath: root }, secrets: { ...store, get: key => { reads++; return store.get(key); } } },
    { https: async (use, credential) => {
      httpCalls.push({ use, credential });
      duringQuery?.();
      return { status: 'ok', data: use.url.endsWith('/echo') ? { echoed: credential } : { httpStatus: 200, body: { account: 'fixture-account' } } };
    }, ssh: () => assert.fail('Unexpected SSH use') });
  const capture = (slot, signal = new AbortController().signal) => interaction({ folderPath: root, id: 'fixture-project' }, 'main', 'Fixture Bot', { action: 'capture', slot }, signal);
  async function openCapture(slot, signal) {
    const shown = Promise.withResolvers();
    const result = capture(slot, signal);
    onShow = shown.resolve;
    try {
      const input = await Promise.race([shown.promise, result.then(status => assert.fail(`Credential input did not open: ${status}`))]);
      return { input, result };
    } finally { onShow = undefined; }
  }
  const slot = { name: 'fixture-sso', kind: 'structured', fields: ['tenant', 'clientId', 'clientSecret'] };
  typed = '{"tenant":"fixture-tenant","clientId":"fixture-id","clientSecret":"fixture-secret"}';
  const { input, result } = await openCapture(slot);
  assert.deepEqual(JSON.parse(input.placeholder), { tenant: '', clientId: '', clientSecret: '' });
  assert.equal(input.password, true);
  assert.equal(input.value, '');
  assert.equal(input.validationMessage, undefined);
  input.changeValue('{');
  input.changeValue('');
  assert.equal(input.validationMessage, undefined);
  const differentlyCased = '{"AccessKeyId":" fixture-id","AccessKeySecret":"fixture-secret"}';
  input.changeValue(differentlyCased);
  input.accept();
  const shape = { format: 'object', fields: [{ name: 'AccessKeyId', type: 'string' }, { name: 'AccessKeySecret', type: 'string' }] };
  assert.deepEqual(await result, { status: 'saved', structure: shape });
  assert.equal(input.disposed, true);
  assert.deepEqual(await capture({ ...slot, fields: ['unrelated'] }), { status: 'existing', structure: shape });
  assert.equal(prompts.length, 1);
  assert.deepEqual([...values.values()], [differentlyCased]);
  const replacement = await openCapture({ ...slot, replace: true });
  assert.match(replacement.input.title, /Replace the saved credential/);
  assert.equal(replacement.input.value, '', 'do not prefill old secret');
  replacement.input.changeValue(typed); replacement.input.accept();
  assert.equal((await replacement.result).status, 'saved');
  typed = 'x';
  assert.deepEqual(await capture({ name: 'fixture-unspecified', kind: 'structured' }), { status: 'saved', structure: { format: 'hidden' } });
  assert.deepEqual(JSON.parse(prompts[2].placeholder), { field: '' });
  assert.equal(values.size, 2);
  assert.equal(warnings.length, 0);

  const abort = new AbortController();
  const cancelled = await openCapture({ ...slot, replace: true }, abort.signal);
  const previous = [...values.values()];
  cancelled.input.changeValue('will not replace');
  abort.abort();
  assert.equal(await cancelled.result, 'declined');
  assert.equal(cancelled.input.disposed, true);
  assert.deepEqual([...values.values()], previous);

  const race = { name: 'capture-race', kind: 'structured' };
  const competing = createBotCredentialVault(store, root, botCredentialNamespace(root, 'fixture-project', 'main', await realpath(root)), async () => true);
  const addition = await openCapture(race);
  const firstWriter = await competing.write(race, '{"firstField":"fixture-winner"}');
  addition.input.changeValue('{"otherField":"fixture-loser"}'); addition.input.accept();
  assert.deepEqual(await addition.result, { status: 'existing', structure: firstWriter.structure });
  const stale = await openCapture({ ...race, replace: true });
  const original = await competing.snapshot(race);
  await competing.write(race, '{"firstField":"fixture-rotated"}', original.revision);
  stale.input.changeValue('stale replacement'); stale.input.accept();
  assert.equal(await stale.result, 'declined');
  assert.deepEqual(await competing.readForUse(race, new AbortController().signal), { firstField: 'fixture-rotated' });
  const removed = await openCapture({ ...race, replace: true });
  await competing.remove(race);
  removed.input.changeValue('do not recreate'); removed.input.accept();
  assert.equal(await removed.result, 'declined');
  assert.equal(await competing.inspect(race), 'missing');
  assert.match(warnings.at(-1), /changed or was removed/);

  const parsed = parseBotCredentialAction({ type: 'bot-credential-request', id: 'id', entryId: 'main', action: 'use', use: {
    name: slot.name, connector: 'host', operation: 'https.get-json', args: {
      url: 'https://fixture.example.test/account', auth: { kind: 'structured', scheme: 'headers', headers: { 'X-Client': 'clientId', 'X-Secret': 'clientSecret' } },
    },
  } });
  assert.equal(parsed.action, 'use');
  const use = (entryId = 'main', instanceId, signal = new AbortController().signal) => interaction({ folderPath: root, id: 'fixture-project',
    ...(instanceId && { folderBot: { id: instanceId, directory: root } }) }, entryId, 'Fixture Bot', parsed, signal);
  const readsBeforeUse = reads;
  approve = false;
  assert.deepEqual(await use(), { status: 'declined' });
  assert.equal(reads, readsBeforeUse, 'declining never reads the vault');
  assert.equal(httpCalls.length, 0);
  assert.equal(approvals.at(-1).items[0].description, 'https://fixture.example.test/account');
  assert.equal(approvals.at(-1).items[0].label, 'Allow once');
  assert.match(approvals.at(-1).options.title, /fixture-sso.*Fixture Bot/);
  approve = true;
  assert.deepEqual(await use('other'), { status: 'missing' });
  assert.deepEqual(await use('main', 'another-instance'), { status: 'missing' });
  assert.equal(httpCalls.length, 0);
  const response = { status: 'ok', data: { httpStatus: 200, body: { account: 'fixture-account' } } };
  assert.deepEqual(await use(), response);
  assert.deepEqual(Object.keys(httpCalls[0].credential), ['tenant', 'clientId', 'clientSecret']);
  await use('main', undefined, AbortSignal.abort());
  assert.equal(httpCalls.length, 1);
  assert.equal(approvals.some(item => JSON.stringify(item).includes('fixture-secret')), false);

  const profile = new AbortController(), scopeId = randomUUID(), project = { folderPath: root, id: 'fixture-project' };
  const ask = (mode, { scope = scopeId, lifetime = profile.signal, entry = 'main', target = project, operation = parsed.use } = {}) => {
    const action = parseBotCredentialAction({ type: 'bot-credential-request', id: 'id', entryId: entry, action: 'use', use: operation, approval: mode === 'auto' ? { mode } : { scopeId: scope, mode } });
    assert.ok(action);
    return interaction(target, entry, 'Fixture Bot', action, lifetime, lifetime);
  };
  assert.equal(parseBotCredentialAction({ ...parsed, approval: { scopeId, mode: 'reuse', granted: true } }), undefined);
  const before = reads;
  assert.equal(await ask('reuse'), 'approval-required');
  assert.equal(reads, before, 'no matching authorization does not read the credential');
  assert.equal((await ask('prompt')).status, 'ok'); // Allow once
  assert.equal(await ask('reuse'), 'approval-required');
  approve = 'conversation';
  assert.equal((await ask('prompt')).status, 'ok');
  assert.deepEqual(approvals.at(-1).items.map(item => item.label), ['Allow once', 'Allow for this conversation']);
  const pickCount = approvals.length;
  assert.equal((await ask('reuse')).status, 'ok');
  assert.equal(approvals.length, pickCount, 'same conversation can reuse the exact approved request');
  const beforePolicyChange = reads;
  assert.equal(await ask('auto'), 'approval-required', 'workspace does not accept a silent auto-approval request');
  policy = 'read-only';
  for (const mode of ['auto', 'reuse', 'prompt']) assert.deepEqual(await ask(mode), { status: 'failed', reason: 'blocked-policy' });
  assert.equal(reads, beforePolicyChange, 'read-only never touches the vault even with an existing grant');
  policy = 'auto';
  assert.equal((await ask('auto')).status, 'ok');
  assert.equal(approvals.length, pickCount, 'matching auto approval needs no native prompt');
  const beforeMalformed = httpCalls.length;
  assert.deepEqual(await ask('auto', { operation: { ...parsed.use, name: 'fixture-unspecified' } }), { status: 'failed', reason: 'invalid-credential' });
  assert.equal(httpCalls.length, beforeMalformed, 'malformed saved content never reaches the transport');
  const withCeiling = permissionCeiling => ({ ...project, folderBot: { id: 'im-fixture', directory: root, background: true, permissionCeiling } });
  const beforeCeiling = reads;
  assert.equal(await ask('auto', { target: withCeiling('workspace') }), 'approval-required');
  for (const mode of ['auto', 'reuse', 'prompt']) assert.deepEqual(await ask(mode, { target: withCeiling('read-only') }), { status: 'failed', reason: 'blocked-policy' });
  assert.equal(reads, beforeCeiling, 'the instance ceiling cannot be raised by the global auto setting');
  assert.equal(parseBotCredentialAction({ ...parsed, approval: { mode: 'auto', scopeId } }), undefined);
  policy = 'workspace';
  const afterReuse = httpCalls.length, afterReads = reads;
  assert.equal(await ask('reuse', { scope: randomUUID() }), 'approval-required');
  assert.equal(await ask('reuse', { lifetime: new AbortController().signal }), 'approval-required');
  assert.equal(await ask('reuse', { entry: 'other' }), 'approval-required');
  assert.equal(await ask('reuse', { target: { ...project, folderBot: { id: 'different-instance', directory: root } } }), 'approval-required');
  assert.equal(await ask('reuse', { operation: { ...parsed.use, args: { ...parsed.use.args, url: 'https://elsewhere.example.test/account' } } }), 'approval-required');
  assert.equal(await ask('reuse', { operation: { ...parsed.use, name: 'fixture-unspecified' } }), 'approval-required');
  assert.equal(reads, afterReads);
  values.set([...values.keys()].find(key => key.endsWith(':fixture-sso')), '{"tenant":"fixture-tenant","clientId":"fixture-id","clientSecret":"rotated-fixture"}');
  assert.equal(await ask('reuse'), 'approval-required');
  assert.equal(httpCalls.length, afterReuse);
  profile.abort();
  assert.equal(await ask('reuse'), 'approval-required');

  const legacyUse = { ...parsed.use, name: 'old-pair', args: { ...parsed.use.args,
    auth: { kind: 'access-key-pair', scheme: 'headers', headers: { 'X-Client': 'AccessKeyId', 'X-Secret': 'AccessKeySecret' } } } };
  const prefix = botCredentialNamespace(root, project.id, 'main', await realpath(root));
  values.set(`${prefix}access-key-pair:old-pair`, '{"AccessKeyId":"fixture-old-id","AccessKeySecret":"fixture-old-secret"}');
  approve = true;
  const legacy = (operation) => ask('prompt', { lifetime: new AbortController().signal, operation });
  assert.equal((await legacy(legacyUse)).status, 'ok');
  assert.equal(values.has(`${prefix}structured:old-pair`), false);

  const hosting = new AbortController();
  const token = 'fixture-only-git-token';
  values.set(`${prefix}api-key:existing-token`, token);
  const hostRequest = { connector: 'host', operation: 'https.get-json', name: 'existing-token', args: {
    url: 'https://git.example.test/api/v4/user', auth: { kind: 'api-key', scheme: 'header', header: 'PRIVATE-TOKEN' },
  } };
  const callHost = (mode, overrides = {}) => ask(mode, { lifetime: hosting.signal, operation: hostRequest, ...overrides });
  const originalReads = reads;
  const listUse = { connector: 'host', operation: 'vault.list', args: { query: 'existing' } };
  const listAction = parseBotCredentialAction({ type: 'bot-credential-request', action: 'use', use: listUse });
  const list = target => interaction(target, 'main', 'Fixture Bot', listAction, hosting.signal, hosting.signal);
  const beforeList = approvals.length;
  assert.deepEqual(await list(project), { status: 'ok', data: { credentials: [{ name: 'existing-token', kind: 'api-key' }], total: 1 } });
  assert.deepEqual(await list({ ...project, folderBot: { id: 'another-instance', directory: root } }), { status: 'ok', data: { credentials: [], total: 0 } });
  assert.equal(reads, originalReads);
  assert.equal(approvals.length, beforeList);
  assert.equal(await callHost('reuse'), 'approval-required');
  policy = 'read-only';
  assert.deepEqual(await callHost('prompt'), { status: 'failed', reason: 'blocked-policy' });
  assert.deepEqual(await list(project), { status: 'failed', reason: 'blocked-policy' });
  assert.equal(reads, originalReads);
  policy = 'workspace';
  approve = false;
  assert.deepEqual(await callHost('prompt'), { status: 'declined' });
  assert.equal(reads, originalReads);
  approve = 'conversation';
  const priorHttpCalls = httpCalls.length;
  policy = 'auto';
  const beforeAuto = approvals.length;
  assert.deepEqual(await callHost('auto'), response);
  assert.equal(approvals.length, beforeAuto, 'eligible HTTPS operations honor Auto Approve');
  policy = 'workspace';
  assert.deepEqual(await callHost('prompt'), response);
  const selected = approvals.at(-1).items[1];
  assert.equal(selected.description, hostRequest.args.url);
  assert.match(selected.detail, /header=private-token/);
  assert.doesNotMatch(JSON.stringify(selected), new RegExp(token));
  assert.equal(httpCalls[priorHttpCalls].credential, token);
  assert.deepEqual(await callHost('reuse'), response);
  const afterUse = reads;
  assert.equal(await callHost('reuse', { operation: { ...hostRequest, args: { ...hostRequest.args, url: 'https://unapproved.example.test/api/v4/user' } } }), 'approval-required');
  assert.equal(await callHost('reuse', { operation: { ...hostRequest, args: { ...hostRequest.args, url: 'https://git.example.test/api/v4/projects' } } }), 'approval-required');
  assert.equal(await callHost('reuse', { operation: { ...hostRequest, args: { ...hostRequest.args, auth: { kind: 'api-key', scheme: 'bearer' } } } }), 'approval-required');
  assert.equal(await callHost('reuse', { target: { ...project, folderBot: { id: 'another-instance', directory: root } } }), 'approval-required');
  assert.deepEqual(await callHost('prompt', { operation: { ...hostRequest, operation: 'fixture.unregistered' } }), { status: 'failed', reason: 'invalid-operation' });
  assert.equal(reads, afterUse);
  values.set(`${prefix}api-key:existing-token`, 'fixture-rotated-git-token');
  assert.equal(await callHost('reuse'), 'approval-required');
  approve = true;
  assert.deepEqual(await callHost('prompt', { operation: { ...hostRequest, args: { ...hostRequest.args, url: 'https://git.example.test/echo' } } }), { status: 'failed', reason: 'unsafe-response' });
  assert.equal(httpCalls.length, priorHttpCalls + 4);

  policy = 'auto';
  duringQuery = () => { policy = 'workspace'; };
  assert.deepEqual(await callHost('auto'), { status: 'denied', reason: 'blocked-policy' });
  assert.equal(httpCalls.length, priorHttpCalls + 5, 'a completed operation does not ask to be run again');
  duringQuery = undefined;

  let authorized = true;
  policy = 'auto';
  duringQuery = () => { authorized = false; };
  assert.deepEqual(await interaction(project, 'main', 'Fixture Bot', { action: 'use', use: hostRequest, approval: { mode: 'auto' } }, hosting.signal,
    hosting.signal, async () => authorized), { status: 'denied', reason: 'blocked-policy' });
  duringQuery = undefined;

  const env = { FIXTURE_ID: 'clientId', FIXTURE_SECRET: 'clientSecret' };
  const client = 'const {FIXTURE_ID, FIXTURE_SECRET} = process.env; if (!FIXTURE_ID || !FIXTURE_SECRET) process.exit(1); process.stdout.write(process.argv[1]);';
  const command = { connector: 'host', name: slot.name, operation: 'command.run',
    args: { kind: 'structured', program: process.execPath, argv: ['-e', client, 'first-service'], env } };
  policy = 'auto';
  const beforeCommandPrompt = approvals.length;
  assert.deepEqual(await callHost('auto', { operation: command }), { status: 'ok', data: { exitCode: 0, stdout: 'first-service', stderr: '' } });
  assert.deepEqual(await callHost('auto', { operation: { ...command, args: { ...command.args, argv: ['-e', client, 'second-service'] } } }),
    { status: 'ok', data: { exitCode: 0, stdout: 'second-service', stderr: '' } });
  assert.deepEqual(await callHost('auto', { operation: command, target: withCeiling('auto') }), { status: 'missing' });
  assert.equal(approvals.length, beforeCommandPrompt, 'Auto Approve never opens a command prompt');
  policy = 'workspace';
  assert.equal(await callHost('auto', { operation: command }), 'approval-required');
  assert.deepEqual(await callHost('prompt', { operation: command }), { status: 'ok', data: { exitCode: 0, stdout: 'first-service', stderr: '' } });
  assert.deepEqual(approvals.at(-1).items.map(item => item.label), ['Allow once']);
  assert.match(approvals.at(-1).items[0].detail, /FIXTURE_SECRET.*clientSecret/);
  assert.doesNotMatch(JSON.stringify(approvals.at(-1)), /rotated-fixture/);
});
