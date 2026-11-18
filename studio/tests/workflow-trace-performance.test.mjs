const key = project => `${project.uri}#entry=${project.entryId}`;
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { durableTraceState } from './fixtures/trace-agent.mjs';

const require = createRequire(import.meta.url);
const host = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-trace-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const client = await build({ entryPoints: ['extensions/studio-workstation/webview/trace.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false });

test('node detail sections are ordered and collapsed, with model requests loaded only on demand', async t => {
  const zh = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));
  for (const [locale, bundle, labels] of [
    ['en', {}, ['Input', 'Model request', 'Output', 'Execution information']],
    ['zh-cn', zh, ['\u8f93\u5165', '\u6a21\u578b\u8bf7\u6c42', '\u8f93\u51fa', '\u6267\u884c\u4fe1\u606f']],
  ]) {
    const dom = new JSDOM('<script type="application/json" id="studio-localization"></script><div id="trace-app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const { window } = dom, frames = [], posts = [];
    window.document.getElementById('studio-localization').textContent = JSON.stringify({ locale, bundle });
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    window.acquireVsCodeApi = () => ({ postMessage: message => posts.push(message), getState: () => ({}), setState() {} });
    window.eval(client.outputFiles[0].text);
    const state = durableTraceState();
    const answer = state.snapshot.sessions[0].messages[1];
    state.snapshot.durable = false;
    state.modelRequests = true;
    answer.modelRequestExecutionId = 'llm';
    answer.events = [{ type: 'node_started', executionId: 'llm', nodeName: 'output', metadata: { type: 'llm-stream', title: 'bot-llm-answer' }, input: { prompt: 'Hello' }, startedAt: 1000 }];
    const receive = data => {
      window.dispatchEvent(new window.MessageEvent('message', { data }));
      for (const callback of frames.splice(0)) callback();
    };
    receive(state);
    const block = window.document.querySelector('.trace-model-request');
    const row = block.closest('.trace-row');
    const sections = () => Array.from(row.querySelectorAll('.trace-row-detail > details'));
    const headings = () => sections().map(section => section.querySelector('summary').textContent);
    assert.deepEqual(headings(), [labels[0], labels[1], labels[3]]);
    row.querySelector('summary').click();
    assert.ok(sections().every(section => !section.open));
    const [input, , info] = sections();
    input.querySelector('summary').click();
    assert.equal(input.open, true);
    assert.equal(posts.filter(post => post.type === 'model-request').length, 0);
    const modelSummary = block.querySelector('summary');
    modelSummary.click(); modelSummary.focus();
    block.dispatchEvent(new window.Event('toggle'));
    const { requestId, target } = posts.at(-1);
    assert.equal(target.sessionId, state.snapshot.sessions[0].id);
    assert.equal(target.messageId, answer.id);
    assert.equal(target.executionId, 'llm');
    receive({ type: 'trace-model-request', generation: state.generation, requestId, request: { systemPrompt: 'Prompt <em>verbatim</em>' } });
    assert.match(block.querySelector('pre').textContent, /Prompt <em>verbatim<\/em>/);
    assert.equal(block.querySelector('em'), null);
    answer.events.push({ type: 'node_finished', executionId: 'llm', nodeName: 'output', output: 'Model output', status: 'success', endedAt: 1350 });
    receive(state);
    assert.deepEqual(headings(), labels);
    const [sameInput, sameModel, output, sameInfo] = sections();
    assert.deepEqual([sameInput, sameModel, sameInfo], [input, block, info]);
    assert.deepEqual(sections().map(section => section.open), [true, true, false, false]);
    assert.equal(window.document.activeElement, modelSummary);
    assert.equal(output.querySelector('pre').textContent, 'Model output');
    assert.equal(JSON.parse(info.querySelector('pre').textContent).durationMs, 350);
    assert.equal(posts.filter(post => post.type === 'model-request').length, 1);
    row.querySelector('.trace-detail-tools button').click();
    assert.equal(posts.at(-1).type, 'copy');
    assert.doesNotMatch(posts.at(-1).text, /Prompt <em>/);
    answer.modelRequestExecutionId = 'retry';
    answer.events.push({ type: 'node_started', executionId: 'retry', nodeName: 'output', metadata: { type: 'llm-stream', title: 'bot-llm-answer' } });
    receive(state);
    const retry = window.document.querySelector('.trace-model-request');
    assert.equal(window.document.querySelectorAll('.trace-model-request').length, 1);
    assert.notEqual(retry, block);
    assert.equal(retry.open, false);
    assert.doesNotMatch(window.document.body.textContent, /Prompt <em>/);
    receive({ ...state, generation: state.generation + 1, modelRequests: false });
    assert.equal(window.document.querySelector('.trace-model-request'), null);
  }
});

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
  const project = { id: 'project', uri: 'file:///project', name: 'Project', projectType: 'bot' };
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
