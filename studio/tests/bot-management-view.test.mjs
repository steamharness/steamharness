import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('../extensions/studio-workstation/src/bot-management-view.ts', import.meta.url));
const { outputFiles: [bundle] } = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'] });
const artifact = 'ba_' + 'a'.repeat(32);
const list = { kind: 'artifacts', route: '', method: 'GET' };
const empty = { status: 200, json: { artifacts: [] } };

async function eventually(predicate) {
  const until = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > until) assert.fail('The expected Bot management event did not arrive.');
    await wait(5);
  }
}

async function fixture(t, { managed = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-bot-management-view-')));
  let registration, dispose;
  t.after(async () => {
    dispose?.();
    registration?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'bot'), folder = path.join(root, 'bound');
  await mkdir(project); await mkdir(folder);
  const projectId = randomUUID(), entryId = 'main';
  // No executable exists. The Launchpad must only read the declaration.
  await writeFile(path.join(project, 'steamharness.json'), JSON.stringify({ id: projectId, name: 'Fixture', version: '1.0.0', defaultEntry: entryId,
    entries: [{ entryId, type: 'bot', name: 'Main', root: '.', entry: 'index.ts', folderContext: true }] }));
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
  const workers = [], messages = [], writes = [];
  const responses = new Map(), saveSelected = Promise.withResolvers();
  const trusted = new Set([project, folder]);
  const scope = { workspace: { owner: 'owner-a' }, data: path.join(root, 'runs'), lifetime: new AbortController() };
  let owner = scope.workspace.owner;
  let instanceId = randomUUID();
  let provider, receive, saveShown = false;
  class FakeWorker extends EventEmitter {
    constructor(_file, options) {
      super();
      this.data = structuredClone(options.workerData);
      workers.push(this);
    }
    terminate() { return this.waitToStop?.promise ?? Promise.resolve(0); }
    complete(result) { this.emit('message', result); }
  }
  const vscode = {
    Uri: { joinPath: (base, part) => uri(path.join(base.fsPath, part)), file: uri }, env: { language: 'en' },
    workspace: { isTrusted: true, fs: { writeFile: async (...args) => writes.push(args) } },
    window: {
      registerWebviewViewProvider: (_type, value) => { provider = value; return { dispose() {} }; },
      showSaveDialog: () => { saveShown = true; return saveSelected.promise; },
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.text, { module, exports: module.exports, Buffer, URL, AbortSignal, AbortController, crypto: webcrypto,
    require: id => id === 'vscode' ? vscode : id === 'node:worker_threads' ? { Worker: FakeWorker } : require(id) });
  registration = module.exports.registerBotManagementView({ extensionUri: uri(root) }, {
    captureScope: async () => scope, currentOwner: () => owner,
    target: { assistantId: randomUUID(), isBuiltinProjectDirectory: () => false, trusted: async directory => trusted.has(directory),
      localAssistantDirectory: async () => { throw new Error('No built-in project in this fixture.'); },
      resolveManaged: async () => managed ? { instanceId, directory: folder, projectDirectory: project, projectId, entryId, name: 'Copy' } : undefined,
    },
  });
  provider.resolveWebviewView({
    webview: { asWebviewUri: value => value, cspSource: 'test:',
      onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; },
      async postMessage(message) { messages.push(message); if (message.type === 'response') responses.set(message.id, message.result); },
    },
    onDidDispose: callback => { dispose = callback; return { dispose() {} }; },
  }, { state: { uri: uri(managed ? path.join(root, 'copy.code-workspace') : project).toString(), projectId, entryId, kind: 'artifacts', owner } },
  { onCancellationRequested: () => ({ dispose() {} }) });
  await receive({ type: 'init' });
  assert.equal(messages[0].status, 'ready');
  return { root, project, folder, trusted, workers, responses, writes, saveShown: () => saveShown, saveSelected,
    newOwner: () => { owner = 'owner-b'; scope.lifetime.abort(); }, rebind: () => { instanceId = randomUUID(); },
    dispose, uri, run: (id, request = list) => { void receive({ type: 'request', id, request }); }, cancel: id => { void receive({ type: 'cancel', id }); } };
}

test('folder trust is still required after the panel opens and before returning a worker result', async t => {
  const f = await fixture(t, { managed: true });
  f.trusted.delete(f.folder);
  f.run(1);
  await eventually(() => f.responses.has(1) || f.workers.length > 0);
  assert.equal(f.workers.length, 0);
  assert.equal(f.responses.get(1).status, 403);

  f.trusted.add(f.folder);
  f.run(2);
  await eventually(() => f.workers.length === 1);
  f.trusted.delete(f.project);
  f.workers[0].complete({ status: 200, json: { artifacts: [{ title: 'Fixture result' }] } });
  await eventually(() => f.responses.has(2));
  assert.equal(f.responses.get(2).status, 403);
  assert.equal(f.responses.get(2).json, undefined);
});

test('the modal does not adopt a rebound Bot, new release, or another account', async t => {
  for (const mode of ['rebound', 'release', 'account']) {
    const f = await fixture(t, { managed: mode === 'rebound' });
    if (mode === 'rebound') f.rebind();
    if (mode === 'release') await writeFile(path.join(f.project, 'steamharness.release.json'), '{}');
    if (mode === 'account') f.newOwner();
    f.run(1);
    await eventually(() => f.responses.has(1) || f.workers.length > 0);
    assert.equal(f.workers.length, 0, mode);
    assert.equal(f.responses.get(1).status, 403, mode);
  }
});

test('the save dialog cannot continue a download after the bound directory loses trust', async t => {
  const f = await fixture(t, { managed: true });
  f.run(1, { kind: 'save', id: artifact });
  await eventually(() => f.workers.length === 1);
  f.workers[0].complete({ status: 200, json: { name: 'report.txt' } });
  await eventually(f.saveShown);
  f.trusted.delete(f.folder);
  f.saveSelected.resolve(f.uri(path.join(f.root, 'report.txt')));
  await eventually(() => f.responses.has(1) || f.workers.length > 1);
  assert.equal(f.workers.length, 1);
  assert.equal(f.responses.get(1).status, 403);
  assert.deepEqual(f.writes, []);
});

test('replacing a cancelled request waits for the worker to exit instead of failing or exceeding the limit', async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 4; ++id) f.run(id);
  await eventually(() => f.workers.length === 4);
  const stopped = Promise.withResolvers();
  for (const worker of f.workers) worker.waitToStop = stopped;
  try {
    f.cancel(1);
    f.run(5);
    assert.equal(f.responses.has(5), false);
    assert.equal(f.workers.length, 4);
  } finally { stopped.resolve(0); }
  await eventually(() => f.workers.length === 5);
  f.workers[4].complete(empty);
  await eventually(() => f.responses.has(5));
  assert.equal(f.responses.get(5).status, 200);
  assert.equal(f.responses.has(1), false);
});

test('closing the panel drops queued work and suppresses late worker results', async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 4; ++id) f.run(id);
  await eventually(() => f.workers.length === 4);
  const stopped = Promise.withResolvers();
  for (const worker of f.workers) worker.waitToStop = stopped;
  f.cancel(1);
  f.run(5);
  f.dispose();
  for (const worker of f.workers) worker.complete(empty);
  stopped.resolve(0);
  await wait(0);
  assert.equal(f.workers.length, 4);
  assert.equal(f.responses.size, 0);
});
