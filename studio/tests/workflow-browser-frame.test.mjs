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

test('clipboard image imports use the native paste route and return only the requested image', () => {
  const received = [];
  const html = module.exports.projectFrameHtml('http://127.0.0.1:3000/', 'Workflow', 'file:///project', 'dark', 'nonce');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://studio.test/', beforeParse(window) {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
  } });
  try {
    const frame = dom.window.document.querySelector('iframe'), native = [];
    dom.window.document.documentElement.dataset.vscodeNativeClipboard = '1';
    frame.contentWindow.postMessage = message => received.push(message);
    frame.addEventListener('vscode-webview-paste', () => native.push(true));
    frame.dispatchEvent(new dom.window.Event('load')); frame.focus();
    assert.equal(received.at(-1).clipboardImageVersion, 1);
    const data = { type: 'workflow-edit', version: 1, command: 'paste', clipboardImageRequestId: 'image-1' };
    const send = origin => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: frame.contentWindow, origin, data }));
    send('https://foreign.test'); assert.equal(native.length, 0);
    send('http://127.0.0.1:3000'); assert.equal(native.length, 1);
    const image = new Uint8Array([1, 2, 3]);
    const event = new dom.window.CustomEvent('vscode-webview-exec-command', { cancelable: true, detail: { command: 'paste', clipboard: { text: 'unrelated text', image } } });
    dom.window.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    assert.deepEqual({ ...received.at(-1).clipboardImage }, { version: 1, requestId: 'image-1', image });
    assert.equal(received.at(-1).editCommand, undefined);
    frame.dispatchEvent(new dom.window.Event('load'));
    dom.window.dispatchEvent(new dom.window.CustomEvent('vscode-webview-exec-command', { cancelable: true, detail: { command: 'paste', clipboard: { image } } }));
    assert.equal(received.at(-1).clipboardImage, undefined);
  } finally { dom.window.close(); }
});

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

test('only the same-host desktop frame can use the native picker, drop and path lookup', () => {
  for (const [local, native] of [[true, true], [true, false], [false, true]]) {
    const posted = [], received = [];
    const origin = 'http://127.0.0.1:3000';
    const html = module.exports.projectFrameHtml(`${origin}/entries/main/`, 'Project', 'file:///project', 'light', 'nonce', 'en',
      undefined, undefined, false, false, true, undefined, { localFilePaths: local });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://studio.test/', beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(message), getState: () => undefined, setState() {} });
    } });
    try {
      const { window } = dom, frame = window.document.querySelector('iframe');
      window.document.documentElement.dataset.vscodeNativeClipboard = native ? '1' : '0';
      frame.contentWindow.postMessage = message => received.push(message);
      frame.dispatchEvent(new window.Event('load'));
      const paths = local && native ? 1 : 0;
      for (const capability of ['localFilePathsVersion', 'pathPickerVersion', 'dropVersion']) assert.equal(received.at(-1)[capability], paths);
      const file = new window.File(['sample'], 'sample.zip'), request = { type: 'workflow-resolve-local-files', version: 1, requestId: 'drop', target: 'assistant:one', files: [file] };
      const send = (origin, data) => window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow, origin, data }));
      send('https://foreign.test', request); send(origin, { ...request, files: [{ name: 'sample.zip' }] }); send(origin, request);
      const lookups = posted.filter(message => message.type === request.type);
      assert.equal(lookups.length, paths);
      if (lookups.length) assert.equal(lookups[0].files[0], file);
      send(origin, { type: 'workflow-path-picker', version: 1, kind: 'folders', requestId: 'pick', target: request.target });
      send(origin, { type: 'workflow-drop-target', version: 1, target: request.target });
      const forwarded = posted.filter(message => message.type === 'workflow-path-picker' || message.type === 'workflow-drop-target' && message.target);
      assert.equal(forwarded.length, 2 * paths);
      const drop = { target: request.target, paths: ['file:///Desktop/sample.zip'] };
      for (const detail of [{ drop }, { pathSelection: { version: 1, requestId: 'pick', ...drop } }]) {
        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'workflow-host', ...detail } }));
      }
      assert.equal(received.filter(message => message.drop).length, paths);
      assert.equal(received.filter(message => message.pathSelection).length, paths);
    } finally { dom.window.close(); }
  }
});

test('the usage bridge forwards only the bound frame revision and strips directory overrides', () => {
  const posted = [], received = [];
  const projectDetails = { version: 1, revision: 'open-project', localUsage: true };
  const html = module.exports.projectFrameHtml('http://127.0.0.1:3000/entries/main/', 'Project', 'file:///project', 'light', 'nonce', 'en',
    undefined, undefined, false, false, true, undefined, { projectDetails });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://studio.test/', beforeParse(window) {
    window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(message), getState: () => undefined, setState() {} });
  } });
  try {
    const frame = dom.window.document.querySelector('iframe');
    frame.contentWindow.postMessage = message => received.push(message);
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.deepEqual({ ...received.at(-1).projectDetails }, projectDetails);
    const incoming = { type: 'workflow-project-usage', version: 1, revision: 'open-project', requestId: 'fresh', part: 'directory', uri: 'file:///unrelated' };
    const send = (data, origin, source = frame.contentWindow) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source, origin, data }));
    send(incoming, 'https://other.test');
    send({ ...incoming, revision: 'closed' }, 'http://127.0.0.1:3000');
    send(incoming, 'http://127.0.0.1:3000');
    const { uri: _uri, ...expected } = incoming;
    assert.deepEqual(posted.filter(item => item.type === incoming.type).map(item => JSON.parse(JSON.stringify(item))), [expected]);
  } finally { dom.window.close(); }
});
