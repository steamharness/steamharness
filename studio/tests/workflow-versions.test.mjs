import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-versions-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
const id = '784af2d9-240a-45d1-a659-452a21867934', otherId = '4c8bed84-e667-446e-860d-663caa5c3587';
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}
const uri = value => ({ fsPath: value.startsWith('file:') ? fileURLToPath(value) : value, toString: () => value.startsWith('file:') ? value : pathToFileURL(value).href });
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t, options = {}) {
  const commands = new Map(), storage = new Map(), accountChanged = new Emitter(), visibility = new Emitter(), messages = [], requests = [];
  const local = { uri: 'file:///demo', folderPath: path.resolve('/demo'), id, name: 'Demo', projectType: 'workflow', fields: [], entrypoints: [], manifest: { version: '1.0.0' } };
  const f = { local, storage, requests, errors: [], infos: [], uploads: [], downloads: [], opens: [], notes: 'New version',
    connection: options.signedOut ? undefined : { serverUrl: 'https://workflow.test', accessToken: 'host-token' },
    projects: [{ id, name: 'Demo', latest: '0.9.0', canManage: true, sourceDownload: { allowed: true, available: true } },
      { id: otherId, name: 'Other', latest: '2.0.0', canManage: false, sourceDownload: { allowed: false, available: true } }],
    versions: new Map([[id, [{ version: '0.9.0', latest: true, releaseLog: '<script>project notes</script>', dependencies: [] }]], [otherId, [{ version: '2.0.0', latest: true, dependencies: [] }]]]),
    manifest: { id, version: '1.0.0' }, documents: [], openDownload: false };
  const context = { subscriptions: [], extensionUri: uri(path.resolve('/extension')), globalState: { get: key => storage.get(key), update: async (key, value) => storage.set(key, value) } };
  const view = { visible: true, webview: { cspSource: 'vscode-resource:', asWebviewUri: value => value, postMessage: value => { messages.push(plain(value)); return Promise.resolve(true); }, onDidReceiveMessage: new Emitter().event },
    onDidChangeVisibility: visibility.event, onDidDispose: new Emitter().event };
  const vscode = {
    EventEmitter: Emitter, env: { language: 'en' }, Uri: { file: uri, joinPath: (root, ...parts) => uri(path.join(root.fsPath, ...parts)), parse: uri },
    workspace: { isTrusted: true, get textDocuments() { return f.documents; }, fs: { readFile: async () => Buffer.from(JSON.stringify(f.manifest)) } },
    ProgressLocation: { Notification: 15 },
    commands: { registerCommand: (name, action) => { commands.set(name, action); return { dispose: () => commands.delete(name) }; },
      executeCommand: async (name, ...args) => {
        if (name === 'vscode.openFolder') { f.opens.push(args); }
        if (name === 'studio.internalShowProjectUpload') {
          f.uploadResult = undefined;
          if (f.notes === undefined) { return; }
          await f.input?.();
          f.cancel = () => commands.get('studio.internalCancelProjectUpload')(args[0].id);
          f.uploadResult = await commands.get('studio.internalUploadProject')({ id: args[0].id, releaseLog: f.notes });
          return;
        }
        return commands.get(name)?.(...args);
      } },
    window: { state: { focused: true }, registerWebviewViewProvider: () => ({ dispose() {} }), onDidChangeWindowState: new Emitter().event,
      showErrorMessage: async message => f.errors.push(message), showInformationMessage: async (message, action) => { f.infos.push(message); return f.openDownload ? action : undefined; },
      showQuickPick: async items => { await f.pick?.(items); return items[0]; }, showInputBox: async () => { await f.input?.(); return f.notes; },
      withProgress: async (_options, action) => { await f.beforeProgress?.(); const changed = new Emitter(); f.cancel = () => changed.fire(); return action({ report() {} }, { onCancellationRequested: changed.event, isCancellationRequested: false }); } },
  };
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    if (f.read) { const result = await f.read(url, init); if (result) { return result; } }
    const selected = /\/projects\/([^/]+)\/versions$/.exec(url)?.[1];
    return Response.json({ errCode: 0, data: selected ? { id: selected, versions: f.versions.get(selected) ?? [] } : f.projects });
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    AbortController, AbortSignal, TextDecoder, URL, Response, fetch: fetcher, setTimeout, clearTimeout,
    setInterval: () => ({}), clearInterval() {}, crypto: globalThis.crypto, Error, DOMException });
  const launcher = {
    uploadProject: async (project, notes, signal) => { f.uploads.push({ project, notes }); await f.upload?.(signal); f.versions.set(project.id, [...f.versions.get(project.id), { version: project.manifest.version, latest: true, dependencies: [] }]); },
    downloadProject: async (projectId, version, signal) => { f.downloads.push({ projectId, version }); await f.download?.(signal); return [{ id: projectId, name: 'Demo', version, directory: path.resolve('/defaults/demo-0.9.0'), role: 'root' }]; },
  };
  if (options.noTransfers) { delete launcher.uploadProject; delete launcher.downloadProject; }
  const provider = new module.exports.VersionsView(context, launcher, { getConnection: () => f.connection, onDidChange: accountChanged.event, open: () => { f.signIn = true; } },
    { appendLine() {} }, async () => ({ dispose() {} }), async projects => { f.remembered = projects; });
  provider.update(options.noLocal ? [] : [local], options.noLocal ? undefined : local);
  provider.resolveWebviewView(view);
  t.after(() => { for (const disposable of context.subscriptions) { disposable.dispose(); } });
  return Object.assign(f, { provider, view, state: () => messages.at(-1), command: (name, ...args) => commands.get(name)(...args),
    message: message => provider.receive({ generation: f.state().generation, projectId: f.state().project?.id, ...message }),
    accountChange: connection => { f.connection = connection; accountChanged.fire({ status: connection ? 'authenticated' : 'signed-out' }); } });
}

test('version tab reads server history with a local version and respects independent source permissions', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  assert.equal(f.state().localVersion, '1.0.0'); assert.equal(f.state().project.id, id); assert.equal(f.state().canDownload, true);
  assert.equal(f.state().versions[0].version, '0.9.0');
  assert.ok(f.requests.every(request => request.init.headers.Authorization === 'Bearer host-token'));
  const other = { ...f.local, id: otherId };
  f.provider.update([other], other); await f.command('studio.refreshVersions');
  assert.equal(f.state().canDownload, false); assert.equal(f.state().project.id, otherId);
  await assert.rejects(f.message({ type: 'download', version: '2.0.0' }), /not granted/);
  assert.equal(f.downloads.length, 0);
});

test('without a local project the version tab stays empty and signed-out users can open the account entry', async t => {
  const f = fixture(t, { noLocal: true }); await f.command('studio.refreshVersions');
  assert.equal(f.state().project, undefined); assert.equal(f.state().canDownload, false); assert.equal(f.state().versions.length, 0);
  assert.equal(f.requests.length, 0);
  f.accountChange(undefined); assert.equal(f.state().signedIn, false); assert.deepEqual(f.state().versions, []);
  await f.message({ type: 'sign-in' }); assert.equal(f.signIn, true);
});

test('local version markers and uploads follow the active copy when UUIDs match', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  const copy = { ...f.local, uri: 'file:///copy', folderPath: path.resolve('/copy'), manifest: { version: '1.1.0' } };
  f.provider.update([f.local, copy], copy); await f.command('studio.refreshVersions');
  assert.equal(f.state().localVersion, '1.1.0');
  f.manifest.version = '1.1.0';
  await f.message({ type: 'upload' });
  assert.equal(f.uploads[0].project.uri, copy.uri);
});

test('changing a project UUID in the same folder selects its own server history', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  const replaced = { ...f.local, id: otherId };
  f.provider.update([replaced], replaced);
  await f.command('studio.refreshVersions');
  assert.equal(f.state().project.id, otherId);
  assert.equal(f.state().versions[0].version, '2.0.0');
  assert.equal(f.state().localVersion, '1.0.0');
});

test('hosts without file transfers retain history and report the host limitation', async t => {
  const f = fixture(t, { noTransfers: true }); await f.command('studio.refreshVersions');
  assert.equal(f.state().versions.length, 1); assert.equal(f.state().transfersAvailable, false);
  assert.equal(f.state().canDownload, false);
  await f.command('studio.downloadProject');
  assert.match(f.errors.at(-1), /extension host/);
});

test('upload publishes the saved package version with release notes and refreshes history', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  await f.command('studio.uploadProject');
  assert.equal(f.errors.length, 0); assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].project.manifest.version, '1.0.0'); assert.equal(f.uploads[0].notes, 'New version');
  assert.ok(f.state().versions.some(entry => entry.version === '1.0.0')); assert.equal(f.state().busy, false);
  await f.command('studio.uploadProject');
  assert.equal(f.uploads.length, 1); assert.match(f.uploadResult.error, /already exists/);
});

test('cancelled prompts, account switches and changed manifests cannot upload stale state', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  f.notes = undefined; await f.command('studio.uploadProject'); assert.equal(f.uploads.length, 0);
  f.notes = ''; f.input = () => { f.manifest.version = '1.0.1'; };
  await f.command('studio.uploadProject'); assert.match(f.uploadResult.error, /version changed/); assert.equal(f.uploads.length, 0);
  f.input = () => f.accountChange({ serverUrl: 'https://other.test', accessToken: 'new-token' });
  await f.command('studio.uploadProject'); assert.match(f.uploadResult.error, /Account changed/); assert.equal(f.uploads.length, 0);
});

for (const phase of ['dialog', 'save', 'version check']) {
  test(`an account change during upload ${phase} cannot publish to the new account`, async t => {
    const f = fixture(t); await f.command('studio.refreshVersions');
    const changeAccount = () => f.accountChange({ serverUrl: 'https://other.test', accessToken: 'other-token' });
    if (phase === 'dialog') {
      f.input = changeAccount;
    } else if (phase === 'save') {
      f.documents = [{ uri: uri('file:///demo/index.ts'), isDirty: true, save: async () => {
        changeAccount();
        return true;
      } }];
    } else {
      f.read = url => { if (url.endsWith('/versions')) { f.read = undefined; changeAccount(); } };
    }
    await f.command('studio.uploadProject');
    assert.equal(f.uploads.length, 0);
    assert.match(f.uploadResult.error, phase === 'dialog' ? /Account changed/ : /Upload cancelled/);
  });
}

test('upload saves only dirty project files and stops when saving fails', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  let saved = 0;
  f.documents = [{ uri: uri('file:///elsewhere/index.ts'), isDirty: true, save: () => { assert.fail('unrelated document was saved'); } },
    { uri: uri('file:///demo/index.ts'), isDirty: true, save: async () => { saved++; return false; } }];
  await f.command('studio.uploadProject'); assert.equal(saved, 1); assert.equal(f.uploads.length, 0); assert.equal(f.state().busy, false);
});

test('an unsaved package version is saved before duplicate-version checks', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  f.versions.set(id, [{ version: '1.0.0', latest: true }]);
  const document = { uri: uri('file:///demo/package.json'), isDirty: true, getText: () => JSON.stringify({ ...f.manifest, version: '1.0.1' }),
    save: async () => { f.manifest.version = '1.0.1'; document.isDirty = false; return true; } };
  f.documents = [document];
  await f.command('studio.uploadProject');
  assert.equal(f.uploads[0].project.manifest.version, '1.0.1'); assert.equal(f.errors.length, 0);
});

test('data write access alone does not enable an upload', async t => {
  const f = fixture(t); f.projects[0].canManage = false; f.projects[0].canWriteData = true;
  await f.command('studio.refreshVersions');
  await f.command('studio.uploadProject');
  assert.equal(f.uploads.length, 0); assert.match(f.uploadResult.error, /management permission/);
});

test('downloads register exact version directories and open only the downloaded root in a new window', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions'); f.openDownload = true;
  await f.message({ type: 'download', version: '0.9.0' });
  assert.deepEqual(f.downloads, [{ projectId: id, version: '0.9.0' }]);
  assert.equal(f.remembered[0].version, '0.9.0');
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0][1].forceNewWindow, true); assert.match(f.opens[0][0].fsPath, /demo-0.9.0$/);
  await f.message({ type: 'download', version: 'not-a-published-version' }); assert.equal(f.downloads.length, 1);
});

test('an account change while choosing a download cannot transfer the prior selection', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  f.pick = () => f.accountChange({ serverUrl: 'https://other.test', accessToken: 'other-token' });
  await f.command('studio.downloadProject');
  assert.equal(f.downloads.length, 0); assert.match(f.errors.at(-1), /Account changed/);
});

test('an account change before the progress action starts cannot download a prior selection', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  f.beforeProgress = () => f.accountChange({ serverUrl: 'https://other.test', accessToken: 'other-token' });
  await assert.rejects(f.message({ type: 'download', version: '0.9.0' }), /Account changed/);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.state().busy, false);
});

test('stale responses and stale webview commands cannot replace or download another selection', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  const oldGeneration = f.state().generation;
  let release, started;
  const pending = new Promise(resolve => { started = resolve; });
  f.read = async url => {
    if (url.endsWith('/versions')) { f.read = undefined; started(); return new Promise(resolve => { release = resolve; }); }
  };
  const reading = f.command('studio.refreshVersions'); await pending;
  const other = { ...f.local, id: otherId };
  f.provider.update([other], other); await f.command('studio.refreshVersions');
  release(Response.json({ errCode: 0, data: { versions: [{ version: 'stale' }] } })); await reading;
  assert.equal(f.state().project.id, otherId); assert.equal(f.state().versions[0].version, '2.0.0');
  await f.provider.receive({ type: 'download', generation: oldGeneration, projectId: id, version: '0.9.0' });
  assert.equal(f.downloads.length, 0);
});

test('refresh retains known versions through errors and sign-out immediately removes prior account history', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  f.read = () => { throw new Error('unavailable'); };
  await f.command('studio.refreshVersions'); assert.equal(f.state().versions[0].version, '0.9.0'); assert.ok(f.state().error);
  f.accountChange(undefined); assert.equal(f.state().versions.length, 0); assert.equal(f.state().canDownload, false);
});

test('upload locks preparation and cancellation releases the action state', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  let enter;
  const started = new Promise(resolve => { enter = resolve; });
  f.upload = signal => new Promise((_resolve, reject) => { enter(); signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); });
  const uploading = f.command('studio.uploadProject'); await started;
  await f.command('studio.uploadProject'); assert.equal(f.uploads.length, 1);
  f.cancel(); await uploading; assert.equal(f.state().busy, false); assert.equal(f.errors.length, 0);
});
