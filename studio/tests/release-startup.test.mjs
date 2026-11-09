import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const kernel = new URL('../upstream/vscode/', import.meta.url);
const read = relative => readFile(new URL(relative, kernel), 'utf8');
const require = createRequire(import.meta.url);
const code = await build({ entryPoints: [new URL('src/vs/platform/windows/node/studioReleaseProject.ts', kernel).pathname], bundle: true, platform: 'node', format: 'cjs', write: false });
const metadata = { exports: {} };
runInNewContext(code.outputFiles[0].text, { exports: metadata.exports, module: metadata, require, process, performance, Buffer, URL, TextEncoder, TextDecoder });
const uri = await build({ entryPoints: [new URL('src/vs/base/common/uri.ts', kernel).pathname], bundle: true, platform: 'node', format: 'cjs', write: false });
const uriModule = { exports: {} };
runInNewContext(uri.outputFiles[0].text, { exports: uriModule.exports, module: uriModule, require, process, performance, Buffer });

const id = 'cf82d82c-7941-4294-b549-5dcccd0ae431';
const project = { id, version: '1.0.0', name: 'Release application', distribution: { kind: 'release', version: 1 }, defaultEntry: 'agent' };
const manifest = { kind: 'steamharness.project.release', version: 1, projectId: id, projectVersion: '1.0.0', entries: [{ entryId: 'agent' }] };
async function fixture(t, declaration = project, release = manifest) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-release-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify(declaration));
  await writeFile(path.join(directory, 'steamharness.release.json'), JSON.stringify(release));
  return { directory, uri: uriModule.exports.URI.file(directory) };
}

test('window creation recognizes a release identity without loading any project modules', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'index.mjs'), "throw new Error('Project code must not run in the window process.');");
  const found = await metadata.exports.readStudioReleaseProject(f.uri);
  assert.deepEqual(JSON.parse(JSON.stringify(found)), { projectUri: f.uri.toString(), name: project.name, avatarUrl: '' });
});

test('source declarations, incomplete releases and unsupported formats cannot select the release shell', async t => {
  for (const [declaration, release] of [[{ ...project, distribution: undefined, release: {} }, manifest], [project, { ...manifest, projectId: 'other' }],
    [project, { ...manifest, version: 2 }], [{ ...project, defaultEntry: undefined }, manifest], [project, { ...manifest, entries: [] }]]) {
    const f = await fixture(t, declaration, release);
    assert.equal(await metadata.exports.readStudioReleaseProject(f.uri), undefined);
  }
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'steamharness.release.json'), 'x'.repeat(2_000_001));
  assert.equal(await metadata.exports.readStudioReleaseProject(f.uri), undefined);
  assert.equal(await metadata.exports.readStudioReleaseProject(uriModule.exports.URI.parse('vscode-remote://host/project')), undefined);
});

const native = ts.transpileModule(await read('src/vs/workbench/browser/parts/studioMode.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
test('release mode and project identity exist before any extension inspection', () => {
  const commands = new Map();
  class Emitter { event = () => ({ dispose() {} }); fire() {} }
  class Disposable { _register(value) { return value; } }
  const common = { Emitter, Disposable, CommandsRegistry: { registerCommand: (name, callback) => commands.set(name, callback) },
    studioLocaleStrings: { loadingProject: '正在加载项目…', showTools: '显示工具区', hideTools: '隐藏工具区' } };
  const module = { exports: {} };
  runInNewContext(native, { module, exports: module.exports, require: () => new Proxy(common, { get: (values, key) => key in values ? values[key] : () => {} }) });
  const release = { projectUri: 'file:///release', name: 'App', avatarUrl: '' };
  module.exports.initializeStudioReleaseProject(release);
  const state = module.exports.studioModeState;
  assert.deepEqual([state.steam, state.busy, state.state.releaseOnly, state.state.available, state.state.projectUri, state.state.labels.loading], [true, true, true, false, release.projectUri, '正在加载项目…']);
  commands.get('studio.internalUpdateModeState')(undefined, { available: false, labels: {}, releaseOnly: false });
  assert.equal(state.state.releaseOnly, true);
  assert.equal(state.state.projectUri, release.projectUri);
  assert.equal(commands.get('studio.internalIsReleaseWindow')(), true);
  commands.get('studio.internalUpdateModeState')(undefined, { available: true, projectUri: 'file:///other', labels: {} });
  assert.equal(state.state.available, false);
  assert.equal(state.state.labels.loading, '正在加载项目…');
});

test('the initial release layout hides IDE parts before selecting views and retains project editor restoration', async () => {
  const text = await read('src/vs/workbench/browser/layout.ts');
  const source = ts.createSourceFile('layout.ts', text, ts.ScriptTarget.Latest, true);
  let method;
  const find = node => { if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'initLayoutState') method = node; ts.forEachChild(node, find); };
  find(source);
  const guard = method.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(source) === 'studioModeState.state.releaseOnly');
  assert.ok(guard);
  const flags = ['ACTIVITYBAR_HIDDEN', 'SIDEBAR_HIDDEN', 'PANEL_HIDDEN', 'AUXILIARYBAR_HIDDEN', 'STATUSBAR_HIDDEN', 'EDITOR_HIDDEN', 'AUXILIARYBAR_WAS_LAST_MAXIMIZED'];
  const state = new Map(), target = { stateModel: { setRuntimeValue: (key, value) => state.set(key, value) } };
  const code = ts.transpileModule(`(function () { ${guard.getText(source)} }).call(target)`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { target, studioModeState: { state: { releaseOnly: true } }, LayoutStateKeys: Object.fromEntries(flags.map(key => [key, key])) });
  assert.equal(target.windowChromeHidden, true);
  assert.deepEqual([...state.values()], [true, true, true, true, true, false, false]);
  assert.ok(guard.end < text.indexOf('const initialLayoutState', method.pos));
  assert.match(method.getText(source), /restoreEditors: this.shouldRestoreEditors/);
});

function findFunction(text, name) {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  let result;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(source); ts.forEachChild(node, visit); };
  visit(source); assert.ok(result); return result;
}
const splash = findFunction(await read('src/vs/code/electron-browser/workbench/workbench.ts'), 'showDefaultSplash');
const splashCode = ts.transpileModule(`globalThis.show = ${splash.replace('function showDefaultSplash', 'function')}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const option of ['studioReleaseProject', 'studioReleasePending']) {
  test(`${option} starts with the application background instead of a restored IDE splash`, () => {
    const dom = new JSDOM('<html><head></head><body></body></html>');
    const data = { baseTheme: 'vs', colorInfo: { foreground: '#111' }, layoutInfo: { activityBarWidth: 48, sideBarWidth: 300, auxiliarySideBarWidth: 400, titleBarHeight: 44, statusBarHeight: 22 } };
    const context = { window: dom.window, document: dom.window.document, performance, preloadGlobals: {},
      getPartsSplashColors: () => ({ background: '#fff' }), getPartsSplashLayoutMetrics: () => { throw new Error('The release must not restore IDE geometry.'); } };
    runInNewContext(splashCode, context);
    context.show({ partsSplash: data, [option]: true, colorScheme: {}, workspace: {} });
    assert.equal(dom.window.document.querySelector('#monaco-parts-splash'), null);
    assert.equal(data.layoutInfo.sideBarWidth, 300, 'Cached splash metadata stays reusable by source windows');
    dom.window.close();
  });
}

test('desktop bootstrap selects release mode before constructing the workbench', async () => {
  const desktop = await read('src/vs/workbench/electron-browser/desktop.main.ts');
  assert.ok(desktop.indexOf('initializeStudioReleaseProject(release)') < desktop.indexOf('new Workbench('));
  const contribution = await read('src/vs/workbench/contrib/studioMode/browser/studioMode.contribution.ts');
  assert.match(contribution, /registerWorkbenchContribution2\(StudioModeContribution.ID, StudioModeContribution, WorkbenchPhase.BlockRestore\)/);
  const extension = await readFile(new URL('../extensions/studio-workstation/src/workflow.ts', import.meta.url), 'utf8');
  assert.match(extension, /if \(!releaseWindow\) \{ void assistant.showInitially\(\)/);
});
