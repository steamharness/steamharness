import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const compile = async entry => (await build({ entryPoints: [`extensions/studio-workstation/${entry}.ts`], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], write: false })).outputFiles[0].text;
const [client, server, policy] = await Promise.all(['webview/context-menu', 'src/webview-context-menu', 'webview/resource-context'].map(compile));
const load = (source, globals = {}) => {
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require, crypto: globalThis.crypto, ...globals });
  return module.exports;
};

class Element {
  attributes = new Map(); isConnected = true; isContentEditable = false;
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  closest() { return this.field ?? null; }
  matches() { return this.type === 'password'; }
}

function fixture(resolve = () => [], getVersion = () => 0, anchor) {
  const listeners = new Map(), sent = [];
  let selection = '', selectedTarget;
  load(client, { Element, document: { querySelector: () => ({ content: 'view-a' }), addEventListener: (type, fn) => listeners.set(type, fn) },
    window: { addEventListener: (type, fn) => listeners.set(type, fn), getSelection: () => ({ rangeCount: selection ? 1 : 0,
      toString: () => selection, getRangeAt: () => ({ intersectsNode: target => target === selectedTarget }) }) } })
    .installContextMenu({ postMessage: message => sent.push(message) }, resolve, getVersion, anchor);
  const context = (target, extra = {}) => {
    let prevented = false;
    listeners.get('contextmenu')({ target, preventDefault: () => { prevented = true; }, ...extra });
    return { prevented, data: JSON.parse(target.getAttribute('data-vscode-context') ?? '{}') };
  };
  const execute = (data, action, extra = {}) => listeners.get('message')({ data: { type: 'studio-context-action', menu: data.studioContextMenu,
    request: data.studioContextRequest, action, ...extra } });
  return { context, execute, sent, listeners, select: (target, text) => { selectedTarget = target; selection = text; } };
}

test('native object menus act on the right-clicked item and preserve unrelated context data', () => {
  const first = new Element(), second = new Element(), calls = [];
  second.setAttribute('data-vscode-context', '{"custom":"kept"}');
  const f = fixture(target => [{ id: 'delete', run: () => calls.push(target) }]);
  f.context(first);
  const { data, prevented } = f.context(second);
  assert.equal(prevented, false); assert.equal(data.preventDefaultContextMenuItems, true);
  assert.equal(data.studioContextAction_delete, true); assert.equal(data.custom, 'kept');
  assert.equal(first.getAttribute('data-vscode-context'), null);
  f.execute(data, 'delete', { menu: 'foreign-view' }); assert.equal(calls.length, 0);
  f.execute(data, 'delete'); f.execute(data, 'delete');
  assert.deepEqual(calls, [second]); assert.equal(second.getAttribute('data-vscode-context'), '{"custom":"kept"}');
});

test('stale targets, project changes, removed permissions and cancelled menus cannot execute actions', () => {
  for (const scenario of ['detached', 'generation', 'permission', 'cancelled', 'request']) {
    let version = 0, writable = true, calls = 0;
    const target = new Element(), f = fixture(() => writable ? [{ id: 'delete', run: () => { calls++; } }] : [], () => version);
    const { data } = f.context(target);
    if (scenario === 'detached') { target.isConnected = false; }
    if (scenario === 'generation') { version++; }
    if (scenario === 'permission') { writable = false; }
    if (scenario === 'cancelled') { f.listeners.get('pointerdown')({ button: 0 }); }
    if (scenario === 'request') { data.studioContextRequest++; }
    f.execute(data, 'delete'); assert.equal(calls, 0, scenario);
  }
});

test('streaming trace content keeps its menu bound to the stable record when inner text is replaced', () => {
  const row = new Element(), text = new Element();
  let copied = 0;
  const f = fixture(target => [{ id: 'copyRecord', run: () => { assert.equal(target, row); copied++; } }], () => 0, () => row);
  f.context(text);
  const data = JSON.parse(row.getAttribute('data-vscode-context'));
  text.isConnected = false;
  f.execute(data, 'copyRecord'); assert.equal(copied, 1);
});

test('editable fields retain native editing while readonly fields only copy the captured selection', () => {
  const f = fixture(), input = new Element();
  input.type = 'text'; input.value = 'before selected after'; input.field = input;
  input.selectionStart = 7; input.selectionEnd = 15;
  assert.deepEqual(f.context(input), { prevented: false, data: {} });
  const contenteditable = new Element(); contenteditable.isContentEditable = true;
  assert.deepEqual(f.context(contenteditable), { prevented: false, data: {} });
  input.readOnly = true;
  const { data } = f.context(input);
  assert.equal(data.studioContextAction_copy, true); assert.equal(data.preventDefaultContextMenuItems, true);
  input.selectionStart = input.selectionEnd = 0;
  f.execute(data, 'copy'); assert.equal(f.sent[0].text, 'selected');
  input.disabled = true; assert.equal(f.context(input).prevented, true);
  input.disabled = false; input.type = 'password'; assert.equal(f.context(input).prevented, true);
  input.readOnly = false; assert.equal(f.context(input).prevented, false);
});

test('readonly selections offer Copy only, preserve text after native focus loss and do not hide another object menu', () => {
  const target = new Element(), other = new Element(), f = fixture(() => [{ id: 'open', run() {} }]);
  f.select(target, '正文\nconst value = 1;');
  const { data } = f.context(target);
  assert.equal(data.studioContextAction_copy, true); assert.equal(data.studioContextAction_open, undefined);
  assert.equal(f.context(other).data.studioContextAction_open, true);
  const latest = f.context(target).data; f.select(target, '');
  f.execute(latest, 'copy'); assert.equal(f.sent[0].text, '正文\nconst value = 1;');
  assert.equal(f.sent[0].menu, 'view-a');
  const blank = fixture(); assert.equal(blank.context(target).prevented, true);
  assert.equal(blank.context(target, { defaultPrevented: true }).prevented, false);
});

test('native commands route to the matching live webview, copy once and unregister disposed bindings', async () => {
  const commands = new Map(), copied = [], failures = [];
  const vscode = { commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    env: { clipboard: { writeText: async text => { copied.push(text); if (text === 'denied') { throw new Error('clipboard denied'); } } } },
    window: { showErrorMessage: async text => failures.push(text) } };
  const { webviewContextMenu } = load(server, { require: name => name === 'vscode' ? vscode : require(name) });
  const context = { subscriptions: [] };
  const view = () => {
    const messages = []; let receiver, dispose;
    const owner = { visible: true, onDidDispose: fn => { dispose = fn; return { dispose() {} }; }, webview: {
      postMessage: async message => messages.push(message), onDidReceiveMessage: fn => { receiver = fn; return { dispose() {} }; } } };
    const id = webviewContextMenu(context, owner).match(/content="([^"]+)"/)[1];
    return { owner, id, messages, receive: message => receiver(message), dispose: () => dispose() };
  };
  const first = view(), second = view();
  const input = { studioContextMenu: second.id, studioContextRequest: 3 };
  const command = commands.get('studio.context.copy');
  await command(); await command({ ...input, studioContextMenu: 'foreign' }); await command({ ...input, studioContextRequest: NaN });
  assert.equal(second.messages.length, 0);
  await command(input); assert.equal(first.messages.length, 0); assert.equal(second.messages[0].request, 3);
  await first.receive({ type: 'studio-context-copy', menu: second.id, request: 3, text: 'foreign' });
  await second.receive({ type: 'studio-context-copy', menu: second.id, request: 2, text: 'old' });
  const reply = { type: 'studio-context-copy', menu: second.id, request: 3, text: 'native selection' };
  await second.receive(reply); await second.receive(reply); assert.deepEqual(copied, ['native selection']);
  await command(input); await second.receive({ ...reply, text: 'denied' }); assert.equal(failures.length, 1);
  second.owner.visible = false; await command(input); assert.equal(second.messages.length, 2);
  second.owner.visible = true;
  const reloadedId = webviewContextMenu(context, second.owner).match(/content="([^"]+)"/)[1];
  assert.notEqual(reloadedId, second.id);
  await command(input); assert.equal(second.messages.length, 2, 'Menus from the previous page cannot reach a replacement page.');
  const reloadedInput = { ...input, studioContextMenu: reloadedId };
  await command(reloadedInput); assert.equal(second.messages.length, 3);
  await second.receive(reply); assert.equal(copied.length, 2);
  second.dispose(); await command(reloadedInput); assert.equal(second.messages.length, 3);
});

test('KV and Knowledge actions follow data source, authentication, readonly previews, editing and pending mutations', () => {
  const { resourceMenuActions } = load(policy);
  const actions = extra => Array.from(resourceMenuActions({ kind: 'kv', source: 'local', readOnly: false, authenticated: false,
    saving: false, hasProject: true, target: 'row', editing: false, ...extra }));
  assert.deepEqual(actions(), ['open', 'edit', 'copyKey', 'copyContent', 'delete']);
  assert.deepEqual(actions({ kind: 'knowledge' }), ['open', 'edit', 'copyId', 'copyContent', 'delete']);
  assert.deepEqual(actions({ source: 'server' }), ['open', 'copyKey', 'copyContent']);
  assert.deepEqual(actions({ source: 'server', authenticated: true }), ['open', 'copyKey', 'copyContent', 'delete']);
  assert.deepEqual(actions({ source: 'server', authenticated: true, kind: 'knowledge' }), ['open', 'edit', 'copyId', 'copyContent', 'delete']);
  assert.deepEqual(actions({ readOnly: true }), ['open', 'copyKey', 'copyContent']);
  assert.deepEqual(actions({ saving: true }), ['copyKey', 'copyContent']);
  assert.deepEqual(actions({ target: 'detail', editing: true }), []);
  assert.deepEqual(actions({ target: 'list' }), ['newKey', 'refresh']);
  assert.deepEqual(actions({ target: 'list', kind: 'knowledge' }), ['newDocument', 'refresh']);
  assert.deepEqual(actions({ target: 'list', source: 'server', authenticated: true }), ['refresh']);
  assert.deepEqual(actions({ target: 'list', readOnly: true }), ['refresh']);
  assert.deepEqual(actions({ target: 'list', saving: true }), []);
  assert.deepEqual(actions({ hasProject: false }), []);
});

test('Knowledge search hits identify the underlying document for unsaved-change protection and deletion', () => {
  const { sameResource } = load(policy);
  const hit = { id: 'document:2', documentId: 'document' }, otherHit = { id: 'document:10', documentId: 'document' };
  assert.equal(sameResource('knowledge', hit, otherHit), true);
  assert.equal(sameResource('knowledge', hit, { id: 'document', documentId: 'document' }), true);
  assert.equal(sameResource('knowledge', hit, { id: 'other-document' }), false);
  assert.equal(sameResource('knowledge', hit, undefined), false);
  assert.equal(sameResource('kv', { id: '["project","","key"]' }, { id: '["conversation","session","key"]' }), false);
});

test('every native object action is hidden from the palette and has English and Chinese menu text', async () => {
  const root = new URL('../extensions/studio-workstation/', import.meta.url);
  const [manifest, en, zh] = await Promise.all(['package.json', 'package.nls.json', 'package.nls.zh-cn.json'].map(async file => JSON.parse(await readFile(new URL(file, root), 'utf8'))));
  for (const command of manifest.contributes.commands.filter(command => command.command.startsWith('studio.context.'))) {
    const key = command.title.slice(1, -1); assert.ok(en[key]); assert.ok(zh[key]);
    assert.ok(manifest.contributes.menus['webview/context'].some(item => item.command === command.command && item.when.includes('studioContextMenu')));
    assert.ok(manifest.contributes.menus.commandPalette.some(item => item.command === command.command && item.when === 'false'));
  }
});
