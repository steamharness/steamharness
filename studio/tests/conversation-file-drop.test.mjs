import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const patch = path.join(root, 'patches/0050-studio-conversation-file-drop.patch');
const contents = await readFile(patch, 'utf8');
const helper = contents.split('diff --git ')[1].split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');

function fixture() {
  const listeners = new Map(), messages = [];
  const code = ts.transpileModule(helper.replace(/^import .*;\n/gm, '').replace('export class StudioWebviewDrop', 'class StudioWebviewDrop') + '\nglobalThis.Drop = StudioWebviewDrop;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  class Disposable {
    items = []; _register(item) { this.items.push(item); return item; }
    dispose() { for (const item of this.items) item.dispose(); }
  }
  const context = {
    Disposable, EventType: { DRAG_OVER: 'dragover', DROP: 'drop' },
    addDisposableListener: (_window, type, listener, capture) => { assert.equal(capture, true); listeners.set(type, listener); return { dispose: () => listeners.delete(type) }; },
    containsDragType: event => event.supported !== false, extractEditorsDropData: event => event.editors ?? [],
    URI: { parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), toString: () => value }) },
  };
  runInNewContext(code, context);
  const drop = new context.Drop(message => messages.push(JSON.parse(JSON.stringify(message))));
  let visible = true;
  drop.mount({ checkVisibility: () => visible, getBoundingClientRect: () => ({ left: 20, top: 30, right: 220, bottom: 330, width: 200, height: 300 }) }, {});
  const dispatch = (type = 'drop', extra = {}) => {
    const event = { clientX: 100, clientY: 100, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; },
      dataTransfer: { getData: () => '' }, ...extra };
    listeners.get(type)(event); return event;
  };
  return { drop, messages, dispatch, listeners, hide: () => { visible = false; } };
}

test('native VS Code and external file paths reach only the currently enabled project frame', () => {
  const f = fixture();
  assert.equal(f.dispatch().prevented, false); f.drop.update('project:conversation:1');
  assert.equal(f.dispatch('dragover').prevented, true);
  const resource = value => ({ scheme: 'file', toString: () => value });
  const event = f.dispatch('drop', { editors: [{ resource: resource('file:///Desktop/folder') }, { resource: resource('file:///work/a%20b.ts') }, { resource: resource('file:///Desktop/folder') }] });
  assert.equal(event.stopped, true);
  assert.deepEqual(f.messages, [{ type: 'workflow-host', drop: { target: 'project:conversation:1', paths: ['file:///Desktop/folder', 'file:///work/a%20b.ts'] } }]);
  assert.equal(f.dispatch('drop', { clientX: 300 }).prevented, false);
  assert.equal(f.dispatch('drop', { supported: false }).prevented, false);
  f.hide(); assert.equal(f.dispatch().prevented, false);
  f.drop.update(undefined); assert.equal(f.dispatch().prevented, false);
  f.drop.dispose(); assert.equal(f.listeners.size, 0);
});

test('native URI drops preserve encoded names and exclude remote resources', () => {
  const f = fixture(); f.drop.update('new-target');
  f.dispatch('drop', { editors: [{ resource: { scheme: 'https' } }], dataTransfer: { getData: () => '# comment\r\nfile:///tmp/a%23.txt\r\nhttps://example.com' } });
  assert.deepEqual(f.messages[0].drop, { target: 'new-target', paths: ['file:///tmp/a%23.txt'] });
});

test('the integrated drag bridge patch reverses and reapplies against the pinned kernel without modifying the active checkout', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-drop-patch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(path.join(root, 'config/upstream.json'), 'utf8'));
  const files = ['src/vs/workbench/contrib/webview/browser/webviewElement.ts', 'src/vs/workbench/contrib/webview/browser/studioWebviewDrop.ts'];
  const original = files.map(filename => execFileSync('git', ['show', `${config.commit}:${filename}`], { cwd: path.join(root, config.path) }));
  for (const [index, filename] of files.entries()) {
    await mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
    await writeFile(path.join(directory, filename), original[index]);
  }
  execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: directory }); execFileSync('git', ['apply', '--reverse', patch], { cwd: directory });
  execFileSync('git', ['apply', '--check', patch], { cwd: directory }); execFileSync('git', ['apply', patch], { cwd: directory });
  assert.deepEqual(await Promise.all(files.map(filename => readFile(path.join(directory, filename)))), original);
});
