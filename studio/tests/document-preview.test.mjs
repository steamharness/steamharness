import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import path from 'node:path';
import { register } from 'tsx/esm/api';
import * as XLSX from 'xlsx';
register();
const require = createRequire(import.meta.url);
const { documentPreviewKind, documentPreviewView, samePreviewBytes } = await import('../extensions/studio-workstation/src/document-preview-types.ts');
const { parseSpreadsheet } = await import('../extensions/studio-workstation/webview/document-preview/spreadsheet-model.ts');
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/document-preview.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });

class Emitter {
  listeners = new Set();
  event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
  fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
  dispose() { this.listeners.clear(); }
}
class Uri {
  constructor(path, scheme = 'file') { this.path = path; this.scheme = scheme; }
  toString() { return `${this.scheme}://${this.path}`; }
  static joinPath(root, ...parts) { return new Uri(path.posix.join(root.path, ...parts), root.scheme); }
}
class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, language = 'en') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchers = [], providers = new Map(), commands = new Map(), copied = [], panels = [];
  let bytes = Buffer.from([1, 2, 3]), size, reads = 0, failure, pending;
  const vscode = { Uri, EventEmitter: Emitter, RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    CancellationError: class extends Error {}, FileSystemError, FileType: { Directory: 2 },
    env: { language, clipboard: { writeText: async text => copied.push(text) } },
    workspace: {
      fs: { stat: async () => { if (failure) { throw failure; } return { type: 1, size: size ?? bytes.length }; }, readFile: async () => { ++reads; return pending ? pending() : bytes; } },
      createFileSystemWatcher: pattern => {
        const create = new Emitter(), change = new Emitter(), deleted = new Emitter();
        const watcher = { pattern, create, change, deleted, onDidCreate: create.event, onDidChange: change.event, onDidDelete: deleted.event,
          disposed: false, dispose() { this.disposed = true; create.dispose(); change.dispose(); deleted.dispose(); } };
        watchers.push(watcher); return watcher;
      },
    }, window: { registerCustomEditorProvider: (id, provider) => { providers.set(id, provider); return { dispose() {} }; } },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    crypto: globalThis.crypto, setTimeout, clearTimeout });
  const context = { extensionUri: new Uri('/extension'), subscriptions: [] };
  module.exports.activateDocumentPreviews(context);
  const provider = providers.get('studio.documentPreview'); t.after(() => provider.dispose());
  const open = async (name = '/workspace/book.xlsx', scheme = 'file') => {
    const document = await provider.openCustomDocument(new Uri(name, scheme), {}, { isCancellationRequested: false });
    const panel = attach(document); await panel.send({ type: 'ready' }); return { document, panel };
  };
  const attach = document => {
    const messages = [], changed = new Emitter(), closed = new Emitter(); let receive;
    const panel = { visible: true, active: true, messages, changed, closed,
      webview: { cspSource: 'vscode-resource:', asWebviewUri: uri => uri, postMessage: async message => { messages.push(message); return true; },
        onDidReceiveMessage: fn => { receive = fn; return { dispose() { receive = undefined; } }; } },
      onDidChangeViewState: changed.event, onDidDispose: closed.event, send: message => receive?.(message) };
    provider.resolveCustomEditor(document, panel, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    panels.push(panel); return panel;
  };
  const debounce = async () => {
    t.mock.timers.tick(150); await tick();
    t.mock.timers.tick(150); await tick();
  };
  return { open, attach, watchers, copied, panels, commands, provider, debounce,
    update: next => { bytes = next; }, size: value => { size = value; }, failure: value => { failure = value; }, pending: fn => { pending = fn; },
    reads: () => reads, latest: panel => panel.messages.at(-1) };
}

test('preview formats are case insensitive and LaTeX routes to its formula editor', () => {
  assert.equal(documentPreviewKind('/files/IMG_0895.HEIC'), 'image');
  for (const extension of ['pdf', 'docx', 'pptx', 'xlsx', 'tex', 'latex', 'svg', 'heif']) { assert.ok(documentPreviewKind(`file.${extension}`)); }
  assert.equal(documentPreviewKind('file.exe'), undefined); assert.equal(documentPreviewView('file.tex'), 'studio.formulaPreview');
  assert.equal(samePreviewBytes(new Uint8Array([1]), new Uint8Array([1])), true);
  assert.equal(samePreviewBytes(new Uint8Array([1]), new Uint8Array([2])), false);
});

test('the host reads only its document URI through workspace.fs and watches atomic saves in the parent', async t => {
  const f = fixture(t), { document, panel } = await f.open('/work with spaces/a[1].PDF', 'vscode-remote');
  assert.equal(f.latest(panel).type, 'document'); assert.equal(f.latest(panel).kind, 'pdf');
  assert.equal(f.latest(panel).bytes.constructor.name, 'Uint8Array', 'Node Buffers must not serialize as a JSON object');
  assert.equal(f.watchers[0].pattern.base.path, '/work with spaces'); assert.equal(f.watchers[0].pattern.pattern, '*');
  f.update(new Uint8Array([9])); f.watchers[0].change.fire(new Uri('/work with spaces/other.PDF', 'vscode-remote'));
  await f.debounce(); assert.equal(f.reads(), 1);
  f.watchers[0].deleted.fire(document.uri); f.watchers[0].create.fire(document.uri); f.watchers[0].change.fire(document.uri);
  await f.debounce(); assert.equal(f.reads(), 2); assert.equal(f.latest(panel).bytes[0], 9);
  await panel.send({ type: 'read', path: '/secret' }); await panel.send({ type: 'write', bytes: [1] }); assert.equal(f.reads(), 2);
});

test('late reads cannot overwrite a newer revision or a closed panel', async t => {
  const f = fixture(t), { document, panel } = await f.open(); let complete;
  f.pending(() => new Promise(resolve => { complete = resolve; }));
  const reading = panel.send({ type: 'refresh' }); await tick();
  f.watchers[0].change.fire(document.uri); complete(new Uint8Array([8])); await reading;
  assert.equal(f.latest(panel).type, 'loading');
  f.pending(undefined); f.update(new Uint8Array([7])); await f.debounce(); assert.equal(f.latest(panel).bytes[0], 7);
  f.pending(() => new Promise(resolve => { complete = resolve; })); const closing = panel.send({ type: 'refresh' }); await tick();
  const count = panel.messages.length; panel.closed.fire(); complete(new Uint8Array([6])); await closing;
  assert.equal(panel.messages.length, count); document.dispose(); assert.equal(f.watchers[0].disposed, true);
});

test('hidden panels refresh on reveal and split editors follow the same source', async t => {
  const f = fixture(t), { document, panel } = await f.open(); const split = f.attach(document); await split.send({ type: 'ready' });
  panel.visible = false; f.update(new Uint8Array([4])); f.watchers[0].change.fire(document.uri); await f.debounce();
  assert.equal(f.latest(panel).bytes[0], 1); assert.equal(f.latest(split).bytes[0], 4);
  panel.visible = true; panel.changed.fire(); await f.debounce(); assert.equal(f.latest(panel).bytes[0], 4);
});

for (const language of ['en', 'zh-cn']) {
  test(`${language}: file errors, deletion and recreation retain a usable preview session`, async t => {
    const f = fixture(t, language), { document, panel } = await f.open('empty.tex');
    f.update(new Uint8Array()); await panel.send({ type: 'refresh' }); assert.equal(f.latest(panel).type, 'error');
    assert.equal(f.latest(panel).error, language === 'en' ? 'The file is empty.' : '文件为空。');
    f.failure(new FileSystemError('FileNotFound')); f.watchers[0].deleted.fire(document.uri); await f.debounce();
    assert.equal(f.latest(panel).error, language === 'en' ? 'File does not exist.' : '文件不存在。');
    f.failure(undefined); f.update(new Uint8Array([5])); f.watchers[0].create.fire(document.uri); await f.debounce();
    assert.equal(f.latest(panel).type, 'document'); assert.equal(f.latest(panel).bytes[0], 5);
  });
}

test('size limits apply before and after reads and the clipboard bridge accepts only bounded text', async t => {
  const f = fixture(t), { panel } = await f.open('/file.tex');
  f.size(201 * 1024); await panel.send({ type: 'refresh' }); assert.match(f.latest(panel).error, /200 KB/); assert.equal(f.reads(), 1);
  f.size(1); f.update(new Uint8Array(201 * 1024)); await panel.send({ type: 'refresh' }); assert.equal(f.latest(panel).type, 'error');
  await panel.send({ type: 'copy', text: 'slide text' }); await panel.send({ type: 'copy', text: 'x'.repeat(1024 * 1024 + 1) });
  assert.deepEqual(f.copied, ['slide text']);
});

test('SheetJS preview retains formatted cells, cached formulas, merges and visible sheet order without evaluating formulas', () => {
  const workbook = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([['<script>unsafe</script>', 123], ['=literal', 0.25]]);
  sheet.B2.z = '0%'; sheet.C1 = { t: 'n', f: 'SUM(B1:B2)' }; sheet['!ref'] = 'A1:C2'; sheet['!merges'] = [XLSX.utils.decode_range('A3:C3')];
  XLSX.utils.book_append_sheet(workbook, sheet, 'Visible'); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['secret']]), 'Hidden');
  workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  const result = parseSpreadsheet(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
  assert.equal(result.length, 1); assert.equal(result[0].name, 'Visible'); assert.equal(result[0].cells.A1, '<script>unsafe</script>');
  assert.equal(result[0].cells.A2, '=literal'); assert.equal(result[0].cells.B2, '25%'); assert.equal(result[0].merges.length, 1);
});

test('spreadsheet range guards reject a sparse sheet with an excessive declared range', () => {
  const workbook = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([['value']]); sheet['!ref'] = 'A1:ZZ30000';
  XLSX.utils.book_append_sheet(workbook, sheet, 'Large');
  assert.throws(() => parseSpreadsheet(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })), /SPREADSHEET_RANGE_LIMIT/);
});
