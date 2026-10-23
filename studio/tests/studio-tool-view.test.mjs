import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(await readFile(new URL('../upstream/vscode/src/vs/workbench/contrib/studioMode/browser/studioToolView.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText;

function fixture(t) {
  class Disposable {
    items = [];
    _register(item) { this.items.push(item); return item; }
    dispose() { for (const item of this.items.splice(0)) { item.dispose(); } }
  }
  class EditorInput extends Disposable {
    _onDidChangeLabel = { fire() {} };
    isDisposed() { return false; }
    matches(other) { return this === other; }
  }
  class EditorPane extends Disposable {
    visible = true;
    async setInput(input) { this.input = input; }
    setVisible(visible) { this.visible = visible; }
    isVisible() { return this.visible; }
    clearInput() { this.input = undefined; }
  }
  const node = () => ({ children: [], classList: { add() {} },
    appendChild(child) { this.insertBefore(child, null); },
    insertBefore(child, next) {
      if (child.parentNode) { child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); }
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, child); child.parentNode = this;
    },
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; },
  });
  const parent = node(), element = node(), next = node(), host = node();
  parent.appendChild(element); parent.appendChild(next);
  const dimensions = [], visibility = [];
  const view = { element, headerVisible: true, orientation: 1, setVisible: value => visibility.push(value),
    layout(size) { dimensions.push([this.orthogonalSize, size]); }, focus() {} };
  let Editor, Serializer;
  const common = { EditorInput, EditorPane, Dimension: { None: { width: 0, height: 0 } }, CancellationToken: { None: { isCancellationRequested: false } },
    Orientation: { VERTICAL: 1 }, EditorInputCapabilities: { Readonly: 1, Singleton: 2 },
    studioModeState: { state: { labels: { kv: 'KV Storage' } }, onDidChangeState: () => ({ dispose() {} }) },
    studioSteamToolDefinitions: [{ id: 'kv', view: 'studio.kv', icon: 'database' }, { id: 'terminal', view: 'terminal' }],
    ThemeIcon: { fromId: id => ({ id }) }, SyncDescriptor: class {},
    Registry: { as: () => ({ registerEditorPane: descriptor => { Editor = descriptor; }, registerEditorSerializer: (_id, ctor) => { Serializer = ctor; } }) },
    EditorExtensions: {}, EditorPaneDescriptor: { create: ctor => ctor },
  };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: () => new Proxy(common, { get: (object, key) => object[key] ?? (() => undefined) }) });
  const views = { openView: async () => view };
  const editor = new Editor({}, {}, {}, {}, views); editor.createEditor(host);
  const input = new module.exports.StudioToolViewInput('kv', 'studio.kv');
  t.after(() => editor.dispose());
  return { editor, input, views, view, parent, element, next, host, dimensions, visibility, serializer: new Serializer(), token: common.CancellationToken.None };
}

test('retained tool views return to their exact IDE position on hide, input close and disposal', async t => {
  const f = fixture(t);
  f.editor.layout({ width: 450, height: 620 });
  await f.editor.setInput(f.input, {}, {}, f.token);
  assert.equal(f.element.parentNode, f.host); assert.equal(f.view.headerVisible, false);
  assert.deepEqual(f.dimensions.at(-1), [450, 620]);
  f.editor.setVisible(false);
  assert.equal(f.element.parentNode, f.parent); assert.equal(f.element.nextSibling, f.next); assert.equal(f.view.headerVisible, true);
  f.editor.setVisible(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element.parentNode, f.host);
  f.editor.clearInput(); assert.equal(f.element.parentNode, f.parent);
  await f.editor.setInput(f.input, {}, {}, f.token);
  f.editor.dispose(); assert.equal(f.element.parentNode, f.parent);
});

test('a delayed view resolution cannot attach after its native tab is hidden or closed', async t => {
  const f = fixture(t); let resolve;
  f.views.openView = () => new Promise(done => { resolve = done; });
  const opening = f.editor.setInput(f.input, {}, {}, f.token);
  await new Promise(resolve => setImmediate(resolve)); f.editor.setVisible(false); resolve(f.view); await opening;
  assert.equal(f.element.parentNode, f.parent);
  f.editor.setVisible(true); f.editor.clearInput(); resolve(f.view); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element.parentNode, f.parent); assert.equal(f.view.headerVisible, true);
});

test('native tab serialization restores the retained view and rejects unknown or malformed tools', t => {
  const f = fixture(t), saved = f.serializer.serialize(f.input), restored = f.serializer.deserialize({}, saved);
  assert.equal(restored.viewId, 'studio.kv'); assert.equal(restored.getName(), 'KV Storage'); assert.equal(restored.matches(f.input), true);
  for (const value of ['invalid json', '{"toolId":"terminal"}', '{"toolId":"unknown"}', 'null']) {
    assert.equal(f.serializer.deserialize({}, value), undefined);
  }
});
