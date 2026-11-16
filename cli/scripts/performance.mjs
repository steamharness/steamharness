import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { register } from 'tsx/esm/api';

export async function runPerformance({ measure, PROFILE }) {
  register();
  const { loadAgentModelCatalog } = await import('../src/web/agent-model-catalog.ts');
  const { ConversationController } = await import('../src/web/conversation-controller.ts');
  const { createLocalRuntimePersistence } = await import('steamharness/runtime-storage');
  const { emptyRuntimeRecord } = await import('steamharness/runtime-storage');

  const directory = await mkdtemp(path.join(tmpdir(), 'steamharness-cli-performance-'));
  const metrics = [], previousFetch = globalThis.fetch;
  const projectId = randomUUID();
  const entry = { entryId: 'main', root: '.', type: 'bot', name: 'Performance', entry: 'index.ts' };
  const project = { id: projectId, entryId: 'main', defaultEntry: 'main', aggregateName: 'Performance', folderPath: directory, entryRoot: directory,
    uri: '', name: 'Performance', projectType: 'bot', entries: [entry], fields: [], entrypoints: [] };
  const connection = { serverUrl: 'https://resources.performance.test', accessToken: 'fixture-only' };
  let requests = 0;
  const persistence = createLocalRuntimePersistence({ directory: path.join(directory, 'runtime') });
  try {
    await writeFile(path.join(directory, 'steamharness.json'), JSON.stringify({ id: projectId, name: 'Performance', version: '1.0.0', defaultEntry: 'main', entries: [entry] }));
    globalThis.fetch = async () => {
      requests++; await delay(PROFILE.networkMs);
      return Response.json({ errCode: 0, data: { credentials: [{ id: 'fixture', name: 'Fixture', providerType: 'openai-responses', models: Array.from({ length: 64 }, (_, index) => `model-${index}`) }] } });
    };
    const aiConnection = { ...connection, aiServerUrl: 'https://ai.performance.test', aiAccessToken: 'fixture-ai-only' };
    await loadAgentModelCatalog(aiConnection);
    metrics.push(await measure('cli.catalog.warm', async () => {
      const before = requests, catalog = await loadAgentModelCatalog(aiConnection);
      assert.equal(catalog.entries[0].models.length, 64); assert.equal(requests, before);
      return { requests: requests - before };
    }, { budgetMs: 40, workload: { models: 64, expectedRequests: 0 } }));

    let remoteRequests = 0;
    globalThis.fetch = async () => { remoteRequests++; throw new Error('Local conversation must not wait for remote persistence.'); };
    metrics.push(await measure('cli.conversation.first-output-local-history', async fixture => {
      const requestId = randomUUID();
      fixture.sending = fixture.controller.send({ text: 'Performance fixture', params: {}, attachments: [] }, fixture.controller.current, false, requestId);
      await fixture.firstOutput;
      const answer = fixture.controller.current.messages.find(message => message.id === requestId && message.role === 'assistant');
      assert.ok(answer && answer.content === 'First fixture output');
      assert.equal(remoteRequests, 0); return { remoteRequests, simulatedModelMs: 20 };
    }, {
      budgetMs: 150, workload: { simulatedModelMs: 20, persistence: 'local-sqlite', expectedRemoteRequests: 0 },
      setup: async () => {
        const scope = randomUUID(), lease = await persistence.acquire(scope);
        let record = emptyRuntimeRecord('conversation', scope), firstOutput;
        const output = new Promise(resolve => { firstOutput = resolve; });
        const runtime = { available: true, cancel() {}, cancelConversation: async () => {},
          async run(_request, emit) {
            await delay(20);
            const item = { id: 'first', content: 'First fixture output', contentType: 'markdown' };
            emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item } });
            return { status: 'success', output: { items: [item] } };
          } };
        let controller;
        controller = new ConversationController(project, runtime, {}, {
          async save(sessions) { record = await lease.write({ ...record, messages: structuredClone(sessions) }); },
          changed() { if (controller?.current.messages.some(message => message.role === 'assistant' && message.content === 'First fixture output')) firstOutput(); },
          log(message) { throw new Error(message); },
        });
        return { controller, firstOutput: output, lease };
      },
      cleanup: async fixture => { await fixture.sending; await fixture.controller.idle(); fixture.controller.dispose(); await fixture.lease.close(); },
    }));
  } finally {
    globalThis.fetch = previousFetch;
    await persistence.close(); await rm(directory, { recursive: true, force: true });
  }
  return metrics;
}
