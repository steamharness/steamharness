import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
register();
const { traceRange, traceRows, traceRowEnd } = await import('../extensions/studio-workstation/webview/trace-model.ts');
const client = await build({ entryPoints: ['extensions/studio-workstation/webview/trace.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false });
const project = { id: 'project', entryId: 'main', name: 'Project', projectType: 'conversation' };
const selection = { sessionId: 'session', messageId: 'answer' };
function snapshot(timed = true) {
  const item = (id, partType, content, startedAt, endedAt) => ({ id, content,
    metadata: { kind: 'agent-part', partType, status: 'success', ...(timed ? { startedAt, endedAt } : {}) } });
  return { project, activeId: 'session', running: false, sessions: [{ id: 'session', title: 'Conversation', messages: [
    { id: 'previous', role: 'assistant', status: 'success', content: 'Previous answer', createdAt: 0, durationMs: 100 },
    { id: 'input', role: 'user', content: 'How much data?', createdAt: 1000 },
    { id: 'answer', runId: 'run', role: 'assistant', status: 'success', createdAt: 1000, durationMs: 51_000, items: [
      item('thinking', 'reasoning', { text: 'Check the database' }, 1000, 20_000),
      item('tool', 'tool', { tool: 'db_status', status: 'success', output: '42 documents' }, 20_000, 21_000),
      item('output', 'text', '42 documents', 21_000, 52_000),
    ] },
  ] }] };
}

test('selected conversation and workflow ranges use their whole duration and live ranges stop when execution stops', () => {
  const data = snapshot();
  assert.deepEqual(traceRange(data, selection), { start: 1000, end: 52_000 });
  assert.deepEqual(traceRange(data, { runId: 'run' }), { start: 1000, end: 52_000 });
  assert.deepEqual(traceRange(data, {}), { start: 0, end: 52_000 });
  assert.equal(traceRange(data, { sessionId: 'missing' }), undefined);
  const answer = data.sessions[0].messages.at(-1); delete answer.durationMs; answer.status = 'running';
  assert.deepEqual(traceRange(data, selection, undefined, 30_000), { start: 1000, end: 30_000 });
  answer.status = 'interrupted'; assert.equal(traceRange(data, selection, undefined, 80_000), undefined);
  const run = { id: 'workflow', title: 'Workflow', status: 'success', createdAt: 5000, durationMs: 51_000 };
  assert.deepEqual(traceRange({ project: { ...project, projectType: 'workflow' }, run }, {}), { start: 5000, end: 56_000 });
  assert.equal(traceRowEnd({ start: 5000, durationMs: 2000, status: 'success' }), 7000);
});

for (const timed of [true, false]) test(`a completed 51-second reply renders a 51-second axis with ${timed ? 'persisted item spans' : 'legacy untimed items'}`, t => {
  const dom = new JSDOM('<div id="trace-app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, frames = [];
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} });
  window.eval(client.outputFiles[0].text);
  const data = snapshot(timed), state = { type: 'trace-state', generation: 1, projects: [{ uri: 'file:///project', name: 'Project' }],
    selection: { projectUri: 'file:///project', ...selection }, status: 'connected', snapshot: data };
  const receive = () => {
    window.dispatchEvent(new window.MessageEvent('message', { data: state }));
    for (const callback of frames.splice(0)) callback();
  };
  receive();
  const axis = () => [...window.document.querySelectorAll('.trace-axis span')].map(node => node.textContent);
  assert.deepEqual(axis(), ['0', '25.5 s', '51.0 s']);
  assert.equal(window.document.querySelectorAll('.lane-tool .trace-bar').length, timed ? 1 : 0);
  assert.equal(window.document.querySelectorAll('.lane-model .trace-bar').length, timed ? 1 : 0);
  if (timed) {
    assert.match(window.document.querySelector('.lane-tool .trace-bar').title, /1.0 s/);
    assert.deepEqual(traceRows(data, selection).filter(row => row.lane === 'model').map(row => row.durationMs), [19_000]);
  }
  delete data.sessions[0].messages.at(-1).durationMs;
  data.sessions[0].messages.at(-1).items.forEach(item => { delete item.metadata.startedAt; delete item.metadata.endedAt; });
  receive(); assert.deepEqual(axis(), []);
});
