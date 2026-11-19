import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import type { WebConnection } from '../web/runtime';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from './web-test-storage';
import type { Project, Report, Runtime } from '../web/workflow-types';

const apps: Awaited<ReturnType<typeof startWebServer>>[] = [], folders: string[] = [];
afterEach(async () => {
  try {
    for (const app of apps.splice(0)) await app.close();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  }
});

async function fixture(options: {
  id?: unknown; connection?: WebConnection; platform?: boolean; savedServer?: string; fail?: boolean; webApp?: boolean;
  configurationChanged?: Parameters<typeof startWebServer>[0]['onWebAppConfigurationChanged'];
} = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aggregate-web-'))); folders.push(directory);
  const history = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aggregate-web-history-'))); folders.push(history);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(directory, 'host'));
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(directory, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  if (options.savedServer) {
    await mkdir(path.join(directory, 'auth'));
    await writeFile(path.join(directory, 'auth/workflow-auth-dev.json'), JSON.stringify({ serverUrl: options.savedServer, apiKey: 'cached-token' }));
    vi.stubEnv('STEAMHARNESS_SERVER_URL', options.savedServer); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', 'env-token');
    vi.stubEnv('STEAMHARNESS_AI_SERVER_URL', options.savedServer); vi.stubEnv('STEAMHARNESS_AI_API_KEY', 'env-ai-token');
  }
  const entries = ([['agent', 'bot'], ['assistant', 'bot'], ['workflow', 'workflow'], ['board', 'kanban']] as const).map(([entryId, type]) => ({
    entryId, type, name: entryId, root: entryId, entry: type === 'kanban' ? 'dist/steamharness/entries/board/build/board/index.html' : 'index.ts', configuration: 'configuration.json', ...(type === 'kanban' && options.webApp ? { webApp: { service: 'sample.app' } } : {}),
  }));
  let id: string = randomUUID();
  const pkg = { id, name: 'Aggregate test', version: "0.1.0", entries, defaultEntry: 'agent' };
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify(pkg));
  if (Object.hasOwn(options, 'id')) {
    const file = path.join(directory, 'steamharness.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), id: options.id }));
    id = (await readProjectManifestFromDirectory(directory)).projectId;
  }
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ version: 1 }));
  for (const entry of entries) {
    await mkdir(path.join(directory, entry.root), {recursive:true});
    const filename = path.join(directory, entry.type === 'kanban' ? '.' : entry.root, entry.entry);
    await mkdir(path.dirname(filename), {recursive:true});
    await writeFile(filename, entry.type === 'kanban' ? '<!doctype html><html><head><title>Board</title><link rel="stylesheet" href="board.css"></head><body><script type="module" src="board.js"></script></body></html>' : 'export {};');
    if (entry.type === 'kanban') {
      await writeFile(path.join(path.dirname(filename), 'board.js'), 'document.body.dataset.loaded = "yes";');
      await writeFile(path.join(path.dirname(filename), 'board.css'), 'body { color: teal; }');
    }
    await writeFile(path.join(directory, entry.root, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'label', type: 'string' }] }));
  }
  const projects: Project[] = entries.map(entry => ({ id, entryId: entry.entryId, name: entry.name, aggregateName: pkg.name, entries, defaultEntry: 'agent', entryRoot: path.join(directory, entry.root), folderPath: directory, uri: '', projectType: entry.type, fields: [], entrypoints: entry.type === 'workflow' ? [{ id: 'operation', title: 'Operation', fields: [] }] : [], ...(entry.type === 'workflow' ? { defaultEntrypoint: 'operation' } : entry.type === 'kanban' ? { kanban: { artifactDir: 'dist/steamharness/entries/board/build/board', entry: 'index.html', ...(options.webApp ? { webApp: { service: 'sample.app' } } : {}) } } : {}) }));
  const active = new Map<string, { runId?: string; finish(report: Report): void }>();
  const runtime: Runtime = { available: true, inspect: vi.fn(async () => options.fail ? ({ projects: [], errors: ['Runtime unavailable'] }) : ({ projects, errors: [] })), resolveParams: vi.fn(async () => ({})),
    run: vi.fn(async request => new Promise<Report>(finish => active.set(request.project.entryId, { runId: request.runId, finish }))),
    cancel: vi.fn(runId => { for (const operation of active.values()) if (operation.runId === runId) operation.finish({ status: 'aborted' }); }),
    dispose: vi.fn(() => { for (const operation of active.values()) operation.finish({ status: 'aborted' }); }),
    uploadFiles: vi.fn(async () => []), readFile: vi.fn(), deleteFiles: vi.fn(), cancelConversation: vi.fn(), deleteConversation: vi.fn(),
  };
  const open = async () => { const app = await startWebServer({ projectDir: directory, dataDir: history, runtime, onWebAppConfigurationChanged: options.configurationChanged, ...(options.connection || options.platform !== undefined ? { host: { surface: 'editor' as const, platform: options.platform, connection: options.connection } } : {}) }); apps.push(app); return app; };
  let app = await open();
  const post = (entryId: string, message: object) => fetch(`${app.origin}/entries/${entryId}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('session')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  const call = async (entryId: string, message: object) => {
    const response = await post(entryId, message);
    if (!response.headers.get('content-type')?.includes('application/json')) {
      const recovery = await fetch(`${app.origin}/entries/${entryId}/api/retry`, { method: 'POST', headers: { Authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('session')}` } });
      throw new Error(`Entry fixture failed to start: ${JSON.stringify(await recovery.json())}`);
    }
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body.messages[0];
  };
  return { directory, entries, runtime, active, post, call, state: (entryId: string) => call(entryId, { type: 'ready' }), get app() { return app; }, async reopen() { await app.close(); apps.splice(apps.indexOf(app), 1); app = await open(); } };
}

it('shows the hosted recovery document in an iframe while keeping recovery APIs and foreign origins blocked', async () => {
  const f = await fixture({ fail: true, platform: true });
  const url = f.app.origin + '/entries/board/';
  const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' };
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('This entry could not start');
  expect((await fetch(url, { headers: { ...headers, Origin: 'https://outside.invalid' } })).status).toBe(403);
  expect((await fetch(url + 'api/retry', { method: 'POST', headers })).status).toBe(403);
  expect((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  expect((await fetch(url + 'api/retry', { method: 'POST' })).status).toBe(401);
  const session = new URL(f.app.url).hash.slice('#session='.length);
  const retry = await fetch(url + 'api/retry', { method: 'POST', headers: { Authorization: 'Bearer ' + session } });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ ready: false, message: 'Runtime unavailable' });
  const standalone = await fixture({ fail: true });
  expect((await fetch(standalone.app.origin + '/entries/board/', { headers })).status).toBe(403);
});

it('invalidates the old Web application origin and publishes the selected entry configuration', async () => {
  const changed: Array<{ entryId: string; configuration: any }> = [];
  const f = await fixture({ webApp: true, configurationChanged: (entryId, configuration) => changed.push({ entryId, configuration }) });
  await f.app.setHostWebApps({ board: { service: 'sample.app', apiBaseUrl: 'https://service.invalid/api', bootstrap: { token: 'old-scope' } } });
  const before = await f.state('board'), oldUrl = before.kanban.preview.url;
  expect(await (await fetch(oldUrl)).text()).toContain('old-scope');
  await f.call('board', { type: 'project-configuration', call: { action: 'create', revision: before.configurations.revision, name: 'Online', values: { label: 'Online service' } } });
  let state = (await f.state('board')).configurations;
  const online = state.configurations.find((item: any) => item.name === 'Online');
  await f.call('board', { type: 'project-configuration', call: { action: 'save', revision: state.revision, id: online.id, values: { label: 'Online service' } } });
  state = (await f.state('board')).configurations;
  await f.call('board', { type: 'project-configuration', call: { action: 'select', revision: state.revision, id: online.id } });
  expect(f.app.webAppConfigurations.board).toMatchObject({ id: online.id, params: { label: 'Online service' } });
  expect(changed.at(-1)).toMatchObject({ entryId: 'board', configuration: { id: online.id, params: { label: 'Online service' } } });
  await expect(fetch(oldUrl)).rejects.toThrow();
  const next = await f.state('board');
  expect(await (await fetch(next.kanban.preview.url)).text()).not.toContain('old-scope');
  const staleCatalog = await f.post('board', { type: 'kanban-method-state', nonce: before.kanban.preview.nonce,
    clientId: 'old-client', instanceId: 'old-preview', ready: true, configurationId: before.configurations.activeConfigurationId,
    presentation: { mode: 'fullscreen' }, methods: [] });
  expect(staleCatalog.status).toBe(200);
  expect((await staleCatalog.json()).messages).toEqual([]);
  expect((await f.call('board', { type: 'kanban-methods', action: 'list' })).value).toEqual([]);
  expect(await f.call('board', { type: 'kanban-bridge', nonce: before.kanban.preview.nonce,
    requestId: 'stale-operation', call: { operation: 'runtime.getLocale', input: {} } })).toMatchObject({
    ok: false, error: { code: 'KANBAN_BRIDGE_SESSION_INVALID' },
  });
});

it('keeps the current Web application connected when another configuration is saved', async () => {
  const changed = vi.fn();
  const f = await fixture({ webApp: true, configurationChanged: changed });
  const initial = (await f.state('board')).configurations;
  await f.call('board', { type: 'project-configuration', call: { action: 'create', revision: initial.revision, name: 'Online' } });
  let state = (await f.state('board')).configurations;
  const online = state.configurations.find((item: any) => item.name === 'Online');
  await f.call('board', { type: 'project-configuration', call: { action: 'select', revision: state.revision, id: initial.activeConfigurationId } });
  await f.app.setHostWebApps({ board: { service: 'sample.app', apiBaseUrl: 'https://service.invalid/api', bootstrap: { token: 'current-scope' } } });
  const before = await f.state('board'), url = before.kanban.preview.url;
  changed.mockClear();
  await f.call('board', { type: 'project-configuration', call: { action: 'save', revision: before.configurations.revision, id: online.id, values: { label: 'Updated online service' } } });
  state = (await f.state('board')).configurations;
  await f.call('board', { type: 'project-configuration', call: { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: state.configurations.find((item: any) => item.id === state.activeConfigurationId).values } });
  expect(changed).not.toHaveBeenCalled();
  expect((await f.state('board')).kanban.preview.url).toBe(url);
  expect(await (await fetch(url)).text()).toContain('current-scope');
});

it('serves mixed and repeated entry types through one host and isolates drafts, configuration and restored sessions', async () => {
  const f = await fixture();
  expect((await fetch(f.app.origin, { redirect: 'manual' })).headers.get('location')).toBe('/entries/agent/');
  expect((await fetch(`${f.app.origin}/entries/missing/`)).status).toBe(404);
  const a = await f.state('agent'), b = await f.state('assistant');
  expect(a.aggregate.entries.map((entry: any) => entry.entryId)).toEqual(f.entries.map(entry => entry.entryId));
  expect(a.project.id).toBe(b.project.id); expect(a.project.entryId).toBe('agent'); expect(b.project.entryId).toBe('assistant');
  await f.call('agent', { type: 'draft', text: 'Agent draft', attachments: [] });
  await f.call('assistant', { type: 'draft', text: 'Assistant draft', attachments: [] });
  await f.call('agent', { type: 'project-configuration', call: { action: 'save', revision: a.configurations.revision, id: a.configurations.activeConfigurationId, values: { label: 'Only agent' } } });
  expect((await f.state('assistant')).configurations.configurations[0].values).toEqual({ STEAMHARNESS_BOT_MEMORY_ENABLED: true });
  expect((await f.post('assistant', { type: 'draft', applicationId: `${a.project.id}:agent`, text: 'Wrong entry', attachments: [] })).ok).toBe(false);
  await f.reopen();
  const restoredA = await f.state('agent'), restoredB = await f.state('assistant');
  expect(JSON.stringify(restoredA)).toContain('Agent draft'); expect(JSON.stringify(restoredA)).not.toContain('Assistant draft');
  expect(JSON.stringify(restoredB)).toContain('Assistant draft'); expect(JSON.stringify(restoredB)).not.toContain('Agent draft');
  expect(restoredA.configurations.configurations[0].values).toEqual({ label: 'Only agent', STEAMHARNESS_BOT_MEMORY_ENABLED: true });
  expect((await f.state('board')).project.projectType).toBe('kanban');
});

it('keeps parallel entries running while navigating and cancels only the requested entry', async () => {
  const f = await fixture();
  for (const entry of ['agent', 'assistant']) await f.call(entry, { type: 'send', text: entry, params: {}, attachments: [] });
  await vi.waitFor(() => expect(f.active.size).toBe(2));
  await fetch(f.app.entryUrl('board')); await f.state('workflow');
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  await f.call('agent', { type: 'stop' });
  await vi.waitFor(() => expect(f.runtime.cancel).toHaveBeenCalledWith(f.active.get('agent')!.runId));
  expect(f.runtime.cancel).not.toHaveBeenCalledWith(f.active.get('assistant')!.runId);
  f.active.get('assistant')!.finish({ status: 'success', output: { items: [] } });
});

it('keeps a newly admitted Conversation stable while native history refreshes during parameter resolution', async () => {
  const f = await fixture();
  f.app.project.paramResolver = { enabled: true };
  type Resolved = Awaited<ReturnType<Runtime['resolveParams']>>;
  let finish!: (value: Resolved) => void;
  const preparing = new Promise<Resolved>(resolve => { finish = resolve; });
  vi.mocked(f.runtime.resolveParams).mockReturnValueOnce(preparing);
  const submission = f.app.invokeEntry({ projectId: f.app.project.id, entryId: 'agent', sourceEntryId: 'board', actor: { isSystemAdmin: false },
    action: 'submit', input: { conversationId: 'new-bot-session', requestId: 'new-bot-request', text: 'hello' } });
  // Attach the rejection handler before forcing the historical refresh.
  const receipt = expect(submission).resolves.toMatchObject({ requestId: 'new-bot-request', status: 'accepted' });
  await vi.waitFor(() => expect(f.runtime.resolveParams).toHaveBeenCalled());
  await f.state('agent');
  finish({ params: {} });
  await receipt;
  await vi.waitFor(() => expect(f.runtime.run).toHaveBeenCalledTimes(1));
  f.active.get('agent')!.finish({ status: 'success', output: { items: [] } });
});

it('keeps saved cross-entry Kanban and image card URLs inside their owning aggregate mount', async () => {
  const f = await fixture(), state = await f.state('agent'), board = await f.state('board');
  await writeFile(path.join(f.directory, 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const cards = [
    { cardId: 'map', kind: 'kanban', title: 'Saved map', target: { source: 'local', projectId: state.project.id, entryId: 'board', configurationId: board.configurations.activeConfigurationId } },
    { cardId: 'image', kind: 'file', target: { source: 'local', filePath: 'card.svg' } },
  ];
  f.app.controller!.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: cards.map(output => ({
    metadata: { kind: 'agent-part', partType: 'tool' }, content: { status: 'success', tool: 'workflow-ui_present_card', output: { action: 'upsert', ...output } },
  })) });
  const headers = { Authorization: `Bearer ${new URLSearchParams(new URL(f.app.url).hash.slice(1)).get('session')}` };
  for (const card of cards) {
    const preview = await f.call('agent', { type: 'resource', messageId: 'answer', cardId: card.cardId, action: 'inline' });
    expect(preview.url).toMatch(/^\/entries\/agent\/resource\//);
    expect((await fetch(new URL(preview.url, f.app.origin), { headers })).status).toBe(200);
    const data = (await f.call('agent', { type: 'resource-data', id: preview.id })).data;
    const assetUrl = data.kanban?.url ?? data.content;
    expect(assetUrl).toMatch(/^\/entries\/agent\/(?:kanban|resource-assets)\//);
    const asset = await fetch(new URL(assetUrl, f.app.origin), { headers });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain(card.cardId === 'map' ? '<title>Board</title>' : '<svg');
    // This was the URL emitted before mount-aware resource previews.
    const unmounted = await fetch(new URL(assetUrl.replace('/entries/agent', ''), f.app.origin), { headers });
    expect(unmounted.status).toBe(404); expect(await unmounted.text()).toBe('Unknown project entry.');
  }
});

it('routes nonce-bound Kanban operations to the aggregate Workflow and streams the native Conversation identity', async () => {
  const f=await fixture();
  const board=await f.state('board'), native=await f.state('agent');
  const nonce=board.kanban.preview.nonce, conversationId=native.activeId;
  const original=vi.mocked(f.runtime.run).getMockImplementation()!;
  vi.mocked(f.runtime.run).mockImplementation(async (request,emit) => request.project.entryId==='workflow'
    ? {status:'success',result:{ok:true,data:{output:{errCode:0,errMessage:'',data:'receipt'}}}} as Report
    : original(request,emit));
  // Read the same controller selected by the native Conversation page.
  const bridge=(operation:string,input:Record<string,unknown>)=>f.call('board',{type:'kanban-bridge',nonce,requestId:randomUUID(),call:{requestId:randomUUID(),operation,input}});
  const reply=await bridge('entries.runEntrypoint',{entryId:'workflow',entrypointId:'operation',args:[],requestId:'api-call'});
  expect(reply).toMatchObject({type:'kanban-bridge-result',ok:true,value:{data:'receipt'}});
  expect(vi.mocked(f.runtime.run).mock.calls.at(-1)![0]).toMatchObject({entryCall:{entryId:'board'},project:{entryId:'workflow'}});
  await f.call('agent',{type:'send',text:'native text',params:{},attachments:[],requestId:randomUUID()});
  await vi.waitFor(()=>expect(f.active.has('agent')).toBe(true));
  const read=await bridge('conversations.snapshot',{entryId:'agent',conversationId});
  expect(read).toMatchObject({ok:true,value:{entryId:'agent',conversationId,running:true,messages:[{role:'user',content:'native text'},{role:'assistant',requestId:f.active.get('agent')!.runId}]}});
  const invalid=await f.call('board',{type:'kanban-bridge',nonce:'old',requestId:randomUUID(),call:{requestId:'old',operation:'conversations.snapshot',input:{entryId:'agent',conversationId}}});
  expect(invalid.ok).toBe(false);
  f.active.get('agent')!.finish({status:'success',output:{items:[]}});
});


it('serves a child Kanban HTML, JavaScript and CSS from aggregate dist over HTTP', async () => {
  const f = await fixture(), state = await f.state('board');
  const headers = { Authorization: `Bearer ${new URLSearchParams(new URL(f.app.url).hash.slice(1)).get('session')}` };
  const htmlUrl = new URL(state.kanban.preview.url, f.app.origin);
  const html = await fetch(htmlUrl, { headers });
  expect(html.status).toBe(200);
  expect(html.headers.get('content-type')).toContain('text/html');
  expect(await html.text()).toContain('src="board.js"');
  for (const [asset, content, mime] of [['board.js', 'dataset.loaded', 'javascript'], ['board.css', 'color: teal', 'text/css']]) {
    const response = await fetch(new URL(asset, htmlUrl), { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(mime);
    expect(await response.text()).toContain(content);
  }
  expect((await fetch(new URL('steamharness.json', htmlUrl), { headers })).status).toBe(404);
});

it('discovers local entries and embeds one existing controller without exposing other sessions or project configuration', async () => {
  const f = await fixture();
  const privateKey = 'native-model-secret-for-test';
  await f.app.setHostUserSettings({ agent: { permissionPolicy: 'read-only', models: [{ id: 'native-model', name: 'Native model', source: 'third-party',
    apiKind: 'openai-completions', model: 'native-test', apiKey: privateKey, baseUrl: 'http://127.0.0.1:1/v1' }] } });
  const board = await f.state('board');
  const bridge = async (operation: string, input: object) => f.call('board', { type: 'kanban-bridge', nonce: board.kanban.preview.nonce,
    call: { requestId: randomUUID(), operation, input } });
  const listed = await bridge('entries.list', {});
  expect(listed.value.map((entry: any) => entry.entryId)).toEqual(f.entries.map(entry => entry.entryId));
  const agent = await f.state('agent');
  const viewId = 'view-isolated', conversationId = 'bot-private-workbench';
  const opened = await bridge('conversations.openView', { viewId, entryId: 'agent', conversationId, draft: `Native draft ${privateKey}` });
  expect(opened.ok).toBe(true);
  expect(opened.value.html).toContain('steamharness-conversation-view');
  expect(opened.value.html).not.toContain(new URLSearchParams(new URL(f.app.url).hash.slice(1)).get('session'));
  // A profile check advances the check epoch without changing the identity.
  await f.call('agent', { type: 'verify' });
  const ready = await bridge('conversations.viewMessage', { viewId, message: { type: 'ready' } });
  const snapshot = ready.value.find((message: any) => message.type === 'state');
  expect(snapshot.activeId).toBe(conversationId);
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0].draft.text).toContain('Native draft');
  expect(JSON.stringify(snapshot)).not.toContain(privateKey);
  expect(snapshot.configurations).toBeUndefined();
  for (const message of [{ type: 'send', sessionId: agent.activeId, text: 'Forged', params: {} }, { type: 'project-configuration', call: { action: 'save' } }])
    expect((await bridge('conversations.viewMessage', { viewId, message })).ok).toBe(false);
  await bridge('conversations.closeView', { viewId });
  expect((await bridge('conversations.viewMessage', { viewId, message: { type: 'ready' } })).error.code).toBe('KANBAN_BRIDGE_SESSION_INVALID');
  await bridge('conversations.openView', { viewId, entryId: 'agent', conversationId });
  const resolved = await bridge('conversations.viewMessage', { viewId, message: { type: 'resolve', params: {} } });
  expect(resolved.ok).toBe(true);
  expect(resolved.value.find((message: any) => message.type === 'params')?.error).toBeUndefined();
  const otherId = 'another-native-view';
  await bridge('conversations.openView', { viewId: otherId, entryId: 'agent', conversationId });
  expect((await bridge('conversations.viewMessage', { viewId: otherId, message: { type: 'resolve', params: {} } })).ok).toBe(true);
  await bridge('conversations.closeView', { viewId: otherId });
  await bridge('conversations.closeView', { viewId });
  const native = await f.state('agent');
  expect(native.sessions.find((session: any) => session.id === conversationId).draft.text).toBe(snapshot.sessions[0].draft.text);
  expect(native.sessions.some((session: any) => session.id === agent.activeId)).toBe(true);
});

it('returns all authorized Workflow receipts to an embedded composer without waiting for models', async () => {
  const f = await fixture(), board = await f.state('board');
  const receipts = [{ id: 'durable-1', conversationId: 'researcher-session', status: 'queued', botId: 'researcher' },
    { id: 'durable-2', conversationId: 'executor-session', status: 'queued', botId: 'executor' }];
  vi.mocked(f.runtime.run).mockResolvedValueOnce({ status: 'success', result: { ok: true,
    data: { output: { data: { errCode: 0, errMessage: '', data: receipts } } } } } as Report);
  const bridge = (operation: string, input: object) => f.call('board', { type: 'kanban-bridge', nonce: board.kanban.preview.nonce,
    call: { requestId: randomUUID(), operation, input } });
  const viewId = 'multi-bot-composer';
  expect((await bridge('conversations.openView', { viewId, entryId: 'agent', conversationId: 'composer-session', ui: { presentation: 'composer' },
    submit: { entryId: 'workflow', entrypointId: 'operation', payload: { threadId: 'topic' } } })).ok).toBe(true);
  const sent = await bridge('conversations.viewMessage', { viewId, message: { type: 'send', text: '@bot:all review', params: {}, requestId: 'stable-submission' } });
  expect(sent.ok, JSON.stringify(sent)).toBe(true);
  expect(sent.value.find((message: any) => message.type === 'sent')).toMatchObject({ requestId: 'stable-submission', receiptId: 'durable-1', external: true, submissionResult: receipts });
  const request = vi.mocked(f.runtime.run).mock.calls.at(-1)![0];
  expect(request.entryCall).toMatchObject({ entryId: 'board' });
  expect(request.args).toContain(JSON.stringify({ threadId: 'topic', conversationId: 'composer-session', text: '@bot:all review', params: {}, requestId: 'stable-submission' }));
  await bridge('conversations.closeView', { viewId });
});

it('shows a Workflow business rejection and links embedded send failures to Kanban diagnostics', async () => {
  const f = await fixture(), board = await f.state('board');
  const bridge = (operation: string, input: object) => f.call('board', { type: 'kanban-bridge', nonce: board.kanban.preview.nonce,
    call: { requestId: randomUUID(), operation, input } });
  const viewId = 'rejected-composer';
  expect((await bridge('conversations.openView', { viewId, entryId: 'agent', conversationId: 'composer-session',
    submit: { entryId: 'workflow', entrypointId: 'operation', payload: { threadId: 'topic' } } })).ok).toBe(true);
  vi.mocked(f.runtime.run).mockResolvedValueOnce({ status: 'success', result: { data: { output: { data: {
    errCode: 409, errMessage: '请先恢复对话，再继续运行。',
  } } } } } as Report);
  const rejected = await bridge('conversations.viewMessage', { viewId, message: { type: 'send', text: 'Continue', params: {}, requestId: 'rejected' } });
  expect(rejected).toMatchObject({ ok: false, error: { code: 'KANBAN_SUBMISSION_REJECTED', detail: '请先恢复对话，再继续运行。', diagnosticId: expect.any(String) } });
  const diagnostics = await f.call('board', { type: 'kanban-diagnostics' });
  expect(diagnostics.value.requests).toContainEqual(expect.objectContaining({
    operation: 'conversations.viewMessage', diagnosticId: rejected.error.diagnosticId, ok: false,
    error: expect.objectContaining({ code: 'KANBAN_SUBMISSION_REJECTED' }),
  }));
  vi.mocked(f.runtime.run).mockResolvedValueOnce({ status: 'success', result: { data: { output: { data: { errCode: 0, errMessage: '', data: [] } } } } } as Report);
  const invalid = await bridge('conversations.viewMessage', { viewId, message: { type: 'send', text: 'Continue', params: {}, requestId: 'invalid' } });
  expect(invalid).toMatchObject({ ok: false, error: { code: 'KANBAN_SUBMISSION_INVALID_RECEIPT' } });
  await bridge('conversations.closeView', { viewId });
});

it('lets same-page views share a session writer and retains it until the final view closes', async () => {
  const f = await fixture(), board = await f.state('board');
  const bridge = (operation: string, input: object) => f.call('board', { type: 'kanban-bridge', nonce: board.kanban.preview.nonce,
    call: { requestId: randomUUID(), operation, input } });
  const open = (viewId: string) => bridge('conversations.openView', { viewId, entryId: 'agent', conversationId: 'same-topic' });
  const state = async (viewId: string) => {
    const result = await bridge('conversations.viewMessage', { viewId, message: { type: 'ready' } });
    expect(result.ok).toBe(true); return result.value.find((message: any) => message.type === 'state');
  };
  expect((await open('group-composer')).ok).toBe(true);
  expect((await open('focused-bot')).ok).toBe(true);
  expect(await state('group-composer')).toMatchObject({ conversationAccess: { readOnly: false } });
  expect(await state('focused-bot')).toMatchObject({ conversationAccess: { readOnly: false } });
  await bridge('conversations.closeView', { viewId: 'group-composer' });
  expect(await state('focused-bot')).toMatchObject({ conversationAccess: { readOnly: false } });
  await bridge('conversations.closeView', { viewId: 'focused-bot' });
  expect((await open('restored-bot')).ok).toBe(true);
  expect(await state('restored-bot')).toMatchObject({ conversationAccess: { readOnly: false } });
});

it.each([
  { id: undefined, platform: undefined }, { id: 'local-draft', platform: false }, { id: randomUUID(), platform: true },
])('runs every local entry and restores history without contacting the platform (platform UI: $platform)', async ({ id, platform }) => {
  const nativeFetch = globalThis.fetch, remote: string[] = [];
  const server = 'https://record-platform.test';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (new URL(String(input)).hostname === '127.0.0.1') return nativeFetch(input, init);
    remote.push(String(input)); return Response.json({ errCode: 500 }, { status: 500 });
  });
  const f = await fixture({ id, platform, savedServer: server });
  const bot = await f.state('agent'), workflow = await f.state('workflow'), board = await f.state('board');
  for (const state of [bot, workflow, board]) {
    expect(state.serverData).toBeUndefined();
    expect(state.project.id).toBe(bot.project.id);
  }
  await f.call('agent', { type: 'send', text: 'Run offline', params: {}, attachments: [] });
  await f.call('workflow', { type: 'workflow-run', entrypointId: 'operation', params: {} });
  await vi.waitFor(() => expect(f.active.has('agent') && f.active.has('workflow')).toBe(true));
  const preview = await fetch(new URL(board.kanban.preview.url, f.app.origin), { headers: { Authorization: `Bearer ${new URLSearchParams(new URL(f.app.url).hash.slice(1)).get('session')}` } });
  expect(preview.status).toBe(200);
  expect(JSON.parse(await readFile(path.join(f.directory, 'steamharness.json'), 'utf8')).id).toBe(id);
  for (const operation of f.active.values()) operation.finish({ status: 'success', output: { items: [] } });
  await vi.waitFor(async () => {
    expect((await f.state('workflow')).running).toBe(false);
    expect((await f.state('agent')).running).toBe(false);
  });
  await f.reopen();
  expect((await f.state('agent')).sessions[0].messages.map((message: { content: string }) => message.content)).toContain('Run offline');
  expect((await f.state('workflow')).runs.length).toBeGreaterThan(0);
  expect(remote).toEqual([]);
});
