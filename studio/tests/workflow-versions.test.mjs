import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const compiled = await build({ stdin: { contents: "export { VersionsView } from './extensions/studio-workstation/src/workflow-versions-view'; export { registerProjectUploadProvider } from './extensions/studio-workstation/src/project-upload-extension';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
const id = '784af2d9-240a-45d1-a659-452a21867934', otherId = '4c8bed84-e667-446e-860d-663caa5c3587';
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}
const uri = value => ({ fsPath: value.startsWith('file:') ? fileURLToPath(value) : value, toString: () => /^[\w-]+:/.test(value) ? value : pathToFileURL(value).href });
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t, options = {}) {
  const commands = new Map(), storage = new Map(), accountChanged = new Emitter(), visibility = new Emitter(), messages = [], requests = [];
  const local = { uri: 'file:///demo', folderPath: path.resolve('/demo'), id, name: 'Demo', projectType: 'workflow', fields: [], entrypoints: [], manifest: { version: '1.0.0' } };
  const f = { local, storage, requests, errors: [], infos: [], uploads: [], downloads: [], opens: [], notes: 'New version',
    connection: options.signedOut ? undefined : { serverUrl: 'https://steamharness.test', accessToken: 'host-token' },
    projects: [{ id, name: 'Demo', latest: '0.9.0',entries:[{entryId:'main',type:'workflow',name:'Main'}],defaultEntry:'main', access: { effectiveRole: 'developer', capabilities: ['read', 'downloadSource', 'readDraft', 'upload', 'publish', 'writeData'], sources: [] }, sourceDownload: { allowed: true, available: true } },
      { id: otherId, name: 'Other', latest: '2.0.0',entries:[{entryId:'main',type:'workflow',name:'Main'}],defaultEntry:'main', access: { effectiveRole: null, capabilities: [], sources: [] }, sourceDownload: { allowed: false, available: true } }],
    groups: [], versions: new Map([[id, [{ version: '0.9.0', latest: true, releaseLog: '<script>project notes</script>', dependencies: [] }]], [otherId, [{ version: '2.0.0', latest: true, dependencies: [] }]]]),
    manifest: { id, version: '1.0.0' }, documents: [], openDownload: false, windowChoice: 'new' };
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
          f.uploadDialog = args[0];
          f.uploadResult = undefined;
          if (f.notes === undefined) { return; }
          await f.input?.();
          f.cancel = () => commands.get('studio.internalCancelProjectUpload')(args[0].id);
          f.submit = () => commands.get('studio.internalUploadProject')({ id: args[0].id, releaseLog: f.notes, options: f.uploadOptions });
          f.uploadResult = await f.submit();
          return;
        }
        return commands.get(name)?.(...args);
      } },
    window: { state: { focused: true }, registerWebviewViewProvider: () => ({ dispose() {} }), onDidChangeWindowState: new Emitter().event,
      showErrorMessage: async message => f.errors.push(message), showInformationMessage: async (message, action, newWindow, currentWindow) => {
        f.infos.push(message);
        if (typeof action === 'object' && action.modal) { return f.windowChoice === 'new' ? newWindow : f.windowChoice === 'current' ? currentWindow : undefined; }
        return f.openDownload ? action : undefined;
      },
      showQuickPick: async items => { return await f.pick?.(items) ?? items[0]; }, showInputBox: async () => { await f.input?.(); return f.notes; },
      withProgress: async (_options, action) => { await f.beforeProgress?.(); const changed = new Emitter(); f.cancel = () => changed.fire(); return action({ report() {} }, { onCancellationRequested: changed.event, isCancellationRequested: false }); } },
  };
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    if (f.read) { const result = await f.read(url, init); if (result) { return result; } }
    const selected = /\/projects\/([^/]+)\/versions$/.exec(url)?.[1];
    return Response.json({ errCode: 0, data: selected ? { id: selected, versions: f.versions.get(selected) ?? [] } : { items: url.includes('/groups?') ? f.groups : f.projects, total: url.includes('/groups?') ? f.groups.length : f.projects.length, page: 1, pageSize: 100 } });
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    AbortController, AbortSignal, TextDecoder, URL, Response, fetch: fetcher, setTimeout, clearTimeout,
    setInterval: () => ({}), clearInterval() {}, crypto: globalThis.crypto, Error, DOMException });
  if (options.uploadProvider) { context.subscriptions.push(module.exports.registerProjectUploadProvider(options.uploadProvider)); }
  const launcher = {
    uploadProject: async (project, notes, signal, _progress, groupId) => { f.uploads.push({ project, notes, groupId }); await f.upload?.(signal); f.versions.set(project.id, [...f.versions.get(project.id), { version: project.manifest.version, latest: true, dependencies: [] }]); },
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

test("version tab reads server history and respects the user's project access", async t => {
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

test('manual version project selection stays independent across repeated updates with the same preferred project', async t => {
  const f = fixture(t), second = { ...f.local, uri: 'file:///second', folderPath: '/second', id: otherId, name: 'Second' };
  f.provider.update([second, f.local], f.local);
  await f.command('studio.selectVersionsProject');
  assert.equal(f.state().project.uri, second.uri);
  f.provider.update([second, f.local], f.local);
  assert.equal(f.state().project.uri, second.uri);
  f.provider.update([second, f.local], second); f.provider.update([second, f.local], f.local);
  assert.equal(f.state().project.uri, f.local.uri);
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

for (const kind of ['kanban', 'workflow', 'conversation']) test(`opening a ${kind} upload dialog does not upload until the user submits it`, async t => {
  const f = fixture(t); f.local.projectType = kind; f.notes = undefined;
  await f.command('studio.uploadProject', { uri: f.local.uri });
  assert.equal(f.uploadDialog.folderPath, f.local.folderPath);
  assert.equal(f.uploadDialog.serverUrl, f.connection.serverUrl);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.errors.length, 0);
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

test('guests can download published source but cannot upload', async t => {
  const f = fixture(t); f.projects[0].access = { effectiveRole: 'guest', capabilities: ['read', 'downloadSource'], sources: [] };
  await f.command('studio.refreshVersions');
  await f.command('studio.uploadProject');
  assert.equal(f.state().canDownload, true);
  assert.equal(f.uploads.length, 0); assert.match(f.uploadResult.error, /role does not allow/);
});

test('downloads register exact version directories and open only the downloaded root in a new window', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions'); f.openDownload = true;
  await f.message({ type: 'download', version: '0.9.0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.downloads, [{ projectId: id, version: '0.9.0' }]);
  assert.equal(f.remembered[0].version, '0.9.0');
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0][1].forceNewWindow, true); assert.match(f.opens[0][0].fsPath, /demo-0.9.0$/);
  await f.message({ type: 'download', version: 'not-a-published-version' }); assert.equal(f.downloads.length, 1);
});

for (const choice of ['current', undefined]) {
  test(`download opening respects the ${choice ?? 'cancelled'} window choice`, async t => {
    const f = fixture(t); await f.command('studio.refreshVersions'); f.openDownload = true; f.windowChoice = choice;
    await f.message({ type: 'download', version: '0.9.0' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.downloads.length, 1);
    assert.equal(f.remembered[0].version, '0.9.0');
    assert.equal(f.opens.length, choice === 'current' ? 1 : 0);
    if (f.opens.length) { assert.deepEqual(plain(f.opens[0][1]), { forceNewWindow: false, forceReuseWindow: true }); }
    assert.deepEqual(f.errors, []);
  });
}

test('an account change while choosing a download cannot transfer the prior selection', async t => {
  const f = fixture(t); await f.command('studio.refreshVersions');
  f.pick = () => f.accountChange({ serverUrl: 'https://other.test', accessToken: 'other-token' });
  await f.command('studio.downloadProject');
  assert.equal(f.downloads.length, 0); assert.match(f.errors.at(-1), /Account changed/);
});

test('the download picker displays the server project avatar', async t => {
  const f = fixture(t);
  f.projects[0].projectType = 'conversation';
  f.projects[0].projectCard = { icon: 'bot', iconColor: '#123456', iconBackgroundColor: '#f0f4f8' };
  let avatar;
  f.pick = items => { if (items[0].project) { avatar = items[0].iconPath.toString(); } };
  await f.command('studio.downloadProject');
  const svg = decodeURIComponent(avatar.split(',')[1]);
  assert.match(svg, /stroke="#123456"/);
  assert.match(svg, /fill="#f0f4f8"/);
  assert.equal(f.downloads.length, 1);
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

test('upload extensions receive only their boolean options after a successful transfer', async t => {
  const completed = [];
  const f = fixture(t, { uploadProvider: { prepare: async context => {
    assert.equal(context.projectId, id);
    return { options: [{ id: 'review', label: 'Submit for review', checked: true }], complete: async values => {
      completed.push(plain(values)); return { message: 'Submitted for review.' };
    } };
  } } });
  f.uploadOptions = { review: false, unknown: true };
  await f.command('studio.uploadProject');
  assert.deepEqual(completed, [{ review: false }]);
  assert.equal(f.uploadDialog.options[0].checked, true);
  assert.equal(f.uploadResult.message, 'Submitted for review.');
  assert.equal(f.uploadResult.success, true);
  assert.ok((await f.submit()).error);
  assert.equal(f.uploads.length, 1);
});

test('follow-up failures cannot retry an uploaded version, and failed transfers never run follow-up actions', async t => {
  let completions = 0;
  const f = fixture(t, { uploadProvider: { prepare: async () => ({ options: [], complete: async () => { completions++; throw new Error('follow-up failed'); } }) } });
  f.upload = () => { throw new Error('transfer failed'); };
  await f.command('studio.uploadProject');
  assert.equal(completions, 0); assert.ok(f.uploadResult.error);
  f.upload = undefined;
  await f.command('studio.uploadProject');
  assert.equal(completions, 1);
  assert.equal(f.uploadResult.success, true); assert.equal(f.uploadResult.warning, true);
  assert.match(f.uploadResult.message, /uploaded/);
  assert.ok((await f.submit()).error);
});

test('account changes while loading upload options cannot open or submit a stale upload', async t => {
  let resolveOptions;
  const f = fixture(t, { uploadProvider: { prepare: () => new Promise(resolve => { resolveOptions = resolve; }) } });
  const uploading = f.command('studio.uploadProject');
  while (!resolveOptions) { await new Promise(resolve => setTimeout(resolve, 1)); }
  f.accountChange({ serverUrl: 'https://other.test', accessToken: 'other-token' });
  resolveOptions({ options: [], complete: async () => assert.fail('must not run') });
  await uploading;
  assert.equal(f.uploadDialog, undefined); assert.equal(f.uploads.length, 0);
  assert.match(f.errors.at(-1), /Account changed/);
});


test('uploading an unregistered project asks for a new application ID before ownership or upload actions', async t => {
  const f = fixture(t); f.projects = [];
  f.read = async url => url.endsWith('/versions') ? Response.json({ errCode: 404, errMessage: 'missing' }, { status: 404 }) : undefined;
  f.pick = () => assert.fail('Project groups must be chosen when applying for an ID');
  await f.command('studio.refreshVersions');
  await f.command('studio.uploadProject');
  assert.equal(f.uploads.length, 0);
  assert.match(f.uploadResult.error, /apply for a new application ID/);
  assert.equal(f.requests.some(request => request.url.includes('/api/groups?minRole=developer')), false);
});
