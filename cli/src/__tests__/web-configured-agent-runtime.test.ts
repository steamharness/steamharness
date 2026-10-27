import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AGENT_MODELS_CONFIGURATION_KEY, type ProjectConfigurationState } from '@steamharness/project-configuration';
import { startEntryWebServer as startWebServer } from '../web/server';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

// Exercise the real page protocol, configuration service, child worker, SDK
// Agent and loopback credential bridge. Only the upstream HTTP service is fake.
it('runs saved system and third-party models through the real Web worker with refreshed scoped credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'configured-agent-runtime-'));
  const applicationId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  let app: Awaited<ReturnType<typeof startWebServer>> | undefined;
  let generation = 0, subscribed = true;
  const catalogRequests: string[] = [], calls: { path: string; model: string; token: string; body: any }[] = [];
  const upstream = createServer(async (request, response) => {
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
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'configured-agent', version: '1.0.0', devDependencies: { steamharness: await resolveHarnessVersion() }, steamHarness: { defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],  } }));
    await writeFile(path.join(directory, 'index.ts'), `
      const agent = steamharness.createAgentConversationProject({ tools: [], outputItemId: 'answer' });
      export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: agent,
        params: [{ kind: 'quick', id: 'ai', label: 'AI', summary: ['model'], fields: [
          { name: 'provider', flag: '--provider', type: 'string', required: true, control: 'select', options: [] },
          { name: 'model', flag: '--model', type: 'string', required: true, control: 'select', options: [] },
        ] }],
        resolveParams: steamharness.createAgentProjectParamResolver(),
        createInput({ args }) { return steamharness.createAgentProjectInput(args); }, });
      export default agent;
    `);
    app = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'data'), host: { surface: 'editor', connection: {
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
      await app.controller!.idle();
      const answer = app.controller!.current.messages.at(-1)!;
      expect(answer.status, answer.error).toBe('success'); expect(answer.content).toContain(`Answer from ${model.model}`);
      expect(answer.model).toBe(model.name);
      expect(calls.at(-1)?.model).toBe(model.model);
      if (model.source === 'system') {
        expect(catalogRequests.length - catalogsBefore).toBe(2);
        expect(calls.at(-1)?.token).toBe(model.id === 'responses' ? `Bearer responses-${generation}` : `anthropic-${generation}`);
      } else { expect(catalogRequests.length).toBe(catalogsBefore); expect(calls.at(-1)?.token).toBe('Bearer third-identity'); }
    }
    expect(calls.map(call => call.path)).toEqual(['/proxy/responses/responses', '/proxy/anthropic/messages', '/v1/chat/completions']);
    expect(catalogRequests.every(token => token === 'Bearer ai-identity')).toBe(true);
    for (const secret of ['ai-identity', 'project-identity', 'third-identity', 'credentialToken']) expect(JSON.stringify(app.controller!.current)).not.toContain(secret);
    subscribed = false;
    await post({ type: 'send', text: 'Revoked subscription', params: { model: 'responses' }, attachments: [] });
    await app.controller!.idle();
    expect(app.controller!.current.messages.at(-1)?.status).toBe('failed'); expect(calls).toHaveLength(3);

    subscribed = true;
    await app.setHostConnection({ serverUrl: origin, accessToken: 'next-project-identity', aiServerUrl: origin, aiAccessToken: 'next-ai-identity' });
    const switchedAt = catalogRequests.length;
    await post({ type: 'send', text: 'Changed account', params: { model: 'responses' }, attachments: [] });
    await app.controller!.idle();
    expect(app.controller!.current.messages.at(-1)?.status).toBe('success');
    expect(catalogRequests.slice(switchedAt)).toEqual(['Bearer next-ai-identity', 'Bearer next-ai-identity']);
    expect(calls.at(-1)?.token).toBe(`Bearer responses-${generation}`);

    await app.setHostConnection(undefined);
    const offlineAt = catalogRequests.length;
    state = app.configurations!.state;
    const updated = [{ ...models[2], model: 'third-next-model', apiKey: 'third-next-identity' }, ...models.slice(0, 2)];
    await post({ type: 'project-configuration', call: { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [AGENT_MODELS_CONFIGURATION_KEY]: updated } } });
    await post({ type: 'send', text: 'Updated configuration without system sign-in', params: { model: 'deleted-entry' }, attachments: [] });
    await app.controller!.idle();
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

it('switches configured models in a durable conversation without hiding prior replies or replaying inputs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'configured-durable-models-'));
  const applicationId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  const calls: { model: string; body: any; token: string }[] = [];
  let app: Awaited<ReturnType<typeof startWebServer>> | undefined;
  const upstream = createServer(async (request, response) => {
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
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ id: applicationId, name: 'durable-model-switch', version: '1.0.0', type: 'module', steamHarness: { defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],  }, devDependencies: { steamharness: await resolveHarnessVersion() } }));
    await writeFile(path.join(directory, 'index.ts'), `
      export const executor = steamharness.defineExecutor({ projectType: 'conversation',
        workflow: steamharness.createAgentConversationProject({ projectName: 'Switch models', outputItemId: 'answer', tools: [], session: { compaction: { enabled: false } } }),
        conversation: { durable: { enabled: true }, recovery: { enabled: true } },
        params: [{ kind: 'quick', id: 'ai', label: 'AI', summary: ['model'], fields: [
          { name: 'provider', flag: '--provider', type: 'string', required: true, control: 'select', options: [] },
          { name: 'model', flag: '--model', type: 'string', required: true, control: 'select', options: [] },
        ] }], resolveParams: steamharness.createAgentProjectParamResolver(),
        createInput({ args }) { return steamharness.createAgentProjectInput(args); },
      });
    `);
    const options = { projectDir: directory, dataDir: path.join(directory, 'data'), host: { surface: 'editor' as const, connection: {
      serverUrl: origin, accessToken: 'identity', aiServerUrl: origin, aiAccessToken: 'ai-identity',
    } } };
    app = await startWebServer(options);
    const post = async (message: object) => {
      const token = new URL(app!.url).hash.slice('#session='.length);
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result.messages;
    };
    const models = [
      { id: 'old', name: 'Original model', source: 'system', credentialId: 'subscription', model: 'system-old' },
      { id: 'custom', name: 'Custom model', source: 'third-party', apiKind: 'openai-responses', model: 'third-party', baseUrl: `${origin}/v1`, apiKey: 'third-identity' },
      { id: 'new', name: 'Replacement model', source: 'system', credentialId: 'subscription', model: 'system-new' },
    ];
    const expected: { status: string; content: string; model: string }[] = [];
    let sessionId: string | undefined;
    for (const [index, model] of models.entries()) {
      const state = app.configurations!.state;
      await post({ type: 'project-configuration', call: { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [model] } } });
      if (index) await expect.poll(() => app!.controller!.hasRuns).toBe(false);
      expect(calls).toHaveLength(index);
      expect(app.controller!.current.messages.filter(message => message.role === 'assistant')).toMatchObject(expected);
      // A stale selection is resolved against the new configuration, never used
      // to restart the owner before the new input's parameters are available.
      const result = await post({ type: 'send', requestId: crypto.randomUUID(), text: `Input ${index}`, params: index ? { model: models[index - 1].id } : {}, attachments: [] });
      expect(result.some((message: { type: string }) => message.type === 'error'), JSON.stringify(result)).toBe(false);
      await expect.poll(() => {
        const answer = app!.controller!.current.messages.at(-1);
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
    expect(app.controller!.current.id).toBe(sessionId);
    expect(app.controller!.current.messages.filter(message => message.role === 'assistant')).toMatchObject(expected);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(app.controller!.current)).not.toContain('third-identity');
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 40_000);
