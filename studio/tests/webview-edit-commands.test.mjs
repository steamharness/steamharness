import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const html = await readFile(new URL('../upstream/vscode/src/vs/workbench/contrib/webview/browser/pre/index.html', import.meta.url), 'utf8');
const handler = html.match(/hostMessaging\.onMessage\('execCommand', \(_event, data\) => \{([\s\S]*?)\n\t\t\t\}\);/)[1];

test('native edit commands can be routed by the embedded editor, preserving the standard fallback', () => {
  const commands = [], events = [];
  let cancelled = false, callback, target;
  const contentWindow = {
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    dispatchEvent: event => { events.push({ ...event }); return !cancelled; },
  };
  runInNewContext(`hostMessaging.onMessage('execCommand', (_event, data) => {${handler}\n});`, {
    hostMessaging: { onMessage: (_type, listener) => { callback = listener; } }, getActiveFrame: () => target,
    assertIsDefined: value => { assert.ok(value); return value; },
  });
  callback(undefined, 'paste');
  target = { contentWindow, contentDocument: { execCommand: command => commands.push(command) } };
  callback(undefined, 'paste');
  cancelled = true; callback(undefined, 'copy');
  const clipboard = { text: 'native text', image: new Uint8Array([1, 2, 3]) };
  callback(undefined, { command: 'paste', clipboard });
  assert.deepEqual(commands, ['paste']);
  assert.deepEqual(events, [
    { type: 'vscode-webview-exec-command', detail: 'paste', cancelable: true },
    { type: 'vscode-webview-exec-command', detail: 'copy', cancelable: true },
    { type: 'vscode-webview-exec-command', detail: { command: 'paste', clipboard }, cancelable: true },
  ]);
});

test('native copy reads text, readonly input selections and same-origin preview frames without using iframe clipboard permissions', () => {
  const copies = [], commands = []; let callback, text = 'Response\n\u4e2d\u6587 error log';
  const contentWindow = { CustomEvent: class {}, dispatchEvent: () => true, getSelection: () => ({ toString: () => text }) };
  const contentDocument = { activeElement: null, execCommand: command => commands.push(command) };
  runInNewContext(`hostMessaging.onMessage('execCommand', (_event, data) => {${handler}\n});`, {
    hostMessaging: { onMessage: (_type, listener) => { callback = listener; }, postMessage: (type, text) => copies.push({ type, text }) },
    getActiveFrame: () => ({ contentWindow, contentDocument }), assertIsDefined: value => value,
  });
  callback(undefined, { command: 'copy' });
  contentDocument.activeElement = { tagName: 'TEXTAREA', value: 'Before selected After', selectionStart: 7, selectionEnd: 15, readOnly: true };
  callback(undefined, { command: 'copy' });
  contentDocument.activeElement = { tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 };
  callback(undefined, { command: 'copy' });
  contentDocument.activeElement = { tagName: 'IFRAME', contentDocument: { activeElement: null }, contentWindow: { getSelection: () => ({ toString: () => 'Preview text' }) } };
  callback(undefined, { command: 'copy' });
  contentDocument.activeElement = null; text = ''; callback(undefined, { command: 'copy' });
  assert.deepEqual(copies, [{ type: 'did-copy', text: 'Response\n\u4e2d\u6587 error log' }, { type: 'did-copy', text: 'selected' }, { type: 'did-copy', text: 'Preview text' }]);
  assert.deepEqual(commands, []);
});

const electronSource = await readFile(new URL('../upstream/vscode/src/vs/workbench/contrib/webview/electron-browser/webviewElement.ts', import.meta.url), 'utf8');
const copyMethod = electronSource.slice(electronSource.indexOf('\tpublic override copy()'), electronSource.indexOf('\tpublic override paste()'));
const copyHandler = electronSource.match(/this\._register\(this\.on\('did-copy', async text => \{([\s\S]*?)\n\t\t\}\)\);/)[1];
test('Studio copy uses the native clipboard and reports failures, ignoring empty, unfocused and foreign requests', async () => {
  const copies = [], commands = [], errors = []; let standardCopies = 0;
  const code = ts.transpileModule(`new (class extends Base { ${copyMethod} async receive(text) { ${copyHandler} } })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const view = runInNewContext(code, { Base: class { copy() { standardCopies++; } }, notificationService: { error: error => errors.push(error.message) } });
  Object.assign(view, { extension: { id: { value: 'studio.studio-workstation' } }, isFocused: true, execCommand: command => commands.push(command),
    _nativeHostService: { writeClipboardText: async text => { copies.push(text); if (text === 'denied') { throw new Error('Native copy denied'); } } } });
  view.copy(); await view.receive('Visible text'); await view.receive('denied'); await view.receive(''); await view.receive(123);
  view.isFocused = false; await view.receive('background'); view.isFocused = true;
  view.extension.id.value = 'other.extension'; view.copy(); await view.receive('foreign');
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [{ command: 'copy' }]);
  assert.deepEqual(copies, ['Visible text', 'denied']); assert.deepEqual(errors, ['Native copy denied']); assert.equal(standardCopies, 1);
});
const pasteMethods = electronSource.slice(electronSource.indexOf('\tpublic override paste()'), electronSource.indexOf('\n\t/**\n\t * Webviews expose'));
const pasteCode = ts.transpileModule(`new (class extends Base {${pasteMethods}\n})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function nativePasteFixture() {
  const commands = [], reads = []; let standardPastes = 0;
  const view = runInNewContext(pasteCode, { Base: class { paste() { standardPastes++; } } });
  Object.assign(view, { element: {}, extension: { id: { value: 'studio.studio-workstation' } }, isFocused: true,
    execCommand: command => commands.push(command),
    _nativeHostService: { readClipboardText: async () => { reads.push('text'); return 'native text'; }, readImage: async () => { reads.push('image'); return new Uint8Array([1, 2, 3]); } } });
  return { view, commands, reads, standardPastes: () => standardPastes };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Studio paste reads text and image from the native host without changing other extensions', async () => {
  const { view, commands, reads, standardPastes } = nativePasteFixture();
  view.paste(); await settle();
  assert.deepEqual(reads, ['text', 'image']);
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [{ command: 'paste', clipboard: { text: 'native text', image: { 0: 1, 1: 2, 2: 3 } } }]);
  view.extension.id.value = 'other.extension'; view.paste(); await settle();
  assert.deepEqual(reads, ['text', 'image']); assert.equal(standardPastes(), 1);
});

test('late native clipboard data cannot paste into an unfocused, replaced or disposed view', async () => {
  for (const change of [view => { view.isFocused = false; }, view => { view.element = {}; }, view => { view.element = undefined; }]) {
    const { view, commands } = nativePasteFixture();
    view.paste(); change(view); await settle(); assert.deepEqual(commands, []);
  }
});

test('native clipboard failures retain the standard paste fallback without an unhandled rejection', async () => {
  const { view, commands, standardPastes } = nativePasteFixture();
  view._nativeHostService.readClipboardText = async () => { throw new Error('native denied'); };
  view.paste(); await settle(); assert.deepEqual(commands, []); assert.equal(standardPastes(), 1);
  view.paste(); view.isFocused = false; await settle(); assert.equal(standardPastes(), 1);
});

test('the preloader CSP permits the exact edited inline script', () => {
  const script = html.match(/<script async type="module">([\s\S]*?)<\/script>/)[1];
  assert.equal(html.match(/script-src 'sha256-([^']+)'/)[1], createHash('sha256').update(script).digest('base64'));
});
