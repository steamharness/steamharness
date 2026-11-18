import { testDataDirectory } from './test-data-directory';
import { createServerRuntimePersistence } from 'steamharness/runtime-storage';
import { runtimeStorageService } from './runtime-storage-service';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AGENT_MODELS_CONFIGURATION_KEY, type ProjectConfigurationState } from '@steamharness/project-configuration';
import { startEntryWebServer as startWebServer } from '../web/server';
import { projectDataDirectory } from '../web/project-data-directory';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

it.each(['agent', 'llm'] as const)('%s Bot uses Studio host user models without exposing keys', async engine => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'user-model-runtime-'));
  const applicationId = crypto.randomUUID(), calls: { model: string; token?: string }[] = [];
  const transcripts: string[] = [];
  let finishQueued: (() => void) | undefined;
  let crashOnce = true;
  let app: Awaited<ReturnType<typeof startWebServer>> | undefined;
  const storageService = runtimeStorageService();
  const upstream = createServer(async (request, response) => {
    if (await storageService.handle(request, response)) return;
    if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ errCode: 0, data: { profile: { userId: 'fixture-user', email: 'fixture@example.test', displayName: 'Fixture' } } })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ model: body.model, token: request.headers.authorization });
    transcripts.push(JSON.stringify(body.messages));
    const prompt = JSON.stringify(body.messages.at(-1));
    const wait = engine === 'llm' && (prompt.includes('Hold queue') || prompt.includes('Cancel this') || prompt.includes('Crash this') && crashOnce);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = wait && !prompt.includes('Hold queue') ? 'Discard this partial answer' : `Answer ${body.model}`;
    response.write(`data: ${JSON.stringify({ id: 'user-answer', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
    const finish = () => response.end(`data: ${JSON.stringify({ id: 'user-answer', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ id: 'user-answer', choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    if (!wait) finish();
    else if (prompt.includes('Hold queue')) finishQueued = finish;
    else if (prompt.includes('Crash this')) crashOnce = false;
  });
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'user-model-agent', version: '1.0.0', devDependencies: { steamharness: await resolveHarnessVersion() },  defaultEntry: 'main', entries: [{ entryId: 'main', name: 'Main', type: 'bot', root: '.', entry: 'index.ts' }]  }));
    const source = (engine: 'agent' | 'llm') => `
      import { writeFileSync } from 'node:fs';
      export const executor = steamharness.defineBot({
        engine: '${engine}',
        ${engine === 'agent' ? "agent: { modelSource: 'user-settings', tools: [] }" : "llm: { modelSource: 'user-settings' }"},
        prepareInput(input) {
          if (input.apiKey || input.baseUrl) throw new Error('Resolved credentials must not reach Bot input hooks');
          if (input.prompt === 'Crash this') writeFileSync(new URL('./worker-pid', import.meta.url), String(process.pid));
          return input;
        },
        async onCompleted({ requestId, output }, context) {
          if (output.prompt !== 'Callback retry') return;
          if (!(await context.conversation.getValue()).values[requestId]) {
            await context.conversation.setValue(requestId, true);
            throw new Error('Fixture notification failure');
          }
        },
      }); export default executor;
    `;
    await writeFile(path.join(directory, 'index.ts'), source(engine));
    const settings: import('steamharness').UserSettings = { agent: { permissionPolicy: 'auto', models: [{
      id: 'first', name: 'User first', source: 'third-party', apiKind: 'openai-completions', baseUrl: `${origin}/v1`, model: 'actual-one', apiKey: 'test-only-first-key',
    }] } };
    const options = { projectDir: directory, dataDir: path.join(testDataDirectory(directory)), host: { surface: 'editor' as const, userSettings: settings, connection: { serverUrl: origin, accessToken: 'fixture-account' } } };
    app = await startWebServer(options);
    const post = async (message: object, status = 200) => {
      const token = new URL(app!.url).hash.slice('#session='.length);
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(status); return status === 200 ? result.messages : result;
    };
    const resolution = (await post({ type: 'resolve', params: {}, requestId: 'user-models' }))[0];
    expect(resolution.error).toBeUndefined(); expect(resolution.params.model.value).toBeUndefined();
    expect(resolution.params.model.resolvedOptions).toEqual([{ value: 'first', label: 'User first', description: 'actual-one' }]);
    await post({ type: 'send', text: 'First', params: {}, attachments: [] }); await expect.poll(() => app!.controller.current.messages.at(-1)?.status).toBe("success");
    expect(app.controller.current.messages.at(-1)).toMatchObject({ status: 'success', content: 'Answer actual-one', model: 'User first' });
    const selectedModel = settings.agent.models![0];
    if (selectedModel.source !== 'third-party') throw new Error('Expected the third-party fixture model.');
    const updated: import('steamharness').UserSettings = { agent: { permissionPolicy: 'auto', models: [{ ...selectedModel, model: 'actual-two', apiKey: 'test-only-next-key' }] } };
    await app.setHostUserSettings(updated);
    const second = crypto.randomUUID();
    await post({ type: 'send', requestId: second, text: 'Second', params: {}, attachments: [] });
    await expect.poll(() => {
      const session = app!.controller.current;
      const answer = session.messages.find(message => message.role === 'assistant' && (message.id === second || message.sessionRequestId === second));
      return { content: answer?.content, status: answer?.status, error: answer?.error,
        queued: session.queuedInputs?.some(input => input.requestId === second) ?? false };
    }, { timeout: 12_000 }).toEqual({ status: 'success', content: 'Answer actual-two', error: undefined, queued: false });
    await post({ type: 'send', text: 'Follow-up', params: {}, attachments: [] });
    await expect.poll(() => calls.length).toBe(3);
    await expect.poll(() => app!.controller.current.messages.filter(message => message.role === 'assistant' && message.status === 'success').length).toBe(3);
    expect(calls).toEqual([{ model: 'actual-one', token: 'Bearer test-only-first-key' }, { model: 'actual-two', token: 'Bearer test-only-next-key' }, { model: 'actual-two', token: 'Bearer test-only-next-key' }]);
    expect(app.controller.current.parameterValues?.['']?.model).toBeUndefined();
    const view = JSON.stringify(await post({ type: 'ready' }));
    const exported = JSON.stringify(await post({ type: 'session-action', action: 'export', id: app.controller.current.id }));
    await app.controller.persist();
    const backend = createServerRuntimePersistence({ serverUrl: origin, token: 'fixture-account', resolveProject: true, workspace: { kind: 'local', projectId: applicationId, entryId: 'main', localKey: createHash('sha256').update(await realpath(directory)).digest('hex') } });
    const history = JSON.stringify(await backend.list('conversation')); await backend.close();
    for (const secret of ['test-only-first-key', 'test-only-next-key']) {
      expect(view).not.toContain(secret); expect(exported).not.toContain(secret); expect(history).not.toContain(secret);
    }
    if (engine === 'llm') {
      expect(app.controller!.current.agent).toBeUndefined();
      expect(app.controller!.current.messages.at(-1)?.tokenUsage?.run).toMatchObject({ calls: 1, totalTokens: 12 });
      expect(transcripts[2]).toMatch(/First.*Answer actual-one.*Second.*Answer actual-two.*Follow-up/);
      const id = crypto.randomUUID();
      await post({ type: 'send', requestId: id, text: 'Callback retry', params: {}, attachments: [] });
      await expect.poll(() => app!.controller!.current.messages.at(-1)?.status).toBe('failed');
      await app.controller!.idle();
      expect(app.controller!.current.messages.at(-1)?.error).toContain('completion notification failed');
      expect(calls).toHaveLength(4);
      await post({ type: 'retry', messageId: id });
      await expect.poll(() => app!.controller!.current.messages.at(-1)?.status).toBe('success');
      expect(calls).toHaveLength(4);
      expect(app.controller!.current.messages.at(-1)).toMatchObject({ id, content: 'Answer actual-two' });
      await post({ type: 'send', requestId: id, text: 'Duplicate', params: {}, attachments: [] });
      expect(calls).toHaveLength(4);

      const send = (text: string, requestId = crypto.randomUUID()) => post({ type: 'send', text, requestId, params: {}, attachments: [] });
      const last = () => app!.controller!.current.messages.at(-1);
      await send('Hold queue');
      await expect.poll(() => last()?.content).toBe('Answer actual-two');
      expect(last()?.status).toBe('running');
      const queuedId = crypto.randomUUID();
      await send('Queued question', queuedId);
      await send('Queued question', queuedId);
      expect(app.controller!.current.queuedInputs?.map(input => input.id)).toEqual([queuedId]);
      expect(calls).toHaveLength(5);
      finishQueued!();
      await expect.poll(() => last()?.id === queuedId && last()?.status).toBe('success');
      expect(calls).toHaveLength(6);

      await send('Cancel this');
      await expect.poll(() => last()?.content).toBe('Discard this partial answer');
      await post({ type: 'stop' });
      await expect.poll(() => last()?.status).toBe('aborted');
      await app.controller!.idle();
      const crashId = crypto.randomUUID(), sessionId = app.controller!.current.id;
      await send('Crash this', crashId);
      await expect.poll(() => last()?.content).toBe('Discard this partial answer');
      expect(transcripts.at(-1)).not.toMatch(/Cancel this|Discard this partial answer/);
      const worker = Number(await readFile(path.join(directory, 'worker-pid'), 'utf8'));
      expect(worker).toBeGreaterThan(1); expect(worker).not.toBe(process.pid);
      process.kill(worker, 'SIGKILL');
      await expect.poll(() => last()?.status).toBe('failed');
      await app.controller!.idle();
      expect(calls).toHaveLength(8);
      await app.close(); app = await startWebServer(options);
      expect(app.controller!.current.id).toBe(sessionId);
      expect(last()?.recovering).not.toBe(true);
      expect(calls).toHaveLength(8);
      await post({ type: 'retry', messageId: crashId });
      await expect.poll(() => last()?.status).toBe('success');
      expect(calls).toHaveLength(9);
      expect(transcripts.at(-1)?.match(/Crash this/g)).toHaveLength(1);
      expect(transcripts.at(-1)).not.toContain('Discard this partial answer');

      await app.controller!.create(true);
      await send('New conversation');
      await expect.poll(() => app!.controller!.current.messages.at(-1)?.status).toBe('success');
      expect(transcripts.at(-1)).not.toMatch(/Callback retry|First|Follow-up/);
      expect(app.controller!.sessions.filter(session => session.messages.length)).toHaveLength(2);
      await app.controller!.idle();
      await writeFile(path.join(directory, 'index.ts'), source('agent'));
      await app.configurations!.refresh();
      const staleHostId = crypto.randomUUID();
      await send('Do not run the new engine in this session', staleHostId);
      await expect.poll(() => last(), { timeout: 12_000 }).toMatchObject({ id: staleHostId, status: 'failed', error: expect.stringContaining('Reopen the project') });
      expect(calls).toHaveLength(10);
      await app.controller!.idle();
      await app.close();
      app = await startWebServer(options);
      expect(app.controller!.current).toMatchObject({ engine: 'agent', messages: [] });
      expect(app.controller!.sessions.find(session => session.id === sessionId)?.messages.at(-1)).toMatchObject({ id: crashId, status: 'success' });
      const blocked = await post({ type: 'send', sessionId, text: 'Old session', params: {}, attachments: [] }, 400);
      expect(blocked.message).toContain('different Bot engine');
      expect(calls).toHaveLength(10);
    }
  } finally {
    await app?.close(); await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    const runKey = createHash('sha256').update(`${applicationId}:main`).digest('hex');
    await rm(path.join(os.homedir(), '.steamharness', 'configurations', 'snapshots', runKey), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
    const key = createHash('sha256').update(`${applicationId}:main`).digest('hex');
    for (const suffix of ['.json', '.json.lock.sqlite']) await rm(path.join(os.homedir(), '.steamharness', 'configurations', `${key}${suffix}`), { force: true });
  }
}, 60_000);

// Exercise the real page protocol, configuration service and worker. Only the upstream HTTP service is fake.
it.each(['agent', 'llm'] as const)('%s Bot runs saved system and third-party models with refreshed scoped credentials', async engine => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'configured-agent-runtime-'));
  const applicationId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`${applicationId}:main`).digest('hex');
  const runKey = createHash('sha256').update(`${applicationId}:main`).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  let app: Awaited<ReturnType<typeof startWebServer>> | undefined;
  let generation = 0, subscribed = true;
  const catalogRequests: string[] = [], calls: { path: string; model: string; token: string; body: any }[] = [];
  const storageService = runtimeStorageService({ account: () => 'fixture-user' });
  const upstream = createServer(async (request, response) => {
    if (await storageService.handle(request, response)) return;
    if (request.url === `/api/projects/${applicationId}`) {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ errCode: 0, data: { id: applicationId } })); return;
    }
    if (request.url === '/api/auth/me') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ errCode: 0, errMessage: '', data: { profile: { userId: 'fixture-user', email: 'fixture@example.test', displayName: 'Fixture' } } })); return;
    }
    if (request.url === '/api/ai/catalog') {
      catalogRequests.push(request.headers.authorization ?? ''); generation++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ errCode: 0, errMessage: '', data: { fetchedAt: new Date().toISOString(), credentials: subscribed ? [
        { id: 'responses-plan', name: 'Responses plan', platform: 'fixture', providerType: 'openai-responses', models: ['system-responses'], proxyPath: '/proxy/responses', credentialToken: `responses-${generation}`, expiresAt: new Date(Date.now() + 30_000).toISOString() },
        { id: 'anthropic-plan', name: 'Anthropic plan', platform: 'fixture', providerType: 'anthropic', models: ['system-anthropic'], proxyPath: '/proxy/anthropic', credentialToken: `anthropic-${generation}`, expiresAt: new Date(Date.now() + 30_000).toISOString() },
      ] : [] } })); return;
    }
    if (!request.url?.startsWith('/proxy/') && !request.url?.startsWith('/v1/')) {
      response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ errCode: 404, errMessage: 'Fixture route not found.' })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ path: request.url!, model: body.model, token: String(request.headers['x-api-key'] ?? request.headers.authorization), body });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = `Answer from ${body.model}`;
    if (request.url === '/proxy/responses/responses') {
      const item = { id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      for (const event of [
        { type: 'response.created', response: { id: 'response', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } else if (request.url === '/proxy/anthropic/messages') {
      for (const event of [
        { type: 'message_start', message: { id: 'message', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ id: 'completion', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'completion', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }
    response.end();
  });
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'configured-agent', version: '1.0.0', devDependencies: { steamharness: await resolveHarnessVersion() },  defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'bot',root:'.',entry:'index.ts'}] }));
    await writeFile(path.join(directory, 'index.ts'), `

      export const executor = steamharness.defineBot({
        engine: '${engine}',
        ${engine === 'agent' ? 'agent: { tools: [] }' : 'llm: { modelSource: "project" }'},
      });
      export default executor;
    `);
    app = await startWebServer({ projectDir: directory, dataDir: path.join(testDataDirectory(directory)), host: { surface: 'editor', connection: {
      serverUrl: origin, accessToken: 'project-identity', aiServerUrl: origin, aiAccessToken: 'ai-identity',
    } } });
    const token = new URL(app.url).hash.slice('#session='.length);
    const post = async (message: object) => {
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result.messages;
    };
    const catalog = (await post({ type: 'project-ai-catalog' }))[0].value;
    expect(catalog.entries.map((entry: { id: string }) => entry.id)).toEqual(['responses-plan', 'anthropic-plan']);
    expect(JSON.stringify(catalog)).not.toContain('credentialToken');
    let state = (await post({ type: 'project-configuration', call: { action: 'get' } }))[0].value as ProjectConfigurationState;
    expect(state.fields[0]?.name).toBe(AGENT_MODELS_CONFIGURATION_KEY);
    const models = [
      { id: 'responses', name: 'Responses', source: 'system', credentialId: 'responses-plan', model: 'system-responses' },
      { id: 'anthropic', name: 'Anthropic', source: 'system', credentialId: 'anthropic-plan', model: 'system-anthropic' },
      { id: 'third', name: 'Third-party', source: 'third-party', apiKind: 'openai-completions', model: 'third-model', baseUrl: `${origin}/v1`, apiKey: 'third-identity' },
    ];
    state = (await post({ type: 'project-configuration', call: { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [AGENT_MODELS_CONFIGURATION_KEY]: models } } }))[0].value;
    const resolved = (await post({ type: 'resolve', params: {}, draftText: '', requestId: 'resolve' }))[0];
    expect(resolved.error).toBeUndefined(); expect(resolved.params.provider.visible).toBe(false);
    expect(resolved.params.model.value).toBe('responses');
    expect(resolved.params.model.resolvedOptions.map((option: { value: string }) => option.value)).toEqual(['responses', 'anthropic', 'third']);
    for (const [index, model] of models.entries()) {
      const catalogsBefore = catalogRequests.length;
      await post({ type: 'send', text: `Turn ${index}`, params: index ? { model: model.id } : {}, attachments: [] });
      await expect.poll(() => app!.controller!.current.messages.at(-1)?.content).toContain(`Answer from ${model.model}`);
      await expect.poll(() => app!.controller!.current.messages.at(-1)?.status).toBe("success");
      const answer = app.controller!.current.messages.at(-1)!;
      expect(answer.status, answer.error).toBe('success'); expect(answer.content).toContain(`Answer from ${model.model}`);
      expect(answer.model).toBe(model.name);
      expect(calls.at(-1)?.model).toBe(model.model);
      if (engine === 'llm') {
        expect(app.controller!.current.agent).toBeUndefined();
        expect(calls.at(-1)?.body.tools).toBeUndefined();
        if (index) expect(JSON.stringify(calls.at(-1)?.body)).toContain(`Answer from ${models[index - 1].model}`);
      }
      if (model.source === 'system') {
        expect(catalogRequests.length - catalogsBefore).toBe(2);
        expect(calls.at(-1)?.token).toBe(model.id === 'responses' ? `Bearer responses-${generation}` : `anthropic-${generation}`);
      } else { expect(catalogRequests.length).toBe(catalogsBefore); expect(calls.at(-1)?.token).toBe('Bearer third-identity'); }
    }
    expect(calls.map(call => call.path)).toEqual(['/proxy/responses/responses', '/proxy/anthropic/messages', '/v1/chat/completions']);
    expect(catalogRequests.every(token => token === 'Bearer ai-identity')).toBe(true);
    for (const secret of ['ai-identity', 'project-identity', 'third-identity', 'credentialToken']) expect(JSON.stringify(app.controller!.current)).not.toContain(secret);
    subscribed = false;
    const revoked = await fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'send', text: 'Revoked subscription', params: { model: 'responses' }, attachments: [] }) });
    if (engine === 'llm') {
      expect(revoked.status).toBe(200);
      await expect.poll(() => app!.controller!.current.messages.at(-1)?.status).toBe('failed');
      await app.controller!.idle();
      expect(app.controller!.current.messages.at(-1)?.error).toContain('no available server AI credentials');
    } else {
      expect(revoked.status).toBe(400);
      expect((await revoked.json()).message).toContain('no available server AI credentials');
    }
    expect(calls).toHaveLength(3);

    subscribed = true;
    await app.setHostConnection({ serverUrl: origin, accessToken: 'next-project-identity', aiServerUrl: origin, aiAccessToken: 'next-ai-identity' });
    const switchedAt = catalogRequests.length;
    await post({ type: 'send', text: 'Changed account', params: { model: 'responses' }, attachments: [] });
    await expect.poll(() => app!.controller!.current.messages.at(-1)?.content).toContain('Answer from system-responses');
    await expect.poll(() => app!.controller!.current.messages.at(-1)?.status).toBe("success");
    expect(app.controller!.current.messages.at(-1)?.status).toBe('success');
    expect(catalogRequests.slice(switchedAt)).toEqual(['Bearer next-ai-identity', 'Bearer next-ai-identity']);
    expect(calls.at(-1)?.token).toBe(`Bearer responses-${generation}`);

    await app.setHostConnection({ serverUrl: origin, accessToken: 'next-project-identity' });
    const offlineAt = catalogRequests.length;
    state = app.configurations!.state;
    const updated = [{ ...models[2], model: 'third-next-model', apiKey: 'third-next-identity' }, ...models.slice(0, 2)];
    await post({ type: 'project-configuration', call: { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [AGENT_MODELS_CONFIGURATION_KEY]: updated } } });
    await post({ type: 'send', text: 'Updated configuration without system AI sign-in', params: { model: 'deleted-entry' }, attachments: [] });
    await expect.poll(() => app!.controller!.current.messages.at(-1)?.content).toContain('Answer from third-next-model');
    await expect.poll(() => app!.controller!.current.messages.at(-1)?.status).toBe("success");
    expect(app.controller!.current.messages.at(-1)?.status).toBe('success');
    expect(app.controller!.current.messages.at(-1)?.content).toContain('Answer from third-next-model');
    expect(app.controller!.current.messages.at(-1)?.model).toBe('Third-party');
    expect(app.controller!.current.messages.filter(message => message.role === 'assistant').slice(0, 3).map(message => message.model)).toEqual(models.map(model => model.name));
    expect(calls.at(-1)).toMatchObject({ path: '/v1/chat/completions', model: 'third-next-model', token: 'Bearer third-next-identity' });
    expect(catalogRequests).toHaveLength(offlineAt);
    for (const secret of ['next-ai-identity', 'next-project-identity', 'third-next-identity']) expect(JSON.stringify(app.controller!.current)).not.toContain(secret);
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 40_000);

it.each(['project', 'user-settings'] as const)('switches %s models in a durable conversation without hiding prior replies or replaying inputs', async modelSource => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'configured-durable-models-'));
  const applicationId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`${applicationId}:main`).digest('hex');
  const runKey = createHash('sha256').update(`${applicationId}:main`).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  const calls: { model: string; body: any; token: string }[] = [];
  let app: Awaited<ReturnType<typeof startWebServer>> | undefined;
  const storageService = runtimeStorageService();
  const upstream = createServer(async (request, response) => {
    if (await storageService.handle(request, response)) return;
    response.setHeader('content-type', 'application/json');
    if (request.url === `/api/projects/${applicationId}`) {
      response.end(JSON.stringify({ errCode: 0, data: { id: applicationId } })); return;
    }
    if (request.url === '/api/auth/me') {
      response.end(JSON.stringify({ errCode: 0, errMessage: '', data: { profile: { userId: 'fixture', email: 'fixture@example.test', displayName: 'Fixture' } } })); return;
    }
    if (request.url === '/api/ai/catalog') {
      response.end(JSON.stringify({ errCode: 0, errMessage: '', data: { fetchedAt: new Date().toISOString(), credentials: [
        { id: 'subscription', name: 'Subscription', platform: 'fixture', providerType: 'openai-responses', models: ['system-old', 'system-new'],
          proxyPath: '/proxy/responses', credentialToken: 'system-identity', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      ] } })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ model: body.model, body, token: String(request.headers.authorization) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = `Reply ${calls.length} from ${body.model}`;
    const item = { id: `message-${calls.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    for (const event of [
      { type: 'response.created', response: { id: `response-${calls.length}`, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `response-${calls.length}`, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  try {
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: applicationId, name: 'durable-model-switch', version: '1.0.0', type: 'module',  defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'bot',root:'.',entry:'index.ts'}], devDependencies: { steamharness: await resolveHarnessVersion() } }));
    await writeFile(path.join(directory, 'index.ts'), `
      export const executor = steamharness.defineBot({ engine: "agent", agent: { modelSource: '${modelSource}', tools: [], session: { compaction: { enabled: false } } } });
    `);
    const options = { projectDir: directory, dataDir: path.join(testDataDirectory(directory)), host: { surface: 'editor' as const, userSettings: { agent: { permissionPolicy: 'auto' as const, models: [] as import('steamharness').UserAgentModel[] } }, connection: {
      serverUrl: origin, accessToken: 'identity', aiServerUrl: origin, aiAccessToken: 'ai-identity',
    } } };
    app = await startWebServer(options);
    const post = async (message: object) => {
      const token = new URL(app!.url).hash.slice('#session='.length);
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...message, clientId }) });
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result.messages;
    };
    const waitForLogin = () => expect.poll(async () => (await post({ type: 'ready' })).find((message: { type: string }) => message.type === 'state')?.account?.status,
      { timeout: 10_000 }).toBe('authenticated');
    await waitForLogin();
    const models: import('steamharness').UserAgentModel[] = [
      { id: 'old', name: 'Original model', source: 'system', credentialId: 'subscription', model: 'system-old' },
      { id: 'custom', name: 'Custom model', source: 'third-party', apiKind: 'openai-responses', model: 'third-party', baseUrl: `${origin}/v1`, apiKey: 'third-identity' },
      { id: 'new', name: 'Replacement model', source: 'system', credentialId: 'subscription', model: 'system-new' },
    ];
    const expected: { status: string; content: string; model: string }[] = [];
    let sessionId: string | undefined;
    for (const [index, model] of models.entries()) {
      if (modelSource === 'user-settings') {
        options.host.userSettings.agent.models = [model];
        await app.setHostUserSettings(options.host.userSettings);
      } else {
        const state = app.configurations!.state;
        await post({ type: 'project-configuration', call: { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [model] } } });
      }
      if (index) await expect.poll(() => app!.controller!.hasRuns).toBe(false);
      expect(calls).toHaveLength(index);
      expect(app.controller!.current.messages.filter(message => message.role === 'assistant')).toMatchObject(expected);
      // A stale selection is resolved against the new configuration, never used
      // to restart the owner before the new input's parameters are available.
      const requestId = crypto.randomUUID();
      const result = await post({ type: 'send', requestId, text: `Input ${index}`, params: index ? { model: models[index - 1].id } : {}, attachments: [] });
      expect(result.some((message: { type: string }) => message.type === 'error'), JSON.stringify(result)).toBe(false);
      await expect.poll(() => {
        // Admission can precede the next durable snapshot. An old completed
        // reply cannot establish success for the newly submitted input.
        const answer = app!.controller!.current.messages.find(message => message.role === 'assistant'
          && (message.id === requestId || message.sessionRequestId === requestId));
        if (answer?.status === 'failed') throw new Error(`Turn ${index}: ${answer.error}`);
        return answer?.status;
      }, { timeout: 12_000 }).toBe('success');
      expected.push({ status: 'success', model: model.name, content: `Reply ${index + 1} from ${model.model}` });
      expect(app.controller!.current.messages.filter(message => message.role === 'assistant')).toMatchObject(expected);
      expect(app.controller!.current.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(models.slice(0, index + 1).map((_, i) => `Input ${i}`));
      expect(calls).toHaveLength(index + 1); expect(calls.at(-1)?.model).toBe(model.model);
      expect(calls.at(-1)?.token).toBe(model.source === 'system' ? 'Bearer system-identity' : 'Bearer third-identity');
      if (index) expect(JSON.stringify(calls.at(-1)?.body)).toContain(expected[index - 1].content);
      if (sessionId) expect(app.controller!.current.id).toBe(sessionId); else sessionId = app.controller!.current.id;
    }
    await app.close(); app = await startWebServer(options);
    await waitForLogin();
    expect(app.controller!.current.id).toBe(sessionId);
    expect(app.controller!.current.messages.filter(message => message.role === 'assistant')).toMatchObject(expected);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(app.controller!.current)).not.toContain('third-identity');
    // Keep two choices available so the branch can select a different model.
    if (modelSource === 'user-settings') {
      options.host.userSettings.agent.models = [models[2], models[1]];
      await app.setHostUserSettings(options.host.userSettings);
    } else {
      const state = app.configurations!.state;
      await post({ type: 'project-configuration', call: { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [models[2], models[1]] } } });
    }
    const owner = app.controller!.current;
    const forkParams = { ...[...owner.messages].reverse().find(message => message.role === 'user')!.input!.params, model: models[1].id, effort: 'medium' };
    const forkReply = await post({ type: 'agent-command', sessionId: owner.id,
      command: { type: 'fork', requestId: crypto.randomUUID(), entryId: owner.messages.at(-1)!.entryId } });
    const forkId = forkReply.find((message: { type: string }) => message.type === 'agent-receipt')!.forkSessionId;
    const fork = app.controller!.sessions.find(session => session.id === forkId)!;
    const committed = JSON.parse(JSON.stringify(owner.agentParameters));
    expect(fork.agentOwnerId).toBeUndefined();
    const currentOwner = () => app!.controller!.sessions.find(session => session.id === owner.id)!;
    const currentFork = () => app!.controller!.sessions.find(session => session.id === forkId)!;
    const continueFork = async (text: string) => {
      const requestId = crypto.randomUUID();
      const result = await post({ type: 'send', sessionId: forkId, requestId, text,
        params: forkParams, attachments: [] });
      expect(result.some((message: { type: string }) => message.type === 'error'), JSON.stringify(result)).toBe(false);
      await expect.poll(() => {
        const answer = currentFork().messages.find(message => message.role === 'assistant'
          && (message.id === requestId || message.sessionRequestId === requestId));
        if (answer?.status === 'failed') throw new Error(answer.error);
        return answer?.status;
      }, { timeout: 12_000 }).toBe('success');
    };
    await continueFork('Continue the fork with more reasoning');
    expect(calls).toHaveLength(4);
    expect(currentOwner().agentParameters).toEqual(committed);
    expect(currentOwner().agent!.configuration.effort).toBe('high');
    expect(currentFork().agent!.configuration.effort).toBe('medium');
    expect(calls.at(-1)?.model).toBe(models[1].model);
    const forkVersion = currentFork().agent!.configuration.version;
    expect(currentOwner().messages.filter(message => message.role === 'assistant')).toMatchObject(expected);
    await app.close(); app = await startWebServer(options);
    await waitForLogin();
    await continueFork('Continue the reopened fork');
    expect(calls).toHaveLength(5);
    expect(app.controller!.sessions.find(session => session.id === owner.id)!.agent!.configuration.effort).toBe('high');
    expect(currentFork().agent!.configuration).toMatchObject({ effort: 'medium', version: forkVersion });
    expect(calls.at(-1)?.model).toBe(models[1].model);
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 55_000);
