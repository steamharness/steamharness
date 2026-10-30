import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { register } from 'tsx/esm/api';
register();
const { projectFrameHtml } = await import('../extensions/studio-workstation/src/workflow-webview.ts');

function fixture() {
  const listeners = new Map(), frameListeners = new Map(), events = [], messages = [];
  const frame = { contentWindow: { postMessage: message => messages.push(message) }, addEventListener: (type, callback) => frameListeners.set(type, callback) };
  const document = { activeElement: frame, getElementById: () => frame, documentElement: { dataset: {} } };
  const html = projectFrameHtml('http://127.0.0.1:3000/', 'Project', 'project', 'dark', 'fixture');
  runInNewContext(html.match(/<script nonce="fixture">([\s\S]*?)<\/script>/)[1], {
    URL, acquireVsCodeApi: () => ({ setState() {}, postMessage() {} }), document,
    addEventListener: (type, callback) => listeners.set(type, callback),
    window: { dispatchEvent: event => events.push(event) },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  });
  const key = { type: 'keydown', key: 'p', code: 'KeyP', keyCode: 80, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false };
  const message = { source: frame.contentWindow, origin: 'http://127.0.0.1:3000', data: { type: 'workflow-keyboard', version: 1, event: key } };
  return { events, messages, document, key, message, send: event => listeners.get('message')(event), load: () => frameListeners.get('load')() };
}

test('advertises keyboard forwarding on every frame load and dispatches both phases through the native webview path', () => {
  const f = fixture(); f.load(); assert.equal(f.messages.at(-1).keyboardVersion, 1);
  f.send(f.message); f.send({ ...f.message, data: { ...f.message.data, event: { ...f.key, type: 'keyup' } } });
  assert.deepEqual(f.events.map(event => ({ ...event })), [
    { ...f.key, bubbles: true, cancelable: true }, { ...f.key, type: 'keyup', bubbles: true, cancelable: true },
  ]);
  f.load(); assert.equal(f.messages.at(-1).keyboardVersion, 1);
});

test('ignores unfocused frames, foreign origins/sources, incompatible versions and malformed keys', () => {
  const f = fixture();
  f.send({ ...f.message, source: {} }); f.send({ ...f.message, origin: 'https://foreign.test' });
  f.send({ ...f.message, data: { ...f.message.data, version: 2 } });
  for (const event of [null, { ...f.key, type: 'paste' }, { ...f.key, keyCode: -1 }, { ...f.key, repeat: 'yes' }, { ...f.key, code: 'x'.repeat(65) }]) f.send({ ...f.message, data: { ...f.message.data, event } });
  f.document.activeElement = {}; f.send(f.message);
  assert.equal(f.events.length, 0);
});
