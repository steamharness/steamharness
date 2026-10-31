import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startEntryWebServer } from '../web/server';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

it('forks through the page protocol without system AI and resumes only when the user sends in the branch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-offline-fork-'));
  const projectId = crypto.randomUUID(), clientId = crypto.randomUUID(), calls: Record<string, any>[] = [];
  let catalogCalls = 0;
  let aiAvailable = true;
  let phase = 'initial conversation';
  let app: Awaited<ReturnType<typeof startEntryWebServer>> | undefined;
  const upstream = createServer(async (request, response) => {
    if (request.url === '/api/ai/catalog') {
      catalogCalls++;
      if (!aiAvailable) { response.writeHead(503); response.end('AI unavailable'); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ errCode: 0, errMessage: '', data: { fetchedAt: new Date().toISOString(), credentials: [{ id: 'fixture', name: 'Fixture', platform: 'fixture',
        providerType: 'openai-responses', models: ['fixture-model'], proxyPath: '/proxy', credentialToken: 'test-proxy', expiresAt: new Date(Date.now() + 3600000).toISOString() }] } }));
      return;
    }
    if (!request.url?.startsWith('/proxy')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ errCode: 0, data: { id: projectId, profile: { userId: 'fixture-user', email: 'fixture@example.test', displayName: 'Fixture' } } })); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    calls.push(JSON.parse(raw));
    const item = { id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Answer ${calls.length}`, annotations: [] }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: 'response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: projectId, name: 'fork-fixture', version: '1.0.0',
      devDependencies: { steamharness: await resolveHarnessVersion() }, defaultEntry: 'main',
      entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
    const source = `
      const workflow = steamharness.createAgentConversationProject({ modelSource: 'user-settings', tools: [], session: { compaction: { enabled: false } } });
      export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow,
        conversation: { durable: { enabled: true }, recovery: { enabled: true } }, params: [],
        createInput({ args }) { return steamharness.createAgentProjectInput(args); } });
    `;
    await writeFile(path.join(directory, 'index.ts'), source);
    const connection = { serverUrl: origin, accessToken: 'test-account', aiServerUrl: origin, aiAccessToken: 'test-ai' };
    const open = (withAi: boolean) => startEntryWebServer({ projectDir: directory, dataDir: path.join(directory, 'data'), host: { surface: 'editor', connection: withAi ? connection : { serverUrl: origin, accessToken: 'test-account' },
      userSettings: { agent: { permissionPolicy: 'auto', models: [{ id: 'selected', name: 'System fixture', source: 'system', credentialId: 'fixture', model: 'fixture-model' }] } } } });
    app = await open(true);
    const post = async (message: object) => {
      const token = new URL(app!.url).hash.slice('#session='.length);
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, ...message }) });
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result.messages;
    };
    const upload = await post({ type: 'upload', files: [{ name: 'diagram.png', mimeType: 'image/png', data: Buffer.from('fixture-image').toString('base64') }] });
    const attachment = upload.find((reply: any) => reply.type === 'attachments').files[0];
    await post({ type: 'send', text: 'First input', params: {}, attachments: [attachment] });
    await expect.poll(() => app!.controller.current.messages.at(-1)?.status, { timeout: 15000 }).not.toBe('running');
    expect(app.controller.current.messages.at(-1)?.error).toBeUndefined();
    expect(app.controller.current.messages.at(-1)?.status).toBe('success');
    let owner = app.controller.current; const selected = owner.messages.at(-1)!, ownerId = owner.id;
    phase = 'later input';
    await post({ type: 'send', text: 'Later input', params: {}, attachments: [] });
    await expect.poll(() => ({ status: app!.controller.current.messages.at(-1)?.status, content: app!.controller.current.messages.at(-1)?.content }), { timeout: 15000 }).toEqual({ status: 'success', content: 'Answer 2' });
    phase = 'fork with a live owner and unavailable AI';
    aiAvailable = false;
    const beforeLiveFork = { calls: calls.length, catalogCalls };
    const liveReply = await post({ type: 'agent-command', command: { type: 'fork', requestId: 'live-fork', entryId: selected.entryId } });
    expect(liveReply.find((reply: any) => reply.type === 'agent-receipt')?.forkSessionId).toBeTruthy();
    expect({ calls: calls.length, catalogCalls }).toEqual(beforeLiveFork);
    phase = 'stop original owner';
    await app.controller.stop(); await app.controller.idle();
    phase = 'remove AI connection';
    await app.close(); app = await open(false);
    owner = app.controller.sessions.find(session => session.id === ownerId)!;
    const originalMessages = structuredClone(owner.messages);
    const beforeFork = { calls: calls.length, catalogCalls };
    // Loading the executor is also forbidden for a history-only operation.
    await writeFile(path.join(directory, 'index.ts'), 'throw new Error("Fork must not run the project");');
    const command = { type: 'fork', requestId: 'offline-fork', entryId: selected.entryId };
    phase = 'create offline fork';
    const replies = await post({ type: 'agent-command', command });
    const receipt = replies.find((reply: any) => reply.type === 'agent-receipt');
    expect(receipt?.forkSessionId).toBeTruthy();
    let fork = app.controller.sessions.find(session => session.id === receipt.forkSessionId)!;
    expect(fork.messages.map(message => message.content)).toEqual(['First input', 'Answer 1']);
    expect(fork.agentOwnerId).toBeUndefined(); expect(fork.agent).toBeUndefined();
    expect(fork.messages.every(message => !message.runId && !message.sessionRequestId && !message.pendingInput && !message.report)).toBe(true);
    const copied = fork.messages[0].attachments![0];
    expect(copied.id).not.toBe(attachment.id); expect(copied.conversationId).toBe(fork.id);
    expect(await readFile(copied.path!, 'utf8')).toBe('fixture-image');
    expect(owner.messages).toEqual(originalMessages);
    expect(owner.activeRunId).toBeUndefined();
    expect({ calls: calls.length, catalogCalls }).toEqual(beforeFork);
    phase = 'replay offline fork receipt';
    const replay = await post({ type: 'agent-command', command });
    expect(replay.find((reply: any) => reply.type === 'agent-receipt').forkSessionId).toBe(fork.id);
    expect(app.controller.sessions).toHaveLength(3);
    phase = 'fork an independent branch before its first input';
    const nestedReply = await post({ type: 'agent-command', sessionId: fork.id, command: { ...command, requestId: 'nested-offline' } });
    const nestedId = nestedReply.find((reply: any) => reply.type === 'agent-receipt').forkSessionId;
    const nested = app.controller.sessions.find(session => session.id === nestedId)!;
    expect(nested.agentOwnerId).toBeUndefined(); expect(nested.forkSource?.sessionId).toBe(fork.id);
    expect({ calls: calls.length, catalogCalls }).toEqual(beforeFork);
    await app.controller.persist();
    await writeFile(path.join(directory, 'index.ts'), source);
    phase = 'restore AI connection';
    aiAvailable = true;
    const forkId = fork.id;
    await app.close(); app = await open(true);
    owner = app.controller.sessions.find(session => session.id === ownerId)!;
    fork = app.controller.sessions.find(session => session.id === forkId)!;
    await post({ type: 'navigate', id: fork.id, updates: [], requestId: 1 });
    phase = 'send branch input';
    await post({ type: 'send', sessionId: forkId, text: 'Branch input', params: {}, attachments: [] });
    await expect.poll(() => app!.controller.sessions.find(session => session.id === forkId)?.messages.at(-1)?.content, { timeout: 15000 }).toBe('Answer 3');
    fork = app.controller.sessions.find(session => session.id === forkId)!;
    const branchRequest = JSON.stringify(calls[2]);
    expect(branchRequest).toContain('First input'); expect(branchRequest).toContain('Answer 1'); expect(branchRequest).toContain('Branch input');
    expect(branchRequest).not.toContain('Later input'); expect(branchRequest).not.toContain('Answer 2');
    expect(owner.messages).toEqual(originalMessages);
    phase = 'delete the original conversation';
    await post({ type: 'session-action', action: 'delete', id: owner.id });
    expect(app.controller.sessions.some(session => session.id === forkId)).toBe(true);
    expect(await readFile(fork.messages[0].attachments![0].path!, 'utf8')).toBe('fixture-image');
    await post({ type: 'send', sessionId: forkId, text: 'Still independent', params: {}, attachments: [] });
    await expect.poll(() => app!.controller.sessions.find(session => session.id === forkId)?.messages.at(-1)?.content, { timeout: 15000 }).toBe('Answer 4');
    phase = 'reopen after deleting the source';
    await app.close(); app = await open(true);
    await post({ type: 'navigate', id: forkId, updates: [], requestId: 1 });
    await post({ type: 'send', sessionId: forkId, text: 'After reopening', params: {}, attachments: [] });
    await expect.poll(() => app!.controller.current.messages.at(-1)?.content, { timeout: 15000 }).toBe('Answer 5');
  } catch (error) {
    throw new Error(`Conversation fork regression failed during ${phase}: ${String(error)}`, { cause: error });
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    const key = createHash('sha256').update(`${projectId}:main`).digest('hex'), configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
    await rm(path.join(configurationRoot, 'snapshots', key), { recursive: true, force: true });
    for (const suffix of ['.json', '.json.lock.sqlite']) await rm(path.join(configurationRoot, `${key}${suffix}`), { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
