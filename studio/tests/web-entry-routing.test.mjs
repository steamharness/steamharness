import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../extensions/studio-workstation/src/workflow-webview.ts', import.meta.url), 'utf8');
const module = { exports: {} };
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, URL, crypto: webcrypto });

function fixture(entryId = 'agent', saved, conversationView) {
  const origin = 'http://127.0.0.1:4567', received = [], posted = [], handlers = new Map(), frameHandlers = new Map();
  let state;
  const frame = { contentWindow: { postMessage: (message, target) => received.push({ message, target }) },
    addEventListener: (name, callback) => frameHandlers.set(name, callback), dispatchEvent() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 900 }), setAttribute() {} };
  const html = module.exports.projectFrameHtml(`${origin}/entries/${entryId}/#session=token`, 'Aggregate / Entry', 'file:///aggregate', 'dark', 'nonce', 'en', undefined, conversationView);
  const code = html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1];
  runInNewContext(code, { URL, document: { getElementById: () => frame, documentElement: { dataset: {} }, activeElement: frame },
    acquireVsCodeApi: () => ({ getState: () => saved, setState: value => { state = JSON.parse(JSON.stringify(value)); }, postMessage: message => posted.push(message) }),
    addEventListener: (type, callback) => handlers.set(type, callback) });
  return { received, posted, state: () => state, url: new URL(frame.src), load: () => frameHandlers.get('load')(),
    send: (message, extra = {}) => handlers.get('message')({ source: frame.contentWindow, origin, data: message, ...extra }),
    host: message => handlers.get('message')({ source: {}, data: message }),
    edit: command => handlers.get('vscode-webview-exec-command')({ detail: command, preventDefault() {} }) };
}

for (const entryId of ['agent', 'workflow', 'board']) {
  test(`${entryId} tabs get independent view identities and restore without collapsing into another tab`, () => {
    const first = fixture(entryId), second = fixture(entryId);
    assert.notEqual(first.url.searchParams.get('projectView'), second.url.searchParams.get('projectView'));
    assert.equal(first.url.hash, '#session=token');
    assert.equal(first.url.searchParams.get('projectLocale'), 'en');
    const restored = fixture(entryId, first.state());
    assert.equal(restored.url.searchParams.get('projectView'), first.url.searchParams.get('projectView'));
    assert.notEqual(fixture('other', first.state()).url.searchParams.get('projectView'), first.url.searchParams.get('projectView'));
  });
}

test('new conversation entry tabs create independent conversations and restore their selection', () => {
  const first = fixture('agent', undefined, 'new'), second = fixture('agent', undefined, 'new');
  assert.notEqual(first.url.searchParams.get('conversationId'), second.url.searchParams.get('conversationId'));
  assert.equal(first.url.searchParams.get('createConversation'), '1');
  const conversation = '12345678-1234-1234-1234-123456789abc';
  first.send({ type: 'workflow-navigation', version: 1, id: conversation, create: false });
  const restored = fixture('agent', first.state(), 'restore');
  assert.equal(restored.url.searchParams.get('conversationId'), conversation);
  assert.equal(restored.url.searchParams.has('createConversation'), false);
});

test('each Studio tab forwards its own open requests, host replies and editing without split routing', () => {
  const first = fixture(), second = fixture(); first.load(); second.load();
  assert.equal(first.received.at(-1).message.entryWindowVersion, 1);
  const message = { type: 'workflow-open-entry', version: 1, entryId: 'agent', projectId: 'aggregate' };
  first.send(message, { origin: 'https://foreign.example' });
  first.send(message, { source: {} });
  assert.equal(first.posted.some(value => value.type === message.type), false);
  first.send(message); first.send(message);
  assert.equal(first.posted.filter(value => value.type === message.type).length, 2);
  assert.equal(second.posted.some(value => value.type === message.type), false);
  const reply = { type: 'workflow-host', pathSelection: { requestId: 'pick' } };
  first.host(reply);
  assert.equal(first.received.at(-1).message, reply);
  assert.equal(second.received.some(value => value.message === reply), false);
  first.send({ type: 'workflow-edit', version: 1 }); first.edit('paste');
  assert.equal(first.received.at(-1).message.editCommand, 'paste');
  const count = first.posted.length;
  first.send({ type: 'workflow-entry-message', version: 1, frameId: 'obsolete', message });
  assert.equal(first.posted.length, count);
});
