import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-webview.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, URL, globalThis: { crypto: webcrypto } });

test('project frames advertise browser support and forward URL opens only from their bound origin', () => {
  const posted = [], received = [];
  const html = module.exports.projectFrameHtml('http://127.0.0.1:3000/entries/main/#session=test', 'Conversation', 'file:///project', 'dark', 'nonce');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://studio.test/', beforeParse(window) {
    window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(message), getState: () => undefined, setState() {} });
  } });
  try {
    const frame = dom.window.document.querySelector('iframe');
    frame.contentWindow.postMessage = message => received.push(message);
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.equal(received.at(-1).browserOpenVersion, 1);
    const message = { type: 'workflow-browser-open', version: 1, requestId: 'website', url: 'https://example.com/' };
    const send = (origin, source = frame.contentWindow) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source, origin, data: message }));
    send('https://other.test'); assert.equal(posted.some(item => item.type === message.type), false);
    send('http://127.0.0.1:3000');
    assert.deepEqual(posted.filter(item => item.type === message.type).map(item => JSON.parse(JSON.stringify(item))), [message]);
    send('http://127.0.0.1:3000', dom.window);
    assert.equal(posted.filter(item => item.type === message.type).length, 1);
  } finally { dom.window.close(); }
});
