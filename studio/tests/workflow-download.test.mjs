import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-download.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode', '@vscode/l10n'], write: false });
const chinese = JSON.parse(await readFile('extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const uri = fsPath => ({ scheme: 'file', fsPath });
const request = (requestId = 'export-1', name = 'conversation-1.json', content = '{"text":"对话内容\\n下一行"}') => ({ type: 'workflow-download', version: 1, requestId, name, content });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ showSaveDialog = async () => uri(resolve('exports', '对话.json')), writeFile = async () => {}, language = 'en' } = {}) {
  const module = { exports: {} }, dialogs = [], writes = [], information = [], errors = [];
  const defaultUri = uri(resolve('workspace'));
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, Error, TextEncoder,
    require: name => name === 'vscode' ? {
      Uri: { joinPath: (base, name) => uri(join(base.fsPath, name)) },
      workspace: { fs: { writeFile: async (target, data) => { writes.push({ target, data }); await writeFile(target, data); } } },
      window: {
        showSaveDialog: async options => { dialogs.push(options); return showSaveDialog(options); },
        showInformationMessage: async message => { information.push(message); },
        showErrorMessage: async message => { errors.push(message); },
      },
    } : { t: (text, ...args) => (language === 'en' ? text : chinese[text] ?? text).replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])) },
  });
  return { binding: module.exports.bindProjectDownload(defaultUri), defaultUri, dialogs, writes, information, errors };
}

for (const language of ['en', 'zh-cn']) {
  test(`${language}: notifies the chosen path only after the complete UTF-8 file is saved`, async () => {
    const saved = deferred(), message = request(), target = uri(resolve('exports', '另存的对话.json'));
    const f = fixture({ showSaveDialog: async () => target, writeFile: () => saved.promise, language });
    assert.equal(f.binding.receive(message), true); await tick();
    assert.equal(f.dialogs[0].defaultUri.fsPath, join(f.defaultUri.fsPath, message.name));
    assert.equal(f.dialogs[0].title, language === 'en' ? 'Export file' : '导出文件');
    assert.equal(f.dialogs[0].saveLabel, language === 'en' ? 'Export' : '导出');
    assert.equal(f.writes[0].target, target);
    assert.equal(new TextDecoder().decode(f.writes[0].data), message.content);
    assert.deepEqual(f.information, []); assert.deepEqual(f.errors, []);
    saved.resolve(); await tick();
    assert.deepEqual(f.information, [language === 'en' ? `Exported to ${target.fsPath}.` : `已导出到 ${target.fsPath}。`]);
  });

  test(`${language}: dialog and write failures show an error without claiming success`, async () => {
    for (const options of [{ showSaveDialog: async () => { throw new Error('dialog failed'); } }, { writeFile: async () => { throw new Error('disk full'); } }]) {
      const f = fixture({ ...options, language }); f.binding.receive(request()); await tick();
      assert.deepEqual(f.information, []);
      assert.deepEqual(f.errors, [language === 'en' ? `Unable to export: ${options.writeFile ? 'disk full' : 'dialog failed'}` : `无法导出：${options.writeFile ? 'disk full' : 'dialog failed'}`]);
    }
  });
}

test('cancelling the save dialog writes nothing and shows no success or error', async () => {
  const f = fixture({ showSaveDialog: async () => undefined });
  f.binding.receive(request()); await tick();
  assert.equal(f.dialogs.length, 1); assert.deepEqual(f.writes, []);
  assert.deepEqual(f.information, []); assert.deepEqual(f.errors, []);
});

test('serializes exports without losing later requests and deduplicates in-flight requests', async () => {
  const firstDialog = deferred(), firstWrite = deferred(), target = uri(resolve('exports', 'first.json'));
  let count = 0;
  const f = fixture({ showSaveDialog: () => ++count === 1 ? firstDialog.promise : target, writeFile: () => f.writes.length === 1 ? firstWrite.promise : Promise.resolve() });
  f.binding.receive(request()); f.binding.receive(request());
  f.binding.receive(request('export-2', 'workflow-2.json', 'second export')); await tick();
  assert.equal(f.dialogs.length, 1); assert.deepEqual(f.writes, []);
  firstDialog.resolve(target); await tick();
  assert.equal(f.dialogs.length, 1); assert.equal(f.writes.length, 1); assert.deepEqual(f.information, []);
  firstWrite.reject(new Error('disk full')); await tick();
  assert.equal(f.dialogs.length, 2); assert.equal(f.writes.length, 2);
  assert.equal(new TextDecoder().decode(f.writes[1].data), 'second export');
  assert.equal(f.errors.length, 1); assert.equal(f.information.length, 1);
});

test('closing a view cancels queued exports and prevents late writes and notifications', async () => {
  const selected = deferred(), f = fixture({ showSaveDialog: () => selected.promise });
  f.binding.receive(request()); f.binding.receive(request('queued')); await tick();
  f.binding.dispose(); selected.resolve(uri(resolve('exports', 'late.json'))); await tick();
  assert.equal(f.dialogs.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.information, []); assert.deepEqual(f.errors, []);
  assert.equal(f.binding.receive(request('closed')), false);
  const saved = deferred(), writing = fixture({ writeFile: () => saved.promise });
  writing.binding.receive(request()); await tick(); writing.binding.dispose(); saved.resolve(); await tick();
  assert.equal(writing.writes.length, 1); assert.deepEqual(writing.information, []); assert.deepEqual(writing.errors, []);
  const unopened = fixture(); unopened.binding.receive(request()); unopened.binding.dispose(); await tick();
  assert.deepEqual(unopened.dialogs, []);
});

test('rejects malformed messages and filenames without opening a save dialog', async () => {
  const f = fixture();
  for (const message of [undefined, {}, { ...request(), version: 2 }, { ...request(), requestId: '' }, { ...request(), requestId: 'x'.repeat(129) }, { ...request(), content: {} },
    ...['', '.', '..', '../export.json', 'folder/export.json', 'folder\\export.json', 'C:export.json', 'a\0b', 'a\nb', 'a?b'].map(name => ({ ...request(), name }))]) {
    assert.equal(f.binding.receive(message), false);
  }
  await tick(); assert.deepEqual(f.dialogs, []); assert.deepEqual(f.writes, []);
  assert.equal(f.binding.receive(request('empty', '空对话.json', '')), true); await tick();
  assert.equal(f.writes[0].data.length, 0); assert.equal(f.information.length, 1);
});
