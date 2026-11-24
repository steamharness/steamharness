import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/start-page.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
const id = '8f6a6240-4860-4efc-bd07-932868be2b98';
const templateCatalog = JSON.parse(await readFile(new URL('../../cli/src/project-templates/catalog.json', import.meta.url), 'utf8'));
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}
const uri = filename => ({ scheme: 'file', fsPath: filename, toString: () => pathToFileURL(filename).href });
function fixture(t, options = {}) {
  const commands = new Map(), storage = options.storage ?? new Map(), calls = [], intervals = new Map(), projectsChanged = new Emitter(), accountChanged = new Emitter(), trustChanged = new Emitter(), windowChanged = new Emitter(), workspaceChanged = new Emitter();
  const files = storage.get('test.files') ?? new Map(); storage.set('test.files', files);
  const f = { calls, storage, intervals, projectsChanged, accountChanged, projects: [], recent: [], warnings: [], errors: [], installs: [], progress: [],
    name: 'New project', parent: path.resolve('/projects'), newWindow: true, inspectedId: id, manifestId: options.manifestId ?? id,
    files, install: options.install, inspect: options.inspect, create: options.create, register: options.register,
    projectId: options.projectId ?? id, idAllocationError: options.idAllocationError,
    account: options.account ?? { status: 'signed-out', serverUrl: 'http://localhost:7126' } };
  const vscode = {
    EventEmitter: Emitter, env: { language: options.language ?? 'en' }, ProgressLocation: { Notification: 15 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    extensions: { getExtension: name => name === 'vscode.typescript-language-features' ? { isActive: options.typescriptActive === true } : undefined },
    Uri: { file: uri, parse: value => ({ fsPath: value.startsWith('file:') ? fileURLToPath(value) : value, toString: () => value }),
      joinPath: (parent, ...parts) => uri(path.join(parent.fsPath, ...parts)) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose: () => commands.delete(name) }; },
      executeCommand: async (name, ...args) => {
        calls.push([name, ...args]);
        if (name === 'studio.internalShowCreateProject') {
          f.dialog = args[0];
          return f.name === undefined ? undefined : { name: f.name, parentDirectory: f.parent, templateId: f.dialog.templateId ?? f.dialog.templates[0].id };
        }
        if (name === 'typescript.reloadProjects') { return options.reloadTypeScript?.(); }
        return name === 'vscode.openFolder' ? f.open?.(...args) : commands.get(name)?.(...args);
      } },
    workspace: { isTrusted: options.trusted ?? true, workspaceFolders: (options.folders ?? []).map(directory => ({ uri: uri(directory) })),
      onDidGrantWorkspaceTrust: trustChanged.event, onDidChangeConfiguration: new Emitter().event, onDidChangeWorkspaceFolders: workspaceChanged.event,
      openTextDocument: async value => ({ uri: value, getText: () => new TextDecoder().decode(files.get(value.fsPath)) }),
      fs: { readFile: async value => {
        if (path.basename(value.fsPath) === 'steamharness.json') { return Buffer.from(JSON.stringify({ id: f.manifestId })); }
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
    templates: async () => options.templates ?? [ { id: 'workflow-starter', projectType: 'workflow', kind: 'starter', name: 'Workflow', description: 'Minimal' },
      { id: 'workflow-hello', projectType: 'workflow', kind: 'example', name: 'Hello', description: 'Offline' } ],
    createProject: async input => { f.created = (f.created ?? 0) + 1; await f.create?.(); return { id: f.projectId, idAllocationError: f.idAllocationError, name: input.name, directory: path.join(input.parentDirectory, input.name), projectType: options.projectType ?? 'workflow', entryFile: options.templates?.find(template => template.id === input.templateId)?.entryFile ?? (options.projectType === 'kanban' ? 'index.html' : 'index.ts') }; },
    registerProject: async directory => { f.registrations = (f.registrations ?? 0) + 1; await f.register?.(directory); f.manifestId = id; return id; },
    validateProjectCreation: async input => { await f.validate?.(input); },
    installDependencies: async (directory, signal, log) => { f.installs.push(directory); log('install log'); await f.install?.(signal); },
    hasProjectDependencies: async () => f.dependenciesPresent !== false,
    prepareProjectTemplate: async () => { f.prepares = (f.prepares ?? 0) + 1; return false; },
    inspect: async () => { await f.inspect?.(); return { projects: [{ id: f.inspectedId }], errors: f.inspectionErrors ?? [] }; },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    AbortController, AbortSignal, Error, DOMException, structuredClone, TextDecoder, TextEncoder, URL, process, crypto: globalThis.crypto, setTimeout, clearTimeout,
    setInterval: (callback, ms) => { const key = {}; intervals.set(key, { callback, ms }); return key; }, clearInterval: key => intervals.delete(key) });
  if (options.recommendations) {
    const registration = module.exports.registerStartRecommendationsProvider(options.recommendations);
    t.after(() => registration.dispose());
  }
  const controller = new module.exports.StudioStartController({ globalStorageUri: uri(path.resolve('/studio-storage')), extension: { packageJSON: { version: '0.1.0' } }, globalState: {
    get: key => storage.get(key), update: async (key, value) => storage.set(key, value) } }, launcher,
  { platform: options.platform, getState: () => f.account, onDidChange: accountChanged.event }, {
    getProjects: () => f.projects, onDidChangeProjects: projectsChanged.event,
    getVersionStatus: () => ({ status: 'unpublished', canDownload: false }), onDidChangeVersions: new Emitter().event,
  },
  { getChildren: () => f.recent, onDidChangeTreeData: new Emitter().event, reconcile: async () => { await f.reconcile?.(); } }, async project => { f.remembered = project; }, { appendLine() {}, append() {} });
  t.after(() => controller.dispose());
  return Object.assign(f, { controller, execute: vscode.commands.executeCommand, state: async () => commands.get('studio.internalGetStartState')(),
    savedSetups: () => storage.get('studio.pendingProjectSetups') ?? [],
    setWorkspace: (folders, workspaceFile) => {
      vscode.workspace.workspaceFolders = folders.map(value => ({ uri: vscode.Uri.parse(value) }));
      vscode.workspace.workspaceFile = workspaceFile ? vscode.Uri.parse(workspaceFile) : undefined;
      workspaceChanged.fire();
    },
    grantTrust: () => { vscode.workspace.isTrusted = true; trustChanged.fire(); }, focus: () => windowChanged.fire({ focused: true }) });
}

async function until(read, message) {
  for (let i = 0; i < 100; i++) { if (await read()) { return; } await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(message);
}

test('only the visible launchpad polls, and its refresh still reconciles removed recents', async t => {
  const f = fixture(t, { platform: true });
  await f.execute('studio.internalStartPageVisibility', false); await f.execute('studio.refreshStart');
  assert.equal(f.intervals.size, 0);
  f.recent = [{ uri: 'file:///deleted', label: 'Deleted', kind: 'folder', lastOpened: 1 }];
  await f.execute('studio.refreshStart');
  assert.equal((await f.state()).recent.length, 1);
  f.reconcile = async () => { f.recent = []; };
  await f.execute('studio.internalStartPageVisibility', true); await f.execute('studio.refreshStart');
  assert.equal(f.intervals.size, 1); assert.equal([...f.intervals.values()][0].ms, 5000);
  const state = await f.state();
  assert.deepEqual({ recent: state.recent, canCreate: state.canCreate, platform: state.platform }, { recent: [], canCreate: true, platform: true });
  assert.ok(!('summary' in state) && !('environment' in state));
  await f.execute('studio.internalStartPageVisibility', false); assert.equal(f.intervals.size, 0);
});

test('overview groups current workspace projects and keeps entries in declaration order, including unavailable entries', async t => {
  const f = fixture(t, { language: 'zh-cn' });
  f.setWorkspace(['file:///workspace']);
  const entries = [{ entryId: 'agent', type: 'bot', name: 'Agent' }, { entryId: 'database', type: 'workflow', name: 'Database' },
    { entryId: 'map-2d', type: 'kanban', name: 'Map 2D', projectInfo: { localizedNames: { 'zh-CN': '地图' } } }];
  f.projects = entries.slice(0, 2).reverse().map(({ entryId, type }) => ({ id, aggregateName: 'Aggregate', name: `Resolved ${entryId}`,
    uri: 'file:///workspace/aggregate', folderPath: '/workspace/aggregate', entryId, projectType: type, defaultEntry: 'database',
    entries, manifest: { version: '1.2.3', description: 'Project description' } }));
  f.projects.push({ ...f.projects[0], uri: 'file:///workspace-other/same-name' }, { ...f.projects[0], uri: 'file:///workspace/assistant', assistant: {} },
    { ...f.projects[0], uri: 'file:///workspace/analysis', builtin: 'analysis' });
  await f.execute('studio.refreshStart');
  const { projects, hasWorkspace } = await f.state();
  assert.equal(hasWorkspace, true);
  assert.deepEqual(projects.map(({ uri, defaultEntry, name, projectType, version, description }) => ({ uri, defaultEntry, name, projectType, version, description })),
    [{ uri: 'file:///workspace/aggregate', defaultEntry: 'database', name: 'Aggregate', projectType: 'aggregate', version: '1.2.3', description: 'Project description' }]);
  assert.deepEqual(projects[0].entries.map(({ entryId, name, projectType, available }) => ({ entryId, name, projectType, available })), [
    { entryId: 'agent', name: 'Resolved agent', projectType: 'bot', available: true },
    { entryId: 'database', name: 'Resolved database', projectType: 'workflow', available: true },
    { entryId: 'map-2d', name: '地图', projectType: 'kanban', available: false },
  ]);
  assert.ok(projects[0].entries.every(entry => entry.avatarUrl.startsWith('data:image/svg+xml,')));
  f.setWorkspace([]);
  await f.execute('studio.refreshStart');
  assert.deepEqual((await f.state()).projects, []);
  assert.equal((await f.state()).hasWorkspace, false);
});

test('recent projects identify current folders and workspace files by URI and refresh when the workspace changes', async t => {
  const f = fixture(t);
  const uris = ['file:///projects/demo', 'file:///other/demo', 'file:///projects/team.code-workspace',
    'vscode-remote://ssh-remote+host/projects/demo', 'file:///projects'];
  f.recent = uris.map((uri, index) => ({ uri, label: 'Same name', kind: index === 2 ? 'workspace' : 'folder', lastOpened: 1, current: true }));
  await f.execute('studio.refreshStart');
  assert.deepEqual((await f.state()).recent.map(project => project.current), [false, false, false, false, false]);
  f.setWorkspace([uris[0], uris[3]], uris[2]);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual((await f.state()).recent.map(project => project.current), [true, false, true, true, false]);
  f.setWorkspace([]);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual((await f.state()).recent.map(project => project.current), [false, false, false, false, false]);
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
  assert.deepEqual(f.installs, []); assert.equal(f.progress.length, 1); assert.equal(f.progress[0].title, 'Creating Project');
  assert.equal(f.savedSetups()[0].installOnOpen, true);
  assert.deepEqual((await f.state()).pending, []);
  const target = fixture(t, { storage: f.storage, folders: [opened[1].fsPath], typescriptActive: true,
    install: () => new Promise((_resolve, reject) => { failInstall = () => reject(new Error('offline registry')); }) });
  await until(() => failInstall, 'The new project window did not start installation');
  assert.equal(target.calls.some(([name]) => name === 'typescript.reloadProjects'), false);
  assert.equal((await target.state()).installing, id); assert.equal(target.savedSetups()[0].installOnOpen, false);
  assert.equal(target.progress.length, 1); assert.equal(target.installs[0], opened[1].fsPath);
  assert.deepEqual(f.installs, []); assert.equal(f.progress.length, 1); assert.equal(f.progress[0].title, 'Creating Project');
  failInstall(); await until(async () => !(await target.state()).busy, 'Installation did not finish');
  assert.equal((await target.state()).pending[0].status, 'failed');
  assert.equal(target.calls.some(([name]) => name === 'typescript.reloadProjects'), false);
  await target.execute('studio.showProjectSetupLog', id); assert.match(target.logDocument.getText(), /install log/);
  assert.equal(target.logDocument.uri.scheme, 'file'); assert.equal(path.basename(target.logDocument.uri.fsPath), 'installation.log');
  target.manifestId = 'changed'; await target.execute('studio.retryProjectSetup', id); assert.match(target.errors.at(-1), /identity changed/);
  target.manifestId = id; target.install = undefined; await target.execute('studio.retryProjectSetup', id);
  assert.equal((await target.state()).pending.length, 0); assert.equal(target.remembered.id, id); assert.equal(f.created, 1);
  assert.equal(target.calls.some(([name]) => name === 'vscode.openFolder'), false);
  assert.equal(target.calls.filter(([name]) => name === 'typescript.reloadProjects').length, 1);
  assert.ok(target.calls.some(([name]) => name === 'studio.refreshProjects'));
});

test('a rejected TypeScript reload does not fail an otherwise successful project setup', async t => {
  const f = fixture(t); await f.execute('studio.createProject', 'workflow');
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], typescriptActive: true,
    reloadTypeScript: async () => { throw new Error('TypeScript command unavailable'); } });
  await until(async () => !(await target.state()).busy, 'Setup did not settle');
  assert.ok(target.calls.some(([name]) => name === 'typescript.reloadProjects'));
  assert.equal((await target.state()).pending.length, 0);
  assert.deepEqual(target.warnings, []);
});

test('validation errors remain separate from dependency installation and retries retain a persistent file log', async t => {
  const f = fixture(t); await f.execute('studio.createProject', 'workflow');
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], inspect: async () => { target.inspectionErrors = ['specific script violation']; } });
  await until(async () => !(await target.state()).busy, 'Validation did not settle');
  const pending = target.savedSetups()[0];
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

test('source generation failure reports the error before a project window is opened', async t => {
  const f = fixture(t, { create: async () => { throw new Error('Project folder is not writable'); } });
  await f.execute('studio.createProject', 'workflow');
  assert.equal(f.created, 1); assert.equal(f.remembered, undefined);
  assert.equal(f.calls.some(call => call[0] === 'vscode.openFolder'), false);
  assert.match(f.errors[0], /not writable/);
});

for (const newWindow of [true, false]) test(`creation opens the ${newWindow ? 'new' : 'current'} window before registration or dependency installation`, async t => {
  const f = fixture(t, { projectId: '', manifestId: '' }); f.newWindow = newWindow;
  await f.execute('studio.createProject', 'workflow');
  const opened = f.calls.find(([name]) => name === 'vscode.openFolder');
  assert.ok(opened); assert.equal(opened[2].forceNewWindow, newWindow);
  assert.deepEqual(f.installs, []); assert.equal(f.registrations, undefined);
  assert.equal(f.savedSetups()[0].projectId, '');
  f.controller.dispose();
  const target = fixture(t, { storage: f.storage, folders: [opened[1].fsPath], manifestId: '' });
  await until(() => target.remembered, 'Setup did not complete in the selected window');
  assert.deepEqual(target.installs, [opened[1].fsPath]); assert.equal(target.registrations, 1);
  assert.equal(target.remembered.id, id); assert.equal(target.created, undefined);
  assert.equal((await target.state()).pending.length, 0);
});

for (const template of templateCatalog) for (const newWindow of [true, false]) {
  test(`${template.id} completes setup in the ${newWindow ? 'new' : 'current'} project window`, async t => {
    const templates = [{ ...template, name: template.name.en, description: template.description.en }];
    const f = fixture(t, { templates, projectType: template.projectType, projectId: '', manifestId: '' });
    f.name = template.id; f.newWindow = newWindow;
    await f.execute(template.kind === 'example' ? 'studio.createExample' : 'studio.createProject', template.kind === 'example' ? template.id : template.projectType);
    const opened = f.calls.find(([name]) => name === 'vscode.openFolder');
    assert.ok(opened); assert.equal(opened[2].forceNewWindow, newWindow);
    assert.equal(f.registrations, undefined); assert.deepEqual(f.installs, []);
    assert.equal(f.savedSetups()[0].entryFile, template.entryFile);
    f.controller.dispose();
    const target = fixture(t, { templates, projectType: template.projectType, storage: f.storage, folders: [opened[1].fsPath], manifestId: '', typescriptActive: true });
    await until(() => target.remembered, 'Template setup did not complete in its project window');
    assert.equal(target.created, undefined); assert.equal(target.registrations, 1);
    assert.deepEqual(target.installs, [opened[1].fsPath]); assert.deepEqual(target.errors, []);
    assert.equal(target.calls.filter(([name]) => name === 'typescript.reloadProjects').length, template.entryFile.endsWith('.ts') ? 1 : 0);
    assert.equal((await target.state()).pending.length, 0);
  });
}

test('ID allocation errors in the opened project window retain its files and can be retried', async t => {
  const f = fixture(t, { projectId: '', manifestId: '' });
  await f.execute('studio.createProject');
  const pending = f.savedSetups()[0];
  const target = fixture(t, { storage: f.storage, folders: [pending.directory], manifestId: '', register: async () => { throw new Error('Server offline'); } });
  await until(async () => !(await target.state()).busy, 'Registration failure did not settle');
  assert.equal(target.registrations, 1); assert.equal(target.savedSetups()[0].projectId, '');
  assert.equal((await target.state()).pending[0].stage, 'registration');
  assert.match(target.warnings[0], /Project files were created.*Server offline/);
  target.register = undefined;
  await target.execute('studio.retryProjectSetup', pending.id);
  assert.equal(target.registrations, 2); assert.equal(target.installs.length, 1);
  assert.equal((await target.state()).pending.length, 0); assert.equal(target.remembered.id, id);
});

test('an empty-ID project installs dependencies and generates a local ID in place', async t => {
  const f = fixture(t, { projectId: '', manifestId: '', idAllocationError: 'Local Node runtime unavailable' });
  await f.execute('studio.createProject', 'workflow');
  const opened = f.calls.find(([name]) => name === 'vscode.openFolder');
  assert.ok(opened); assert.equal(f.remembered.id, ''); assert.deepEqual(f.errors, []);
  const pending = f.savedSetups()[0];
  assert.equal(pending.projectId, ''); assert.match(pending.id, /^[a-f0-9-]{36}$/i);
  const target = fixture(t, { storage: f.storage, folders: [opened[1].fsPath], manifestId: '' });
  await until(async () => !(await target.state()).busy, 'Unregistered setup did not settle');
  assert.deepEqual(target.installs, [opened[1].fsPath]); assert.equal(target.registrations, 1);
  assert.equal(target.created, undefined);
  assert.equal((await target.state()).pending.length, 0); assert.equal(target.remembered.id, id);
  assert.equal(target.storage.get('studio.importedProjects')[0].id, id);
});

test('multiple projects without IDs keep separate setup records and logs across reloads', async t => {
  const f = fixture(t, { projectId: '', manifestId: '', idAllocationError: 'Local Node runtime unavailable' });
  await f.execute('studio.createProject'); f.name = 'Second project'; await f.execute('studio.createProject');
  const pending = f.savedSetups();
  assert.equal(pending.length, 2); assert.notEqual(pending[0].id, pending[1].id);
  const targets = pending.map(project => fixture(t, { storage: f.storage, folders: [project.directory], manifestId: '', register: async () => { throw new Error('Local Node runtime unavailable'); } }));
  for (const target of targets) await until(async () => !(await target.state()).busy, 'Setup did not settle');
  const logPaths = [];
  for (const [index, target] of targets.entries()) {
    assert.deepEqual((await target.state()).pending.map(project => project.id), [pending[index].id]);
    await target.execute('studio.showProjectSetupLog', pending[1 - index].id);
    assert.equal(target.logDocument, undefined);
    await target.execute('studio.showProjectSetupLog', pending[index].id);
    logPaths.push(target.logDocument.uri.fsPath);
    assert.match(target.logDocument.getText(), /Local Node runtime unavailable/);
  }
  assert.notEqual(logPaths[0], logPaths[1]);
  const restored = fixture(t, { storage: f.storage });
  assert.deepEqual((await restored.state()).pending, []);
  assert.equal(restored.savedSetups().length, 2);
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
  assert.equal((await target.state()).pending[0].status, 'cancelled'); assert.equal(target.savedSetups()[0].installOnOpen, false);
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
  f.setWorkspace(['file:///board']);
  f.validate = () => { throw Object.assign(new Error('conflict'), { code: 'directory-exists' }); };
  const validation = await f.execute('studio.internalValidateProjectCreation', { name: 'Existing', templateId: 'workflow-starter', parentDirectory: f.parent });
  assert.match(validation.error, /already exists/);
  f.projects = [
    { id, aggregateName: 'Aggregate', name: 'Board', uri: 'file:///board', entryId: 'board', defaultEntry:'board', entries:[{entryId:'board',type:'kanban'}], folderPath: '/board', projectType: 'kanban', aggregateProjectCard: { icon: 'boxes', iconColor: '#112233', iconBackgroundColor: '#aabbcc' } },
    { id, name: 'Assistant', uri: 'file:///assistant', projectType: 'bot', assistant: {} },
  ];
  await f.execute('studio.refreshStart');
  const [{ avatarUrl, uri, defaultEntry, folderPath, name, projectType }] = (await f.state()).projects;
  assert.match(decodeURIComponent(avatarUrl), /stroke="#112233"/);
  assert.match(decodeURIComponent(avatarUrl), /fill="#aabbcc"/);
  assert.deepEqual({ uri, defaultEntry, folderPath, name, projectType }, { uri: 'file:///board', defaultEntry: 'board', folderPath: '/board', name: 'Aggregate', projectType: 'kanban' });
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
  assert.equal(f.created, 1); assert.deepEqual(f.installs, []); assert.equal(f.progress.length, 1); assert.equal(f.progress[0].title, 'Creating Project');
  assert.equal(f.calls.filter(([name]) => name === 'vscode.openFolder').length, 2);
  target.install = undefined; target.focus(); target.focus();
  await until(() => target.remembered, 'The existing project window did not retry');
  assert.deepEqual(target.installs, [directory, directory]); assert.equal(target.calls.some(([name]) => name === 'vscode.openFolder'), false);
});

test('a changed project identity and a failed window open never install in the source window', async t => {
  const f = fixture(t); f.open = async () => { throw new Error('window unavailable'); };
  await f.execute('studio.createProject', 'workflow'); assert.match(f.errors.at(-1), /window unavailable/);
  assert.equal(f.savedSetups()[0].installOnOpen, true); assert.deepEqual(f.installs, []);
  f.open = undefined; await f.execute('studio.retryProjectSetup', id);
  const target = fixture(t, { storage: f.storage, folders: [path.join(f.parent, f.name)], manifestId: 'changed' });
  await until(() => target.errors.length, 'A changed identity was not reported');
  assert.match(target.errors[0], /identity changed/); assert.deepEqual(target.installs, []);
  await target.execute('studio.refreshStart'); target.focus();
  assert.equal(target.errors.length, 1); assert.equal(target.savedSetups()[0].installOnOpen, false);
});


test('the launchpad retains recommendations and rejects unknown app actions', async t => {
  const opened = [];
  const provider = { id: 'catalog', title: 'Recommended apps', openLabel: 'View app', browseLabel: 'Browse apps', loadingMessage: 'Loading', emptyMessage: 'No recommendations', unavailableMessage: 'Unavailable', contextKey: () => 'server-a',
    load: async () => ({ items: [{ id: 'app-one', name: '<App>', description: 'Plain text', projectType: 'bot', projectCard: { icon: 'bot' } }] }), open: value => opened.push(value) };
  const f = fixture(t, { recommendations: provider });
  await f.execute('studio.internalStartPageVisibility', true); await f.execute('studio.refreshStart');
  const first = await f.state(); assert.equal(first.recommendations.title, 'Recommended apps');
  assert.equal(first.recommendations.items[0].name, '<App>'); assert.match(first.recommendations.items[0].avatarUrl, /^data:image\/svg\+xml,/);
  await f.execute('studio.openStartRecommendation', 'not-loaded'); assert.equal(opened.length, 0);
  await f.execute('studio.openStartRecommendation', 'app-one'); assert.deepEqual(opened, ['app-one']);
  f.setWorkspace(['file:///ordinary-folder']); await f.execute('studio.refreshStart');
  assert.equal((await f.state()).recommendations, undefined);
  await f.execute('studio.openStartRecommendation', 'app-one'); assert.equal(opened.length, 1);
});

test('recommendations ignore responses from previous servers and preserve the last good list on failure', async t => {
  let key = 'old', release, fail = false, reads = 0;
  const provider = { id: 'catalog', title: 'Recommended apps', openLabel: 'View app', browseLabel: 'Browse apps', loadingMessage: 'Loading', emptyMessage: 'Empty', unavailableMessage: 'Unavailable', contextKey: () => key,
    load: async () => { reads++; if (reads === 1) return new Promise(resolve => { release = resolve; }); if (fail) throw new Error('offline'); return { items: [{ id: key, name: key }] }; }, open() {} };
  const f = fixture(t, { recommendations: provider });
  await f.execute('studio.internalStartPageVisibility', true);
  await until(() => reads === 1, 'recommendation request did not start');
  key = 'new'; f.accountChanged.fire(); release({ items: [{ id: 'old', name: 'old' }] });
  await f.execute('studio.refreshStart');
  assert.deepEqual((await f.state()).recommendations.items.map(item => item.id), ['new']);
  fail = true; await f.execute('studio.refreshStart');
  const state = await f.state(); assert.deepEqual(state.recommendations.items.map(item => item.id), ['new']);
  assert.equal(state.recommendations.message, 'Unavailable');
});
