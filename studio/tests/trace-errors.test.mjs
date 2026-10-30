import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
register();
const { traceRows, filterTraceRows } = await import('../extensions/studio-workstation/webview/trace-model.ts');
const client = await build({ entryPoints: ['extensions/studio-workstation/webview/trace.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false });
const project = { id: 'project', entryId: 'main', name: 'Project', projectType: 'conversation' };
const tool = { id: 'tool', metadata: { kind: 'agent-part', partType: 'tool', status: 'failed' },
  content: { tool: 'read', input: { path: 'missing.ts' }, output: 'File unavailable', status: 'failed' } };
const retry = { id: 'retry', metadata: { kind: 'opencode-retry' }, content: { attempt: 1, maxAttempts: 10, reason: 'Provider disconnected' } };
const snapshot = () => ({ project, activeId: 'session', running: false, sessions: [{ id: 'session', title: 'Conversation', messages: [
  { id: 'input', role: 'user', content: 'The word error in this input is not a failure' },
  { id: 'answer', runId: 'run', role: 'assistant', status: 'success', content: 'Done', items: [tool, retry, { id: 'output', content: 'Done' }],
    report: { status: 'success', nodes: [{ executionId: 'failed-node', name: 'Fetch', status: 'failed', error: { message: 'First fetch failed' } },
      { executionId: 'successful-node', name: 'Finish', status: 'success' }], logs: 'error: a quoted sample in a regular log' } },
  { id: 'other-answer', role: 'assistant', status: 'failed', error: 'Other turn failed' },
] }, { id: 'other', title: 'Other', messages: [{ id: 'private', role: 'assistant', status: 'failed', error: 'Other session failed' }] }],
  errors: [{ id: 'execution', sessionId: 'session', messageId: 'answer', runId: 'run', message: 'Transient execution failure', timestamp: 1234 },
    { id: 'foreign', sessionId: 'other', messageId: 'private', message: 'Other session failed' }] });

test('Errors retains failed nodes, tools and model retries after success without classifying message or log text', () => {
  const data = snapshot(), before = JSON.stringify(data), rows = traceRows(data, { messageId: 'answer' });
  const errors = filterTraceRows(rows, '', 'errors');
  assert.equal(errors.length, 4);
  assert.ok(errors.some(row => row.lane === 'tool' && /File unavailable/.test(row.preview)));
  assert.ok(errors.some(row => row.lane === 'node' && row.sections.some(section => /First fetch failed/.test(section.value))));
  assert.ok(errors.some(row => /Provider disconnected/.test(row.preview)));
  assert.equal(errors.find(row => row.lane === 'error').start, 1234);
  assert.doesNotMatch(JSON.stringify(errors), /Other turn failed|Other session failed|quoted sample|not a failure/);
  assert.equal(filterTraceRows(rows, 'PROVIDER DISCONNECTED', 'errors').length, 1);
  assert.equal(JSON.stringify(data), before);
  assert.match(JSON.stringify(traceRows(data, { messageId: 'other-answer' })), /Other turn failed/);
  assert.doesNotMatch(JSON.stringify(traceRows(data, { messageId: 'other-answer' })), /Transient execution failure/);
});

test('Workflow Errors uses report failures and run identity while normal cancellation stays outside Errors', () => {
  const run = { id: 'run', title: 'Workflow', status: 'failed', report: { status: 'failed', result: { error: { message: 'Run failed in provider' } } } };
  const data = { ...snapshot(), project: { ...project, projectType: 'workflow' }, run,
    errors: [{ id: 'duplicate', runId: 'run', message: 'Run failed in provider' }, { id: 'old', runId: 'old-run', message: 'Old run failed' }] };
  const errors = filterTraceRows(traceRows(data, {}), '', 'errors');
  assert.equal(errors.length, 1); assert.equal(errors[0].lane, 'error'); assert.equal(errors[0].preview, 'Run failed in provider');
  assert.equal(filterTraceRows(traceRows({ ...data, errors: [], run: { ...run, report: undefined, status: 'aborted', error: 'Stopped' } }, {}), '', 'errors').length, 0);
});

for (const [language, label, empty] of [['en', 'Errors', 'No execution errors'], ['zh-cn', '错误', '没有运行错误']]) {
  test(`Trace ${language} Errors restores its mode, keeps diagnostics through success and preserves expanded details`, async t => {
    const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
    const dom = new JSDOM('<script id="studio-localization" type="application/json"></script><div id="trace-app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const { window } = dom, frames = [], preferences = [];
    window.document.getElementById('studio-localization').textContent = JSON.stringify({ bundle, locale: language });
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({ mode: 'errors' }), setState: value => preferences.push(value) });
    window.eval(client.outputFiles[0].text);
    const data = snapshot(), state = { type: 'trace-state', generation: 1, projects: [{ uri: 'file:///project', name: 'Project' }],
      selection: { projectUri: 'file:///project', sessionId: 'session', messageId: 'answer' }, status: 'connected', snapshot: data };
    const receive = () => {
      window.dispatchEvent(new window.MessageEvent('message', { data: state }));
      for (const callback of frames.splice(0)) callback();
    };
    data.running = true; data.sessions[0].messages[1].status = 'running'; receive();
    assert.equal(window.document.querySelector('[data-mode=errors]').textContent, label);
    assert.equal(window.document.querySelector('[data-mode=errors]').getAttribute('aria-pressed'), 'true');
    assert.equal(window.document.querySelector('#trace-timeline').hidden, true);
    const detail = window.document.querySelector('[data-row-id="diagnostic:execution"]'); detail.open = true;
    data.running = false; data.sessions[0].messages[1].status = 'success'; receive();
    assert.equal(window.document.querySelector('[data-row-id="diagnostic:execution"]'), detail); assert.equal(detail.open, true);
    assert.match(window.document.querySelector('#trace-list').textContent, /Provider disconnected/);
    assert.equal(preferences.at(-1).mode, 'errors');
    data.errors = []; data.sessions[0].messages[1] = { id: 'answer', role: 'assistant', status: 'success', content: 'Done' }; receive();
    assert.equal(window.document.querySelector('#trace-empty').textContent, empty);
    assert.equal(window.document.querySelector('#trace-list').children.length, 0);
  });
}
