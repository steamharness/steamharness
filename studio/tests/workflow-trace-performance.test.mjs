const key = project => `${project.uri}#entry=${project.entryId}`;
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { durableTraceState } from './fixtures/trace-agent.mjs';

const require = createRequire(import.meta.url);
const host = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-trace-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const client = await build({ entryPoints: ['extensions/studio-workstation/webview/trace.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false });

test('hidden retained Trace views skip serialization and replay the latest snapshot on reveal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const disposable = { dispose() {} }, module = { exports: {} }, posted = [], events = {};
  class Emitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire() { for (const listener of this.listeners) listener(); }
    dispose() { this.listeners.clear(); }
  }
  const vscode = { EventEmitter: Emitter, env: { language: 'en' },
    commands: { registerCommand: () => disposable, executeCommand: async () => {} }, window: { registerWebviewViewProvider: () => disposable },
    Uri: { joinPath: (root, ...parts) => `${root}/${parts.join('/')}` } };
  runInNewContext(host.outputFiles[0].text, { module, exports: module.exports, crypto: globalThis.crypto, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? vscode : require(name) });
  const view = { visible: false, webview: { onDidReceiveMessage: () => disposable, asWebviewUri: uri => uri, postMessage: value => posted.push(value) },
    onDidChangeVisibility: callback => { events.visibility = callback; return disposable; }, onDidDispose: () => disposable };
  const provider = new module.exports.TraceView({ subscriptions: [], extensionUri: '/extension' }, async () => {}, { appendLine() {} });
  t.after(() => provider.dispose());
  const project = { id: 'project', uri: 'file:///project', name: 'Project', projectType: 'conversation' };
  provider.update([project]); provider.resolve(view);
  const binding = provider.bind(project, 1, { postMessage() {} });
  let serializations = 0;
  for (let index = 0; index < 100; index++) {
    const snapshot = { project, activeId: `session-${index}`, sessions: [] };
    Object.defineProperty(snapshot, 'diagnostics', { enumerable: true, get: () => { serializations++; return 'large'; } });
    binding.receive({ type: 'workflow-trace', version: 1, kind: 'state', snapshot }); t.mock.timers.tick(50);
  }
  assert.equal(posted.length, 0); assert.equal(serializations, 0);
  view.visible = true; events.visibility();
  assert.equal(posted.length, 1); assert.equal(posted[0].snapshot.activeId, 'session-99'); assert.equal(serializations, 1);
  view.visible = false; binding.dispose(); assert.equal(posted.length, 1);
  view.visible = true; events.visibility(); assert.equal(posted.at(-1).status, 'closed');
});

test('task tabs skip hidden timeline projection and show the newest trace when selected', t => {
  const dom = new JSDOM('<div id="trace-app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, frames = [], intervals = [];
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({ tab: 'tasks' }), setState() {} });
  window.eval(client.outputFiles[0].text);
  let reads = 0;
  const state = durableTraceState(), answer = state.snapshot.sessions[0].messages[1];
  Object.defineProperty(answer, 'events', { enumerable: true, get: () => { reads++; return []; } });
  const receive = () => {
    window.dispatchEvent(new window.MessageEvent('message', { data: state }));
    for (const callback of frames.splice(0)) callback();
  };
  receive(); assert.equal(reads, 0); assert.equal(window.document.querySelector('#trace-execution').hidden, true);
  window.document.querySelector('#trace-tab-trace').click(); assert.ok(reads > 0);
  const previous = window.document.querySelector('#trace-list').innerHTML;
  window.document.querySelector('#trace-tab-tasks').click(); reads = 0;
  answer.items[0].content = 'Newest checkpoint'; receive(); intervals.forEach(callback => callback());
  assert.equal(reads, 0); assert.equal(window.document.querySelector('#trace-list').innerHTML, previous);
  window.document.querySelector('#trace-tab-trace').click();
  assert.ok(reads > 0); assert.match(window.document.querySelector('#trace-list').textContent, /Newest checkpoint/);
});
