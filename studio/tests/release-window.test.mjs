import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const workflow = await readFile(new URL('../extensions/studio-workstation/src/workflow.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('workflow.ts', workflow, ts.ScriptTarget.Latest, true);
let releaseAction, updateEntry;
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'updateEntry') updateEntry = node.initializer;
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'studio.openProjectRelease') releaseAction = node.arguments[1];
  ts.forEachChild(node, find);
}
find(parsed);
assert.ok(releaseAction);
const actionCode = ts.transpileModule(`globalThis.action = ${releaseAction.getText(parsed)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

test('release run opens only the prepared directory in a separate window', async () => {
  const calls = [], source = { uri: 'file:///source', folderPath: '/source', entryId: 'map', aggregateName: 'Demo' };
  const context = {
    currentProject: () => source,
    launcher: {
      prepareDistribution: async (project, snapshot) => { assert.equal(project, source); assert.equal(snapshot, true); return { mode: 'release', directory: '/source/dist/steamharness/release/snapshots/build/map', entries: ['agent', 'map'] }; },
      inspect: () => { throw new Error('The source window must not mount the release.'); },
    },
    openReleaseProjectWindow: (...args) => calls.push(args),
    vscode: { ProgressLocation: { Notification: 15 }, workspace: { isTrusted: true, textDocuments: [] },
      window: { withProgress: async (_options, run) => run({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }) } },
    t: value => value, AbortController, Error,
  };
  runInNewContext(actionCode, context); await context.action();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/source/dist/steamharness/release/snapshots/build/map');
  assert.equal(calls[0][1], source.uri);
});

const folderCode = await build({ entryPoints: ['extensions/studio-workstation/src/project-window.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
test('release folder opening forces a new window without prompting or replacing the source folder', async () => {
  const calls = [];
  const uri = value => { const url = new URL(value); return { scheme: url.protocol.slice(0, -1), path: url.pathname, toString: () => url.href,
    with: changes => { const next = new URL(url); next.pathname = changes.path; return uri(next.href); } }; };
  const vscode = { Uri: { parse: uri, file: value => uri(pathToFileURL(value).href) }, commands: { executeCommand: (...args) => calls.push(args) },
    window: { showInformationMessage: () => { throw new Error('Release launch does not ask to reuse the source window.'); } } };
  const module = { exports: {} };
  runInNewContext(folderCode.outputFiles[0].text, { exports: module.exports, module, require: name => name === 'vscode' ? vscode : require(name) });
  await module.exports.openReleaseProjectWindow('/release/project', 'file:///source', new AbortController().signal);
  assert.equal(calls[0][0], 'vscode.openFolder'); assert.equal(calls[0][1].toString(), 'file:///release/project');
  assert.equal(calls[0][2].forceNewWindow, true); assert.equal(calls[0][2].forceReuseWindow, false);
  await module.exports.openReleaseProjectWindow('/release/project', 'vscode-remote://ssh-remote+host/source', new AbortController().signal);
  assert.equal(calls[1][1].toString(), 'vscode-remote://ssh-remote+host/release/project');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(module.exports.openReleaseProjectWindow('/release/project', 'file:///source', abort.signal));
  assert.equal(calls.length, 2);
});

test('release chrome displays project identity and filters authoring tools', async () => {
  const source = await readFile(new URL('../upstream/vscode/src/vs/workbench/browser/parts/studioMode.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const dom = new JSDOM('<div class="monaco-workbench"><div id="left"></div><div id="right"></div><div id="tools"></div></div>');
  const { document } = dom.window;
  const style = document.createElement('style'); style.textContent = await readFile(new URL('../upstream/vscode/src/vs/workbench/browser/parts/media/studioMode.css', import.meta.url), 'utf8'); document.head.append(style);
  class Emitter { listeners = new Set(); event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(value) { for (const listener of this.listeners) listener(value); } }
  class Disposable { items = []; _register(item) { this.items.push(item); return item; } dispose() { for (const item of this.items.reverse()) item.dispose(); } }
  class DisposableStore extends Disposable { add(item) { return this._register(item); } clear() { this.dispose(); this.items = []; } }
  const event = () => ({ dispose() {} });
  const element = (selector, attributes, ...children) => {
    const [tag, ...classes] = selector.split('.'), node = document.createElement(tag || 'div'); node.className = classes.join(' ');
    for (const [key, value] of Object.entries(attributes ?? {})) { if (key === 'hidden') node.hidden = value; else node.setAttribute(key, value); }
    for (const child of children) node.append(child); return node;
  };
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  const common = { Disposable, DisposableStore, Emitter, $: element, append: (parent, child) => parent.appendChild(child), clearNode: node => node.replaceChildren(),
    addDisposableListener: event, getWindow: () => dom.window, toDisposable: dispose => ({ dispose }),
    CommandsRegistry: { registerCommand: event }, getDefaultHoverDelegate: () => ({}), onDidChangeFullscreen: event, onDidChangeZoomLevel: event,
    Parts: { AUXILIARYBAR_PART: 'tools' } };
  const module = { exports: {} }, service = () => {};
  runInNewContext(code, { module, exports: module.exports, require: () => new Proxy(common, { get: (value, key) => key in value ? value[key] : service }) });
  const native = module.exports;
  const layout = { mainContainer: document.querySelector('.monaco-workbench'), isVisible: () => false, getContainer: () => undefined, onDidChangePartVisibility: event, onDidLayoutMainContainer: event };
  const commands = { executeCommand: async () => {} }, notifications = { error: error => { throw error; } }, hover = { setupManagedHover: () => ({ update() {}, dispose() {} }) };
  const caption = new native.StudioModeSwitcher(document.querySelector('#left'), document.querySelector('#right'), commands, notifications, layout, hover);
  const tools = new native.StudioSteamTools(document.querySelector('#tools'), commands, notifications);
  const before = [...tools.element.querySelectorAll('[data-tool]')].map(node => node.dataset.tool);
  assert.ok(before.includes('editor')); assert.ok(before.includes('assistant'));
  native.studioModeState.state = { available: true, releaseOnly: true, project: { name: 'Demo <project>', avatarUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, labels: {} };
  native.studioModeState.setMode(true, false);
  // State updates are normally published by the extension through the registered command.
  native.studioModeState.state = { ...native.studioModeState.state };
  tools.render();
  assert.equal(document.querySelector('.studio-mode-toggle').hidden, true);
  assert.equal(dom.window.getComputedStyle(document.querySelector('.studio-mode-toggle')).display, 'none');
  assert.equal(document.querySelector('.studio-release-project-name').textContent, 'Demo <project>');
  assert.equal(document.querySelector('.studio-release-project-logo').getAttribute('src'), 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(document.querySelector('.studio-release-project').hidden, false);
  const after = [...tools.element.querySelectorAll('[data-tool]')].map(node => node.dataset.tool);
  assert.ok(!after.includes('editor')); assert.ok(!after.includes('assistant')); assert.ok(after.includes('versions')); assert.ok(after.includes('trace'));
  assert.equal(native.isStudioSteamToolAvailable('editor'), false);
  caption.dispose(); tools.dispose(); dom.window.close();
});


test('release window identity and tool policy follow its root when another project tab is active', () => {
  const root = { uri: 'file:///release', entryId: 'agent', defaultEntry: 'agent', distribution: 'release', aggregateName: 'Release App', projectType: 'bot', aggregateProjectCard: { icon: 'boxes' } };
  const target = { uri: 'file:///other-source', distribution: 'source', name: 'Other' };
  const calls = [], noop = () => {};
  const context = { launcher: { prepareDistribution() {} }, disposed: false, entryTimer: undefined, clearTimeout: noop, provider: { projects: [root] }, currentProject: () => target, activeProject: () => target,
    projectWindows: { update: noop }, databases: { update: noop }, trace: { update: noop }, versions: { update: noop }, info: { update: noop }, toolInstances: { update: noop }, updateVersionEntry: noop,
    findWorkspace: () => ({ running: true, loaded: true }), projectScanReady: true, mode: { update: (...args) => calls.push(args) },
    projectAvatarDataUrl: card => card.icon, status: { show: noop, hide: noop }, projectDisplayName: project => project.name, t: value => value,
    vscode: { workspace: { isTrusted: true, workspaceFolders: [{ uri: { toString: () => root.uri } }] }, commands: { executeCommand: noop } } };
  const code = ts.transpileModule(`globalThis.update = ${updateEntry.getText(parsed)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, context); context.update();
  assert.equal(calls[0][1], root.uri); assert.equal(calls[0][3], true);
  assert.equal(calls[0][4].name, 'Release App'); assert.equal(calls[0][4].avatarUrl, 'boxes');
});
