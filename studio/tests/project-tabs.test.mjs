import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './extensions/studio-workstation/src/project-tabs';
  export { configureLocalization } from './extensions/studio-workstation/src/localization';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const chinese = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));
const uri = value => ({ scheme: new URL(value).protocol.slice(0, -1), fsPath: new URL(value).protocol === 'file:' ? fileURLToPath(value) : '', toString: () => value });

for (const language of ['en', 'zh-cn']) {
  test(`${language}: project tabs choose existing or external projects and cancellation leaves the window alone`, async () => {
    const dialogs = [], picks = [], module = { exports: {} };
    let selection, folder;
    const vscode = { Uri: { parse: uri, file: value => uri(pathToFileURL(value).href) }, window: {
      showQuickPick: async (items, options) => { picks.push({ items, options }); return typeof selection === 'number' ? items[selection] : undefined; },
      showOpenDialog: async options => { dialogs.push(options); return folder ? [uri(folder)] : undefined; },
    } };
    runInNewContext(compiled.outputFiles[0].text, { exports: module.exports, module, require: name => name === 'vscode' ? vscode : require(name) });
    const { chooseProjectTab, inspectProjectTab, configureLocalization } = module.exports;
    configureLocalization(language === 'en' ? {} : chinese, language);
    const project = { uri: 'file:///projects/other', folderPath: '/projects/other', name: 'Other', projectType: 'workflow' };
    assert.equal(await chooseProjectTab([project]), undefined); assert.equal(dialogs.length, 0);
    assert.equal(picks[0].options.title, language === 'en' ? 'Open Other Project' : '打开其它项目');
    selection = 0; assert.equal((await chooseProjectTab([project])).toString(), project.uri);
    selection = 1; assert.equal(await chooseProjectTab([project]), undefined);
    folder = 'file:///external/project'; assert.equal((await chooseProjectTab([project])).toString(), folder);
    assert.equal(dialogs.at(-1).canSelectFiles, false); assert.equal(dialogs.at(-1).canSelectFolders, true);
    assert.equal((await chooseProjectTab([], '/external/project')).toString(), folder);
    const inspected = await inspectProjectTab(uri(project.uri), { inspect: async paths => {
      assert.deepEqual(Array.from(paths), [project.folderPath]); return { projects: [project], errors: [] };
    } });
    assert.deepEqual({ ...inspected }, project);
    await assert.rejects(inspectProjectTab(uri('file:///plain-folder'), { inspect: async () => ({ projects: [], errors: [] }) }),
      error => error.message === (language === 'en' ? 'Select a SteamHarness project folder.' : '请选择 SteamHarness 项目文件夹。'));
    await assert.rejects(inspectProjectTab(uri('https://example.test/project'), { inspect: () => { throw new Error('must not inspect remote URLs'); } }),
      error => error.message === (language === 'en' ? 'Select a SteamHarness project folder.' : '请选择 SteamHarness 项目文件夹。'));
  });
}
