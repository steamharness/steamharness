import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';
import { startEntryWebServer } from './web-test-storage';
import { testDataDirectory } from './test-data-directory';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';

it.each([true, false])('approves=%s a write after a completed Bot query without changing the earlier answer', async approved => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bot-write-approval-'));
  let app: Awaited<ReturnType<typeof startEntryWebServer>> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const user = body.messages.findLastIndex((message: any) => message.role === 'user');
    const prompt = JSON.stringify(body.messages[user]?.content);
    const result = body.messages.slice(user + 1).find((message: any) => message.role === 'tool');
    const invoke = prompt.includes('write') && !result;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.end(chunk(invoke ? { role: 'assistant', tool_calls: [{ index: 0, id: 'write-call', type: 'function', function: { name: 'write_business', arguments: '{}' } }] }
      : { role: 'assistant', content: prompt.includes('write') ? approved ? 'Saved' : 'Rejected' : 'Read complete' }, null)
      + chunk({}, invoke ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: crypto.randomUUID(), name: 'Approval', version: '1.0.0', type: 'module', devDependencies: { steamharness: await resolveHarnessVersion() },
      defaultEntry: 'main', entries: [{ entryId: 'main', type: 'bot', name: 'Approval', root: '.', entry: 'index.ts', databases: [] }] }));
    await writeFile(path.join(directory, 'index.ts'), `
      import { appendFile } from 'node:fs/promises';
      export const executor = steamharness.defineBot({
        agent: { provider: 'openai', model: 'fixture', apiKind: 'openai-completions', apiKey: 'offline', baseUrl: 'http://127.0.0.1:${(server.address() as { port: number }).port}/v1', tools: [],
          paramOptions: { fields: { provider: false, model: false } },
          createTools() { return [{ name: 'write_business', label: 'Write business data', description: 'Write only after approval.', parameters: { type: 'object', properties: {} },
            async execute() { await appendFile(new URL('./writes', import.meta.url), 'write\\n'); return { content: [{ type: 'text', text: 'Saved' }], details: {} }; } }]; } },
        tools: [{ name: 'write_business', enabled: true, autoApprove: false, approvalMode: 'always' }],
      });`);
    app = await startEntryWebServer({ projectDir: directory, dataDir: testDataDirectory(directory) });
    const token = new URL(app.url).hash.slice('#session='.length);
    const post = async (message: object) => {
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
      expect(response.status, await response.text()).toBe(200);
    };
    await post({ type: 'send', text: 'read', params: {}, attachments: [] });
    await expect.poll(() => app!.controller.current.messages.at(-1)?.status).toBe('success');
    const first = app.controller.current.messages.at(-1)!;
    await post({ type: 'send', text: 'write', params: {}, attachments: [] });
    await expect.poll(() => app!.controller.current.messages.some(message => message.pendingInput)).toBe(true);
    await expect.poll(() => app!.controller.current.activeRunId).toBeUndefined();
    const waiting = app.controller.current.messages.find(message => message.pendingInput)!;
    expect(waiting.id).not.toBe(first.id);
    expect(app.controller.current.messages.find(message => message.id === first.id)?.status).toBe('success');
    expect(await readFile(path.join(directory, 'writes'), 'utf8').catch(() => '')).toBe('');
    await post({ type: 'resume', messageId: waiting.id, requestId: waiting.pendingInput!.requestId, values: { approved } });
    try { await expect.poll(() => app!.controller.current.messages.find(message => message.id === waiting.id)?.status, { timeout: 8000 }).toBe('success'); }
    catch (error) { throw new Error(JSON.stringify({ messages: app.controller.current.messages.map(message => ({ id: message.id, runId: message.runId,
      status: message.status, pending: message.pendingInput?.requestId, submitting: message.submittingInput?.requestId,
      resolved: message.resolvedInputs?.map(input => input.requestId), report: message.report?.status, error: message.error })),
      writes: await readFile(path.join(directory, 'writes'), 'utf8').catch(() => ''), turns: app.controller.current.agent?.turns.map(turn => ({ requestId: turn.requestId, status: turn.status })) }), { cause: error }); }
    expect(await readFile(path.join(directory, 'writes'), 'utf8').catch(() => '')).toBe(approved ? 'write\n' : '');
    expect(app.controller.current.messages.find(message => message.id === first.id)?.content).toBe('Read complete');
    expect(app.controller.current.messages.filter(message => message.role === 'assistant')).toHaveLength(2);
  } finally {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
