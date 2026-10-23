import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request as httpRequest, ServerResponse } from 'node:http';
import { createServer as createProxy, connect as connectSocket, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseWebArgs } from '../web';
import { startWebServer } from '../web/server';
import { createWebRuntime, sanitizeWebWorkerEnvironment } from '../web/runtime';
import { readCliAuthConfig, writeCliAuthConfig } from '../auth-config';
import { parseHostConfiguration, parseHostConnection } from '../web/host-config';
import type { WebHostConfiguration } from '../web/host-config';
import type { Project, Runtime, Run, Report } from '../web/workflow-types';
import { initI18n } from '@steamharness/i18n';
import { t } from '../web/localization';
import { resolveHarnessRoot } from './harness-source';
import { ConversationState } from '../web/conversation-state';

const folders: string[] = [];
const services: Awaited<ReturnType<typeof startWebServer>>[] = [];
afterEach(async () => {
  for (const app of services.splice(0)) await app.close();
  for (const folder of folders.splice(0)) {
    const key = createHash('sha256').update(await realpath(folder)).digest('hex');
    const config = path.join(os.homedir(), '.steamharness', 'configurations', `${key}.json`);
    for (const suffix of ['', '.lock.sqlite', '.lock.sqlite-wal', '.lock.sqlite-shm']) await rm(`${config}${suffix}`, { force: true });
    await rm(folder, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

async function accountState(app: Awaited<ReturnType<typeof startWebServer>>, cookie: string) {
  const events = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } });
  return (await initialState(events)).account;
}

async function initialState(events: Response) {
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Event stream closed before its state snapshot.');
      buffer += decoder.decode(chunk.value, { stream: true });
      const end = buffer.search(/\r?\n\r?\n/);
      if (end >= 0) return JSON.parse(buffer.slice(0, end).slice('data: '.length));
    }
  } finally { await reader.cancel(); }
}

async function fixture(host?: WebHostConfiguration, beforeStart?: () => Promise<void>, projectType: Project['projectType'] = 'conversation') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'steamharness-web-')); folders.push(directory);
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(directory, 'auth')); vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  const project: Project = { id: '364764e9-ef0e-4e86-9e56-77d0410e1723', uri: '', folderPath: directory, name: 'Test conversation', projectType, fields: [{ name: 'model', flag: '--model', type: 'string', panel: 'auxiliary' }], paramLayout: { actions: [{ kind: 'auxiliary', id: 'ai', label: 'AI', params: ['model'] }] }, paramResolver: { enabled: true }, entrypoints: [], tools: [{ name: 'read', enabled: true, autoApprove: false }] };
  if (projectType === 'kanban') {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ id: project.id, steamHarness: { projectType } }));
  }
  let count = 0;
  const runtime: Runtime = {
    available: true, inspect: vi.fn(async () => ({ projects: [project], errors: [] })),
    resolveParams: vi.fn(async () => ({ params: {} })),
    run: vi.fn(async (request: Run, emit) => {
      count++;
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'answer', title: 'Output', content: '', contentType: 'markdown' } } });
      emit({ type: 'node_chunk', chunk: { type: 'output_item_delta', itemId: 'answer', delta: `Turn ${count}` } });
      return { status: 'success', output: { items: [{ id: 'answer', title: 'Output', content: `Turn ${count}`, contentType: 'markdown' }] }, runId: request.runId } as Report;
    }),
    cancel: vi.fn(), dispose: vi.fn(), uploadFiles: vi.fn(async () => []), readFile: vi.fn(async () => { throw new Error('Unknown file.'); }),
    deleteFiles: vi.fn(async () => {}), readResource: vi.fn(async () => null), cancelConversation: vi.fn(async () => {}), deleteConversation: vi.fn(async () => {}),
  };
  await beforeStart?.();
  const app = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'data'), runtime, host }); services.push(app);
  const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session');
  const auth = await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  const post = async (message: object, headers: Record<string, string> = {}) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: app.origin, ...headers }, body: JSON.stringify(message) });
  return { directory, project, runtime, app, cookie, post };
}

describe('steamharness web', () => {
  it('keeps raw trace and export data out of live snapshots without changing persisted history', async () => {
    const { app, cookie, post } = await fixture();
    const clientId = crypto.randomUUID();
    await post({ type: 'ready', clientId });
    const payload = 'raw output '.repeat(100_000);
    const answer = { id: 'answer', role: 'assistant' as const, content: 'Visible answer', status: 'success', items: [{ id: 'item', content: 'Visible answer' }],
      events: [
        { type: 'node_chunk', timestamp: 10, chunk: { type: 'output_item_start', item: { id: 'item', content: payload } } },
        { type: 'node_chunk', timestamp: 20, chunk: { type: 'output_item_delta', itemId: 'item', delta: payload } },
        { type: 'node_chunk', timestamp: 30, chunk: { type: 'output_item_end', itemId: 'item', result: payload } },
      ], report: { status: 'success', result: { data: payload }, outputs: [payload], nodes: [{ executionId: 'node', output: 'Node detail' }] } };
    app.controller.current.messages.push(answer);
    await app.controller.persist();
    const state = await initialState(await fetch(`${app.origin}/api/events?clientId=${clientId}`, { headers: { Cookie: cookie } }));
    expect(JSON.stringify(state).length).toBeLessThan(20_000);
    expect(state.sessions[0].messages[0]).toMatchObject({ items: answer.items, report: { nodes: answer.report.nodes } });
    const trace = await (await post({ type: 'trace', clientId, sessionId: app.controller.activeId, messageId: 'answer' })).json();
    expect(trace.messages[0].content.events).toEqual(answer.events);
    expect(trace.messages[0].content.report.result.data).toBe(payload);
    const exported = await (await post({ type: 'session-action', clientId, id: app.controller.activeId, action: 'export' })).json();
    expect(JSON.parse(exported.messages[0].content).messages[0]).toEqual(answer);
    expect(app.controller.current.messages[0].events).toEqual(answer.events);
  });

  it('skips serialization for blocked clients and sends their latest state after drain while other pages keep receiving updates', async () => {
    const { app, cookie, post, runtime } = await fixture();
    let emit!: (event: Record<string, unknown>) => void, finish!: (report: Report) => void;
    vi.mocked(runtime.run).mockImplementation((_request, onEvent) => {
      emit = onEvent; return new Promise(resolve => { finish = resolve; });
    });
    await post({ type: 'send', text: 'Run', params: {}, attachments: [] });
    await vi.waitFor(() => expect(emit).toBeDefined());
    let slow: ServerResponse | undefined, released = false;
    const write = ServerResponse.prototype.write;
    vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, chunk: any, ...args: any[]) {
      const result = Reflect.apply(write, this, [chunk, ...args]);
      if (this.getHeader('Content-Type') === 'text/event-stream' && !slow) slow = this;
      return this === slow && !released ? false : result;
    });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const next = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      let text = '';
      while (!text.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream closed before snapshot.');
        text += new TextDecoder().decode(chunk.value);
      }
      return JSON.parse(text.split('\n\n')[0].slice('data: '.length));
    };
    try {
      for (let index = 0; index < 2; ++index) {
        const response = await fetch(`${app.origin}/api/events?clientId=${crypto.randomUUID()}`, { headers: { Cookie: cookie } });
        const reader = response.body!.getReader(); readers.push(reader); await next(reader);
      }
      const snapshots = vi.spyOn(ConversationState.prototype, 'sessions');
      for (let index = 0; index < 3; ++index) {
        app.controller.current.title = `Update ${index}`;
        emit({ type: 'node_chunk', chunk: { type: 'output_item_delta', itemId: 'answer', delta: String(index) } });
        expect((await next(readers[1])).sessions[0].title).toBe(`Update ${index}`);
        expect(snapshots).toHaveBeenCalledTimes(index + 1);
      }
      released = true; slow!.emit('drain');
      expect((await next(readers[0])).sessions[0].title).toBe('Update 2');
      expect(snapshots).toHaveBeenCalledTimes(4);
    } finally {
      released = true; finish({ status: 'success' }); await app.controller.idle();
      await Promise.all(readers.map(reader => reader.cancel()));
    }
  });

  it('makes duplicate windows read-only and runs different conversations in independent services without losing history', async () => {
    const { app: one, directory, runtime: first } = await fixture();
    const left = crypto.randomUUID(), right = crypto.randomUUID();
    const post = (app: typeof one, clientId: string, message: object) => fetch(`${app.origin}/api/message`, {
      method: 'POST', headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, ...message }),
    });
    const replies = async (response: Response) => {
      const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200);
      return value.messages.find((message: any) => message.type === 'state');
    };
    const original = one.controller.activeId;
    await replies(await post(one, left, { type: 'ready' }));
    await post(one, left, { type: 'draft', sessionId: original, text: 'Original draft', attachments: [] });
    const second: Runtime = { ...first, run: vi.fn(), dispose: vi.fn() };
    const two = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'data'), runtime: second }); services.push(two);
    let finishLeft!: (report: Report) => void, finishRight!: (report: Report) => void;
    vi.mocked(first.run).mockImplementation(() => new Promise(resolve => { finishLeft = resolve; }));
    vi.mocked(second.run).mockImplementation(() => new Promise(resolve => { finishRight = resolve; }));
    const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (const [app, clientId] of [[one, left], [two, right]] as const) {
        const response = await fetch(`${app.origin}/api/events?session=${new URL(app.url).hash.slice('#session='.length)}&clientId=${clientId}`);
        const reader = response.body!.getReader(); streams.push(reader); await reader.read();
      }
      expect((await replies(await post(two, right, { type: 'ready' }))).conversationAccess.readOnly).toBe(true);
      const blocked = await post(two, right, { type: 'send', sessionId: original, text: 'Duplicate', params: {}, attachments: [] });
      expect(blocked.status).toBe(400); expect((await blocked.json()).message).toMatch(/another window|其它/);
      expect(second.run).not.toHaveBeenCalled();
      expect((await post(two, right, { type: 'new', sessionId: original, text: 'Stale duplicate draft' })).status).toBe(200);
      const created = await replies(await post(two, right, { type: 'ready' }));
      const other = created.activeId;
      expect(other).not.toBe(original); expect(created.conversationAccess.readOnly).toBe(false);
      await Promise.all([
        post(one, left, { type: 'send', sessionId: original, text: 'Left runs', params: {}, attachments: [] }),
        post(two, right, { type: 'send', sessionId: other, text: 'Right runs', params: {}, attachments: [] }),
      ]);
      await vi.waitFor(() => { expect(first.run).toHaveBeenCalledOnce(); expect(second.run).toHaveBeenCalledOnce(); });
      expect(one.controller.hasRuns).toBe(true); expect(two.controller.hasRuns).toBe(true);
      finishLeft({ status: 'success' }); finishRight({ status: 'success' });
      await Promise.all([one.controller.idle(), two.controller.idle()]);
      const key = createHash('sha256').update(await realpath(directory)).digest('hex').slice(0, 24);
      const history = JSON.parse(await readFile(path.join(directory, 'data', key, 'conversations.json'), 'utf8'));
      expect(history.sessions.find((session: any) => session.id === original).messages[0].content).toBe('Left runs');
      expect(history.sessions.find((session: any) => session.id === other).messages[0].content).toBe('Right runs');
      await streams[0].cancel();
      await one.close();
      expect((await post(two, right, { type: 'select', id: original })).status).toBe(200);
      const transferred = await replies(await post(two, right, { type: 'ready' }));
      expect(transferred.conversationAccess.readOnly).toBe(false);
      expect(transferred.sessions.find((session: any) => session.id === original).messages[0].content).toBe('Left runs');
    } finally {
      finishLeft?.({ status: 'aborted' }); finishRight?.({ status: 'aborted' });
      await Promise.all(streams.map(reader => reader.cancel()));
    }
  });

  it('removes deployment and credential environment values from project workers', () => {
    const environment = sanitizeWebWorkerEnvironment({
      PATH: '/bin',
      NODE_OPTIONS: '--require ./private-hook.mjs',
      STEAMHARNESS_SERVER_ADMIN_KEY: 'project-admin',
      STEAMHARNESS_AI_SERVER_ADMIN_KEY: 'ai-admin',
      STEAMHARNESS_AI_UPSTREAM_API_KEY: 'provider-key',
      STEAMHARNESS_STUDIO_INTERNAL: '1',
      STEAMHARNESS_STUDIO_INTERNAL_MODULE: '/private/studio-internal/src/extension-layer.mjs',
      STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL: 'http://127.0.0.1:7127',
      STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: '{"id":"workflow-studio"}',
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: 'http://127.0.0.1:9999/studio-control',
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: 'capability-token',
      SUB2API_JWT_SECRET: 'sub2api-secret',
      DATABASE_URL: 'postgres://private',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/gcp.json',
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/private/gcloud.json',
      AWS_SHARED_CREDENTIALS_FILE: '/private/aws-credentials',
      AWS_CONFIG_FILE: '/private/aws-config',
      DOCKER_CONFIG: '/private/docker',
      KUBECONFIG: '/private/kubeconfig',
      SSH_AUTH_SOCK: '/private/ssh-agent.sock',
      STEAMHARNESS_RUNTIME_LOCALE: 'zh-CN',
    });
    expect(environment).toEqual({ PATH: '/bin', STEAMHARNESS_RUNTIME_LOCALE: 'zh-CN',
      STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: '{"id":"workflow-studio"}',
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: 'http://127.0.0.1:9999/studio-control',
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: 'capability-token' });
  });

  it('routes Trace controls to an explicitly selected historical session and rejects a replaced owner', async () => {
    const { app, post } = await fixture();
    const root = app.controller.current;
    const childId = crypto.randomUUID();
    root.agent = { version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: false, backgroundCount: 0, epoch: 0,
      configuration: { version: 0, provider: 'fixture', model: 'test', effort: 'off' }, prompt: { hash: 'digest', version: 1 }, plan: { version: 0, items: [] },
      conversations: [{ id: 1, title: 'Main', background: false }, { id: 2, title: 'Child', background: true }],
      tasks: [], history: [], turns: [], receipts: [], records: [], contexts: [], usage: [] };
    app.controller.sessions.push({ ...root, id: childId, agentOwnerId: root.id, agentConversationId: 2 });
    const control = vi.spyOn(app.controller, 'agentCommand').mockResolvedValue({ requestId: 'trace-command', status: 'accepted', conversationId: 2 });
    const open = vi.spyOn(app.controller, 'openAgentConversation').mockResolvedValue(root.id);
    const request = { type: 'agent-command', sessionId: childId, agentOwner: 'owner', command: { type: 'compact', requestId: 'trace-command', targetId: 2 } };
    const response = await post(request);
    expect(response.status, await response.text()).toBe(200);
    expect(control).toHaveBeenCalledWith(childId, request.command);
    expect((await post({ ...request, agentOwner: 'previous-owner' })).status).toBe(400);
    expect(control).toHaveBeenCalledOnce();
    expect((await post({ type: 'agent-open', sessionId: childId, agentOwner: 'owner', conversationId: 1 })).status).toBe(200);
    expect(open).toHaveBeenCalledWith(childId, 1);
    expect((await post({ type: 'agent-open', sessionId: childId, agentOwner: 'previous-owner', conversationId: 1 })).status).toBe(400);
    expect(open).toHaveBeenCalledOnce(); expect(app.controller.current.id).toBe(root.id);
  });
  it('confirms an optimistic send by request identity without clearing a draft typed during slow parameter resolution', async () => {
    const { app, post, runtime } = await fixture();
    const sessionId = app.controller.current.id, requestId = crypto.randomUUID();
    let resolve!: (value: { params: {} }) => void;
    vi.mocked(runtime.resolveParams).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const message = { type: 'send', sessionId, requestId, text: 'First message', params: {}, attachments: [], preserveDraft: true };
    const sending = post(message);
    await vi.waitFor(() => expect(runtime.resolveParams).toHaveBeenCalledOnce());
    expect((await post({ type: 'navigate', clientId: crypto.randomUUID(), requestId: 1, id: sessionId,
      updates: [{ id: sessionId, draft: { text: 'Next draft', attachments: [] } }] })).status).toBe(200);
    resolve({ params: {} });
    const response = await sending;
    expect(response.status).toBe(200);
    const replies = (await response.json()).messages;
    expect(replies.find((reply: any) => reply.type === 'sent')).toMatchObject({ sessionId, projectUri: app.project.uri, requestId });
    const snapshot = replies.find((reply: any) => reply.type === 'state');
    expect(snapshot.sessions[0].draft.text).toBe('Next draft');
    expect(snapshot.sessions[0].messages[1].id).toBe(requestId);
    await app.controller.idle();
    expect((await post(message)).status).toBe(200);
    await app.controller.idle();
    expect(runtime.run).toHaveBeenCalledOnce();
    expect(app.controller.current.draft?.text).toBe('Next draft');
  });

  it.each(['stop', 'cancel'])('handles %s for the requested session while another mutation is stalled', async type => {
    const { app, post } = await fixture();
    const target = app.controller.current;
    target.messages.push({ id: 'answer', role: 'assistant', content: 'Working', status: 'running' });
    await app.controller.create();
    expect(app.controller.current.id).not.toBe(target.id);
    let release!: () => void;
    const draft = vi.spyOn(app.controller, 'updateDraft').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stalled = post({ type: 'draft', sessionId: target.id, text: 'Saved draft', attachments: [] });
    const stop = vi.spyOn(app.controller, 'stop').mockResolvedValue();
    const command = vi.spyOn(app.controller, 'agentCommand').mockImplementation(async (_id, message) => ({ requestId: message.requestId, status: 'accepted', conversationId: 1 }));
    let queued: Promise<Response> | undefined;
    try {
      await vi.waitFor(() => expect(draft).toHaveBeenCalledOnce());
      queued = post({ type: 'agent-command', sessionId: target.id, command: { type: 'compact', requestId: 'compact' } });
      const requestId = crypto.randomUUID();
      const response = await post({ type: type === 'cancel' ? 'agent-command' : 'stop', sessionId: target.id, requestId,
        ...(type === 'cancel' ? { command: { type: 'cancel', scope: 'foreground', requestId } } : {}) });
      expect(response.status).toBe(200);
      const replies = (await response.json()).messages;
      expect(replies).toContainEqual(expect.objectContaining({ type: type === 'cancel' ? 'agent-receipt' : 'stopped', projectUri: app.project.uri, sessionId: target.id, requestId }));
      expect(replies.some((reply: any) => reply.type === 'state')).toBe(true);
      if (type === 'cancel') expect(command).toHaveBeenCalledWith(target.id, { type: 'cancel', scope: 'foreground', requestId });
      else expect(stop).toHaveBeenCalledWith(target);
      expect(command.mock.calls.some(([, message]) => message.type === 'compact')).toBe(false);
    } finally {
      release?.(); await stalled; await queued;
    }
    expect(command.mock.calls.some(([, message]) => message.type === 'compact')).toBe(true);
  });

  it('rejects a delayed stop after the session starts a different run', async () => {
    const { app, post } = await fixture();
    const target = app.controller.current;
    target.activeRunId = 'new-run';
    const stop = vi.spyOn(app.controller, 'stop').mockResolvedValue();
    expect((await post({ type: 'stop', sessionId: target.id, runId: 'old-run' })).status).toBe(400);
    expect(stop).not.toHaveBeenCalled();
    expect((await post({ type: 'stop', sessionId: target.id, runId: 'new-run' })).status).toBe(200);
    expect(stop).toHaveBeenCalledWith(target);
  });

  it('keeps page selections independent and routes sends to their explicit conversations', async () => {
    const { app, cookie, post, runtime } = await fixture();
    const firstClient = crypto.randomUUID(), secondClient = crypto.randomUUID();
    const ready = async (clientId: string) => (await (await post({ type: 'ready', clientId })).json()).messages.find((reply: any) => reply.type === 'state');
    const initial = await ready(firstClient), first = initial.activeId, second = crypto.randomUUID();
    expect((await post({ type: 'navigate', clientId: secondClient, requestId: 1, id: second,
      updates: [{ id: second, create: true, draft: { text: 'Second draft', attachments: [] } }] })).status).toBe(200);
    expect((await ready(firstClient)).activeId).toBe(first);
    expect((await ready(secondClient)).activeId).toBe(second);
    expect((await ready(crypto.randomUUID())).activeId).toBe(second);
    for (const [clientId, sessionId, text] of [[firstClient, first, 'First page'], [secondClient, second, 'Second page']]) {
      expect((await post({ type: 'send', clientId, sessionId, text, params: {}, attachments: [] })).status).toBe(200);
    }
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runtime.run).mock.calls.map(([request]) => request.conversationId)).toEqual([first, second]);
    for (const [clientId, selected] of [[firstClient, first], [secondClient, second]]) {
      const events = await fetch(`${app.origin}/api/events?clientId=${clientId}`, { headers: { Cookie: cookie } });
      const state = await initialState(events);
      expect(state.activeId).toBe(selected);
      expect(state.sessions.find((session: any) => session.id === first).messages[0].content).toBe('First page');
      expect(state.sessions.find((session: any) => session.id === second).messages[0].content).toBe('Second page');
    }
  });

  it('creates a new tool conversation while the original is running and preserves its selection and draft', async () => {
    const { app, post, runtime } = await fixture();
    const firstClient = crypto.randomUUID(), secondClient = crypto.randomUUID(), original = app.controller.current;
    let finish!: (report: Report) => void;
    vi.mocked(runtime.run).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const ready = async (clientId: string) => (await (await post({ type: 'ready', clientId })).json()).messages.find((reply: any) => reply.type === 'state');
    await ready(firstClient);
    expect((await post({ type: 'send', clientId: firstClient, sessionId: original.id, text: 'Keep running', params: {}, attachments: [] })).status).toBe(200);
    try {
      await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
      expect((await post({ type: 'navigate', clientId: firstClient, requestId: 1, id: original.id,
        updates: [{ id: original.id, draft: { text: 'Original next turn', attachments: [] } }] })).status).toBe(200);
      const id = crypto.randomUUID(), request = { type: 'navigate', clientId: secondClient, requestId: 1, id,
        updates: [{ id, create: true, draft: { text: '', attachments: [] } }] };
      expect((await post(request)).status).toBe(200); expect((await post(request)).status).toBe(200);
      const second = await ready(secondClient), first = await ready(firstClient);
      expect(second.activeId).toBe(id); expect(second.running).toBe(false);
      expect(second.sessions.find((session: any) => session.id === id)).toMatchObject({ messages: [], draft: { text: '', attachments: [] } });
      expect(first.activeId).toBe(original.id); expect(first.running).toBe(true);
      expect(first.sessions.find((session: any) => session.id === original.id).draft.text).toBe('Original next turn');
      expect(app.controller.sessions.filter(session => session.id === id)).toHaveLength(1);
      expect(runtime.cancel).not.toHaveBeenCalled(); expect(runtime.cancelConversation).not.toHaveBeenCalled();
    } finally { finish?.({ status: 'success', runId: original.activeRunId } as Report); await app.controller.idle(); }
  });

  it.each(['queue-promote', 'queue-remove'] as const)('acknowledges %s only after completion and binds it to the original conversation', async type => {
    const { app, post } = await fixture();
    const original = app.controller.current;
    await app.controller.recordCommand('fixture', 'Original conversation');
    await app.controller.create();
    const selected = app.controller.current;
    let finish!: () => void;
    const method = type === 'queue-promote' ? 'promoteQueued' : 'removeQueued';
    const operation = vi.spyOn(app.controller, method).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const requestId = crypto.randomUUID();
    let completed = false;
    const pending = post({ type, sessionId: original.id, id: 'queued', requestId }).then(response => { completed = true; return response; });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    expect(operation).toHaveBeenCalledWith('queued', original, requestId); expect(completed).toBe(false);
    finish();
    const response = await pending; expect(response.status).toBe(200);
    const { messages } = await response.json();
    expect(messages).toContainEqual({ type: 'queue-updated', projectUri: app.controller.project.uri, sessionId: original.id, requestId, id: 'queued' });
    expect(messages.find((reply: any) => reply.type === 'state').activeId).toBe(selected.id);
    expect((await post({ type, sessionId: original.id, id: 'queued', requestId: 'invalid' })).status).toBe(400);
    expect(operation).toHaveBeenCalledOnce();
    operation.mockResolvedValue(undefined);
    expect((await post({ type, sessionId: original.id, id: 'queued' })).status).toBe(200);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('restores the last selected conversation after reopening (older conversation=%s)', async older => {
    const { directory, app, post, runtime } = await fixture();
    const clientId = crypto.randomUUID(), first = app.controller.activeId, second = crypto.randomUUID();
    expect((await post({ type: 'send', clientId, sessionId: first, text: 'First run', params: {}, attachments: [] })).status).toBe(200);
    await app.controller.idle();
    expect((await post({ type: 'navigate', clientId, requestId: 1, id: second,
      updates: [{ id: second, create: true, draft: { text: 'Second draft', attachments: [] } }] })).status).toBe(200);
    expect((await post({ type: 'send', clientId, sessionId: second, text: 'Last run', params: {}, attachments: [] })).status).toBe(200);
    await app.controller.idle();
    if (older) {
      expect((await post({ type: 'navigate', clientId, requestId: 2, id: first, updates: [] })).status).toBe(200);
      expect((await post({ type: 'navigate', clientId, requestId: 1, id: second, updates: [] })).status).toBe(200);
    }
    await app.close();
    const next = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'data'), runtime }); services.push(next);
    expect(next.controller.activeId).toBe(older ? first : second);
    expect(next.controller.current.messages[0].content).toBe(older ? 'First run' : 'Last run');
    expect(runtime.run).toHaveBeenCalledTimes(2);
  });

  it.each(['stale', 'missing', 'deleted'] as const)('opens the most recently active conversation from legacy history with a %s selection', async selection => {
    const { directory, app, runtime } = await fixture();
    const template = app.controller.current;
    await app.close();
    const sessions = [10, 20, 50, 30, 40].map((updatedAt, index) => ({
      ...template, id: crypto.randomUUID(), title: `Conversation ${index + 1}`, createdAt: index + 1, updatedAt,
      messages: [{ role: 'user', content: `Message ${index + 1}`, createdAt: updatedAt }],
    }));
    const key = createHash('sha256').update(await realpath(directory)).digest('hex').slice(0, 24);
    const historyPath = path.join(directory, 'data', key, 'conversations.json');
    await writeFile(historyPath, JSON.stringify({ sessions, activeId: selection === 'stale' ? sessions[0].id : selection === 'deleted' ? crypto.randomUUID() : undefined }));
    const next = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'data'), runtime }); services.push(next);
    expect(next.controller.activeId).toBe(sessions[2].id);
    const token = new URLSearchParams(new URL(next.url).hash.slice(1)).get('session');
    const auth = await fetch(`${next.origin}/api/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const cookie = auth.headers.get('set-cookie')!.split(';')[0];
    const events = await fetch(`${next.origin}/api/events?clientId=${crypto.randomUUID()}`, { headers: { Cookie: cookie } });
    const state = await initialState(events);
    expect(state.activeId).toBe(sessions[2].id);
    expect(state.sessions).toEqual(sessions);
    await next.close();
    expect(JSON.parse(await readFile(historyPath, 'utf8'))).toMatchObject({ selectionVersion: 1, activeId: sessions[2].id });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it.each(['new', 'select'])('updates a pinned page selection for legacy %s requests', async type => {
    const { app, post } = await fixture();
    const clientId = crypto.randomUUID(), first = app.controller.activeId;
    await post({ type: 'ready', clientId });
    await app.controller.recordCommand('fixture', 'First conversation');
    await app.controller.create();
    const id = app.controller.activeId;
    await app.controller.recordCommand('fixture', 'Second conversation');
    await app.controller.select(first);
    const changed = await post({ type, clientId, id });
    expect(changed.status, await changed.text()).toBe(200);
    const response = await (await post({ type: 'ready', clientId })).json();
    const selected = response.messages.find((reply: any) => reply.type === 'state').activeId;
    expect(selected).toBe(app.controller.activeId);
    expect(selected).not.toBe(first);
    if (type === 'select') expect(selected).toBe(id);
  });

  it.each([
    ['conversation', 'workflow-ui'], ['workflow', 'workflow-workspace'], ['kanban', 'kanban-workspace'],
  ] as const)('serves the shared theme after the %s page styles, including resource previews', async (projectType, ui) => {
    const { app } = await fixture(undefined, undefined, projectType);
    for (const [pathname, stylesheet] of [['/', ui], [`/resource/${crypto.randomUUID()}`, 'resource-preview']]) {
      const response = await fetch(`${app.origin}${pathname}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<link rel="stylesheet" href="/assets/${stylesheet}.css"><link rel="stylesheet" href="/assets/theme.css">`);
    }
    const theme = await fetch(`${app.origin}/assets/theme.css`);
    expect(theme.status).toBe(200);
    expect(theme.headers.get('content-type')).toBe('text/css');
    expect(await theme.text()).toBe(await readFile(fileURLToPath(new URL('../web/theme.css', import.meta.url)), 'utf8'));
  });

  it.each(['en', 'zh-CN'] as const)('serves the %s UI language from the CLI invocation', async language => {
    initI18n({ preference: language });
    try {
      const { app } = await fixture();
      expect(await fetch(app.origin).then(response => response.text())).toContain(`<html lang="${language}"`);
    } finally { initI18n({ preference: 'zh-CN' }); }
  });
  it('parses host options and rejects invalid ports, themes and flags', () => {
    expect(parseWebArgs(['.', '--port', '0', '--no-open', '--json', '--theme', 'dark'])).toMatchObject({ port: 0, open: false, json: true, theme: 'dark' });
    for (const argv of [['--port', '-1'], ['--port', '65536'], ['--port', '1.5'], ['--theme', 'purple'], ['--port'], ['--host', '0.0.0.0'], ['one', 'two']]) { expect(() => parseWebArgs(argv)).toThrow(); }
    expect(parseWebArgs(['--inspect', '--json'])).toMatchObject({ inspect: true });
    expect(parseWebArgs(['--host-stdio'])).toMatchObject({ hostStdio: true });
  });

  it('validates the private host configuration and assistant workspace', () => {
    expect(parseHostConfiguration({ type: 'configure', surface: 'editor', connection: null })).toEqual({ surface: 'editor', connection: undefined, relatedProjects: [] });
    expect(parseHostConnection({ serverUrl: 'https://steamharness.test/', accessToken: 'host-token' })).toEqual({ serverUrl: 'https://steamharness.test', accessToken: 'host-token' });
    for (const connection of [{ serverUrl: 'file:///tmp', accessToken: 'token' }, { serverUrl: 'https://user:password@steamharness.test', accessToken: 'token' }, { serverUrl: 'https://steamharness.test', accessToken: '' }]) { expect(() => parseHostConnection(connection)).toThrow(); }
    const aiConnection = { serverUrl: 'https://steamharness.test', accessToken: 'host-token', aiServerUrl: 'https://ai.workflow.test', aiAccessToken: 'ai-token' };
    // Editor surfaces also receive the host's system-AI connection: a project
    // that asks for host LLM credentials must be able to run in the editor.
    expect(parseHostConfiguration({ type: 'configure', surface: 'editor', connection: aiConnection }).connection).toEqual(aiConnection);
    expect(parseHostConfiguration({ type: 'configure', surface: 'assistant', connection: aiConnection,
      assistant: { workdir: '/tmp/workflow-assistant', roots: [{ uri: 'file:///tmp/workflow-assistant', folderPath: '/tmp/workflow-assistant', name: 'Assistant' }] },
      assistantProjectDir: '/tmp/workflow-assistant' }).connection).toEqual(aiConnection);
    expect(() => parseHostConfiguration({ type: 'configure', surface: 'unknown' })).toThrow();
    expect(() => parseHostConfiguration({ type: 'configure', surface: 'assistant', assistant: { workdir: 'relative', roots: [] } })).toThrow();
  });

  it('supports embedded sessions without cookies and limits query credentials to read endpoints', async () => {
    const { app } = await fixture();
    const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session')!;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${app.origin}/api/session`, { headers })).status).toBe(200);
    const created = await fetch(`${app.origin}/api/message`, { method: 'POST', headers, body: JSON.stringify({ type: 'new' }) });
    expect(created.status, await created.text()).toBe(200);
    const events = await fetch(`${app.origin}/api/events?session=${token}`);
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"state"'); await reader.cancel();
    expect((await fetch(`${app.origin}/api/message?session=${token}`, { method: 'POST', body: '{"type":"new"}' })).status).toBe(401);
    expect((await fetch(`${app.origin}/api/session?session=${token}`)).status).toBe(401);
  });

  it('supports a forwarded loopback port for embedded pages while rejecting foreign origins', async () => {
    const { app } = await fixture({ surface: 'editor' });
    const sockets = new Set<Socket>();
    const proxy = createProxy(socket => {
      const target = connectSocket(Number(new URL(app.origin).port), '127.0.0.1');
      for (const entry of [socket, target]) { sockets.add(entry); entry.on('close', () => sockets.delete(entry)); }
      socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy());
      socket.pipe(target).pipe(socket);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const token = new URL(app.url).hash.slice('#session='.length);
    try {
      const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
      expect((await fetch(`${origin}/api/session`, { method: 'POST', headers })).status).toBe(200);
      const created = await fetch(`${origin}/api/message`, { method: 'POST', headers, body: JSON.stringify({ type: 'new' }) });
      expect(created.status, await created.text()).toBe(200);
      const events = await fetch(`${origin}/api/events?session=${token}`, { headers: { Origin: origin } });
      expect(events.status).toBe(200);
      const reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"state"'); await reader.cancel();
      expect((await fetch(`${origin}/api/message`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ type: 'new' }) })).status).toBe(403);
    } finally { for (const socket of sockets) { socket.destroy(); } await new Promise<void>(resolve => proxy.close(() => resolve())); }
  });

  it('sends observable SSE heartbeats while the project is idle', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app, cookie } = await fixture();
    const response = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } });
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"state"');
      const next = (async () => {
        let frames = '';
        while (!frames.includes('event: heartbeat\ndata: {}\n\n')) {
          const frame = await reader.read();
          if (frame.done) throw new Error('Event stream closed before its heartbeat.');
          frames += new TextDecoder().decode(frame.value);
        }
        return frames;
      })();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await next).toContain('event: heartbeat\ndata: {}\n\n');
    } finally { await reader.cancel(); }
  });

  it('injects and clears host login without writing host credentials to CLI configuration', async () => {
    const { app, cookie, post } = await fixture();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer private-host-token');
      return new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'host', email: 'host@example.com', displayName: 'Host user', secret: 'non-public-profile-field' } } }));
    });
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'private-host-token' });
    expect(await readCliAuthConfig()).toEqual({ serverUrl: '', apiKey: '' });
    const state = async () => {
      const events = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } }); const reader = events.body!.getReader();
      const result = new TextDecoder().decode((await reader.read()).value); await reader.cancel(); return result;
    };
    expect(await state()).toContain('"status":"authenticated"');
    expect(await state()).not.toContain('private-host-token');
    expect(await state()).not.toContain('non-public-profile-field');
    expect((await post({ type: 'verify' })).status).toBe(200);
    await app.setHostConnection(undefined);
    expect(await state()).toContain('"status":"signed-out"');
    expect(await readCliAuthConfig()).toEqual({ serverUrl: '', apiKey: '' });
  });

  it.each(['cache', 'environment'])('keeps a signed-out host authoritative over %s credentials', async source => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const realFetch = globalThis.fetch;
    const verify = vi.fn(async () => new Response(JSON.stringify({ errCode: 0, data: {
      profile: { userId: 'host', email: 'host@example.com', displayName: 'Host user' },
    } })));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => String(input).startsWith('https://steamharness.test') ? verify() : realFetch(input, options));
    const saved = { serverUrl: 'https://steamharness.test', apiKey: 'cached-cli-token', user: { userId: 'cached', email: 'cached@example.com', displayName: 'Cached user' } };
    const { app, cookie, post } = await fixture({ surface: 'editor' }, async () => {
      await writeCliAuthConfig(saved);
      vi.stubEnv('STEAMHARNESS_SERVER_URL', source === 'environment' ? saved.serverUrl : undefined);
      vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', source === 'environment' ? 'environment-token' : undefined);
    });
    expect(await accountState(app, cookie)).toMatchObject({ status: 'signed-out' });
    expect(await accountState(app, cookie)).not.toHaveProperty('user');
    expect((await post({ type: 'verify' })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(verify).not.toHaveBeenCalled();
    expect(await readCliAuthConfig()).toEqual(saved);

    await app.setHostConnection({ serverUrl: saved.serverUrl, accessToken: 'host-token' });
    expect(await accountState(app, cookie)).toMatchObject({ status: 'authenticated', user: { displayName: 'Host user' } });
    await app.setHostConnection(undefined);
    expect((await post({ type: 'verify' })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await accountState(app, cookie)).toMatchObject({ status: 'signed-out' });
    expect(await accountState(app, cookie)).not.toHaveProperty('user');
    expect(verify).toHaveBeenCalledOnce();
    expect(await readCliAuthConfig()).toEqual(saved);
  });

  it('still restores cached CLI login for a standalone Web page', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer cached-cli-token');
      return new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'cached', email: 'cached@example.com', displayName: 'Cached user' } } }));
    });
    const { app, cookie } = await fixture(undefined, async () => {
      vi.stubEnv('STEAMHARNESS_SERVER_URL', undefined); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', undefined);
      await writeCliAuthConfig({ serverUrl: 'https://steamharness.test', apiKey: 'cached-cli-token' });
    });
    expect(await accountState(app, cookie)).toMatchObject({ status: 'authenticated', user: { displayName: 'Cached user' } });
  });

  it('routes embedded account management to the host and refuses independent login or logout', async () => {
    const { app, cookie, post } = await fixture({ surface: 'editor' });
    const realFetch = globalThis.fetch;
    const verify = vi.fn(async () => new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'host', email: 'host@example.com', displayName: 'Host user' } } })));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => String(input).startsWith('https://steamharness.test') ? verify() : realFetch(input, options));
    expect(await fetch(app.origin).then(response => response.text())).toContain('data-account-host="true"');
    for (const action of [
      { type: 'login', serverUrl: 'https://steamharness.test', email: 'other@example.com', password: 'password' },
      { type: 'login', serverUrl: 'https://steamharness.test' },
      { type: 'logout' },
    ]) { expect((await post(action)).status).toBe(400); }
    expect(verify).not.toHaveBeenCalled();
    expect(await readCliAuthConfig()).toEqual({ serverUrl: '', apiKey: '' });
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'host-token' });
    expect((await post({ type: 'logout' })).status).toBe(400);
    expect(await accountState(app, cookie)).toMatchObject({ status: 'authenticated', user: { displayName: 'Host user' } });
  });

  it('redacts failed host verification even after the active connection is cleared', async () => {
    const { app, cookie } = await fixture();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => String(input).startsWith('https://steamharness.test') ? new Response('secret-host-value') : realFetch(input, options));
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'secret-host-value' });
    const events = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } });
    const reader = events.body!.getReader(); const state = new TextDecoder().decode((await reader.read()).value); await reader.cancel();
    expect(state).toContain('"status":"error"'); expect(state).not.toContain('secret-host-value');
  });

  it.each(['host', 'environment'])('does not borrow a saved CLI expiry for an account supplied by %s', async source => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app, cookie, post } = await fixture();
    await writeCliAuthConfig({ serverUrl: 'https://old-account.test', apiKey: 'old-cli-token', expiresAt: '2000-01-01T00:00:00.000Z' });
    const realFetch = globalThis.fetch;
    let checks = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      checks++;
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer current-token');
      return new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'current', email: 'current@example.com', displayName: 'Current account' } } }));
    });
    if (source === 'host') { await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'current-token' }); }
    else {
      vi.stubEnv('STEAMHARNESS_SERVER_URL', 'https://steamharness.test'); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', 'current-token');
      expect((await post({ type: 'verify' })).status).toBe(200);
    }
    const account = await accountState(app, cookie);
    expect(account).toMatchObject({ status: 'authenticated', user: { displayName: 'Current account' } });
    expect(account).not.toHaveProperty('expiresAt');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checks).toBe(1);
    expect(await readCliAuthConfig()).toMatchObject({ apiKey: 'old-cli-token', expiresAt: '2000-01-01T00:00:00.000Z' });
  });

  it('does not authenticate a token when the server returns a malformed account profile', async () => {
    const { app, cookie } = await fixture();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => String(input).startsWith('https://steamharness.test')
      ? Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: {} } }))) : realFetch(input, options));
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'host-token' });
    expect(await accountState(app, cookie)).toMatchObject({ status: 'error' });
  });

  it.each(['host', 'standalone'])('refreshes changed and removed profile avatars for %s without invalidating project authentication', async source => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const realFetch = globalThis.fetch;
    let profile = { userId: 'user', email: 'user@example.com', displayName: 'Original user', avatarUrl: 'data:image/png;base64,b2xk' as string | undefined };
    const verify = vi.fn(async () => Response.json({ errCode: 0, data: { profile } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => String(input).startsWith('https://steamharness.test') ? verify() : realFetch(input, options));
    const { app, cookie } = await fixture(source === 'host' ? { surface: 'editor', connection: { serverUrl: 'https://steamharness.test', accessToken: 'profile-token' } } : undefined, async () => {
      if (source === 'standalone') {
        vi.stubEnv('STEAMHARNESS_SERVER_URL', undefined); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', undefined);
        await writeCliAuthConfig({ serverUrl: 'https://steamharness.test', apiKey: 'profile-token' });
      }
    });
    const initial = await accountState(app, cookie);
    const stop = vi.spyOn(app.controller, 'stop');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
    expect(await accountState(app, cookie)).toEqual(initial);

    profile = { ...profile, displayName: 'Updated user', avatarUrl: 'data:image/webp;base64,bmV3' };
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expect(await accountState(app, cookie)).toMatchObject({ status: 'authenticated', user: profile }));
    const refreshed = await accountState(app, cookie);
    expect(refreshed.revision).toBe(initial.revision + 1);

    profile = { ...profile, avatarUrl: undefined };
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expect((await accountState(app, cookie)).user).not.toHaveProperty('avatarUrl'));
    expect(stop).not.toHaveBeenCalled();
  });

  it('background profile checks preserve the active account on network failure and expire revoked credentials', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const realFetch = globalThis.fetch;
    let unavailable = false, revoked = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      if (unavailable) { throw new TypeError('Temporary network failure.'); }
      if (revoked) { return Response.json({ errCode: 401 }, { status: 401 }); }
      return Response.json({ errCode: 0, data: { profile: { userId: 'user', email: 'user@example.com', displayName: 'Current user' } } });
    });
    const { app, cookie } = await fixture({ surface: 'editor', connection: { serverUrl: 'https://steamharness.test', accessToken: 'profile-token' } });
    const initial = await accountState(app, cookie), stop = vi.spyOn(app.controller, 'stop');
    unavailable = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await accountState(app, cookie)).toEqual(initial);
    expect(stop).not.toHaveBeenCalled();
    unavailable = false; revoked = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expect(await accountState(app, cookie)).toMatchObject({ status: 'expired' }));
    expect(stop).toHaveBeenCalledOnce();
  });

  it('an older host verification cannot replace a newer injected account', async () => {
    const { app, cookie } = await fixture();
    const realFetch = globalThis.fetch;
    let finishOld!: (response: Response) => void;
    const profile = (name: string) => new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: name, email: `${name}@example.com`, displayName: name } } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      return new Headers(options?.headers).get('Authorization') === 'Bearer old-host-token' ? new Promise(resolve => { finishOld = resolve; }) : profile('New account');
    });
    const old = app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'old-host-token' });
    await vi.waitFor(() => expect(finishOld).toBeDefined());
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'new-host-token' });
    finishOld(profile('Old account')); await old;
    const events = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } });
    const reader = events.body!.getReader(); const state = new TextDecoder().decode((await reader.read()).value); await reader.cancel();
    expect(state).toContain('New account'); expect(state).not.toContain('Old account'); expect(state).not.toContain('host-token');
  });

  it('automatically verifies the same account again after a transient authentication failure', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app, cookie } = await fixture();
    const realFetch = globalThis.fetch;
    let checks = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      if (++checks === 1) { throw new TypeError('Temporary network failure.'); }
      return new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'host', email: 'host@example.com', displayName: 'Recovered account' } } }));
    });
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'host-token' });
    expect(await accountState(app, cookie)).toMatchObject({ status: 'error' });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(async () => expect(await accountState(app, cookie)).toMatchObject({ status: 'authenticated', user: { displayName: 'Recovered account' } }));
    expect(checks).toBe(2);
  });

  it('does not supersede a slow authentication check with a polling request', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app, cookie } = await fixture();
    const realFetch = globalThis.fetch;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    let checks = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      checks++;
      return pending;
    });
    const checking = app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'host-token' });
    try {
      await vi.waitFor(() => expect(checks).toBe(1));
      await vi.advanceTimersByTimeAsync(5_000);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(checks).toBe(1);
    } finally {
      finish(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'host', email: 'host@example.com', displayName: 'Slow account' } } })));
      await checking;
    }
    expect(await accountState(app, cookie)).toMatchObject({ status: 'authenticated', user: { displayName: 'Slow account' } });
  });

  it('keeps a newer injected identity when an earlier password login finishes', async () => {
    const { app, cookie, post } = await fixture();
    vi.stubEnv('STEAMHARNESS_SERVER_URL', undefined); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', undefined);
    const realFetch = globalThis.fetch;
    let finishLogin!: (response: Response) => void;
    const profile = (userId: string) => ({ userId, email: `${userId}@example.com`, displayName: userId });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (!String(input).startsWith('https://steamharness.test')) { return realFetch(input, options); }
      if (String(input).endsWith('/api/auth/login')) { return new Promise(resolve => { finishLogin = resolve; }); }
      const name = new Headers(options?.headers).get('Authorization') === 'Bearer host-token' ? 'Injected account' : 'CLI account';
      return new Response(JSON.stringify({ errCode: 0, data: { profile: profile(name) } }));
    });
    const passwordLogin = post({ type: 'login', serverUrl: 'https://steamharness.test', email: 'cli@example.com', password: 'test-password' });
    await vi.waitFor(() => expect(finishLogin).toBeDefined());
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'host-token' });
    finishLogin(new Response(JSON.stringify({ errCode: 0, data: { authenticated: true, accessToken: 'cli-token', apiKey: { id: 'cli-key' } } })));
    expect((await passwordLogin).status).toBe(200);
    expect(await accountState(app, cookie)).toMatchObject({ status: 'authenticated', user: { displayName: 'Injected account' } });
    expect(await readCliAuthConfig()).toMatchObject({ apiKey: 'cli-token', user: { displayName: 'CLI account' } });
  });

  it('serves the real UI and protects APIs against missing sessions, foreign origins and path traversal', async () => {
    const { app, cookie, post } = await fixture();
    const html = await fetch(app.origin).then(response => response.text());
    expect(html).toContain('/assets/workflow-ui.js');
    expect(html).not.toContain('session=');
    const bundle = await fetch(`${app.origin}/assets/workflow-ui.js`).then(response => response.text());
    expect(bundle).toContain('history-popover'); expect(bundle).toContain('agent-activity');
    expect((await fetch(`${app.origin}/api/events`)).status).toBe(401);
    expect((await fetch(`${app.origin}/api/session`)).status).toBe(401);
    expect(await fetch(`${app.origin}/api/session`, { headers: { Cookie: cookie } }).then(response => response.json())).toEqual({ connected: true });
    expect((await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await post({ type: 'new' }, { Origin: 'https://example.com' })).status).toBe(403);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${app.origin}/api/events`, { headers: { Host: 'example.com', Cookie: cookie } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject); request.end();
    });
    expect(foreignHost).toBe(403);
    expect((await fetch(`${app.origin}/assets/%2e%2e/package.json`)).status).toBe(404);
    expect((await fetch(`${app.origin}/api/file/..%2fsecret`, { headers: { Cookie: cookie } })).status).toBe(400);
    expect((await post({ type: 'upload', files: [{ name: 'secret', data: '', path: '/etc/passwd' }] })).status).toBe(400);
  });

  it('streams state, passes project parameters and restores history after restart', async () => {
    const { directory, runtime, app, cookie, post } = await fixture();
    const events = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } });
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"state"'); await reader.cancel();
    expect((await post({ type: 'send', text: 'Hello', params: { model: 'demo' }, attachments: [] })).status).toBe(200);
    await app.controller.idle();
    expect(app.controller.current.messages.at(-1)?.content).toBe('Turn 1');
    expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({ args: ['--model', 'demo', '--message', 'Hello'], project: expect.objectContaining({ folderPath: directory }) }), expect.any(Function));
    expect(runtime.resolveParams).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ args: ['--model', 'demo'] }), undefined);
    const id = app.controller.activeId;
    await app.close();
    const next = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'data'), runtime }); services.push(next);
    expect(next.controller.activeId).toBe(id); expect(next.controller.current.messages.at(-1)?.content).toBe('Turn 1');
  });

  it('preserves credential-named custom Conversation parameters in state, resolution and export', async () => {
    const { app, project, runtime, post } = await fixture();
    project.fields.push({ name: 'apiKey', flag: '--api-key', type: 'string' });
    vi.mocked(runtime.resolveParams).mockResolvedValue({ params: { apiKey: { value: 'project-key' } } });
    const resolved = await post({ type: 'resolve', params: { apiKey: 'project-key' } }).then(response => response.json());
    expect(resolved.messages[0].params.apiKey).toEqual({ value: 'project-key' });
    const next = await post({ type: 'ready' }).then(response => response.json());
    expect(next.messages[0].parameterValues[''].apiKey).toBe('project-key');
    await post({ type: 'send', text: 'Custom', params: { apiKey: 'project-key' }, attachments: [] }); await app.controller.idle();
    const exported = await post({ type: 'session-action', action: 'export', id: app.controller.activeId }).then(response => response.json());
    expect(JSON.parse(exported.messages[0].content).messages[0].input.params.apiKey).toBe('project-key');
  });

  it('shares web password login with the CLI, verifies it again and only publishes public account data', async () => {
    const { app, cookie, post } = await fixture();
    vi.stubEnv('STEAMHARNESS_SERVER_URL', undefined); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', undefined);
    const realFetch = globalThis.fetch;
    const profile = { userId: 'test-user', email: 'test@example.com', displayName: 'Test User' };
    let checks = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (!url.startsWith('https://steamharness.test')) { return realFetch(input, options); }
      if (url.endsWith('/api/auth/login')) { return new Response(JSON.stringify({ errCode: 0, data: { authenticated: true, accessToken: 'test-api-key', apiKey: { id: 'key-id' } } })); }
      checks++;
      return new Response(JSON.stringify({ errCode: 0, data: { profile, principal: { expiresAt: '2027-01-01T00:00:00Z' } } }));
    });
    const result = await post({ type: 'login', serverUrl: 'https://steamharness.test', email: profile.email, password: 'test-password' });
    expect(result.status).toBe(200);
    expect(await readCliAuthConfig()).toMatchObject({ apiKey: 'test-api-key', user: profile, source: 'password' });
    expect((await post({ type: 'verify' })).status).toBe(200);
    expect(checks).toBe(3);
    const events = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } });
    const reader = events.body!.getReader();
    const state = new TextDecoder().decode((await reader.read()).value); await reader.cancel();
    expect(state).toContain('"status":"authenticated"'); expect(state).toContain(profile.email);
    expect(state).not.toContain('test-api-key'); expect(state).not.toContain('test-password');
    expect((await post({ type: 'logout' })).status).toBe(200);
    expect(await readCliAuthConfig()).toEqual({ serverUrl: '', apiKey: '' });
  });

  it('preserves tool approval and resumes the original answer', async () => {
    const { app, runtime, post } = await fixture();
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: { requestId: 'approval', nodeName: 'tool', title: 'Read file?', params: [{ name: 'decision', type: 'string', defaultValue: 'approve' }] } }).mockResolvedValueOnce({ status: 'success', output: { items: [{ id: 'done', content: 'Approved', contentType: 'text' }] } });
    await post({ type: 'send', text: 'Read', params: {}, attachments: [] }); await app.controller.idle();
    const answer = app.controller.current.messages.at(-1)!;
    expect(answer.status).toBe('waiting_for_input');
    await post({ type: 'resume', messageId: answer.id, requestId: 'approval', values: { decision: 'approve' } }); await app.controller.idle();
    expect(app.controller.current.messages).toHaveLength(2); expect(answer.content).toBe('Approved');
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ resolvedInputs: [expect.objectContaining({ requestId: 'approval' })], resumeAfterRequestId: 'approval' }), expect.any(Function));
  });

  it('does not let an older resolver overwrite parameters set by an accepted user input', async () => {
    const { runtime, app, post } = await fixture();
    const project = app.project;
    project.fields.push({ name: 'review', flag: '--review', type: 'boolean', panel: 'slash', defaultValue: 'true' });
    project.conversation = { userInput: { effects: [{ when: { type: 'review', values: { accepted: true } }, params: { review: 'false' } }] } };
    const request = { requestId: 'review-request', nodeName: 'review', title: 'Accept?', metadata: { type: 'review' }, params: [{ name: 'accepted', type: 'boolean' }] };
    vi.mocked(runtime.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: request }).mockResolvedValueOnce({ status: 'success' });
    await post({ type: 'send', text: 'Review', params: { model: 'chosen', review: 'true' }, attachments: [] }); await app.controller.idle();
    let finish!: (value: { params: {} }) => void;
    vi.mocked(runtime.resolveParams).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const oldRequest = post({ type: 'resolve', requestId: 1, params: { model: 'chosen', review: 'true' } });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await post({ type: 'resume', messageId: app.controller.current.messages.at(-1)!.id, requestId: request.requestId, values: { accepted: true } }); await app.controller.idle();
    finish({ params: {} });
    const outdated = await oldRequest.then(response => response.json());
    expect(outdated.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'params', requestId: 1, stale: true })]));
    expect(app.controller.current.parameterValues?.['']).toEqual({ model: 'chosen', review: 'false' });
  });

  it('invalidates cached parameter options on configuration edits and acknowledges obsolete resolutions', async () => {
    const { app, runtime, post } = await fixture();
    const before = (await post({ type: 'ready' }).then(response => response.json())).messages.find((message: any) => message.type === 'state');
    let finish!: (value: { params: {} }) => void;
    vi.mocked(runtime.resolveParams).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const resolving = post({ type: 'resolve', requestId: 42, params: { model: 'old' } });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await app.configurations.dispatch({ action: 'field.save', revision: app.configurations.state.revision, field: { name: 'label', type: 'string' } });
    finish({ params: {} });
    const result = await resolving.then(response => response.json());
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'params', requestId: 42, stale: true })]));
    expect(result.messages.find((message: any) => message.type === 'state').parameterRevision).toBeGreaterThan(before.parameterRevision);
    expect(app.controller.current.parameterValues ?? {}).toEqual({});
    await post({ type: 'resolve', requestId: 43, params: { model: 'new' } });
    expect(app.controller.current.parameterValues).toEqual({ '': { model: 'new' } });
  });

  it('validates every send against fresh options and rejects configuration changes during validation', async () => {
    const { app, runtime, post } = await fixture();
    app.project.fields[0].control = 'select';
    vi.mocked(runtime.resolveParams).mockResolvedValueOnce({ params: { model: { resolvedOptions: [{ value: 'cached' }] } } });
    await post({ type: 'resolve', requestId: 1, params: { model: 'cached' } });
    vi.mocked(runtime.resolveParams).mockResolvedValueOnce({ params: { model: { resolvedOptions: [{ value: 'current' }] } } });
    expect((await post({ type: 'send', text: 'Validate current options', params: { model: 'cached' }, attachments: [] })).status).toBe(400);
    expect(runtime.run).not.toHaveBeenCalled();
    let finish!: (value: { params: {} }) => void;
    vi.mocked(runtime.resolveParams).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const sending = post({ type: 'send', text: 'Validate current configuration', params: { model: 'current' }, attachments: [] });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await app.configurations.dispatch({ action: 'field.save', revision: app.configurations.state.revision, field: { name: 'label', type: 'string' } });
    finish({ params: {} });
    const response = await sending;
    expect(response.status).toBe(400); expect(await response.text()).toMatch(/configuration changed|项目配置已变更/u);
    expect(runtime.run).not.toHaveBeenCalled(); expect(app.controller.current.messages).toEqual([]);
  });

  it('rejects a cached selection when fresh resolution returns no available options', async () => {
    const { app, runtime, post } = await fixture();
    app.project.fields[0].control = 'select';
    vi.mocked(runtime.resolveParams).mockResolvedValueOnce({ params: { model: { resolvedOptions: [{ value: 'cached' }] } } });
    await post({ type: 'resolve', requestId: 1, params: { model: 'cached' } });
    vi.mocked(runtime.resolveParams).mockResolvedValueOnce({ params: { model: { resolvedOptions: [] } } });
    const response = await post({ type: 'send', text: 'All models were removed', params: { model: 'cached' }, attachments: [] });
    expect(response.status).toBe(400);
    expect(runtime.run).not.toHaveBeenCalled(); expect(app.controller.current.messages).toEqual([]);
    expect(app.controller.current.parameterValues?.['']?.model).toBe('cached');
  });

  it('resolves a required dynamic default on send after initial background resolution fails', async () => {
    const { app, runtime, post } = await fixture();
    Object.assign(app.project.fields[0], { control: 'select', required: true, options: [] });
    vi.mocked(runtime.resolveParams).mockRejectedValueOnce(new Error('Catalogue unavailable'));
    const background = await post({ type: 'resolve', requestId: 1, params: { model: '' } }).then(response => response.json());
    expect(background.messages[0].error).toBe('Catalogue unavailable');
    vi.mocked(runtime.resolveParams).mockResolvedValueOnce({ params: { model: { value: 'current', resolvedOptions: [{ value: 'current' }] } } });
    expect((await post({ type: 'send', text: 'Use fresh default', params: { model: '' }, attachments: [] })).status).toBe(200);
    await app.controller.idle();
    expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({ args: ['--model', 'current', '--message', 'Use fresh default'] }), expect.any(Function));
  });

  it('translates the composer parameter protocol and saves edited parameters before sending', async () => {
    const { app, runtime, post } = await fixture();
    const response = await post({ type: 'resolve', requestId: 3, params: { model: 'chosen-model' }, draftText: 'draft', trigger: { kind: 'param', paramName: 'model' } }).then(response => response.json());
    expect(response.messages[0]).toMatchObject({ type: 'params', requestId: 3 });
    expect(runtime.resolveParams).toHaveBeenCalledWith(expect.anything(), { draftText: 'draft', args: ['--model', 'chosen-model'], inputMode: 'form', trigger: { kind: 'param', paramName: 'model' } }, undefined);
    expect(app.controller.current.parameterValues).toEqual({ '': { model: 'chosen-model' } });
  });

  it('keeps the newest parameters when resolver replies arrive in reverse order', async () => {
    const { app, runtime, post } = await fixture();
    let finishOld!: (result: { params: {} }) => void;
    const oldResult = new Promise<{ params: {} }>(resolve => { finishOld = resolve; });
    vi.mocked(runtime.resolveParams).mockImplementationOnce(() => oldResult);
    const oldRequest = post({ type: 'resolve', requestId: 1, params: { model: 'old' } });
    await vi.waitFor(() => expect(runtime.resolveParams).toHaveBeenCalledTimes(1));
    await post({ type: 'resolve', requestId: 2, params: { model: 'new' } });
    finishOld({ params: {} });
    expect(await oldRequest.then(response => response.json())).toMatchObject({ messages: [{ type: 'params', requestId: 1, params: {} }] });
    expect(app.controller.current.parameterValues).toEqual({ '': { model: 'new' } });
  });

  it('replies to each page loading project options without replacing the latest saved values', async () => {
    const { app, runtime, post } = await fixture();
    const options = { params: { model: { resolvedOptions: [{ value: 'alpha', label: 'Project Alpha' }, { value: 'beta', label: 'Project Beta' }] } } };
    let finishFirst!: (result: typeof options) => void;
    vi.mocked(runtime.resolveParams).mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockResolvedValueOnce(options);
    const firstPage = post({ type: 'resolve', requestId: 3, params: { model: 'alpha' } });
    await vi.waitFor(() => expect(runtime.resolveParams).toHaveBeenCalledTimes(1));
    const secondPage = await post({ type: 'resolve', requestId: 3, params: { model: 'beta' } }).then(response => response.json());
    finishFirst(options);
    const firstReply = await firstPage.then(response => response.json());
    for (const reply of [firstReply, secondPage]) {
      expect(reply.messages).toEqual([expect.objectContaining({ type: 'params', requestId: 3, params: options.params })]);
    }
    expect(app.controller.current.parameterValues).toEqual({ '': { model: 'beta' } });
  });

  it('does not overwrite sent parameters with a resolver that started before the send', async () => {
    const { app, runtime, post } = await fixture();
    let finishOld!: (result: { params: {} }) => void;
    vi.mocked(runtime.resolveParams).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const oldRequest = post({ type: 'resolve', requestId: 1, params: { model: 'old' } });
    await vi.waitFor(() => expect(runtime.resolveParams).toHaveBeenCalledTimes(1));
    await post({ type: 'send', text: 'Hello', params: { model: 'sent-model' }, attachments: [] });
    finishOld({ params: {} }); await oldRequest; await app.controller.idle();
    expect(app.controller.current.parameterValues).toEqual({ '': { model: 'sent-model' } });
    expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({ args: ['--model', 'sent-model', '--message', 'Hello'] }), expect.any(Function));
  });

  it('rejects command collisions across accumulated Slash option patches without saving invalid states', async () => {
    const { app, runtime, post } = await fixture();
    app.project.fields = ['first', 'second'].map(name => ({ name, flag: `--${name}`, type: 'string', panel: 'slash',
      defaultValue: name, options: [{ value: name }] }));
    app.project.paramLayout = { actions: [{ kind: 'slash', name: 'first' }, { kind: 'slash', name: 'second' }] };
    app.project.conversation = { commands: [{ command: 'export', label: 'Export', action: { kind: 'export' } }] };
    vi.mocked(runtime.resolveParams).mockResolvedValueOnce({ params: { first: { resolvedOptions: [{ value: 'shared' }], value: 'shared' } } })
      .mockResolvedValueOnce({ params: { second: { resolvedOptions: [{ value: 'shared' }], value: 'shared' } } })
      .mockResolvedValueOnce({ params: { second: { resolvedOptions: [{ value: 'export' }], value: 'export' } } })
      .mockResolvedValueOnce({ params: { second: { resolvedOptions: [{ value: 'shared' }] } } })
      .mockResolvedValueOnce({ params: {} })
      .mockResolvedValueOnce({ params: { first: { resolvedOptions: null, value: 'first' }, second: { resolvedOptions: [{ value: 'shared' }], value: 'shared' } } });
    const initial = await post({ type: 'resolve', requestId: 1, params: { first: 'first', second: 'second' } }).then(response => response.json());
    expect(initial.messages[0].error).toBeUndefined();
    const values = { first: 'shared', second: 'second' };
    for (const requestId of [2, 3]) {
      const reply = await post({ type: 'resolve', requestId, params: values }).then(response => response.json());
      expect(reply.messages[0]).toMatchObject({ type: 'params', requestId, error: expect.stringContaining(requestId === 2 ? 'shared' : 'export') });
      expect(app.controller.current.parameterValues?.['']).toEqual(values);
    }
    const invalidSend = await post({ type: 'send', text: 'Reject conflicting options', params: values });
    expect(invalidSend.status).toBe(400);
    expect(app.controller.current.parameterValues?.['']).toEqual(values);
    expect(runtime.run).not.toHaveBeenCalled();
    expect((await post({ type: 'send', text: 'Retain valid options', params: values })).status).toBe(200);
    await app.controller.idle();
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['--first', 'shared', '--second', 'second', '--message', 'Retain valid options'] }), expect.any(Function));
    const restored = await post({ type: 'resolve', requestId: 4, params: values }).then(response => response.json());
    expect(restored.messages[0].error).toBeUndefined();
    expect(app.controller.current.parameterValues?.['']).toEqual({ first: 'first', second: 'shared' });
  });

  it('rejects stale conversation mutations and retains public tool policy and export actions', async () => {
    const { app, post } = await fixture();
    expect((await post({ type: 'send', sessionId: 'stale', text: 'ignored', params: {} })).status).toBe(400);
    await post({ type: 'tool-policy', policies: { read: { enabled: true, autoApprove: true }, injected: { enabled: true } } });
    expect(app.controller.current.toolPermissionPolicies).toEqual({ read: { enabled: true, autoApprove: true } });
    const id = app.controller.activeId;
    await post({ type: 'session-action', action: 'rename', id, title: 'Named chat' }); expect(app.controller.current.title).toBe('Named chat');
    const exported = await post({ type: 'session-action', action: 'export', id }).then(response => response.json());
    expect(exported.messages[0]).toMatchObject({ type: 'download', name: `conversation-${id}.json` });
    await post({ type: 'session-action', action: 'delete', id }); expect(app.controller.activeId).not.toBe(id);
  });

  it('exports all current messages with a persistent command result and dispatches only declared prompts', async () => {
    const { app, runtime, post } = await fixture();
    app.project.conversation = { commands: [
      { command: 'export', label: 'Export', action: { kind: 'export' } },
      { command: 'compact', label: 'Summarize', action: { kind: 'prompt', text: '/compact' } },
      { command: 'review', label: 'Review', action: { kind: 'prompt', text: 'Review the current project.' } },
    ] };
    await post({ type: 'send', text: 'First turn', params: {}, attachments: [] }); await app.controller.idle();
    await post({ type: 'send', text: 'Second turn', params: {}, attachments: [] }); await app.controller.idle();
    await post({ type: 'draft', text: 'Unsent draft', attachments: [] });
    const id = app.controller.activeId;
    const exported = await post({ type: 'command', command: 'export', sessionId: id }).then(response => response.json());
    expect(exported.messages[0]).toMatchObject({ type: 'download', name: `conversation-${id}.json` });
    const snapshot = JSON.parse(exported.messages[0].content);
    expect(snapshot.messages.map((message: { content: string }) => message.content)).toEqual([
      'First turn', 'Turn 1', 'Second turn', 'Turn 2', '/export', expect.stringContaining(`conversation-${id}.json`),
    ]);
    expect(app.controller.current.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'success', content: t("Conversation export ready: {0} ({1} messages).", `conversation-${id}.json`, snapshot.messages.length) });
    expect(runtime.run).toHaveBeenCalledTimes(2);
    const ready = await post({ type: 'ready' }).then(response => response.json());
    expect(app.controller.current.messages).toEqual(snapshot.messages);
    expect(ready.messages[0].sessions.find((session: { id: string }) => session.id === id).messages)
      .toMatchObject(snapshot.messages.map(({ id, role, content }: { id: string; role: string; content: string }) => ({ id, role, content })));
    expect((await post({ type: 'command', command: 'unknown', params: {} })).status).toBe(400);
    expect((await post({ type: 'command', command: 'export', sessionId: 'stale' })).status).toBe(400);
    await post({ type: 'command', command: 'compact', text: 'Ignore this injected prompt', params: {} }); await app.controller.idle();
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['--message', '/compact'] }), expect.any(Function));
    expect(app.controller.current.draft).toEqual({ text: 'Unsent draft', attachments: [] });
    await post({ type: 'command', command: 'review', params: {} }); await app.controller.idle();
    expect(runtime.run).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['--message', 'Review the current project.'] }), expect.any(Function));
  });

  it('does not queue or start a context command while another turn is running or awaiting approval', async () => {
    const { app, runtime, post } = await fixture();
    app.project.conversation = { inputQueue: { enabled: true }, commands: [{ command: 'compact', label: 'Summarize', action: { kind: 'prompt', text: '/compact' } }] };
    let finish!: (report: Report) => void;
    vi.mocked(runtime.run).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await post({ type: 'send', text: 'Working', params: {} });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
    expect((await post({ type: 'command', command: 'compact', params: {} })).status).toBe(400);
    expect(app.controller.current.queuedInputs).toEqual([]);
    finish({ status: 'waiting_for_input', pendingUserInput: { requestId: 'approval', nodeName: 'approve', title: 'Approve', params: [] } });
    await app.controller.idle();
    expect((await post({ type: 'command', command: 'compact', params: {} })).status).toBe(400);
    expect(runtime.run).toHaveBeenCalledOnce();
  });

  it('runs declared commands after a durable foreground finishes while its worker remains alive', async () => {
    const { app, runtime, post } = await fixture();
    app.project.conversation = { durable: { enabled: true }, recovery: { enabled: true }, commands: [
      { command: 'export', label: 'Export', action: { kind: 'export' } },
      { command: 'compact', label: 'Summarize', action: { kind: 'prompt', text: '/compact' } },
    ] };
    let finish!: (report: Report) => void;
    vi.mocked(runtime.run).mockImplementationOnce((request, emit) => new Promise(resolve => {
      finish = resolve;
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'agent-session', metadata: { kind: 'agent-session' }, content: {
        version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: false, tasks: [], history: [], receipts: [],
        conversations: [{ id: 1, title: 'Main', background: false }], contexts: [],
        turns: [{ requestId: `${request.runId}:agent:build`, conversationId: 1, prompt: 'First', mode: 'reject', status: 'done', epoch: 0, entryId: 1, answerId: 2, items: [] }],
      } } } });
    }));
    runtime.agentControl = vi.fn(async (_runId, command) => ({ requestId: command.requestId, conversationId: 1, status: 'accepted' as const }));
    try {
      await post({ type: 'send', text: 'First', params: {}, attachments: [] });
      await vi.waitFor(() => expect(app.controller.current.agent).toBeDefined());
      expect(app.controller.running).toBe(false); expect(app.controller.hasRuns).toBe(true);
      await post({ type: 'draft', text: 'Unsent', attachments: [] });
      const exported = await post({ type: 'command', command: 'export', params: {} });
      expect(exported.status).toBe(200);
      expect((await exported.json()).messages[0].type).toBe('download');
      expect((await post({ type: 'command', command: 'compact', params: {} })).status).toBe(200);
      expect(runtime.agentControl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'compact' }), app.controller.current.id, undefined);
      expect(app.controller.current.draft?.text).toBe('Unsent');
      expect(runtime.run).toHaveBeenCalledOnce();
    } finally { finish?.({ status: 'success' }); await app.controller.idle(); }
  });

  it('uses the Core resolved from the project and isolates development aliases', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'steamharness-web-runtime-')); folders.push(directory);
    await mkdir(path.join(directory, 'node_modules'));
    const harnessRoot = await resolveHarnessRoot();
    await symlink(harnessRoot, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    const harnessVersion = JSON.parse(await readFile(path.join(harnessRoot, 'package.json'), 'utf8')).version;
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ id: '364764e9-ef0e-4e86-9e56-77d0410e1723', name: 'project-runtime', type: 'module', devDependencies: { 'steamharness': harnessVersion }, steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } }));
    await writeFile(path.join(directory, 'index.ts'), `
      const flow = steamharness.defineProject({ name: 'test', run() { return {
        errCode: 0, errMessage: '', text: 'project runtime',
        llmServer: process.env.STEAMHARNESS_AI_SERVER_URL,
        llmToken: process.env.STEAMHARNESS_AI_API_KEY,
        llmLoginIsCurrent: process.env.STEAMHARNESS_AI_API_KEY === process.env.STEAMHARNESS_SERVER_ADMIN_KEY,
        assistantEnvironmentEmpty: !process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_HOST && !process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR && !process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST
      }; } });
      export const executor = steamharness.defineExecutor({
        projectType: 'conversation', workflow: flow,
        params: [
          { kind: 'auxiliary', id: 'formatting', label: 'Project formatting', fields: [
            { name: 'compact', flag: '--compact', type: 'boolean', label: 'Compact output', defaultValue: 'true' }
          ] },
          { kind: 'quick', id: 'audience-menu', label: 'Project audience', summary: ['audience'], fields: [
            { name: 'audience', flag: '--audience', type: 'string', control: 'select', label: 'Audience', options: [] }
          ] },
          { kind: 'mode', name: 'delivery', flag: '--delivery', label: 'Delivery', defaultValue: 'draft', options: [
            { value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }
          ] },
          { kind: 'auxiliary', id: 'brief-panel', label: 'Project brief', fields: [
            { name: 'brief', flag: '--brief', type: 'string', label: 'Project brief', control: 'textarea', defaultValue: 'Explain the project' }
          ] }
        ],
        resolveParams() { return { params: { audience: {
          value: 'developers', resolvedOptions: [{ value: 'developers', label: 'Developers' }, { value: 'operators', label: 'Operators' }],
          options: { operators: { disabled: true } }
        } } }; },
        createInput() { return {}; }
      });
    `);
    vi.stubEnv('TSX_TSCONFIG_PATH', path.join(directory, 'missing.json'));
    vi.stubEnv('STEAMHARNESS_LOCAL_HARNESS_ROOT', '/missing/core');
    vi.stubEnv('STEAMHARNESS_AI_SERVER_URL', 'https://old-account.test');
    vi.stubEnv('STEAMHARNESS_AI_API_KEY', 'old-account-token');
    vi.stubEnv('STEAMHARNESS_DEVELOPER_ASSISTANT_HOST', 'vscode');
    vi.stubEnv('STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR', '/old-workspace');
    vi.stubEnv('STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST', '/old-workspace/workspace.json');
    let activeConnection: { serverUrl: string; accessToken: string; aiServerUrl?: string; aiAccessToken?: string } | undefined;
    const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => activeConnection);
    try {
      const inspected = await runtime.inspect([directory]); expect(inspected.errors).toEqual([]);
      expect((inspected.projects[0] as unknown as { runtime: { harnessPath: string } }).runtime.harnessPath).toBe(path.join(harnessRoot, 'dist', 'index.js'));
      const project = { ...inspected.projects[0], uri: '' };
      expect(project.fields.map(field => field.name)).toEqual(['compact', 'audience', 'delivery', 'brief']);
      expect(project.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'compact', defaultValue: 'true' }),
        expect.objectContaining({ name: 'delivery', defaultValue: 'draft' }),
        expect.objectContaining({ name: 'brief', control: 'textarea', defaultValue: 'Explain the project' }),
      ]));
      expect(project.paramLayout).toEqual({ actions: [
        { kind: 'auxiliary', id: 'formatting', label: 'Project formatting', params: ['compact'] },
        { kind: 'quick', id: 'audience-menu', label: 'Project audience', summary: ['audience'], params: ['audience'] },
        { kind: 'mode', name: 'delivery' },
        { kind: 'auxiliary', id: 'brief-panel', label: 'Project brief', params: ['brief'] },
      ] });
      expect(project.paramResolver).toEqual({ enabled: true });
      expect(await runtime.resolveParams(project, { args: [], draftText: '', inputMode: 'form', trigger: { kind: 'init' } })).toMatchObject({
        params: { audience: {
          value: 'developers', resolvedOptions: [{ value: 'developers', label: 'Developers' }, { value: 'operators', label: 'Operators' }],
          options: { operators: { disabled: true } },
        } },
      });
      const report = await runtime.run({ project, conversationId: 'offline-test', runId: 'test-run', args: [] }, () => {});
      expect(report.status).toBe('success'); expect(report.output?.items?.[0].content).toMatchObject({ text: 'project runtime', llmServer: '', llmLoginIsCurrent: true, assistantEnvironmentEmpty: true });
      activeConnection = { serverUrl: 'https://current-account.test', accessToken: 'current-account-token', aiServerUrl: 'https://current-ai.test', aiAccessToken: 'current-ai-token' };
      const signedIn = await runtime.run({ project, conversationId: 'offline-test', runId: 'signed-in-run', args: [] }, () => {});
      expect(signedIn.output?.items?.[0].content).toMatchObject({ llmServer: activeConnection.aiServerUrl, llmLoginIsCurrent: false });
      const restrictedRuntime = createWebRuntime(directory, path.join(directory, 'restricted-data'), () => activeConnection, () => [], { allowSystemAi: false });
      try {
        const restricted = await restrictedRuntime.run({ project, conversationId: 'offline-test', runId: 'restricted-run', args: [] }, () => {});
        expect(restricted.output?.items?.[0].content).toMatchObject({ llmServer: '', llmToken: '', llmLoginIsCurrent: false });
      } finally { restrictedRuntime.dispose(); }
      activeConnection = undefined;
      const signedOut = await runtime.run({ project, conversationId: 'offline-test', runId: 'signed-out-run', args: [] }, () => {});
      expect(signedOut.output?.items?.[0].content).toMatchObject({ llmServer: '', llmLoginIsCurrent: true });
      project.requiresLogin = true;
      await expect(runtime.run({ project, conversationId: 'offline-test', runId: 'blocked-run', args: [] }, () => {})).rejects.toThrow('SteamHarness Server login is not configured');
      await expect(runtime.resolveParams(project, { args: [], draftText: '', inputMode: 'form', trigger: { kind: 'init' } })).rejects.toThrow('SteamHarness Server login is not configured');
    } finally { runtime.dispose(); }
  }, 30_000);

  it('accepts delayed pipe chunks, large uploads and split UTF-8 filenames', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'steamharness-web-pipe-')); folders.push(directory);
    await mkdir(path.join(directory, 'node_modules'));
    const harnessRoot = await resolveHarnessRoot();
    await symlink(harnessRoot, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    const filename = '\u6587\u4ef6.txt';
    const content = Buffer.alloc(256 * 1024, 'x');
    const request = Buffer.from(JSON.stringify({ method: 'upload', project: { folderPath: directory, id: 'pipe-project' },
      storageDir: path.join(directory, 'data'), conversationId: 'pipe-conversation',
      files: [{ name: filename, mimeType: 'text/plain', data: content.toString('base64') }],
    }));
    const split = request.indexOf(Buffer.from(filename)) + 1;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/web/worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => undefined);
    const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    const remainder = setTimeout(() => child.stdin.end(request.subarray(split)), 750);
    try {
      child.stdin.write(request.subarray(0, split));
      expect(await closed, stderr || stdout).toBe(0);
      const response = JSON.parse(stdout.split('\n').find(line => line.startsWith('__STEAMHARNESS_WEB__'))!.slice('__STEAMHARNESS_WEB__'.length));
      expect(response.kind).toBe('result'); expect(response.value[0].name).toBe(filename);
      expect(await readFile(response.value[0].path)).toEqual(content);
    } finally { clearTimeout(remainder); if (child.exitCode === null) { child.kill('SIGKILL'); await closed; } }
  }, 15_000);
});

it('binds a stop across process replacement to the original run and exact task identities', async () => {
  const { app, post } = await fixture();
  const current = app.controller.current;
  current.activeRunId = 'restored-run';
  current.agent = { version: 1, ownerId: 'replacement', revision: 1, conversationId: 1, foreground: true, backgroundCount: 0, epoch: 0,
    configuration: { version: 0, provider: 'fixture', model: 'test', effort: 'off' }, prompt: { hash: 'digest', version: 1 }, plan: { version: 0, items: [] },
    conversations: [{ id: 1, title: 'Main', background: false }],
    tasks: [{ id: 42, conversationId: 1, kind: 'pi.generation', label: 'Model', status: 'running', background: false, stopping: false, blockedOn: [] }],
    history: [], turns: [], receipts: [], records: [], contexts: [], usage: [] };
  const control = vi.spyOn(app.controller, 'agentCommand').mockResolvedValue({ requestId: 'original-stop', conversationId: 1, status: 'accepted' });
  const request = { type: 'agent-command', sessionId: current.id, agentOwner: 'exited-owner', runId: 'restored-run', taskIds: [42], errorScope: 'stop',
    command: { type: 'cancel', scope: 'foreground', requestId: 'original-stop' } };
  expect((await post({ ...request, taskIds: [43] })).status).toBe(400);
  expect((await post({ ...request, runId: 'another-run' })).status).toBe(400);
  expect((await post({ ...request, taskIds: [] })).status).toBe(400);
  expect((await post({ ...request, command: { ...request.command, type: 'reset' } })).status).toBe(400);
  expect(control).not.toHaveBeenCalled();
  const stopped = await post(request);
  expect(stopped.status, await stopped.text()).toBe(200);
  expect(control).toHaveBeenCalledExactlyOnceWith(current.id, request.command);
});
