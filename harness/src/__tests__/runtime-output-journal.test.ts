import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalRuntimePersistence, emptyRuntimeRecord, copyRuntimePersistence } from '../runtime-storage';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'output-journal-'));
  const persistence = createLocalRuntimePersistence({ directory });
  const lease = await persistence.acquire('workflow');
  await lease.write(emptyRuntimeRecord('run', 'run', 'workflow'));
  return { directory, persistence, lease, close: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); } };
}
const output = (id: number, content: unknown = `item-${id}`) => ({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: String(id), title: 'Output', content, contentType: 'text' } } });
for (const count of [99, 100, 101, 200, 201]) test(`pages all ${count} outputs at 100 per page`, async () => {
  const f = await fixture();
  try {
    await f.lease.appendRunOutput!('run', { events: Array.from({ length: count }, (_, i) => output(i)) });
    const last = await f.persistence.readRunOutputPage!('run');
    assert.equal(last.page, Math.ceil(count / 100)); assert.equal(last.total, count);
    assert.equal(last.items.length, count % 100 || 100);
    const all = [];
    for (let page = 1; page <= last.page; page++) all.push(...(await f.persistence.readRunOutputPage!('run', page)).items);
    assert.deepEqual(all.map(item => item.id), Array.from({ length: count }, (_, i) => String(i)));
    assert.equal((await f.persistence.list('run'))[0].messages.length, 0);
  } finally { await f.close(); }
});
test('keeps an old page stable and merges updates and bounded final snapshots without truncating', async () => {
  const f = await fixture();
  try {
    await f.lease.appendRunOutput!('run', { events: Array.from({ length: 201 }, (_, i) => output(i)) });
    const first = await f.persistence.readRunOutputPage!('run', 1);
    await f.lease.appendRunOutput!('run', { events: [output(201), { type: 'node_chunk', chunk: { type: 'output_item_delta', itemId: '200', delta: ' updated' } }] });
    assert.deepEqual((await f.persistence.readRunOutputPage!('run', 1)).items, first.items);
    await f.lease.appendRunOutput!('run', { items: [{ id: '201', content: 'final' }] });
    const last = await f.persistence.readRunOutputPage!('run');
    assert.equal(last.total, 202); assert.equal(last.items[0].content, 'item-200 updated'); assert.equal(last.items[1].content, 'final');
    assert.ok(last.revision > first.revision);
  } finally { await f.close(); }
});
test('stores 10,000 outputs incrementally, returns only page attachments and restores after restart', async () => {
  const f = await fixture();
  const fileId = `wf_${'a'.repeat(32)}`;
  try {
    for (let offset = 0; offset < 10000; offset += 100) await f.lease.appendRunOutput!('run', { events: Array.from({ length: 100 }, (_, i) => output(offset + i)) });
    await f.lease.appendRunOutput!('run', { events: [{ type: 'file_created', file: { id: fileId, name: 'frame.jpg', mimeType: 'image/jpeg' } }, output(10000, `![frame](${fileId})`)] });
    assert.equal((await f.persistence.readRunOutputPage!('run', 1)).files.length, 0);
    assert.deepEqual((await f.persistence.readRunOutputPage!('run')).files.map(file => file.id), [fileId]);
    await f.persistence.close();
    const restored = createLocalRuntimePersistence({ directory: f.directory });
    try { assert.equal((await restored.readRunOutputPage!('run')).total, 10001); assert.equal((await restored.readRunOutputDetails!('run')).items.length, 10001); }
    finally { await restored.close(); }
  } finally { await f.close(); }
});
test('requires the matching live lease, rolls back failed batches and deletes journal data', async () => {
  const f = await fixture();
  try {
    const other = await f.persistence.acquire('other');
    await assert.rejects(other.appendRunOutput!('run', { events: [output(1)] }), { code: 'RUNTIME_STORAGE_ACCESS_DENIED' });
    await other.close();
    await f.lease.appendRunOutput!('run', { events: [output(1)] });
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await assert.rejects(f.lease.appendRunOutput!('run', { events: [output(2), circular] }));
    assert.equal((await f.persistence.readRunOutputPage!('run')).total, 1);
    await assert.rejects(f.persistence.readRunOutputPage!('run', -1));
    await f.lease.delete((await f.persistence.list('run'))[0]);
    assert.equal((await f.persistence.readRunOutputPage!('run')).total, 0);
    assert.deepEqual(await f.persistence.readRunOutputReferences!('run'), []);
    await f.lease.close();
    await assert.rejects(f.lease.appendRunOutput!('run', {}), { code: 'RUNTIME_STORAGE_LEASE_LOST' });
  } finally { await f.close(); }
});
test('backup includes complete journal output and events', async () => {
  const f = await fixture(); const targetDir = await mkdtemp(path.join(tmpdir(), 'output-backup-'));
  const target = createLocalRuntimePersistence({ directory: targetDir });
  try {
    await f.lease.appendRunOutput!('run', { events: Array.from({ length: 201 }, (_, i) => output(i)) });
    await copyRuntimePersistence({ source: f.persistence, target });
    const run = (await target.list('run'))[0]; assert.equal(run.messages.length, 201); assert.equal(run.events.length, 201);
  } finally { await target.close(); await rm(targetDir, { recursive: true, force: true }); await f.close(); }
});

test('retains standalone deliverables that are not linked from output items', async () => {
  const f = await fixture();
  try {
    const file = { id: `wf_${'b'.repeat(32)}`, name: 'result.pdf', mimeType: 'application/pdf' };
    await f.lease.appendRunOutput!('run', { files: [file], items: [{ id: 'answer', content: 'Done' }] });
    assert.deepEqual((await f.persistence.readRunOutputPage!('run')).files, [file]);
  } finally { await f.close(); }
});

test('terminal output includes the initial content of structured stream items immediately', async t => {
  const { createCliOutputStreamHooks } = await import('../executor');
  const chunks: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; });
  const hooks = createCliOutputStreamHooks();
  await hooks.onNodeChunk!({ executionId: 'stream', nodeName: 'output', kind: 'stream-node', startedAt: new Date(), timestamp: new Date(), chunkOrder: 1,
    chunk: { type: 'output_item_start', item: { id: 'capture', title: 'Output', contentType: 'text', content: '界面文字与截图记录' } } });
  assert.ok(chunks.join('').includes('界面文字与截图记录'));
});
