import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
import { runInNewContext } from 'node:vm';
register();
const { projectFrameHtml } = await import('../extensions/studio-workstation/src/workflow-webview.ts');

test('native export support forwards content only from the trusted project frame', () => {
  const html = projectFrameHtml('http://127.0.0.1:3000/', 'Conversation', 'file:///project', 'dark', 'nonce');
  const listeners = {}, sent = [], frameMessages = [], child = { postMessage: value => frameMessages.push(value) };
  const frame = { contentWindow: child, addEventListener: (type, callback) => { listeners[type] = callback; }, set src(_value) { listeners.load(); } };
  runInNewContext(html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1], {
    URL, acquireVsCodeApi: () => ({ setState() {}, postMessage: value => sent.push(value) }),
    document: { documentElement: { dataset: {} }, getElementById: () => frame },
    addEventListener: (type, callback) => { listeners[type] = callback; },
  });
  assert.equal(frameMessages[0].downloadVersion, 1);
  const exports = () => sent.filter(value => value.type === 'workflow-download');
  const data = { type: 'workflow-download', version: 1, requestId: 'export-1', name: 'conversation.json', content: '{"text":"对话内容"}' };
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data });
  listeners.message({ source: child, origin: 'http://foreign.test', data });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...data, version: 2 } });
  assert.deepEqual(exports(), []);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data });
  assert.deepEqual(JSON.parse(JSON.stringify(exports())), [data]);
});

for (const enabled of [false, true]) {
  test(`project upload navigation is explicit and bound to the trusted project frame (enabled=${enabled})`, () => {
    const html = projectFrameHtml('http://127.0.0.1:3000/', 'Map', 'file:///map', 'dark', 'nonce', 'en', undefined, undefined, enabled);
    const listeners = {}, sent = [], frameMessages = [], child = { postMessage: value => frameMessages.push(value) };
    const frame = { contentWindow: child, addEventListener: (type, callback) => { listeners[type] = callback; }, set src(_value) { listeners.load(); } };
    runInNewContext(html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1], {
      URL, acquireVsCodeApi: () => ({ setState() {}, postMessage: value => sent.push(value) }),
      document: { documentElement: { dataset: {} }, getElementById: () => frame },
      addEventListener: (type, callback) => { listeners[type] = callback; },
    });
    assert.equal(frameMessages[0].projectSetupVersion, enabled ? 1 : undefined);
    const uploads = () => sent.filter(value => value.type === 'workflow-project-upload');
    assert.equal(uploads().length, 0);
    const data = { type: 'workflow-project-upload', version: 1, projectUri: 'file:///untrusted-target' };
    listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data });
    listeners.message({ source: child, origin: 'http://foreign.test', data });
    listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...data, version: 2 } });
    assert.equal(uploads().length, 0);
    listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data });
    assert.deepEqual(JSON.parse(JSON.stringify(uploads())), enabled ? [{ type: 'workflow-project-upload', version: 1 }] : []);
  });
}
