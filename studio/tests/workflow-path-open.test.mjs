import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { posix, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-path-open.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode', '@vscode/l10n'], write: false });
const chinese = JSON.parse(await readFile('extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (name = 'preview-sample.docx', requestId = 'open-1') => ({ type: 'workflow-path-open', version: 1, requestId, path: resolve('fixtures', name) });

function fixture({ stat = async () => ({ type: 1 }), openExternal = async () => true, executeCommand = async () => {}, language = 'en', basePath } = {}) {
  const module = { exports: {} }, replies = [], commands = [], external = [], stats = [], editors = [];
  const uriFor = path => ({ scheme: 'file', fsPath: path, path: path.replaceAll('\\', '/') });
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, Error,
    require: name => name === 'vscode' ? {
      Uri: { file: uriFor, joinPath: (base, path) => uriFor(posix.join(base.path, path)) },
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
      window: { showTextDocument: async (uri, options) => { editors.push({ uri, options }); } },
      FileType: { File: 1, Directory: 2 },
      workspace: { fs: { stat: async uri => { stats.push(uri); return stat(uri); } } },
      env: { openExternal: async uri => { external.push(uri); return openExternal(uri); } },
      commands: { executeCommand: async (...args) => { commands.push(args); return executeCommand(...args); } },
    } : name === '@vscode/l10n' ? { t: (text, ...args) => (language === 'en' ? text : chinese[text] ?? text).replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])) } : require(name),
  });
  const binding = module.exports.bindProjectPathOpen({ postMessage: async message => { replies.push(JSON.parse(JSON.stringify(message))); } }, basePath ? uriFor(basePath) : undefined);
  return { binding, replies, commands, external, stats, editors };
}

test('resolves output links against the bound project or Assistant workdir and selects the requested line', async () => {
  for (const basePath of ['/workspace/aggregate', '/workspace/assistant-target']) {
    const f = fixture({ basePath });
    for (const [index, path] of ['configuration.json', './src/a b.ts', '../common/报告.md', 'src\\main.ts'].entries()) {
      f.binding.receive({ ...request('unused', `link-${index}`), path, line: 12, column: 3 }); await tick();
      const editor = f.editors.at(-1);
      assert.equal(editor.uri.path, posix.join(basePath, path.replaceAll('\\', '/')));
      assert.deepEqual(JSON.parse(JSON.stringify(editor.options.selection)), { start: { line: 11, character: 2 }, end: { line: 11, character: 2 } });
      assert.equal(f.replies.at(-1).pathOpened.error, undefined);
    }
    assert.equal(f.commands.length, 0); assert.equal(f.external.length, 0);
    f.binding.receive({ ...request('file'), line: 1 }); await tick(); assert.equal(f.editors.at(-1).options.selection.start.character, 0);
    f.binding.receive({ ...request('file'), path: '/different/root/config.json' }); await tick();
    assert.equal(f.commands.at(-1)[1].path, '/different/root/config.json');
  }
});

test('validates editor coordinates and local paths even when a project base is available', async () => {
  const f = fixture({ basePath: '/workspace/project' });
  for (const coordinates of [{ line: 0 }, { line: -1 }, { line: 1.5 }, { line: '12' }, { line: NaN }, { line: Infinity }, { column: 2 }, { line: 1, column: 0 }]) {
    f.binding.receive({ ...request(), ...coordinates }); await tick();
    assert.match(f.replies.at(-1).pathOpened.error, /Invalid file line or column/);
  }
  for (const path of ['https://example.com/a', 'command:close', 'file:///tmp/a', '/tmp/a\0b']) {
    f.binding.receive({ ...request(), path }); await tick(); assert.ok(f.replies.at(-1).pathOpened.error);
  }
  assert.equal(f.stats.length, 0); assert.equal(f.editors.length, 0); assert.equal(f.commands.length, 0);
});

test('opens document references with Studio previews and code references with the editor', async () => {
  const f = fixture();
  for (const [index, name] of ['a b.DOCX', '报告.pdf', 'table.xlsx', 'slides.pptx', 'image.heic', 'formula.tex', 'main.ts', 'README.md'].entries()) {
    const message = request(name, `open-${index}`); assert.equal(f.binding.receive(message), true); await tick();
    const [command, uri, view] = f.commands.at(-1);
    assert.equal(uri.fsPath, message.path);
    if (index < 6) {
      assert.equal(command, 'vscode.openWith'); assert.equal(view, index === 5 ? 'studio.formulaPreview' : 'studio.documentPreview');
    } else { assert.equal(command, 'vscode.open'); assert.equal(view, undefined); }
    assert.deepEqual(f.replies.at(-1), { type: 'workflow-host', pathOpened: { version: 1, requestId: message.requestId } });
  }
  assert.equal(f.external.length, 0); assert.equal(f.stats.length, 8);
});

test('opens the folder itself in the system file manager and uses its actual filesystem type', async () => {
  const f = fixture({ stat: async () => ({ type: 2 | 64 }) }), message = { ...request('folder.docx'), kind: 'file' };
  f.binding.receive(message); await tick();
  assert.equal(f.external.length, 1); assert.equal(f.external[0].fsPath, message.path); assert.equal(f.commands.length, 0);
  assert.equal(f.replies[0].pathOpened.error, undefined);
  const file = fixture(); file.binding.receive({ ...request('main.ts'), kind: 'directory' }); await tick();
  assert.equal(file.commands[0][0], 'vscode.open'); assert.equal(file.external.length, 0);
});

for (const language of ['en', 'zh-cn']) {
  test(`${language}: reports invalid file coordinates in the host language`, async () => {
    const f = fixture({ language });
    f.binding.receive({ ...request(), line: 0 }); await tick();
    assert.match(f.replies[0].pathOpened.error, language === 'en' ? /Invalid file line or column/ : /文件行号或列号无效/);
  });

  test(`${language}: reports missing paths, unavailable file managers, and editor failures`, async () => {
    const cases = [
      { stat: async () => { throw new Error('ENOENT'); } },
      { stat: async () => ({ type: 2 }), openExternal: async () => false },
      { executeCommand: async () => { throw new Error('preview failed'); } },
      { stat: async () => ({ type: 0 }) },
    ];
    for (const options of cases) {
      const f = fixture({ ...options, language }); f.binding.receive(request()); await tick();
      assert.equal(f.replies.length, 1); assert.equal(f.replies[0].pathOpened.requestId, 'open-1');
      assert.match(f.replies[0].pathOpened.error, language === 'en' ? /^Unable to open the file or folder: / : /^无法打开文件或文件夹：/);
      assert.doesNotMatch(f.replies[0].pathOpened.error, /\{0\}/);
    }
  });
}

test('rejects nonlocal and malformed paths without launching an editor or file manager', async () => {
  const f = fixture();
  for (const message of [undefined, {}, { ...request(), version: 2 }, { ...request(), requestId: '' }, { ...request(), requestId: 'x'.repeat(129) }]) assert.equal(f.binding.receive(message), false);
  for (const [index, path] of ['', 'relative.txt', 'file:///tmp/file', 'https://example.com', 'command:workbench.action.closeWindow', '/tmp/a\0b', '/tmp/a\nb', '/'.repeat(4097), undefined, {}].entries()) {
    assert.equal(f.binding.receive({ ...request('file', `bad-${index}`), path }), true); await tick();
    assert.match(f.replies.at(-1).pathOpened.error, /Only (?:absolute )?local file or folder paths/);
  }
  assert.equal(f.stats.length, 0); assert.equal(f.commands.length, 0); assert.equal(f.external.length, 0);
});

test('deduplicates in-flight requests and does not open or reply after a view is disposed', async () => {
  let finish;
  const f = fixture({ stat: () => new Promise(resolve => { finish = resolve; }) });
  f.binding.receive(request()); f.binding.receive(request()); assert.equal(f.stats.length, 1);
  f.binding.dispose(); finish({ type: 1 }); await tick();
  assert.equal(f.commands.length, 0); assert.equal(f.replies.length, 0); assert.equal(f.binding.receive(request()), false);
});
