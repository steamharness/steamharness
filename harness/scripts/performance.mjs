import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { register } from 'tsx/esm/api';

export async function runPerformance({ measure, PROFILE }) {
  register();
  const { getServerLLMCredentials } = await import('../src/provider/llm/server.ts');
  const { createLocalRuntimePersistence } = await import('../src/runtime-storage/local.ts');
  const { createMemoryRuntimePersistence } = await import('../src/runtime-storage/memory.ts');
  const { emptyRuntimeRecord } = await import('../src/runtime-storage/history.ts');
  const { copyRuntimePersistence } = await import('../src/runtime-storage/backup.ts');
  const { createServerKnowledgeBaseHost } = await import('../src/knowledge-bases/index.ts');
  const { RemoteProjectFileStore } = await import('../src/files/remote.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');

  const metrics = [], previousFetch = globalThis.fetch;
  const directory = await mkdtemp(path.join(tmpdir(), 'steamharness-performance-'));
  const environment = ['STEAMHARNESS_AI_SERVER_URL', 'STEAMHARNESS_AI_API_KEY'].map(key => [key, process.env[key]]);
  const local = createLocalRuntimePersistence({ directory });
  try {
    process.env.STEAMHARNESS_AI_SERVER_URL = 'https://performance.test';
    process.env.STEAMHARNESS_AI_API_KEY = 'fake-performance-key';
    let requests = 0;
    const models = Array.from({ length: 64 }, (_, index) => `model-${index}`);
    globalThis.fetch = async input => {
      assert.equal(String(input), 'https://performance.test/api/ai/catalog'); requests++;
      await delay(PROFILE.networkMs);
      return Response.json({ errCode: 0, errMessage: '', data: { credentials: [{ id: 'provider:performance', name: 'Fixture', platform: 'openai', providerType: 'openai-responses',
        models, proxyPath: '/api/ai/proxy/provider%3Aperformance', credentialToken: 'fixture-proxy-only', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }], warnings: [], fetchedAt: new Date().toISOString() } });
    };
    for (const [name, callers, fresh, expectedRequests, budgetMs] of [
      ['cold', 1, true, 1, 150], ['warm', 1, false, 0, 40], ['concurrent-cold', 20, true, 1, 150],
    ]) metrics.push(await measure(`harness.catalog.${name}`, async () => {
      const before = requests;
      const catalogs = await Promise.all(Array.from({ length: callers }, () => getServerLLMCredentials({ fresh })));
      assert.ok(catalogs.every(catalog => catalog[0].models.length === models.length));
      assert.equal(requests - before, expectedRequests);
      return { requests: requests - before };
    }, { budgetMs, workload: { models: models.length, callers, expectedRequests } }));

    let networkReads = 0;
    globalThis.fetch = async () => { networkReads++; throw new Error('Local runtime history must never wait for a server.'); };
    const lease = await local.acquire('history');
    let record = emptyRuntimeRecord('conversation', 'history');
    record.messages = Array.from({ length: 200 }, (_, index) => ({ id: `message-${index}`, role: 'assistant', content: 'x'.repeat(512) }));
    const write = async () => { record = await lease.write(record); assert.equal(networkReads, 0); return { networkReads }; };
    metrics.push(await measure('harness.history.write-200-messages', write, { budgetMs: 100, workload: { messages: 200, charactersPerMessage: 512 } }));
    for (let index = 0; index < 99; index++) await lease.write({ ...record, key: `history-${index}`, revision: 0 });
    metrics.push(await measure('harness.history.load-100-sessions', async () => {
      const records = await local.list('conversation'); assert.equal(records.length, 100); assert.equal(networkReads, 0);
      return { sessions: records.length, networkReads };
    }, { budgetMs: 150, workload: { sessions: 100, messagesPerSession: 200, charactersPerMessage: 512 } }));

    const target = createMemoryRuntimePersistence();
    let releaseBackup, backupFinished = false;
    const blocked = new Promise(resolve => { releaseBackup = resolve; });
    const originalList = target.list.bind(target);
    target.list = async kind => { await blocked; return originalList(kind); };
    const backup = copyRuntimePersistence({ source: local, target }).finally(() => { backupFinished = true; });
    try {
      metrics.push(await measure('harness.history.write-during-blocked-backup', async () => {
        assert.equal(backupFinished, false); return write();
      }, { budgetMs: 100, workload: { messages: 200, charactersPerMessage: 512, backupBlocked: true } }));
    } finally { releaseBackup(); await backup; await target.close(); }
    await lease.close();

    const agent = await local.agentStorage('checkpoint', 'main').open();
    try {
      await agent.storage.commit([{ type: 'conversation', value: { id: 1 } }], BACKGROUND_CONTEXT);
      let nextId = 2;
      metrics.push(await measure('harness.agent.checkpoint', async () => {
        await agent.storage.commit([{ type: 'entry', value: { id: nextId++, conversationId: 1, kind: 'message', data: { text: 'x'.repeat(16_384) } } }], BACKGROUND_CONTEXT);
        assert.equal(networkReads, 0); return { networkReads };
      }, { budgetMs: 100, workload: { payloadBytes: 16_384 } }));
    } finally { await agent.release(); }

    const identity = { projectId: 'project', entryId: 'main', alias: 'docs', knowledgeBaseId: 'knowledge' };
    const binding = { id: 'binding', revision: 1, knowledgeBaseId: 'knowledge', mode: 'read', accessRevision: 1 };
    const bytes = Buffer.alloc(1024 * 1024, 'x'), base64 = bytes.toString('base64');
    const file = id => ({ id, name: 'fixture.png', mimeType: 'image/png', kind: 'image', storage: 'database', spaceId: 'knowledge', size: bytes.length, createdAt: '2026-01-01T00:00:00Z' });
    let downloads = 0, checks = 0, fileNumber = 0;
    globalThis.fetch = async (_url, init) => {
      const { operation, input } = JSON.parse(init.body);
      await delay(PROFILE.networkMs);
      if (operation === 'files.stat') { checks++; return Response.json({ errCode: 0, data: file(input.fileId) }); }
      assert.equal(operation, 'files.readFile'); downloads++; await delay(PROFILE.downloadMs);
      return Response.json({ errCode: 0, data: { file: file(input.fileId), base64 } });
    };
    const knowledge = createServerKnowledgeBaseHost({ serverUrl: 'https://knowledge.performance.test', token: 'fixture-only' });
    const readKnowledge = fileId => knowledge.operation(identity, binding, 'files.readFile', { fileId });
    metrics.push(await measure('harness.knowledge-attachment.cold', async () => {
      const before = downloads; const result = await readKnowledge(`file-${fileNumber++}`);
      assert.equal(result.base64.length, base64.length); assert.equal(downloads - before, 1);
      return { downloads: downloads - before };
    }, { budgetMs: 300, workload: { bytes: bytes.length, expectedDownloads: 1 } }));
    await readKnowledge('retained');
    metrics.push(await measure('harness.knowledge-attachment.revalidate', async () => {
      const beforeDownloads = downloads, beforeChecks = checks;
      await readKnowledge('retained'); assert.equal(downloads, beforeDownloads); assert.equal(checks - beforeChecks, 1);
      return { downloads: downloads - beforeDownloads, permissionChecks: checks - beforeChecks };
    }, { budgetMs: 150, workload: { bytes: bytes.length, expectedDownloads: 0, permissionChecks: 1 } }));

    requests = 0; downloads = 0;
    globalThis.fetch = async (_url, init) => {
      requests++; await delay(PROFILE.networkMs);
      if (new Headers(init.headers).has('If-None-Match')) return new Response(null, { status: 304 });
      downloads++; await delay(PROFILE.downloadMs);
      return new Response(bytes, { headers: { etag: '"performance-fixture"' } });
    };
    const managed = new RemoteProjectFileStore({ serverUrl: 'https://files.performance.test', token: 'fixture-only', projectName: 'project' });
    const reference = id => ({ ...file(id), storage: 'server', projectId: 'project' });
    metrics.push(await measure('harness.managed-attachment.cold', async () => {
      const before = downloads; const resolved = await managed.resolveFile(reference(`managed-${fileNumber++}`));
      assert.equal((await resolved.readBuffer()).length, bytes.length); assert.equal(downloads - before, 1);
      return { downloads: downloads - before };
    }, { budgetMs: 300, workload: { bytes: bytes.length, expectedDownloads: 1 } }));
    const retained = await managed.resolveFile(reference('retained')); await retained.readBuffer();
    metrics.push(await measure('harness.managed-attachment.revalidate', async () => {
      const beforeRequests = requests, beforeDownloads = downloads;
      assert.equal((await retained.readBuffer()).length, bytes.length); assert.equal(downloads, beforeDownloads); assert.equal(requests - beforeRequests, 1);
      return { requests: requests - beforeRequests, downloads: downloads - beforeDownloads };
    }, { budgetMs: 150, workload: { bytes: bytes.length, expectedDownloads: 0, permissionChecks: 1 } }));
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await local.close(); await rm(directory, { recursive: true, force: true });
  }
  return metrics;
}
