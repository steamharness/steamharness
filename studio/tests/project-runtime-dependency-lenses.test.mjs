import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
export { registerRuntimeDependencyIndicators } from './extensions/studio-workstation/src/project-runtime-dependency-lenses';
export { configureLocalization } from './extensions/studio-workstation/src/localization';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const zh = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));

const project = '/workspace/pinned project';
const source = '{\n  "devDependencies": {\n    "steamharness": "file:core.tgz",\n    "@steamharness/cli": "file:cli.tgz"\n  }\n}';
const state = () => ({ kind: 'archive', bundleVersion: '0.2.0', revision: '1'.repeat(64), manager: 'pnpm', matches: false, packages: [
  { name: 'steamharness', group: 'devDependencies', version: '0.2.0', installedVersion: '0.2.0', projectSha256: 'a'.repeat(64), studioSha256: 'a'.repeat(64), sameArchive: true },
  { name: '@steamharness/cli', group: 'devDependencies', version: '0.2.0', installedVersion: '0.2.0', projectSha256: 'b'.repeat(64), studioSha256: 'c'.repeat(64), sameArchive: false },
] });

class Uri {
  constructor(path) { this.scheme = 'file'; this.path = this.fsPath = path; }
  static parse(value) { return new Uri(decodeURI(value.slice('file://'.length))); }
  static file(path) { return new Uri(path); }
  static joinPath(uri, ...paths) { return new Uri(posix.join(uri.path, ...paths)); }
  toString() { return `file://${encodeURI(this.path)}`; }
}
class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

function fixture(t, language = 'en') {
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const capture = { source, inspection: state(), confirm: false, calls: [], warnings: [], errors: [], inspections: [], watchers: [], progress: [] };
  const status = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.hide(); } };
  const document = { uri: Uri.file(`${project}/package.json`), isDirty: false, version: 1, getText: () => capture.source, positionAt: offset => offset };
  let provider, command;
  const vscode = {
    Uri, EventEmitter,
    Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
    CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1 },
    workspace: {
      isTrusted: true, textDocuments: [document], getWorkspaceFolder: uri => ({ uri: Uri.joinPath(uri, '..') }),
      onDidGrantWorkspaceTrust: () => ({ dispose() {} }), createFileSystemWatcher: () => {
        const events = new EventEmitter();
        capture.watchers.push(events);
        return { onDidChange: events.event, onDidCreate: events.event, onDidDelete: events.event, dispose: () => events.dispose() };
      },
    },
    languages: { registerCodeLensProvider: (_, value) => { provider = value; return { dispose() {} }; } },
    commands: { registerCommand: (id, run) => { command = { id, run }; return { dispose() {} }; } },
    window: {
      createStatusBarItem: (id, alignment, priority) => Object.assign(status, { id, alignment, priority }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      showWarningMessage: async (title, options, action) => { capture.warnings.push({ title, ...options, action }); return capture.confirm ? action : undefined; },
      showErrorMessage: async message => capture.errors.push(message),
    },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    AbortController, AbortSignal, Error, setTimeout, clearTimeout });
  module.exports.configureLocalization(language === 'zh-cn' ? zh : {}, language);
  const context = { subscriptions: [] };
  t.after(() => { for (const disposable of context.subscriptions.reverse()) disposable.dispose(); });
  const updateProject = module.exports.registerRuntimeDependencyIndicators(context, {
    bundleDirectory: '/studio/project-packages',
    inspect: async (candidate, signal) => {
      capture.inspections.push(candidate);
      return capture.inspect ? capture.inspect(candidate, signal) : capture.inspection;
    },
    replace: async (_, revision, signal, prepare, log) => {
      assert.equal(revision, capture.inspection.revision);
      signal.throwIfAborted(); await prepare(project); capture.calls.push('install');
      log('package manager output\n');
      if (capture.installError) throw capture.installError;
      capture.inspection.matches = true;
      capture.inspection.packages[1].sameArchive = true;
      capture.inspection.packages[1].projectSha256 = capture.inspection.packages[1].studioSha256;
      return capture.inspection.bundleVersion;
    },
  }, async directory => {
    assert.equal(directory, project); capture.calls.push('prepare'); return { dispose: () => capture.calls.push('release') };
  }, { append() {}, appendLine() {} }, {
    async run(options, task) {
      const run = { options, log: '' };
      capture.progress.push(run);
      try { return await task({ signal: options.signal, append: chunk => { run.log += chunk; } }); }
      catch (error) { run.error = options.describeError(error); throw error; }
    },
  }, () => capture.manifest);
  return { capture, document, vscode, status, select: uri => { capture.manifest = uri; updateProject(); }, lenses: () => provider.provideCodeLenses(document, token),
    invoke: lens => { assert.equal(lens.command.command, command.id); return command.run(...lens.command.arguments); } };
}

test('shows the same-version archive mismatch on the dependency declaration and installs only after confirmation', async t => {
  const f = fixture(t, 'zh-cn');
  const [status, action] = await f.lenses();
  assert.equal(status.range.start, source.indexOf('"steamharness"'));
  assert.equal(status.command.title, '同版本，归档不同');
  assert.match(status.command.tooltip, /项目：Core 0\.2\.0、CLI 0\.2\.0 \| Studio：0\.2\.0/u);
  assert.ok(status.command.tooltip.includes(`@steamharness/cli\n项目 SHA-256：${'b'.repeat(64)}\nStudio SHA-256：${'c'.repeat(64)}`));
  assert.equal(action.command.title, '使用 Studio 自带依赖');

  await f.invoke(action);
  assert.equal(f.capture.warnings[0].modal, true);
  assert.match(f.capture.warnings[0].detail, /同版本，归档不同/u);
  assert.deepEqual(f.capture.calls, []);
  assert.deepEqual(f.capture.progress, []);

  f.capture.confirm = true;
  await f.invoke(action);
  assert.deepEqual(f.capture.calls, ['prepare', 'install', 'release']);
  assert.equal(f.capture.progress[0].options.title, '正在替换运行依赖');
  assert.match(f.capture.progress[0].log, /package manager output\n\s*已安装 Studio 自带的 Core 和 CLI 0\.2\.0。/u);
  assert.deepEqual(Array.from(await f.lenses(), lens => lens.command.title), ['运行依赖与 Studio 一致']);
});

test('shows a package manager failure in the dependency details and releases the replacement lease', async t => {
  const f = fixture(t);
  f.capture.confirm = true;
  f.capture.installError = new Error('registry offline');
  await f.invoke((await f.lenses())[1]);
  assert.deepEqual(f.capture.calls, ['prepare', 'install', 'release']);
  assert.deepEqual(f.capture.errors, []);
  assert.equal(f.capture.progress[0].error, 'Could not replace runtime dependencies: registry offline');
  assert.match(f.capture.progress[0].log, /package manager output/);
});

test('distinguishes installation refresh from archive mismatch and ignores stale or untrusted actions', async t => {
  const f = fixture(t);
  const title = async () => (await f.lenses())[0].command.title;
  assert.equal(await title(), 'Same version, different archives');
  f.capture.inspection.packages[1].version = '0.1.9';
  assert.equal(await title(), 'Runtime archives differ');
  const [, oldAction] = await f.lenses();
  f.capture.inspection.revision = '2'.repeat(64);
  f.capture.inspection.packages[1] = { ...f.capture.inspection.packages[1], version: '0.2.0', projectSha256: 'c'.repeat(64), sameArchive: true };
  assert.equal(await title(), 'Archives match; installation needs refresh');
  await f.invoke(oldAction);
  assert.match(f.capture.errors[0], /Refresh the comparison/u);
  assert.equal(f.capture.warnings.length, 0);
  const [, repair] = await f.lenses();
  await f.invoke(repair);
  assert.equal(f.capture.warnings[0].action, 'Reinstall');
  assert.match(f.capture.warnings[0].detail, /without changing the archives/u);

  f.capture.inspection.manager = undefined;
  assert.deepEqual(Array.from(await f.lenses(), lens => lens.command.title), ['Runtime archives match']);
  f.capture.inspection.bundleVersion = undefined;
  assert.deepEqual(Array.from(await f.lenses(), lens => lens.command.title), ['Studio runtime bundle unavailable']);
  f.vscode.workspace.isTrusted = false;
  assert.equal((await f.lenses()).length, 0);
  await f.invoke(repair);
  assert.deepEqual(f.capture.calls, []);
});

test('shows a localized, read-only npm reminder right above each affected dependency', async t => {
  const f = fixture(t, 'zh-cn');
  f.capture.source = '{\n  "dependencies": { "steamharness": "0.2.9" },\n  "devDependencies": {\n    "@steamharness/cli": "^0.2.0"\n  }\n}';
  f.capture.inspection = { kind: 'npm', updates: [
    { name: 'steamharness', group: 'dependencies', spec: '0.2.9', installedVersion: '0.2.9', latestVersion: '0.2.10', kind: 'declaration' },
    { name: '@steamharness/cli', group: 'devDependencies', spec: '^0.2.0', installedVersion: '0.2.9', latestVersion: '0.2.10', kind: 'installation' },
  ] };
  const [core, cli, extra] = await f.lenses();
  assert.equal(extra, undefined);
  assert.equal(core.range.start, f.capture.source.indexOf('"steamharness"'));
  assert.equal(cli.range.start, f.capture.source.indexOf('"@steamharness/cli"'));
  assert.equal(core.command.title, 'npm 有新版本：0.2.10');
  assert.match(core.command.tooltip, /声明的版本或范围：0\.2\.9.*需要修改版本声明/su);
  assert.match(cli.command.tooltip, /已安装版本：0\.2\.9.*只需更新安装/su);
  assert.equal(core.command.command, '');
  assert.equal(cli.command.command, '');
  assert.deepEqual(f.capture.calls, []);
});

test('supports a project that only declares the CLI and drops npm reminders when there is no newer version', async t => {
  const f = fixture(t);
  f.capture.source = '{ "devDependencies": { "@steamharness/cli": "0.2.9" } }';
  f.capture.inspection = { kind: 'npm', updates: [
    { name: '@steamharness/cli', group: 'devDependencies', spec: '0.2.9', latestVersion: '0.2.10', kind: 'declaration' },
  ] };
  const [lens] = await f.lenses();
  assert.equal(lens.command.title, 'npm update available: 0.2.10');
  assert.match(lens.command.tooltip, /Installed version: Unavailable/u);
  f.capture.inspection = undefined;
  assert.equal((await f.lenses()).length, 0);
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test('uses the left status bar for archive status, shares the editor check, and refreshes after changes', async t => {
  const f = fixture(t, 'zh-cn');
  f.select(f.document.uri);
  await f.lenses(); await tick();
  assert.deepEqual(f.capture.inspections.map(item => item.directory), [project]);
  assert.equal(f.status.alignment, f.vscode.StatusBarAlignment.Left);
  assert.equal(f.status.priority, 110);
  assert.equal(f.status.visible, true);
  assert.equal(f.status.text, '$(arrow-circle-up) 运行依赖有新版可升级');
  assert.match(f.status.tooltip, /同版本，归档不同/u);
  assert.match(f.status.tooltip, /项目 SHA-256/u);
  assert.equal(f.status.command.command, 'vscode.open');
  assert.equal(f.status.command.arguments[0].toString(), f.document.uri.toString());

  const result = f.capture.inspection;
  result.packages[1].projectSha256 = result.packages[1].studioSha256;
  result.packages[1].sameArchive = result.matches = true;
  f.select(f.document.uri);
  assert.equal(f.capture.inspections.length, 1);
  f.capture.watchers[0].fire(Uri.file(`${project}/vendor/core.tgz`));
  f.capture.watchers[0].fire(Uri.file(`${project}/pnpm-lock.yaml`));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.capture.inspections.length, 2);
  assert.equal(f.status.text, '$(package) 依赖版本 0.2.0');
  assert.equal(f.status.visible, true);
});

test('describes an available build upgrade separately from an installation refresh', async t => {
  const f = fixture(t);
  f.select(f.document.uri); await tick();
  assert.equal(f.status.text, '$(arrow-circle-up) Runtime updates available');

  const cli = f.capture.inspection.packages[1];
  cli.projectSha256 = cli.studioSha256;
  cli.sameArchive = true;
  f.select(undefined);
  f.select(f.document.uri); await tick();
  assert.equal(f.status.text, '$(warning) Archives match; installation needs refresh');
});

test('switches the status and its click target between projects without showing a stale result', async t => {
  const f = fixture(t);
  const old = Promise.withResolvers(), next = Uri.file('/workspace/npm project/package.json');
  f.capture.inspect = ({ directory }) => directory === project ? old.promise : { kind: 'npm', updates: [
    { name: 'steamharness', group: 'dependencies', spec: '0.2.0', latestVersion: '0.2.6', kind: 'declaration' },
  ] };
  f.select(f.document.uri);
  f.select(next);
  await tick();
  assert.equal(f.status.visible, true);
  assert.equal(f.status.text, '$(arrow-circle-up) npm update available: 0.2.6');
  assert.match(f.status.tooltip, /steamharness\nnpm update available/u);
  assert.equal(f.status.command.arguments[0].toString(), next.toString());
  old.resolve(state()); await tick();
  assert.equal(f.status.command.arguments[0].toString(), next.toString());
  assert.match(f.status.text, /npm update available/u);
  f.select(undefined);
  assert.equal(f.status.visible, false);
  f.vscode.workspace.isTrusted = false;
  f.select(f.document.uri); await tick();
  assert.equal(f.status.visible, false);
  assert.equal(f.capture.inspections.length, 2);
});
