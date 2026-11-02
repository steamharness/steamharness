import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createMemoryRuntimePersistence, emptyRuntimeRecord, SnapshotMemoryStorage, agentRuntimeSessionKey, RuntimeStorageError } from '../runtime-storage';
import { exportAgentSession, importAgentSession, isolateStoredAgentConversation, forkStoredAgentConversation } from '../agent/stored-session';
import { runLocalProjectWithReport } from '../executor';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('history revisions fence stale windows and preserve deletion tombstones', async () => {
  const persistence = createMemoryRuntimePersistence();
  const lease = await persistence.acquire('thread');
  await assert.rejects(persistence.acquire('thread'), { code: 'RUNTIME_STORAGE_OWNER_CONFLICT' });
  const initial = emptyRuntimeRecord('conversation', 'thread');
  const saved = await lease.write(initial);
  await assert.rejects(lease.write(initial), { code: 'RUNTIME_STORAGE_REVISION_CONFLICT' });
  await lease.delete(saved);
  assert.deepEqual(await persistence.list('conversation'), []);
  await assert.rejects(lease.write(initial), { code: 'RUNTIME_STORAGE_REVISION_CONFLICT' });
  await assert.rejects(lease.write(saved), { code: 'RUNTIME_STORAGE_REVISION_CONFLICT' });
  await lease.close(); await lease.close();
  const next = await persistence.acquire('thread');
  await lease.close(); next.assertOwned(); await next.close();
});

test('session snapshots preserve historical documents and reserved IDs while a source owner is active', async () => {
  const persistence = createMemoryRuntimePersistence();
  const opened = await persistence.agentStorage('source', 'main').open();
  const storage = opened.storage;
  await storage.commit([
    { type: 'conversation', value: { id: 1 as never } },
    { type: 'document.create', record: { id: 2 as never, kind: 'plan', scope: { kind: 'conversation', conversationId: 1 as never }, history: 'rewindable', fork: 'asOf' }, content: { kind: 'base', version: 1, value: { text: 'old' } } },
    { type: 'entry', value: { id: 3 as never, conversationId: 1 as never, kind: 'message', data: { text: 'source-path' } } },
  ], context);
  await storage.commit([{ type: 'document.change', id: 2 as never, content: { kind: 'base', version: 1, value: { text: 'new' } } }], context);
  await storage.mintId();
  const snapshot = await exportAgentSession({ persistence, conversationId: 'source' });
  const detached = new SnapshotMemoryStorage(snapshot);
  assert.equal((await detached.document(2 as never, 1 as never, context))?.value.text, 'old');
  assert.equal((await detached.document(2 as never, 'current', context))?.value.text, 'new');
  assert.equal(await detached.mintId(), snapshot.nextId);
  await importAgentSession({ persistence, conversationId: 'imported', sessionKey: 'main', snapshot });
  await assert.rejects(importAgentSession({ persistence, conversationId: 'imported', sessionKey: 'main', snapshot }), { code: 'RUNTIME_STORAGE_REVISION_CONFLICT' });
  await assert.rejects(persistence.agentStorage('source', 'main').open(), { code: 'RUNTIME_STORAGE_OWNER_CONFLICT' });
  await isolateStoredAgentConversation({ persistence, sourceConversationId: 'source', conversationId: 'branch', targetId: 1, replacements: [{ from: 'source-path', to: 'branch-path' }] });
  await isolateStoredAgentConversation({ persistence, sourceConversationId: 'source', conversationId: 'branch', targetId: 1 });
  const branch = new SnapshotMemoryStorage(await persistence.exportSession(agentRuntimeSessionKey('branch', 'main')));
  assert.equal((await branch.entry(3 as never, context))?.entry.data && ((await branch.entry(3 as never, context))!.entry.data as { text: string }).text, 'branch-path');
  const doc = await branch.findDocument({ kind: 'plan', scope: { kind: 'conversation', conversationId: 1 as never } }, 'current', context);
  assert.equal((await branch.document(doc!.id, 'current', context))?.value.text, 'new');
  const receipt = await forkStoredAgentConversation({ persistence, conversationId: 'branch', command: { type: 'fork', requestId: 'fork-without-model', entryId: 3 } });
  assert.equal(receipt.status, 'accepted');
  assert.deepEqual(await forkStoredAgentConversation({ persistence, conversationId: 'branch', command: { type: 'fork', requestId: 'fork-without-model', entryId: 3 } }), receipt);
  await opened.release?.();
});

test('isolated conversations preserve document versions and incarnations when their values stay equal', async () => {
  const persistence = createMemoryRuntimePersistence();
  const opened = await persistence.agentStorage('source', 'main').open();
  const definition = { kind: 'plan', scope: { kind: 'conversation' as const, conversationId: 1 as never }, history: 'rewindable' as const, fork: 'asOf' as const };
  await opened.storage.commit([
    { type: 'conversation', value: { id: 1 as never } },
    { type: 'document.create', record: { ...definition, id: 2 as never }, content: { kind: 'base', version: 1, value: { text: 'same' } } },
    { type: 'entry', value: { id: 3 as never, conversationId: 1 as never, kind: 'message' } },
  ], context);
  await opened.storage.commit([
    { type: 'document.change', id: 2 as never, content: { kind: 'base', version: 2, value: { text: 'same' } } },
    { type: 'entry', value: { id: 4 as never, conversationId: 1 as never, kind: 'message' } },
  ], context);
  await opened.storage.commit([
    { type: 'document.retire', id: 2 as never },
    { type: 'document.create', record: { ...definition, id: 5 as never }, content: { kind: 'base', version: 2, value: { text: 'same' } } },
    { type: 'entry', value: { id: 6 as never, conversationId: 1 as never, kind: 'message' } },
  ], context);
  await opened.storage.commit([{ type: 'document.change', id: 5 as never, content: { kind: 'base', version: 3, value: { text: 'same' } } }], context);
  try {
    await isolateStoredAgentConversation({ persistence, sourceConversationId: 'source', conversationId: 'branch', targetId: 1 });
    const branch = new SnapshotMemoryStorage(await persistence.exportSession(agentRuntimeSessionKey('branch', 'main')));
    const copied = [];
    for (const [entryId, version] of [[3, 1], [4, 2], [6, 2]]) {
      const at = (await branch.entry(entryId as never, context))!.commitSeq;
      const doc = (await branch.findDocument(definition, at, context))!;
      assert.equal((await branch.document(doc.id, at, context))?.version, version);
      copied.push(doc.id);
    }
    assert.equal(copied[0], copied[1]); assert.notEqual(copied[1], copied[2]);
    assert.equal((await branch.document(copied[2]!, 'current', context))?.version, 3);
  } finally { await opened.release?.(); }
});

test('durable conversation execution requires storage before business code runs', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-history-required-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ id: randomUUID(), name: 'Requires storage', version: '1.0.0', defaultEntry: 'main', entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
  await writeFile(path.join(directory, 'index.ts'), `
    const workflow = steamharness.defineProject({ name: 'Must not run', run() { throw new Error('Business code ran before storage was ready'); } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow, createInput() { return {}; } });
  `);
  const report = await runLocalProjectWithReport({ projectDir: directory, env: {} });
  assert.equal(report.status, 'failed');
  assert.equal(report.error?.metadata?.code, 'RUNTIME_STORAGE_ACCESS_DENIED');
  assert.match(report.error?.message ?? '', /Sign in/);
});

test('losing the runtime history lease aborts an executing conversation', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-history-lost-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ id: randomUUID(), name: 'Lease loss', version: '1.0.0', defaultEntry: 'main', entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
  await writeFile(path.join(directory, 'index.ts'), `
    import { writeFile } from 'node:fs/promises';
    const workflow = steamharness.defineProject({ name: 'Wait for cancellation', async run(input, context) {
      await writeFile(new URL('./started', import.meta.url), 'started');
      await new Promise((resolve, reject) => {
        context.abortSignal.throwIfAborted();
        context.abortSignal.addEventListener('abort', () => reject(context.abortSignal.reason), { once: true });
      });
      return { errCode: 0, errMessage: '' };
    } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow, createInput() { return {}; } });
  `);
  const persistence = createMemoryRuntimePersistence();
  const acquire = persistence.acquire.bind(persistence);
  let lose: ((error: Error) => void) | undefined;
  persistence.acquire = (scope, onLost) => { lose = onLost; return acquire(scope); };
  const running = runLocalProjectWithReport({ projectDir: directory, env: {}, storage: { host: 'local', local: { runtimePersistence: persistence } } });
  while (true) {
    if (await readFile(path.join(directory, 'started'), 'utf8').catch(() => '') === 'started') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(lose);
  lose(new Error('Execution ownership was lost'));
  const report = await running;
  assert.notEqual(report.status, 'success');
  assert.match(report.error?.message ?? '', /Execution ownership was lost/);
});

for (const fails of [false, true]) test(`lease release failures remain in a structured report and preserve business failures (${fails})`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-history-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ id: randomUUID(), name: 'Lease release', version: '1.0.0', defaultEntry: 'main',
    entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
  await writeFile(path.join(directory, 'index.ts'), `
    const workflow = steamharness.defineProject({ name: 'Release failure', async run() {
      ${fails ? "throw new Error('Original business failure');" : "return { errCode: 0, errMessage: '' };"}
    } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow, createInput() { return {}; } });
  `);
  const persistence = createMemoryRuntimePersistence(), acquire = persistence.acquire.bind(persistence);
  persistence.acquire = async scope => {
    const lease = await acquire(scope);
    return { ...lease, async close() { await lease.close(); throw new RuntimeStorageError('RUNTIME_STORAGE_UNAVAILABLE', 'Release unavailable'); } };
  };
  const report = await runLocalProjectWithReport({ projectDir: directory, env: {}, storage: { host: 'local', local: { runtimePersistence: persistence } } });
  assert.equal(report.status, 'failed');
  assert.match(report.error?.message ?? '', fails ? /Original business failure/ : /Release unavailable/);
  if (!fails) assert.equal(report.error?.metadata?.code, 'RUNTIME_STORAGE_UNAVAILABLE');
});
