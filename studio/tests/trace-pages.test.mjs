import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { register } from 'tsx/esm/api';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { durableTraceState } from './fixtures/trace-agent.mjs';
register();
const { traceRows, traceDuration } = await import('../extensions/studio-workstation/webview/trace-model.ts');
const { latestAgentPlan, taskDuration } = await import('../extensions/studio-workstation/webview/trace-agent-model.ts');
const { TraceStore } = await import('../extensions/studio-workstation/src/workflow-trace-store.ts');
const client = await build({ entryPoints: ['extensions/studio-workstation/webview/trace.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false });

async function page(t, language = 'en') {
  const dom = new JSDOM('<script id="studio-localization" type="application/json"></script><div id="trace-app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, frames = [], intervals = [], sent = [];
  const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
  window.document.getElementById('studio-localization').textContent = JSON.stringify({ bundle, locale: language });
  window.Date.now = () => 20_000;
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message), getState: () => ({}), setState() {} });
  window.eval(client.outputFiles[0].text);
  return { window, document: window.document, intervals, sent, receive(state) {
    window.dispatchEvent(new window.MessageEvent('message', { data: structuredClone(state) }));
    for (const callback of frames.splice(0)) callback();
  } };
}

test('completed text retains its own status while later work runs and duration rounding carries minutes', () => {
  const state = durableTraceState(), answer = state.snapshot.sessions[0].messages[1];
  answer.items = [{ id: 'complete', content: 'Completed text', metadata: { kind: 'agent-part', partType: 'text', status: 'success', startedAt: 1000, endedAt: 2000 } }];
  assert.equal(traceRows(state.snapshot, {}).find(row => row.lane === 'output').status, 'success');
  answer.items[0].metadata.status = 'running'; answer.status = 'aborted';
  assert.equal(traceRows(state.snapshot, {}).find(row => row.lane === 'output').status, 'stopped');
  assert.equal(traceDuration(119_999), '2 m 0 s');
});

test('plans restored only in a final report retain the approval boundary', () => {
  const item = { id: 'plan', content: 'Restore the approved plan', contentType: 'markdown' };
  const resolved = { requestId: 'approve', request: { metadata: { type: 'agent-plan-approval' } },
    values: { decision: 'approve' }, precedingOutputItemIds: ['plan'] };
  const message = { role: 'assistant', content: '', report: { output: { items: [item] }, resolvedUserInputs: [resolved] } };
  assert.deepEqual(latestAgentPlan([message]), { text: item.content, state: 'approved' });
});

test('task duration does not invent missing historical spans', () => {
  const agent = durableTraceState().snapshot.agents.main, task = agent.tasks[0];
  agent.capturedAt = 6000;
  assert.equal(taskDuration(task, agent, true, 20_000), undefined);
  task.startedAt = 1000;
  assert.equal(taskDuration(task, agent, false, 20_000), 5000);
  task.status = 'completed';
  assert.equal(taskDuration(task, agent, true, 20_000), undefined);
  task.endedAt = 1000;
  assert.equal(taskDuration(task, agent, true, 20_000), 0);
});

for (const language of ['en', 'zh-cn']) test(`task and usage pages render persisted spans and selected context totals (${language})`, async t => {
  const f = await page(t, language), state = durableTraceState(), agent = state.snapshot.agents.main;
  agent.capturedAt = 6000;
  agent.tasks[0].startedAt = 1000;
  agent.history.at(-1).startedAt = 1000; agent.history.at(-1).endedAt = 5000;
  agent.contexts[0].tokenUsage = { inputTokens: 8000, outputTokens: 500, totalTokens: 8500, calls: 3 };
  agent.contexts[0].contextUsage = { used: 100, total: 200 };
  agent.contexts[1].tokenUsage = { inputTokens: 250, outputTokens: 50, totalTokens: 300, calls: 1 };
  agent.contexts[1].contextUsage = { used: 25, total: 200 };
  f.receive(state); f.document.querySelector('#trace-tab-tasks').click();
  assert.match(f.document.querySelector('[data-focus=task-10]').textContent, /19.0 s/);
  f.document.querySelector('[data-focus=task-164]').click();
  assert.match(f.document.querySelector('#trace-task-164').textContent, /4.0 s/);
  state.status = 'offline'; f.receive(state);
  assert.match(f.document.querySelector('[data-focus=task-10]').textContent, /5.0 s/);
  f.window.Date.now = () => 90_000; f.intervals.forEach(callback => callback());
  assert.match(f.document.querySelector('[data-focus=task-10]').textContent, /5.0 s/);
  state.status = 'connected'; f.receive(state); f.document.querySelector('#trace-tab-usage').click();
  assert.match(f.document.querySelector('[data-usage-summary]').textContent, /8500/);
  assert.match(f.document.querySelector('[data-usage-summary]').textContent, /100 \/ 200/);
  state.selection.sessionId = 'child'; state.generation++; f.receive(state);
  assert.match(f.document.querySelector('[data-usage-summary]').textContent, /300/);
  assert.match(f.document.querySelector('[data-usage-summary]').textContent, /25 \/ 200/);
  assert.doesNotMatch(f.document.querySelector('[data-usage-summary]').textContent, /8500/);
  agent.contexts[1].tokenUsage.totalTokens = 350; f.receive(state);
  assert.match(f.document.querySelector('[data-usage-summary]').textContent, /350/);
});

test('closing a project freezes whole-turn timing at the latest received snapshot', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 6000 });
  const state = durableTraceState(), project = { ...state.snapshot.project, uri: 'file:///fixture' }, store = new TraceStore();
  store.update([project]); const binding = store.bind(project, 1, () => {});
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'state', snapshot: state.snapshot });
  t.mock.timers.tick(50_000); binding.dispose();
  const answer = store.state().snapshot.sessions[0].messages[1];
  assert.equal(answer.status, 'interrupted'); assert.equal(answer.durationMs, 4900);
});

test('live trace refresh keeps keyboard focus and freezes the axis and footer on disconnection', async t => {
  const f = await page(t), state = durableTraceState(), answer = state.snapshot.sessions[0].messages[1];
  state.snapshot.capturedAt = 6000;
  answer.items = [{ id: 'thinking', content: { text: 'Thinking' }, metadata: { kind: 'agent-part', partType: 'reasoning', status: 'running', startedAt: 1000 } }];
  f.receive(state);
  f.document.querySelector('.lane-model .trace-bar').focus();
  f.window.Date.now = () => 21_000; f.intervals.forEach(callback => callback());
  assert.equal(f.document.activeElement.dataset.rowId, 'reply:item:thinking');
  assert.match(f.document.querySelector('#trace-status').textContent, /19.9 s/);
  state.status = 'offline'; f.receive(state);
  const axis = () => f.document.querySelector('.trace-axis').textContent;
  const frozen = axis(); assert.match(frozen, /5.0 s/);
  f.window.Date.now = () => 90_000; f.intervals.forEach(callback => callback());
  f.document.querySelector('[data-mode=calls]').click(); f.document.querySelector('[data-mode=duration]').click();
  assert.equal(axis(), frozen); assert.match(f.document.querySelector('#trace-status').textContent, /4.9 s/);
});

test('a second Trace view reloads its historical selection after the source reconnects', () => {
  const project = { id: 'workflow', entryId: 'main', projectType: 'workflow', uri: 'file:///workflow' }, store = new TraceStore();
  store.update([project]); const second = store.fork(), key = 'file:///workflow#entry=main';
  const data = { project, run: { id: 'latest', status: 'success' }, runs: [{ id: 'old' }, { id: 'latest' }] };
  let binding = store.bind(project, 1, () => {});
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'state', snapshot: data });
  second.select(key, { runId: 'old' }); second.request('run', 'old');
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'run', runId: 'old', error: 'Disconnected' });
  binding.dispose(); const sent = [];
  binding = store.bind(project, 1, message => sent.push(message));
  second.state(); assert.equal(sent.length, 0, 'wait for the new source handshake');
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'state', snapshot: data });
  assert.equal(second.state().loading, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].traceCommand.runId, 'old');
  second.state(); assert.equal(sent.length, 1, 'coalesce repeated publications');
  second.request('run', 'old'); assert.equal(sent.length, 1, 'selection handling shares the same in-flight request');
});
