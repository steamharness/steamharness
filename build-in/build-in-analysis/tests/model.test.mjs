import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, csv, formatTimestamp } from '../src/model.js';
import { translations } from '../src/locales.js';

const now = new Date('2026-10-14T12:00:00Z').getTime();
const snapshot = { version: 1, generatedAt: now, projects: [{ name: 'Notes', id: 'notes', uri: 'file:///notes', folderPath: '/notes', projectType: 'workflow', availability: 'available', queued: 2,
  runs: ['success', 'failed', 'aborted', 'interrupted', 'running', 'waiting_for_input', 'unknown'].map((status, index) => ({ id: String(index), status, createdAt: now - index * 1000, durationMs: status === 'success' ? 10 : undefined })) },
  { name: 'Board', id: 'board', uri: 'file:///board', folderPath: '/board', projectType: 'kanban', availability: 'missing', queued: 0, runs: [] }] };

test('completed statistics exclude running, waiting and unknown and never invent durations', () => {
  const data = analyze(snapshot); assert.equal(data.runs.length, 7); assert.equal(data.completed, 4); assert.equal(data.successRate, 0.25);
  assert.equal(data.averageDuration, 10); assert.equal(data.active.length, 2); assert.equal(data.queued, 2); assert.equal(data.unavailable, 1);
  assert.equal(data.days.reduce((count, day) => count + day.count, 0), 7);
});
test('filters and empty datasets retain true zero and unknown rate states', () => {
  assert.equal(analyze(snapshot, { type: 'kanban' }).runs.length, 0); assert.equal(analyze(snapshot, { project: 'file:///notes', status: 'success' }).runs.length, 1);
  assert.equal(analyze(snapshot, { search: '/notes' }).projects.length, 1); assert.equal(analyze(snapshot, { search: 'missing' }).projects.length, 0);
  const value = analyze({ ...snapshot, projects: [] }); assert.equal(value.successRate, null); assert.equal(value.averageDuration, null); assert.equal(value.runs.length, 0);
});
test('time filters do not count older or undated runs', () => {
  const data = analyze({ ...snapshot, projects: [{ ...snapshot.projects[0], runs: [
    { id: 'old', status: 'success', createdAt: now - 31 * 86_400_000 }, { id: 'undated', status: 'success' }, { id: 'today', status: 'failed', createdAt: now },
  ] }] }, { days: 30 }); assert.deepEqual(data.runs.map(run => run.id), ['today']);
});
test('CSV escapes quotes, multiline values and spreadsheet formula prefixes', () => {
  assert.equal(csv([['=SUM(1,2)', 'a"b', 'two\nlines', 0]]), '\uFEFF"\'=SUM(1,2)","a""b","two\nlines","0"');
  for (const value of [' =SUM(1,2)', '\n=SUM(1,2)', '\uFEFF+SUM(1,2)']) assert.equal(csv([[value]]), `\uFEFF"'${value}"`);
});
test('record timestamps include year and seconds in both languages without invalid-date exceptions', () => {
  const date = new Date(2026, 9, 14, 13, 40, 5);
  assert.equal(formatTimestamp(date.getTime()), '2026-10-14 13:40:05');
  for (const value of [undefined, null, NaN, Infinity, 1e30]) assert.equal(formatTimestamp(value), '-');
  assert.match(formatTimestamp(0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
test('both languages expose identical keys and unsupported locales fall back to English', () => {
  assert.deepEqual(Object.keys(translations('zh-CN')).sort(), Object.keys(translations('en')).sort()); assert.equal(translations('fr').title, 'Studio Analysis');
});
