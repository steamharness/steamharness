import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../extensions/studio-workstation/src/workflow-webview.ts', import.meta.url), 'utf8');
const module = { exports: {} };
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, URL });

test('the Studio frame routes split responses, editing and disposal without broadcasting request replies', () => {
  const origin = 'http://127.0.0.1:4567', received = [], posted = [], handlers = new Map(), frameHandlers = new Map();
  const frame = { contentWindow: { postMessage: (message, target) => received.push({ message, target }) },
    addEventListener: (name, callback) => frameHandlers.set(name, callback), dispatchEvent() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 900 }), setAttribute() {} };
  const html = module.exports.projectFrameHtml(`${origin}/entries/agent/`, 'Aggregate / Agent', 'file:///aggregate', 'dark', 'nonce');
  const code = html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1];
  runInNewContext(code, { URL, document: { getElementById: () => frame, documentElement: { dataset: {} }, activeElement: frame },
    acquireVsCodeApi: () => ({ getState() {}, setState() {}, postMessage: message => posted.push(message) }),
    addEventListener: (type, callback) => handlers.set(type, callback) });
  frameHandlers.get('load')();
  assert.equal(received.at(-1).message.entryWindowVersion, 1);
  const route = { frameId: '20b3ee85-1697-4c57-811e-22e02f568073', entryId: 'database', projectId: '3bd18168-f4f6-486b-842c-ab9f8098d9d4' };
  const send = message => handlers.get('message')({ source: frame.contentWindow, origin, data: message });
  const message = { type: 'workflow-path-picker', version: 1, requestId: 'one', target: 'entry-file', kind: 'files' };
  send({ type: 'workflow-entry-message', version: 1, ...route, message });
  assert.equal(posted.at(-1).entryId, 'database');
  const reply = { type: 'workflow-host', pathSelection: { requestId: 'one' } };
  handlers.get('message')({ source: {}, data: { type: 'workflow-entry-host', version: 1, frameId: route.frameId, message: reply } });
  assert.equal(received.at(-1).message.frameId, route.frameId); assert.equal(received.at(-1).message.message, reply);
  send({ type: 'workflow-entry-message', version: 1, ...route, message: { type: 'workflow-edit', version: 1 } });
  send({ type: 'workflow-entry-focus', version: 1, frameId: route.frameId });
  handlers.get('vscode-webview-exec-command')({ detail: 'paste', preventDefault() {} });
  assert.equal(received.at(-1).message.frameId, route.frameId); assert.equal(received.at(-1).message.message.editCommand, 'paste');
  send({ type: 'workflow-entry-message', version: 1, ...route, message: { type: 'workflow-entry-dispose', version: 1 } });
  const count = received.length;
  handlers.get('message')({ source: {}, data: { type: 'workflow-entry-host', version: 1, frameId: route.frameId, message: reply } });
  assert.equal(received.length, count);
});
