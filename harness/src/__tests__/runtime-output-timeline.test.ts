import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createLocalOutputJournal } from '../runtime-storage/output-journal';

const epoch = Date.parse('2026-11-15T08:00:00Z');
const item = (id: number, timestamp = new Date(epoch + id * 1000).toISOString(), kind = 'snapshot') => ({
  id: String(id), metadata: { kind: 'activity-record' }, contentType: 'json',
  content: { version: 1, kind, timestamp, title: '窗口画面', fields: [{ label: '窗口', value: '测试窗口' }],
    text: '完整文字'.repeat(100), imageFileId: kind === 'snapshot' ? `wf_${String(id).padStart(32, '0')}` : undefined },
});
function fixture() {
  const db = new DatabaseSync(':memory:'), journal = createLocalOutputJournal(() => db);
  return { db, journal };
}

test('reads the whole run by real time with duplicates, mixed precision and delayed events', () => {
  const { db, journal } = fixture();
  try {
    journal.append('run', { items: Array.from({ length: 201 }, (_, i) => item(i)) });
    journal.append('run', { items: [item(201, '2026-11-15T08:00:02Z', 'click'), item(202, '2026-11-15T08:00:02.100Z', 'input'), { id: 'status', content: 'ready' }, item(203, 'invalid')] });
    const all = journal.timeline('run', { at: epoch + 2100, limit: 12 });
    assert.deepEqual(all.bounds, { from: epoch, to: epoch + 200000 });
    assert.equal(all.total, 205); assert.ok(all.frames.length <= 12); assert.ok(all.buckets.length <= 80);
    assert.equal(all.selection?.point.id, '202');
    assert.equal(all.selection?.frame?.id, '2');
    assert.deepEqual(all.selection?.nearby.map(point => point.id), ['0', '1', '2', '201', '202', '3', '4', '5', '6']);
    assert.equal(all.buckets.reduce((sum, bucket) => sum + bucket.click + bucket.input + bucket.snapshot, 0), 203);
    assert.ok(!JSON.stringify(all.frames).includes('完整文字'));
    assert.equal(journal.timeline('run', { position: 2, direction: 'next' }).selection?.point.id, '3');
    assert.equal(journal.timeline('run', { position: 3, direction: 'previous' }).selection?.point.id, '2');
    assert.equal(journal.timeline('run', { at: 0 }).selection?.point.id, '0');
    assert.equal(journal.timeline('run', {}).selection?.point.id, '200');
  } finally { db.close(); }
});

test('bounds responses for 10000 records, keeps genuine gaps, and updates the time index in place', () => {
  const { db, journal } = fixture();
  try {
    for (let start = 0; start < 10000; start += 100) journal.append('run', { items: Array.from({ length: 100 }, (_, offset) => item(start + offset)) });
    const range = { from: epoch + 3000000, to: epoch + 3100000, at: epoch + 3050000, limit: 10 };
    const page = journal.timeline('run', range);
    assert.equal(page.selection?.point.id, '3050'); assert.equal(page.total, 10000);
    assert.ok(page.frames.length <= 10); assert.equal(page.selection?.nearby.length, 9);
    assert.ok(JSON.stringify(page).length < 30000);
    const gap = journal.timeline('run', { from: epoch + 20000000, to: epoch + 21000000 });
    assert.deepEqual(gap.frames, []); assert.deepEqual(gap.buckets, []);
    journal.append('run', { items: [item(0, new Date(epoch + 11000000).toISOString())] });
    const updated = journal.timeline('run');
    assert.equal(updated.total, 10000); assert.equal(updated.selection?.point.id, '0'); assert.ok(updated.revision > page.revision);
    const reopened = createLocalOutputJournal(() => db).timeline('run', range);
    assert.equal(reopened.selection?.point.id, '3050');
    journal.delete('run'); assert.equal(journal.timeline('run').bounds, null);
  } finally { db.close(); }
});

test('validates ranges and orders frames with identical timestamps by output position', () => {
  const { db, journal } = fixture();
  try {
    journal.append('run', { items: [item(0), item(1, new Date(epoch).toISOString()), item(2, new Date(epoch).toISOString())] });
    assert.equal(journal.timeline('run', { position: 0, direction: 'next' }).selection?.point.id, '1');
    assert.equal(journal.timeline('run', { position: 1, direction: 'next' }).selection?.point.id, '2');
    assert.equal(journal.timeline('run', { position: 1, direction: 'previous' }).selection?.point.id, '0');
    assert.equal(journal.timeline('run').selection?.point.id, '2');
    for (const query of [{ from: -1 }, { limit: 49 }, { from: 2, to: 1 }, { at: NaN }, { direction: 'next' }, { position: .5 }]) assert.throws(() => journal.timeline('run', query as never));
    assert.equal(journal.timeline('missing').selection, null);
  } finally { db.close(); }
});

test('reads pre-journal saved runs in place without rewriting their output or history', () => {
  const { db, journal } = fixture();
  try {
    db.exec('CREATE TABLE history(kind TEXT,key TEXT,revision INTEGER,deleted INTEGER,record TEXT)');
    const saved = JSON.stringify({ messages: Array.from({ length: 201 }, (_, id) => ({ id: String(id), value: item(id) })) });
    db.prepare('INSERT INTO history VALUES(?,?,?,?,?)').run('run', 'old', 3, 0, saved);
    const result = journal.timeline('old', { at: epoch + 100000 });
    assert.equal(result.total, 201); assert.equal(result.revision, 3);
    assert.equal(result.selection?.point.id, '100');
    assert.equal(journal.timeline('old', { position: 100, direction: 'next' }).selection?.point.id, '101');
    assert.equal(db.prepare('SELECT record FROM history').get()?.record, saved);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_output_items").get()?.count, 0);
    db.exec('UPDATE history SET deleted=1');
    assert.equal(journal.timeline('old').bounds, null);
  } finally { db.close(); }
});
