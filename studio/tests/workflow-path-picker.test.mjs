import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-path-picker.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode', '@vscode/l10n'], write: false });
const chinese = JSON.parse(await readFile('extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (kind = 'files', requestId = 'picker-1') => ({ type: 'workflow-path-picker', version: 1, kind, requestId, target: 'conversation:1' });
const uri = (value, scheme = 'file') => ({ scheme, toString: () => value });

function fixture(showOpenDialog, language = 'en') {
  const module = { exports: {} }, replies = [], defaultUri = uri('file:///workspace');
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, Error,
    require: name => name === 'vscode' ? { window: { showOpenDialog } } : { t: text => language === 'en' ? text : chinese[text] ?? text },
  });
  const binding = module.exports.bindProjectPathPicker({ postMessage: async message => { replies.push(JSON.parse(JSON.stringify(message))); } }, defaultUri);
  return { binding, replies, defaultUri };
}

for (const language of ['en', 'zh-cn']) {
  test(`${language}: native selection keeps file/folder paths and uses separate unrestricted multi-select dialogs`, async () => {
    const calls = [], { binding, replies, defaultUri } = fixture(async options => {
      calls.push(options); return options.canSelectFolders ? [uri('file:///Desktop/%E8%B5%84%E6%96%99')] : [uri('file:///work/a%20b.png'), uri('file:///C:/work/readme.txt')];
    }, language);
    assert.equal(binding.receive(request()), true); await tick();
    assert.equal(calls[0].canSelectFiles, true); assert.equal(calls[0].canSelectFolders, false); assert.equal(calls[0].canSelectMany, true);
    assert.equal(calls[0].defaultUri, defaultUri); assert.equal(calls[0].filters, undefined);
    assert.equal(calls[0].title, language === 'en' ? 'Choose files' : '选择文件');
    assert.deepEqual(replies[0], { type: 'workflow-host', pathSelection: { version: 1, requestId: 'picker-1', target: 'conversation:1', paths: ['file:///work/a%20b.png', 'file:///C:/work/readme.txt'] } });
    binding.receive(request('folders', 'picker-2')); await tick();
    assert.equal(calls[1].canSelectFolders, true); assert.equal(calls[1].canSelectFiles, false);
    assert.equal(calls[1].title, language === 'en' ? 'Choose folders' : '选择文件夹');
    assert.deepEqual(replies[1].pathSelection.paths, ['file:///Desktop/%E8%B5%84%E6%96%99']);
  });
}

test('native cancellation, failures and non-local resources return a scoped result', async () => {
  const results = [undefined, new Error('denied'), [uri('vscode-remote://ssh/remote', 'vscode-remote')]];
  const { binding, replies } = fixture(async () => { const result = results.shift(); if (result instanceof Error) throw result; return result; });
  for (let index = 0; index < 3; index++) { binding.receive(request('folders', `picker-${index}`)); await tick(); }
  assert.deepEqual(replies[0].pathSelection.paths, []); assert.equal(replies[0].pathSelection.error, undefined);
  assert.equal(replies[1].pathSelection.error, 'denied');
  assert.equal(replies[2].pathSelection.error, 'Only local files and folders can be referenced.');
  assert.deepEqual(replies[2].pathSelection.paths, []);
});

test('malformed requests never open native dialogs and disposed views suppress replies', async () => {
  let finish, count = 0;
  const { binding, replies } = fixture(async () => { count++; return await new Promise(resolve => { finish = resolve; }); });
  for (const message of [undefined, {}, { ...request(), version: 2 }, request('anything'), request(['files']), request('files', ''), request('files', 'a'.repeat(129)),
    { ...request(), target: '' }, { ...request(), target: 'x'.repeat(513) }]) assert.equal(binding.receive(message), false);
  assert.equal(count, 0);
  binding.receive(request()); binding.receive(request()); assert.equal(count, 1); assert.equal(replies.length, 0);
  binding.receive(request('folders', 'other')); assert.equal(count, 1); assert.deepEqual(replies[0].pathSelection.paths, []);
  binding.dispose(); finish([uri('file:///late')]); await tick(); assert.equal(replies.length, 1);
  assert.equal(binding.receive(request()), false);
});
