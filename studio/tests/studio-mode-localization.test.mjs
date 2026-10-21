import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { StudioModeController } from './extensions/studio-workstation/src/studio-mode';
  export { configureLocalization } from './extensions/studio-workstation/src/localization';
`, loader: 'ts', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const chinese = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);

for (const language of ['en', 'zh-cn']) {
  test(`${language}: mode availability is deduplicated and every public command and tool uses the host language`, async t => {
    const callbacks = new Map(), calls = [], subscriptions = [];
    const vscode = { commands: {
      registerCommand: (id, callback) => { callbacks.set(id, callback); return { dispose() {} }; },
      executeCommand: async (...args) => { calls.push(args); },
    } };
    const module = { exports: {} };
    runInNewContext(compiled.outputFiles[0].text, { exports: module.exports, module, require: name => {
      return name === 'vscode' ? vscode : require(name);
    } });
    module.exports.configureLocalization(language === 'en' ? {} : chinese, language);
    const controller = new module.exports.StudioModeController({ subscriptions }, { appendLine() {} });
    t.after(() => subscriptions.forEach(item => item.dispose()));
    controller.update(false); controller.update(false); controller.update(true); controller.update(true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call[1].available), [false, true]);
    const labels = calls[1][1].labels;
    assert.equal(labels.tools, language === 'en' ? 'Open Tools' : '打开工具');
    assert.equal(labels.hideTools, language === 'en' ? 'Hide Tools' : '隐藏工具区');
    assert.equal(labels.showTools, language === 'en' ? 'Show Tools' : '显示工具区');
    assert.equal(labels.switchToSteam, language === 'en' ? 'Switch to Steam Mode' : '切换到 Steam 模式');
    assert.equal(labels.loading, language === 'en' ? 'Loading project...' : '正在加载项目…');
    assert.equal(labels.workspace, language === 'en' ? 'Tool Workspace' : '工具工作区');
    assert.equal(labels.addTool, language === 'en' ? 'Open Tool' : '打开工具');
    assert.equal(labels.closeTab, language === 'en' ? 'Close {0}' : '关闭 {0}');
    assert.equal(labels.moveEditorsError, language === 'en' ? 'Unable to move tool workspace editors back to the IDE.' : '无法将工具工作区的编辑器移回 IDE。');
    assert.equal(labels.editorEmpty, language === 'en' ? 'Open a file from Explorer or Quick Open to start editing.' : '从资源管理器或快速打开中选择文件，开始编辑。');
    assert.equal(labels.openFile, language === 'en' ? 'Open File' : '打开文件');
    for (const id of ['editor', 'kv', 'knowledge', 'info', 'assistant', 'versions', 'trace', 'terminal', 'browser', 'project']) {
      assert.ok(labels[id]); assert.ok(labels[`${id}Hint`]);
      assert.equal(/\p{Script=Han}/u.test(labels[id]), language !== 'en');
    }
    for (const [id, native] of [['toggleMode', 'ToggleMode'], ['enterIdeMode', 'EnterIdeMode'], ['enterSteamMode', 'EnterSteamMode'], ['openSteamTools', 'OpenSteamTools']]) {
      await callbacks.get(`studio.${id}`)(); assert.equal(calls.at(-1)[0], `studio.internal${native}`);
    }
    controller.update(true, 'file:///project-one', true);
    controller.update(true, 'file:///project-one', true);
    controller.update(true, 'file:///project-two', false);
    assert.deepEqual(calls.slice(-2).map(call => [call[1].projectUri, call[1].ready]), [['file:///project-one', true], ['file:///project-two', false]]);
  });
}
