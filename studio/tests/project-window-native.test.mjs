import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';
import { kernelLock } from './helpers/kernel-lock.mjs';

const compiled = await build({ stdin: { contents: `
  export { URI } from './upstream/vscode/src/vs/base/common/uri';
  export * from './upstream/vscode/src/vs/platform/window/common/studioProjectWindow';
  export * from './upstream/vscode/src/vs/platform/windows/electron-main/studioProjectWindow';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'window-types', setup(plugin) {
    plugin.onResolve({ filter: /^\.\/window\.js$/ }, args => args.importer.endsWith('/window/common/studioProjectWindow.ts') ? { path: 'window', namespace: 'window-mock' } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: 'window-mock' }, () => ({ contents: `
      export const isFolderToOpen = value => !!value.folderUri;
      export const isWorkspaceToOpen = value => !!value.workspaceUri;
      export const isFileToOpen = value => !!value.fileUri;
    ` }));
  } }] });

function fixture(language = 'en') {
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, _VSCODE_NLS_LANGUAGE: language,
    performance, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, TextEncoder, URL, crypto: globalThis.crypto });
  const f = { choice: 0, dialogs: [], opens: [], destroyed: false };
  const window = { id: 7, win: { isDestroyed: () => f.destroyed } };
  const windows = { getWindowById: id => id === 7 ? window : undefined, getFocusedWindow: () => window, getLastActiveWindow: () => window,
    open: async config => { f.opens.push(config); return [window]; } };
  return Object.assign(f, module.exports, {
    open: config => module.exports.openWithProjectWindowChoice(config, windows, async (windowId, options) => {
      f.dialogs.push({ windowId, options }); await f.beforeChoice?.(); return { response: f.choice };
    }),
  });
}

for (const language of ['en', 'zh-cn', 'fr']) {
  for (const response of [0, 1, 2]) {
    test(`${language}: native project opening respects choice ${response} and preserves the remote target`, async () => {
      const f = fixture(language); f.choice = response;
      const config = { urisToOpen: [{ workspaceUri: 'vscode-remote://host/demo.code-workspace' }], remoteAuthority: 'ssh-remote+host', contextWindowId: 7 };
      const opened = await f.open(config);
      assert.equal(f.dialogs.length, 1); assert.equal(f.dialogs[0].windowId, 7);
      assert.equal(f.dialogs[0].options.buttons[1], language === 'zh-cn' ? '在当前窗口打开' : 'Open in Current Window');
      assert.equal(f.dialogs[0].options.cancelId, 2);
      assert.equal(f.opens.length, response === 2 ? 0 : 1);
      if (response === 2) { assert.equal(opened, undefined); }
      else {
        assert.equal(opened.length, 1);
        assert.equal(f.opens[0].forceNewWindow, response === 0); assert.equal(f.opens[0].forceReuseWindow, response === 1);
        assert.equal(f.opens[0].remoteAuthority, config.remoteAuthority); assert.equal(f.opens[0].contextWindowId, 7);
      }
      assert.equal(config.forceReuseWindow, undefined);
    });
  }
}

test('explicit window choices, file opens and workspace-folder edits never ask twice', async () => {
  const f = fixture();
  for (const config of [
    { urisToOpen: [{ folderUri: '/project' }], forceNewWindow: true },
    { urisToOpen: [{ folderUri: '/project' }], forceReuseWindow: true },
    { urisToOpen: [{ folderUri: '/project' }], addMode: true },
    { urisToOpen: [{ folderUri: '/project' }], removeMode: true },
    { urisToOpen: [{ fileUri: { path: '/file.txt' } }] }, { urisToOpen: [] },
  ]) { await f.open(config); }
  assert.deepEqual(f.dialogs, []); assert.equal(f.opens.length, 6);
  assert.equal(f.shouldChooseProjectWindow([{ folderUri: '/project' }], { forceNewWindow: false, forceReuseWindow: false }), true);
  assert.equal(f.shouldChooseProjectWindow([{ fileUri: { path: '/demo.code-workspace' } }]), true);
});

test('closing the source window during a native dialog cancels the project open', async () => {
  const f = fixture(); f.beforeChoice = () => { f.destroyed = true; };
  assert.equal(await f.open({ urisToOpen: [{ folderUri: '/project' }] }), undefined);
  assert.deepEqual(f.opens, []);
});

test('the native launch request is scoped to the single project folder rather than another window', () => {
  const f = fixture();
  const folder = f.URI.parse('vscode-remote://ssh-remote+host/projects/aggregate');
  const other = f.URI.parse('vscode-remote://ssh-remote+other/projects/aggregate');
  const run = { studioProjectEntry: { entryId: 'board' }, forceNewWindow: true };
  const explicit = f.studioEntryForOpenables([{ folderUri: folder.toJSON() }], run);
  assert.equal(explicit.uri, folder.toString());
  assert.equal(f.studioEntryForFolder(explicit, folder).entryId, 'board');
  assert.equal(f.studioEntryForFolder(explicit, other), undefined);
  assert.equal(f.studioEntryForFolder(explicit, undefined), undefined);
  assert.equal(f.studioEntryForOpenables([{ folderUri: folder }, { folderUri: other }], run), undefined);
  assert.equal(f.studioEntryForOpenables([{ workspaceUri: folder }], run), undefined);
  assert.equal(f.studioEntryForOpenables([{ folderUri: folder }], { ...run, addMode: true }), undefined);
  const defaultEntry = f.studioEntryForOpenables([{ folderUri: folder }], { studioProjectEntry: {} });
  assert.equal(f.studioEntryForFolder(defaultEntry, folder).entryId, undefined);
});

test('the project-window patch reproduces the kernel changes repeatedly without changing the index', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'studio-project-window-patch-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const kernel = path.join(fixture, 'vscode');
  const upstream = await kernelLock();
  const files = ['src/vs/platform/window/common/studioProjectWindow.ts', 'src/vs/platform/windows/electron-main/studioProjectWindow.ts',
    'src/vs/platform/native/electron-main/nativeHostMainService.ts', 'src/vs/platform/menubar/electron-main/menubar.ts',
    'src/vs/workbench/services/host/browser/browserHostService.ts'];
  const source = path.join(ROOT, upstream.path);
  const present = execFileSync('git', ['ls-tree', '-r', '--name-only', upstream.commit, '--', ...files], { cwd: source, encoding: 'utf8' }).trim().split('\n');
  for (const file of present.filter(Boolean)) {
    await mkdir(path.dirname(path.join(kernel, file)), { recursive: true });
    await writeFile(path.join(kernel, file), execFileSync('git', ['show', `${upstream.commit}:${file}`], { cwd: source }));
  }
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  await mkdir(path.join(fixture, 'patches'));
  const patch = path.join(fixture, 'patches/0034-studio-project-window-choice.patch');
  await copyFile(path.join(ROOT, 'patches/0034-studio-project-window-choice.patch'), patch);
  const entryPatchName = '0110-studio-shared-project-details.patch';
  const entryPatch = path.join(fixture, 'patches', entryPatchName);
  const details = await readFile(path.join(ROOT, 'patches', entryPatchName), 'utf8');
  await writeFile(entryPatch, details.split(/(?=^diff --git )/m).filter(part => files.some(file => part.startsWith(`diff --git a/${file} b/${file}\n`))).join(''));
  const applied = file => {
    try { git(['apply', '--reverse', '--check', file]); return true; } catch { return false; }
  };
  if (!applied(entryPatch)) { git(['apply', entryPatch]); }
  const bytes = () => Promise.all(files.map(file => readFile(path.join(kernel, file), 'utf8')));
  const expected = await bytes();
  git(['apply', '--reverse', entryPatch]);
  if (applied(patch)) { git(['apply', '--reverse', patch]); }
  git(['add', '--all']);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(fixture, 'hooks')}`, 'commit', '--quiet', '-m', 'kernel fixture']);
  const index = git(['write-tree']);
  for (let attempt = 0; attempt < 2; attempt++) {
    await applyPatches(fixture, kernel);
    assert.deepEqual(await bytes(), expected);
    assert.equal(git(['write-tree']), index);
  }
});
