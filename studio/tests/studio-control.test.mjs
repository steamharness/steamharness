import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { IMPORTED_PROJECTS_KEY } from '../extensions/studio-workstation/src/projects.ts';

const require = createRequire(import.meta.url);
const compile = async entry => (await build({ entryPoints: [`extensions/studio-workstation/src/${entry}.ts`], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], write: false })).outputFiles[0].text;
const [hostCode, bridgeCode] = await Promise.all([compile('studio-control'), compile('studio-control-bridge')]);
function load(code, vscode = {}) {
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    process, Buffer, AbortSignal, TextDecoder, URL, setTimeout, clearTimeout });
  return module.exports;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-control-host-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'workspace'), linked = path.join(root, 'linked'), outside = path.join(root, 'outside');
  for (const directory of [workdir, linked, outside]) { await mkdir(directory); await writeFile(path.join(directory, 'index.ts'), 'first\nsecond\n'); }
  await symlink(path.join(outside, 'index.ts'), path.join(workdir, 'leak.ts'));
  const parseUri = value => { const url = new URL(value); return { scheme: url.protocol.slice(0, -1), fsPath: decodeURIComponent(url.pathname), path: url.pathname, toString: () => value }; };
  const uri = file => parseUri(pathToFileURL(file).href);
  const roots = [workdir, linked].map(folderPath => ({ folderPath, uri: pathToFileURL(folderPath).href, name: path.basename(folderPath) }));
  const events = [];
  const vscode = {
    version: '1.140.0', env: { appName: 'Studio', language: 'en' },
    Uri: { file: uri, parse: parseUri, joinPath: (root, ...parts) => {
      const url = new URL(root.toString()); url.pathname = path.posix.join(decodeURIComponent(url.pathname), ...parts); return parseUri(url.href);
    } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    extensions: { all: [{ packageJSON: { contributes: { themes: [{ id: 'Dark' }, { label: 'Light' }] } } }] },
    workspace: {
      isTrusted: true, workspaceFolders: roots.map(root => ({ name: root.name, uri: uri(root.folderPath) })),
      fs: { readFile: target => readFile(target.fsPath) },
      getConfiguration: section => ({ get: () => section === 'workbench' ? 'Dark' : true, inspect: () => undefined,
        update: async (...args) => events.push(['theme', ...args]) }),
      openTextDocument: async documentUri => ({ uri: documentUri, validatePosition: position => position }),
    },
    window: {
      activeTextEditor: { document: { uri: uri(path.join(workdir, 'index.ts')), languageId: 'typescript', isDirty: true }, selection: { active: { line: 1, character: 2 } } },
      showTextDocument: async (document, options) => { events.push(['file', document.uri.fsPath]); return { selection: { active: options.selection?.start ?? { line: 0, character: 0 } } }; },
      createTerminal: options => ({ name: options.name, show: () => events.push(['terminal', options.cwd]), sendText: () => assert.fail('Control must not execute commands.') }),
    },
    languages: { getDiagnostics: () => [] }, commands: { executeCommand: async command => events.push(['view', command]) },
  };
  const controller = new AbortController();
  const state = new Map([[IMPORTED_PROJECTS_KEY, []]]);
  const execute = load(hostCode, vscode).createStudioControlHandler({ workdir, roots }, controller.signal, { globalState: { get: key => state.get(key) } });
  return { execute, vscode, events, controller, roots, workdir, linked, outside, uri, state };
}

const ids = ['294b1eec-23fa-42cf-9fd3-2417f71c0570', '615e6cf6-b40a-456a-8d19-b71c63454c7a', '4d8d3580-6356-42b1-a8f0-2a14b0a7b955'];
const manifest = (id, relatedProjects = []) => ({ id, name: 'Notes', workflowCode: { projectInfo: { relatedProjects, localizedNames: { en: 'English notes', 'zh-cn': 'Chinese notes' } } } });
const saveManifest = (directory, value) => writeFile(path.join(directory, 'package.json'), JSON.stringify(value));

for (const [language, name] of [['en', 'English notes'], ['zh-cn', 'Chinese notes'], ['fr', 'English notes']]) {
test(`related project queries verify imports, retain missing declarations and resolve ${language} names`, async t => {
  const f = await fixture(t); f.vscode.env.language = language;
  await saveManifest(f.workdir, manifest(ids[0], [{ alias: 'notes', projectId: ids[1] }, { alias: 'missing', projectId: ids[2] }]));
  await saveManifest(f.outside, manifest(ids[1]));
  await saveManifest(f.linked, manifest(ids[0]));
  f.state.set(IMPORTED_PROJECTS_KEY, [
    { id: ids[1], uri: f.uri(f.linked).toString(), name: 'Stale UUID' },
    { id: ids[1], uri: f.uri(f.outside).toString(), name: 'Old name' },
  ]);
  const result = await f.execute('studio.relatedProjects.get', {});
  assert.equal(result.projectId, ids[0]); assert.equal(result.projectDir, await realpath(f.workdir));
  assert.deepEqual(JSON.parse(JSON.stringify(result.relatedProjects)), [
    { alias: 'notes', projectId: ids[1], imported: true, name, uri: f.uri(f.outside).toString(), projectDir: await realpath(f.outside) },
    { alias: 'missing', projectId: ids[2], imported: false, name: null, uri: null, projectDir: null },
  ]);
  await assert.rejects(f.execute('studio.file.open', { filePath: path.join(f.outside, 'index.ts') }));
  assert.equal(f.events.length, 0);
});
}

test('related project queries use the requested project and recheck imports and manifests on every call', async t => {
  const f = await fixture(t);
  await saveManifest(f.linked, manifest(ids[0], [{ alias: 'notes', projectId: ids[1] }]));
  await saveManifest(f.outside, manifest(ids[1]));
  const input = { projectDir: f.linked };
  assert.equal((await f.execute('studio.relatedProjects.get', input)).relatedProjects[0].imported, false);
  f.state.set(IMPORTED_PROJECTS_KEY, [{ id: ids[1], uri: f.uri(f.outside).toString(), name: 'Notes' }]);
  assert.equal((await f.execute('studio.relatedProjects.get', input)).relatedProjects[0].imported, true);
  await saveManifest(f.outside, manifest(ids[2]));
  const changed = (await f.execute('studio.relatedProjects.get', input)).relatedProjects[0];
  assert.equal(changed.imported, false); assert.equal(changed.projectDir, null);
  await saveManifest(f.linked, manifest(ids[0]));
  assert.equal((await f.execute('studio.relatedProjects.get', input)).relatedProjects.length, 0);
});

test('related project queries reject out-of-scope paths, escaping manifest symlinks and invalid project UUIDs', async t => {
  const f = await fixture(t);
  await saveManifest(f.outside, manifest(ids[1]));
  await symlink(path.join(f.outside, 'package.json'), path.join(f.workdir, 'package.json'));
  for (const input of [{}, { projectDir: f.outside }, { projectDir: 'index.ts' }, { projectDir: [] }, { projectDir: '' }, { command: 'arbitrary' }]) {
    await assert.rejects(f.execute('studio.relatedProjects.get', input));
  }
  await saveManifest(f.linked, { name: 'Ordinary package' });
  await assert.rejects(f.execute('studio.relatedProjects.get', { projectDir: f.linked }), /Workflow project directory/);
  assert.equal(f.events.length, 0);
});

test('remote related imports expose their URI without claiming a local directory', async t => {
  const f = await fixture(t);
  const remote = 'vscode-remote://ssh-remote+host/workspace/notes';
  await saveManifest(f.workdir, manifest(ids[0], [{ alias: 'notes', projectId: ids[1] }]));
  f.state.set(IMPORTED_PROJECTS_KEY, [{ id: ids[1], uri: remote, name: 'Notes' }]);
  const read = f.vscode.workspace.fs.readFile;
  f.vscode.workspace.fs.readFile = target => target.toString() === `${remote}/package.json`
    ? Promise.resolve(Buffer.from(JSON.stringify(manifest(ids[1])))) : read(target);
  const related = (await f.execute('studio.relatedProjects.get', {})).relatedProjects[0];
  assert.equal(related.imported, true); assert.equal(related.uri, remote); assert.equal(related.projectDir, null);
});

test('state exposes registered scope and themes while hiding an editor outside the scope', async t => {
  const f = await fixture(t);
  const state = await f.execute('studio.state.get', {});
  assert.equal(state.activeEditor.filePath, await realpath(path.join(f.workdir, 'index.ts')));
  assert.equal(state.activeEditor.line, 2);
  assert.deepEqual(Array.from(state.themes), ['Dark', 'Light']);
  assert.equal(state.folders.length, 2);
  assert.equal(state.permissionPolicy, 'workspace'); assert.equal(state.pathAccess, 'workspace');
  f.vscode.window.activeTextEditor.document.uri = f.uri(path.join(f.outside, 'index.ts'));
  assert.equal((await f.execute('studio.state.get', {})).activeEditor, null);
});

test('a nested control project uses its own directory while retaining the opened workspace scope', async t => {
  const f = await fixture(t);
  const project = path.join(f.workdir, 'build-in', 'studio-control');
  await mkdir(project, { recursive: true });
  await saveManifest(project, manifest(ids[0]));
  await writeFile(path.join(project, 'control.txt'), 'control\n');
  const execute = load(hostCode, f.vscode).createStudioControlHandler({ workdir: project, roots: f.roots }, f.controller.signal,
    { globalState: { get: key => f.state.get(key) } });
  assert.equal((await execute('studio.state.get', {})).workdir, project);
  assert.equal((await execute('studio.relatedProjects.get', {})).projectDir, await realpath(project));
  assert.equal((await execute('studio.file.open', { filePath: 'control.txt' })).filePath, await realpath(path.join(project, 'control.txt')));
  await execute('studio.terminal.open', {});
  assert.deepEqual(f.events.at(-1), ['terminal', await realpath(project)]);
  await assert.rejects(execute('studio.file.open', { filePath: path.join(f.outside, 'index.ts') }), /only access/);
  f.vscode.workspace.workspaceFolders = [];
  await assert.rejects(execute('studio.state.get', {}), /workspace is no longer available/);
});

test('a control project outside the opened workspace cannot register a scope', async t => {
  const f = await fixture(t);
  const execute = load(hostCode, f.vscode).createStudioControlHandler({ workdir: `${f.workdir}-other`, roots: f.roots }, f.controller.signal,
    { globalState: { get: key => f.state.get(key) } });
  await assert.rejects(execute('studio.state.get', {}), /workspace is no longer available/);
});

test('auto permits external files, diagnostics, terminals and project queries while other policies keep their scope', async t => {
  const f = await fixture(t);
  const outsideFile = path.join(f.outside, 'index.ts');
  await saveManifest(f.outside, manifest(ids[1]));
  for (const policy of ['workspace', 'read-only']) {
    await assert.rejects(f.execute('studio.file.open', { filePath: outsideFile }, policy), /only access/);
    await assert.rejects(f.execute('studio.relatedProjects.get', { projectDir: f.outside }, policy), /only access/);
  }
  f.vscode.window.activeTextEditor.document.uri = f.uri(outsideFile);
  const state = await f.execute('studio.state.get', {}, 'auto');
  assert.equal(state.permissionPolicy, 'auto'); assert.equal(state.pathAccess, 'all');
  assert.equal(state.activeEditor.filePath, await realpath(outsideFile));
  await f.execute('studio.file.open', { filePath: outsideFile }, 'auto');
  await f.execute('studio.file.open', { filePath: 'leak.ts' }, 'auto');
  await f.execute('studio.terminal.open', { cwd: f.outside }, 'auto');
  const project = await f.execute('studio.relatedProjects.get', { projectDir: f.outside }, 'auto');
  assert.equal(project.projectId, ids[1]); assert.equal(project.projectDir, await realpath(f.outside));
  const diagnostic = { message: 'External error', severity: 0, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  f.vscode.languages.getDiagnostics = () => [[f.uri(outsideFile), [diagnostic]]];
  assert.equal((await f.execute('studio.diagnostics.get', {}, 'auto')).diagnostics[0].filePath, await realpath(outsideFile));
  assert.equal((await f.execute('studio.diagnostics.get', {}, 'workspace')).diagnostics.length, 0);
  await assert.rejects(f.execute('studio.file.open', { filePath: outsideFile }, 'workspace'), /only access/);
  assert.equal((await f.execute('studio.state.get', {}, 'workspace')).activeEditor, null);
});

test('file diagnostics match canonical paths while retaining diagnostics registered through aliases', async t => {
  const f = await fixture(t);
  const target = path.join(f.workdir, 'index.ts'), alias = path.join(f.workdir, 'alias.ts');
  await symlink(target, alias);
  const entry = { message: 'Aliased file error', severity: 0, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } } };
  f.vscode.languages.getDiagnostics = uri => uri ? [] : [[f.uri(alias), [entry]], [f.uri(path.join(f.linked, 'index.ts')), [entry]]];
  for (const filePath of [target, alias]) {
    const result = await f.execute('studio.diagnostics.get', { filePath });
    assert.equal(result.total, 1); assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].filePath, await realpath(target));
    assert.equal(result.diagnostics[0].line, 2); assert.equal(result.diagnostics[0].column, 3);
  }
});

for (const revoke of ['trust', 'workspace', 'session']) {
test(`file opening rechecks ${revoke} after the document resolves`, async t => {
  const f = await fixture(t);
  f.vscode.workspace.openTextDocument = async uri => {
    if (revoke === 'trust') f.vscode.workspace.isTrusted = false;
    else if (revoke === 'workspace') f.vscode.workspace.workspaceFolders = [];
    else f.controller.abort();
    return { uri, validatePosition: position => position };
  };
  await assert.rejects(f.execute('studio.file.open', { filePath: 'index.ts' }, 'auto'));
  assert.equal(f.events.length, 0);
});
}

test('file navigation, themes, terminals and views use the VS Code APIs without sending commands', async t => {
  const f = await fixture(t);
  const file = await f.execute('studio.file.open', { filePath: 'index.ts', line: 2, column: 3 });
  assert.equal(file.line, 2); assert.equal(file.column, 3);
  await f.execute('studio.file.open', { filePath: path.join(f.linked, 'index.ts') });
  await f.execute('studio.theme.set', { theme: 'Light' });
  await f.execute('studio.terminal.open', {});
  await f.execute('studio.view.show', { view: 'assistant' });
  assert.deepEqual(f.events.slice(2), [['theme', 'colorTheme', 'Light', 1], ['theme', 'autoDetectColorScheme', false, 1],
    ['theme', 'autoDetectHighContrast', false, 1], ['terminal', await realpath(f.workdir)], ['view', 'studio.openAssistant']]);
});

test('explicit theme selection respects workspace overrides and switches automatic themes to manual', async t => {
  const f = await fixture(t);
  const settings = { colorTheme: { globalValue: 'Light', workspaceValue: 'Dark' },
    autoDetectColorScheme: { globalValue: true, workspaceValue: true }, autoDetectHighContrast: { globalValue: true } };
  f.vscode.workspace.getConfiguration = () => ({
    inspect: key => settings[key], get: key => settings[key].workspaceValue ?? settings[key].globalValue,
    update: async (key, value, target) => { settings[key][target === 2 ? 'workspaceValue' : 'globalValue'] = value; },
  });
  assert.equal((await f.execute('studio.theme.set', { theme: 'Light' })).mode, 'manual');
  assert.equal(settings.colorTheme.workspaceValue, 'Light');
  assert.equal(settings.colorTheme.globalValue, 'Light');
  assert.equal(settings.autoDetectColorScheme.workspaceValue, false);
  assert.equal(settings.autoDetectColorScheme.globalValue, true);
  assert.equal(settings.autoDetectHighContrast.globalValue, false);
});

test('canonical paths reject traversal, symlink escapes, wrong path kinds and malformed arguments', async t => {
  const f = await fixture(t);
  for (const [operation, input] of [
    ['studio.file.open', { filePath: '../outside/index.ts' }], ['studio.file.open', { filePath: 'leak.ts' }],
    ['studio.file.open', { filePath: f.workdir }], ['studio.terminal.open', { cwd: 'index.ts' }],
    ['studio.file.open', { filePath: 'index.ts', line: 0 }], ['studio.file.open', { filePath: 'index.ts', column: '1' }],
    ['studio.file.open', { filePath: 'index.ts', command: 'arbitrary' }], ['studio.theme.set', { theme: 'missing' }],
    ['studio.view.show', { view: 'workbench.action.quit' }], ['studio.unknown', {}],
  ]) { await assert.rejects(f.execute(operation, input)); }
  assert.equal(f.events.length, 0);
});

test('diagnostics are scoped, bounded and use one-based positions', async t => {
  const f = await fixture(t);
  const diagnostic = { message: 'Type error', severity: 0, source: 'ts', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } };
  const records = [[f.uri(path.join(f.workdir, 'index.ts')), Array(201).fill(diagnostic)], [f.uri(path.join(f.outside, 'index.ts')), [diagnostic]]];
  f.vscode.languages.getDiagnostics = uri => uri ? records[0][1] : records;
  const result = await f.execute('studio.diagnostics.get', {});
  assert.equal(result.total, 201); assert.equal(result.diagnostics.length, 200); assert.equal(result.truncated, true);
  assert.equal(result.diagnostics[0].line, 2); assert.equal(result.diagnostics[0].column, 3);
  assert.equal(result.diagnostics[0].severity, 'error');
  const single = await f.execute('studio.diagnostics.get', { filePath: 'index.ts' });
  assert.equal(single.total, 201);
  await assert.rejects(f.execute('studio.diagnostics.get', { filePath: '../outside/index.ts' }));
});

test('trust revocation, removed roots and cancellation block subsequent actions', async t => {
  const f = await fixture(t);
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.execute('studio.view.show', { view: 'explorer' }), /Trust/);
  await assert.rejects(f.execute('studio.relatedProjects.get', {}), /Trust/);
  await assert.rejects(f.execute('studio.file.open', { filePath: path.join(f.outside, 'index.ts') }, 'auto'), /Trust/);
  f.vscode.workspace.isTrusted = true; f.vscode.workspace.workspaceFolders.pop();
  await assert.rejects(f.execute('studio.view.show', { view: 'explorer' }), /no longer available/);
  await assert.rejects(f.execute('studio.relatedProjects.get', {}), /no longer available/);
  await assert.rejects(f.execute('studio.file.open', { filePath: path.join(f.outside, 'index.ts') }, 'auto'), /no longer available/);
  f.controller.abort();
  await assert.rejects(f.execute('studio.state.get', {}));
  await assert.rejects(f.execute('studio.relatedProjects.get', {}));
  assert.equal(f.events.length, 0);
});

test('the loopback service authenticates calls, rejects browser requests and malformed bodies, and closes with the session', async t => {
  let count = 0;
  const policies = [];
  const controller = new AbortController();
  const bridge = await load(bridgeCode).startStudioControlBridge(async (operation, input, policy) => { count++; policies.push(policy); return { operation }; }, controller.signal);
  t.after(() => bridge.close());
  const body = JSON.stringify({ operation: 'studio.state.get', input: {} });
  const headers = { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(bridge.url, { method: 'POST', body })).status, 403);
  assert.equal((await fetch(bridge.url, { method: 'POST', headers: { ...headers, Origin: 'http://untrusted.test' }, body })).status, 403);
  assert.equal((await fetch(bridge.url, { method: 'GET', headers })).status, 403);
  for (const invalid of ['invalid', JSON.stringify({ operation: 'studio.state.get', input: [] }), JSON.stringify({ operation: 'studio.state.get', input: {}, extra: true }),
    ...['unknown', null, [], true].map(permissionPolicy => JSON.stringify({ operation: 'studio.state.get', input: {}, permissionPolicy })),
    JSON.stringify({ operation: 'studio.state.get', input: { text: 'x'.repeat(70_000) } })]) {
    assert.equal((await fetch(bridge.url, { method: 'POST', headers, body: invalid })).status, 400);
  }
  assert.equal(count, 0);
  const response = await fetch(bridge.url, { method: 'POST', headers, body });
  assert.deepEqual(await response.json(), { ok: true, value: { operation: 'studio.state.get' } });
  assert.equal(count, 1);
  assert.deepEqual(policies, ['workspace']);
  const auto = await fetch(bridge.url, { method: 'POST', headers, body: JSON.stringify({ operation: 'studio.state.get', input: {}, permissionPolicy: 'auto' }) });
  assert.equal(auto.status, 200); assert.deepEqual(policies, ['workspace', 'auto']);
  controller.abort(); await bridge.close();
  await assert.rejects(fetch(bridge.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(2_000) }));
});

test('an already canceled session cannot create a control endpoint', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(load(bridgeCode).startStudioControlBridge(async () => null, controller.signal));
});
