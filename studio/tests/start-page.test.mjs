import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/start-page.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
const id = '8f6a6240-4860-4efc-bd07-932868be2b98';
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}
const uri = filename => ({ scheme: 'file', fsPath: filename, toString: () => pathToFileURL(filename).href });
function fixture(t, options = {}) {
  const commands = new Map(), storage = options.storage ?? new Map(), calls = [], intervals = new Map(), projectsChanged = new Emitter(), accountChanged = new Emitter(), trustChanged = new Emitter(), windowChanged = new Emitter();
  const files = storage.get('test.files') ?? new Map(); storage.set('test.files', files);
  const f = { calls, storage, intervals, projectsChanged, accountChanged, projects: [], recent: [], warnings: [], errors: [], installs: [], progress: [],
    name: 'New project', parent: path.resolve('/projects'), newWindow: true, summary: { projects: 2, running: 1, waiting: 1, unavailable: 0, generatedAt: 1 },
    environment: { node: 'v24.18.0', core: '0.2.4', cli: '0.2.4' }, inspectedId: id, manifestId: options.manifestId ?? id,
    files, install: options.install, inspect: options.inspect, create: options.create,
    account: options.account ?? { status: 'signed-out', serverUrl: 'http://localhost:7126' } };
  const vscode = {
    EventEmitter: Emitter, version: '1.141.0', ProgressLocation: { Notification: 15 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    Uri: { file: uri, parse: value => ({ fsPath: value.startsWith('file:') ? fileURLToPath(value) : value, toString: () => value }),
      joinPath: (parent, ...parts) => uri(path.join(parent.fsPath, ...parts)) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose: () => commands.delete(name) }; },
      executeCommand: async (name, ...args) => {
        calls.push([name, ...args]);
        if (name === 'studio.internalShowCreateProject') {
          f.dialog = args[0];
          return f.name === undefined ? undefined : { name: f.name, parentDirectory: f.parent, templateId: f.dialog.templateId ?? f.dialog.templates[0].id };
        }
        return name === 'vscode.openFolder' ? f.open?.(...args) : commands.get(name)?.(...args);
      } },
    workspace: { isTrusted: options.trusted ?? true, workspaceFolders: (options.folders ?? []).map(directory => ({ uri: uri(directory) })),
      onDidGrantWorkspaceTrust: trustChanged.event, onDidChangeConfiguration: new Emitter().event,
      openTextDocument: async value => ({ uri: value, getText: () => new TextDecoder().decode(files.get(value.fsPath)) }),
      fs: { readFile: async value => {
        if (path.basename(value.fsPath) === 'package.json') { return Buffer.from(JSON.stringify({ id: f.manifestId })); }
        if (!files.has(value.fsPath)) { throw Object.assign(new Error('File missing'), { code: 'FileNotFound' }); }
        return files.get(value.fsPath);
      }, writeFile: async (value, content) => { files.set(value.fsPath, content); }, createDirectory: async () => {} } },
    window: { onDidChangeWindowState: windowChanged.event,
      showErrorMessage: async message => { f.errors.push(message); }, showWarningMessage: async message => { f.warnings.push(message); },
      showInformationMessage: async (_message, _options, newWindow, currentWindow) => f.newWindow === undefined ? undefined : f.newWindow ? newWindow : currentWindow,
      showTextDocument: async document => { f.logDocument = document; },
      withProgress: async (options, action) => {
        f.progress.push(options);
        const cancellation = new Emitter(); f.cancel = () => cancellation.fire();
        return action({ report() {} }, { onCancellationRequested: cancellation.event, isCancellationRequested: false });
      } },
  };
  const launcher = {
    projectCreationDirectory: path.join(homedir(), 'Documents', 'steamharness-projects'),
    templates: async () => [ { id: 'workflow-starter', projectType: 'workflow', kind: 'starter', name: 'Workflow', description: 'Minimal' },
      { id: 'workflow-hello', projectType: 'workflow', kind: 'example', name: 'Hello', description: 'Offline' } ],
    createProject: async input => { f.created = (f.created ?? 0) + 1; await f.create?.(); return { id, name: input.name, directory: path.join(input.parentDirectory, input.name), projectType: 'workflow', entryFile: 'index.ts' }; },
    validateProjectCreation: async input => { await f.validate?.(input); },
    installDependencies: async (directory, signal, log) => { f.installs.push(directory); log('install log'); await f.install?.(signal); },
    hasProjectDependencies: async () => f.dependenciesPresent !== false,
    prepareProjectTemplate: async () => { f.prepares = (f.prepares ?? 0) + 1; return false; },
    inspect: async () => { await f.inspect?.(); return { projects: [{ id: f.inspectedId }], errors: f.inspectionErrors ?? [] }; },
    environmentStatus: async () => { if (f.environmentError) { throw f.environmentError; } return f.environment; },
    analysisSummary: async () => { f.summaryReads = (f.summaryReads ?? 0) + 1; if (f.readSummary) { return f.readSummary(); } return f.summary; },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    AbortController, AbortSignal, Error, DOMException, structuredClone, TextDecoder, TextEncoder, process, setTimeout, clearTimeout,
    setInterval: (callback, ms) => { const key = {}; intervals.set(key, { callback, ms }); return key; }, clearInterval: key => intervals.delete(key) });
  const controller = new module.exports.StudioStartController({ globalStorageUri: uri(path.resolve('/studio-storage')), extension: { packageJSON: { version: '0.1.0' } }, globalState: {
    get: key => storage.get(key), update: async (key, value) => storage.set(key, value) } }, launcher,
  { getState: () => f.account, onDidChange: accountChanged.event }, {
    getProjects: () => f.projects, onDidChangeProjects: projectsChanged.event,
    getVersionStatus: () => ({ status: 'unpublished', canDownload: false }), onDidChangeVersions: new Emitter().event,
  },
  { getChildren: () => f.recent, onDidChangeTreeData: new Emitter().event }, async project => { f.remembered = project; }, { appendLine() {}, append() {} });
  t.after(() => controller.dispose());
  return Object.assign(f, { controller, execute: vscode.commands.executeCommand, state: async () => commands.get('studio.internalGetStartState')(),
    grantTrust: () => { vscode.workspace.isTrusted = true; trustChanged.fire(); }, focus: () => windowChanged.fire({ focused: true }) });
}

async function until(read, message) {
  for (let i = 0; i < 100; i++) { if (await read()) { return; } await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(message);
}

test('start status polls only while visible and preserves last good counts after refresh failures', async t => {
  const f = fixture(t); await f.execute('studio.refreshStart'); assert.equal(f.summaryReads, undefined); assert.equal(f.intervals.size, 0);
  await f.execute('studio.internalStartPageVisibility', true); await f.execute('studio.refreshStart');
  assert.equal(f.intervals.size, 1); assert.equal([...f.intervals.values()][0].ms, 5000); assert.equal((await f.state()).summary.running, 1);
  f.readSummary = () => { throw new Error('history unavailable'); };
  await f.execute('studio.refreshStart'); assert.equal((await f.state()).summary.running, 1); assert.match((await f.state()).error, /history unavailable/);
  f.readSummary = () => ({ ...f.summary, running: 0, unavailable: 1 }); await f.execute('studio.refreshStart');
  assert.equal((await f.state()).summary.running, 1); assert.match((await f.state()).error, /could not be read/);
  f.readSummary = undefined; await f.execute('studio.refreshStart'); assert.equal((await f.state()).error, undefined);
  await f.execute('studio.internalStartPageVisibility', false); assert.equal(f.intervals.size, 0);
  const reads = f.summaryReads; await f.execute('studio.refreshStart'); assert.equal(f.summaryReads, reads);
});

test('project and account changes debounce, invalidate old summaries and preserve current state', async t => {
  const f = fixture(t); await f.execute('studio.refreshStart');
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.readSummary = () => { f.readSummary = undefined; started(); return new Promise(resolve => { release = resolve; }); };
  await f.execute('studio.internalStartPageVisibility', true); await ready;
  f.projects = [{ id, aggregateName: 'Aggregate', name: 'Current', uri: 'file:///current', entryId: 'main', projectType: 'workflow' }];
  for (let i = 0; i < 10; i++) { f.projectsChanged.fire(); }
  f.account = { status: 'authenticated', serverUrl: 'http://localhost:7126', user: { displayName: 'Local User' } }; f.accountChanged.fire();
  release({ ...f.summary, projects: 99 }); await f.execute('studio.refreshStart');
  assert.equal((await f.state()).summary.projects, 2); assert.equal((await f.state()).projects[0].name, 'Aggregate / Current'); assert.equal((await f.state()).environment.account, 'Local User');
  assert.equal(f.summaryReads, 2);
});

test('Start preserves every aggregate entry sharing one project URI, including entries without database bindings', async t => {
  const f = fixture(t);
  const entries = [['agent', 'conversation'], ['database', 'workflow'], ['map-2d', 'kanban'], ['minimax', 'workflow'], ['tikhub', 'workflow']];
  f.projects = entries.map(([entryId, projectType]) => ({ id, aggregateName: 'Aggregate', name: entryId,
    uri: 'file:///aggregate', folderPath: '/aggregate', entryId, projectType, databases: [{ alias: 'data', host: 'server' }] }));
  await f.execute('studio.refreshStart');
  assert.deepEqual((await f.state()).projects.map(({ uri, entryId, name, projectType }) => ({ uri, entryId, name, projectType })),
    entries.map(([entryId, projectType]) => ({ uri: 'file:///aggregate', entryId, name: `Aggregate / ${entryId}`, projectType })));
});

test('creation opens the project before installation and hands progress, logs and retry to the new window', async t => {
  const f = fixture(t); await f.execute('studio.refreshStart');
  let finishCreate, failInstall;
  f.create = () => new Promise(resolve => { finishCreate = resolve; });
  const creating = f.execute('studio.createProject', 'workflow');
  await until(() => finishCreate, 'Source generation did not begin');
  await f.execute('studio.createProject', 'workflow'); assert.equal(f.created, 1);
  finishCreate(); await creating;
  const opened = f.calls.find(([name]) => name === 'vscode.openFolder'); assert.equal(opened[2].forceNewWindow, true);
  assert.deepEqual(f.installs, []); assert.equal(f.progress.length, 1); assert.equal(f.progress[0].title, 'Applying for a new project ID');
  assert.equal((await f.state()).pending[0].installOnOpen, true);
  const target = fixture(t, { storage: f.storage, folders: [opened[1].fsPath],
    install: () => new Promise((_resolve, reject) => { failInstall = () => reject(new Error('offline registry')); }) });
  await until(() => failInstall, 'The new project window did not start installation');
  assert.equal((await target.state()).installing, id); assert.equal((await target.state()).pending[0].installOnOpen, false);
  assert.equal(target.progress.length, 1); assert.equal(target.installs[0], opened[1].fsPath);
  assert.deepEqual(f.installs, []); assert.equal(f.progress.length, 1); assert.equal(f.progress[0].title, 'Applying for a new project ID');
  failInstall(); await until(async () => !(await target.state()).busy, 'Installation did not finish');
  assert.equal((await target.state()).pending[0].status, 'failed');
  await target.execute('studio.showProjectSetupLog'); assert.match(target.logDocument.getText(), /install log/);
  assert.equal(target.logDocument.uri.scheme, 'file'); assert.equal(path.basename(target.logDocument.uri.fsPath), 'installation.log');
  target.manifestId = 'changed'; await target.execute('studio.retryProjectSetup', id); assert.match(target.errors.at(-1), /identity changed/);
  target.manifestId = id; target.install = undefined; await target.execute('studio.retryProjectSetup', id);
  assert.equal((await target.state()).pending.length, 0); assert.equal(target.remembered.id, id); assert.equal(f.created, 1);
  assert.equal(target.calls.some(([name]) => name === 'vscode.openFolder'), false);
  assert.ok(target.calls.some(([name]) => name === 'studio.refreshProjects'));
});

test('validation errors remain separate from dependency installation and retries retain a persistent file log', async t => {
  const f = fixture(t); await f.execute('studio.createProject', 'workflow');
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], inspect: async () => { target.inspectionErrors = ['specific script violation']; } });
  await until(async () => !(await target.state()).busy, 'Validation did not settle');
  const pending = (await target.state()).pending[0];
  assert.equal(pending.stage, 'validation'); assert.equal(pending.dependenciesInstalled, true);
  assert.equal(f.created, 1);
  await target.execute('studio.showProjectSetupLog');
  assert.match(target.logDocument.getText(), /Dependencies installed successfully[\s\S]*specific script violation/);
  target.controller.dispose();
  const restored = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)] });
  await restored.execute('studio.showProjectSetupLog'); assert.match(restored.logDocument.getText(), /specific script violation/);
  await restored.execute('studio.retryProjectSetup', id);
  assert.deepEqual(restored.installs, []); assert.equal(restored.created, undefined);
  assert.equal((await restored.state()).pending.length, 0);
});

test('ID allocation failure reports the error before a project window is opened', async t => {
  const f = fixture(t, { create: async () => { throw new Error('ID allocation offline'); } });
  await f.execute('studio.createProject', 'workflow');
  assert.equal(f.created, 1); assert.equal(f.remembered, undefined);
  assert.equal(f.calls.some(call => call[0] === 'vscode.openFolder'), false);
  assert.match(f.errors[0], /ID allocation offline/);
});

test('a retry reinstalls dependencies if a successful installation was subsequently removed', async t => {
  const f = fixture(t); await f.execute('studio.createProject', 'workflow');
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], inspect: async () => { throw new Error('validation offline'); } });
  await until(async () => !(await target.state()).busy, 'Setup did not settle');
  target.dependenciesPresent = false; target.inspect = undefined;
  await target.execute('studio.retryProjectSetup', id);
  assert.equal(target.installs.length, 2); assert.equal((await target.state()).pending.length, 0);
});

test('form and window-choice cancellation create nothing, while install cancellation stays in the project window', async t => {
  const f = fixture(t); f.name = undefined;
  await f.execute('studio.createProject'); assert.equal(f.created, undefined);
  assert.equal(f.dialog.templates.length, 2);
  assert.equal(f.dialog.parentDirectory, path.join((await import('node:os')).homedir(), 'Documents', 'steamharness-projects'));
  f.name = 'Cancelled opening'; f.newWindow = undefined;
  await f.execute('studio.createProject'); assert.equal(f.created, undefined);
  assert.equal(f.calls.some(([name]) => name === 'vscode.openFolder'), false);
  f.newWindow = true;
  f.name = 'Cancelled';
  await f.execute('studio.createExample', 'workflow-hello');
  assert.equal(f.dialog.templateId, 'workflow-hello');
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], install: async signal => { target.cancel(); signal.throwIfAborted(); } });
  await until(async () => !(await target.state()).busy, 'Cancellation did not settle');
  assert.equal((await target.state()).pending[0].status, 'cancelled'); assert.equal((await target.state()).pending[0].installOnOpen, false);
  const restored = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)] });
  await restored.execute('studio.refreshStart'); assert.deepEqual(restored.installs, []);
  assert.equal(f.calls.filter(([name]) => name === 'vscode.openFolder').length, 1);
  assert.equal(target.calls.some(([name]) => name === 'vscode.openFolder'), false);
});

test('current-window creation hands installation to the reloaded target workspace', async t => {
  const f = fixture(t); f.newWindow = false;
  await f.execute('studio.createProject', 'workflow');
  const opened = f.calls.find(([name]) => name === 'vscode.openFolder');
  assert.deepEqual({ ...opened[2] }, { forceNewWindow: false, forceReuseWindow: true });
  assert.deepEqual(f.installs, []);
  f.controller.dispose();
  const target = fixture(t, { storage: f.storage, folders: [opened[1].fsPath] });
  await until(() => target.remembered, 'Reusing the window did not resume setup');
  assert.deepEqual(target.installs, [opened[1].fsPath]);
  assert.equal((await target.state()).pending.length, 0);
});

test('retrying setup from another workspace asks for a window before changing the installation handoff', async t => {
  const f = fixture(t);
  await f.execute('studio.createProject');
  const pending = JSON.stringify(f.storage.get('studio.pendingProjectSetups'));
  f.newWindow = undefined;
  await f.execute('studio.retryProjectSetup', id);
  await f.execute('studio.openCreatedProject', id);
  assert.equal(f.calls.filter(([name]) => name === 'vscode.openFolder').length, 1);
  assert.equal(JSON.stringify(f.storage.get('studio.pendingProjectSetups')), pending);
  assert.deepEqual(f.installs, []);
  f.newWindow = false;
  await f.execute('studio.retryProjectSetup', id);
  const opened = f.calls.filter(([name]) => name === 'vscode.openFolder').at(-1);
  assert.deepEqual({ ...opened[2] }, { forceNewWindow: false, forceReuseWindow: true });
});

test('form validation returns inline errors and current-project cards receive paths and types', async t => {
  const f = fixture(t);
  f.validate = () => { throw Object.assign(new Error('conflict'), { code: 'directory-exists' }); };
  const validation = await f.execute('studio.internalValidateProjectCreation', { name: 'Existing', templateId: 'workflow-starter', parentDirectory: f.parent });
  assert.match(validation.error, /already exists/);
  f.projects = [
    { id, aggregateName: 'Aggregate', name: 'Board', uri: 'file:///board', entryId: 'board', folderPath: '/board', projectType: 'kanban', projectCard: { icon: 'boxes', iconColor: '#112233', iconBackgroundColor: '#aabbcc' } },
    { id, name: 'Assistant', uri: 'file:///assistant', projectType: 'conversation', assistant: {} },
  ];
  await f.execute('studio.refreshStart');
  const [{ avatarUrl, ...project }] = (await f.state()).projects;
  assert.match(decodeURIComponent(avatarUrl), /stroke="#112233"/);
  assert.match(decodeURIComponent(avatarUrl), /fill="#aabbcc"/);
  assert.deepEqual([project], [{ uri: 'file:///board', entryId: 'board', folderPath: '/board', name: 'Aggregate / Board', projectType: 'kanban',
    update: { status: 'unpublished', canDownload: false } }]);
});

test('cancellation during final inspection retains the project in its new window', async t => {
  const f = fixture(t);
  await f.execute('studio.createProject', 'workflow');
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], inspect: async () => target.cancel() });
  await until(async () => !(await target.state()).busy, 'Inspection cancellation did not settle');
  assert.equal((await target.state()).pending[0].status, 'cancelled'); assert.equal(target.remembered, undefined);
  assert.equal(target.calls.some(([name]) => name === 'vscode.openFolder'), false);
});

test('automatic installation requires the exact trusted project window and survives closing the source window', async t => {
  const f = fixture(t); await f.execute('studio.createProject', 'workflow'); f.controller.dispose();
  const directory = path.join(f.parent, f.name);
  const parent = fixture(t, { storage: f.storage, folders: [f.parent] });
  const multi = fixture(t, { storage: f.storage, folders: [directory, f.parent] });
  await parent.execute('studio.refreshStart'); await multi.execute('studio.refreshStart');
  assert.deepEqual([parent.installs, multi.installs], [[], []]);
  const target = fixture(t, { storage: f.storage, folders: [directory], trusted: false });
  await target.execute('studio.refreshStart'); assert.deepEqual(target.installs, []);
  target.grantTrust(); await until(() => target.remembered, 'Granting trust did not resume the target installation');
  assert.deepEqual(target.installs, [directory]);
  const restored = fixture(t, { storage: f.storage, folders: [directory] });
  await restored.execute('studio.refreshStart'); assert.deepEqual(restored.installs, []);
});

test('retrying in the source window hands installation back to an existing project window', async t => {
  const f = fixture(t); await f.execute('studio.createProject', 'workflow');
  const directory = path.join(f.parent, f.name);
  const target = fixture(t, { storage: f.storage, folders: [directory], install: async () => { throw new Error('offline registry'); } });
  await until(async () => !(await target.state()).busy, 'The failed setup did not settle');
  await f.execute('studio.retryProjectSetup', id);
  assert.equal(f.created, 1); assert.deepEqual(f.installs, []); assert.equal(f.progress.length, 1); assert.equal(f.progress[0].title, 'Applying for a new project ID');
  assert.equal(f.calls.filter(([name]) => name === 'vscode.openFolder').length, 2);
  target.install = undefined; target.focus(); target.focus();
  await until(() => target.remembered, 'The existing project window did not retry');
  assert.deepEqual(target.installs, [directory, directory]); assert.equal(target.calls.some(([name]) => name === 'vscode.openFolder'), false);
});

test('a changed project identity and a failed window open never install in the source window', async t => {
  const f = fixture(t); f.open = async () => { throw new Error('window unavailable'); };
  await f.execute('studio.createProject', 'workflow'); assert.match(f.errors.at(-1), /window unavailable/);
  assert.equal((await f.state()).pending[0].installOnOpen, true); assert.deepEqual(f.installs, []);
  f.open = undefined; await f.execute('studio.retryProjectSetup', id);
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], manifestId: 'changed' });
  await until(() => target.errors.length, 'A changed identity was not reported');
  assert.match(target.errors[0], /identity changed/); assert.deepEqual(target.installs, []);
  await target.execute('studio.refreshStart'); target.focus();
  assert.equal(target.errors.length, 1); assert.equal((await target.state()).pending[0].installOnOpen, false);
});
