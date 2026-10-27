import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProjectInfo } from '@steamharness/project-info';
import { startWebServer } from '../web/server';
import type { Project, ProjectKind, Runtime } from '../web/workflow-types';
import type { ProjectServerState } from '../web/project-server-state';
import { ProjectServerCreation } from '../web/project-server-create';
import { DEVELOPER_ASSISTANT_PROJECT_ID } from '../web/assistant-project';

const id = 'aaa10f6d-c322-461a-aecd-56d644d227c5', targetId = '78648759-bcde-4fd5-b3bd-9a2dd46a7192';
const grant = { read: { mode: 'all' }, write: { mode: 'none' } };
const connection = { serverUrl: 'https://startup.test', accessToken: 'private-startup-token' };
const nativeFetch = globalThis.fetch;
const apps: Awaited<ReturnType<typeof startWebServer>>[] = [], folders: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture(kind: ProjectKind, options: { mode?: 'local' | 'both' | 'server'; related?: boolean; imported?: boolean; status?: number; signedOut?: boolean; projectId?: string; assistant?: boolean } = {}) {
  const applicationId = options.projectId ?? id;
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'startup-checks-'))); folders.push(folder);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(folder, 'host'));
  const projectDir = path.join(folder, 'application'), targetDir = path.join(folder, 'database');
  await mkdir(projectDir); await mkdir(targetDir); await mkdir(path.join(projectDir, 'dist'));
  const projectInfo = readProjectInfo({ steamHarness: { projectInfo: { dataStorage: { mode: options.mode ?? 'server' },
    relatedProjects: options.related ? [{ alias: 'database', projectId: targetId, grantToRelatedProject: grant }] : [] } } });
  const targetInfo = readProjectInfo({ steamHarness: { projectInfo: { dataStorage: { mode: 'both' }, relatedProjects: [{ alias: 'application', projectId: applicationId, grantToRelatedProject: grant }] } } });
  const pkg = { id: applicationId, steamHarness: { projectType: kind, projectInfo, kanban: { artifactDir: 'dist', entry: 'index.html' },
    ...(applicationId === DEVELOPER_ASSISTANT_PROJECT_ID ? { builtinRelease: { projectId: 'developer-assistant' } } : {}) } };
  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(projectDir, 'dist/index.html'), '<html><body>Preview</body></html>');
  await writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ id: targetId, steamHarness: { projectInfo: targetInfo } }));
  const project: Project = { id: applicationId, uri: `file://${projectDir}`, folderPath: projectDir, name: 'Application', projectType: kind,
    projectInfo, fields: [], entrypoints: [], ...(kind === 'kanban' ? { kanban: { artifactDir: 'dist', entry: 'index.html' } } : {}) };
  const runtime: Runtime = { available: true, inspect: vi.fn(async () => ({ projects: [project], errors: [] })),
    resolveParams: vi.fn(async () => ({ params: {} })), run: vi.fn(async () => ({ status: 'success' })), kanbanBridge: vi.fn(async () => null),
    uploadFiles: vi.fn(async () => []), readFile: vi.fn(), readResource: vi.fn(), deleteFiles: vi.fn(), deleteConversation: vi.fn(), cancelConversation: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
  const records = new Map<string, { status: number; info: unknown }>([[applicationId, { status: options.status ?? 200, info: projectInfo }], [targetId, { status: 200, info: targetInfo }]]);
  let intercept: ((url: string, init?: RequestInit) => Promise<Response> | undefined) | undefined;
  const remote = vi.fn(async (url: string, init?: RequestInit) => {
    const intercepted = intercept?.(url, init); if (intercepted) return intercepted;
    if (url.endsWith('/api/auth/me')) return Response.json({ errCode: 0, data: { profile: { userId: 'user', email: 'user@example.com', displayName: 'User' } } });
    if (url.endsWith('/related-project-revisions')) return new Response('event: snapshot\ndata: {"resolvedTarget":"draft","revisions":[]}\n\n');
    const recordId = url.split('/').at(-1)!, record = records.get(recordId);
    if (!record || record.status !== 200) return new Response('', { status: record?.status ?? 404 });
    return Response.json({ errCode: 0, data: { id: recordId, projectInfo: record.info } });
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url).startsWith(connection.serverUrl) ? remote(String(url), init) : nativeFetch(url, init));
  const binding = { alias: 'database', projectDir: targetDir };
  const app = await startWebServer({ projectDir, dataDir: path.join(folder, 'data'), runtime,
    host: { surface: options.assistant ? 'assistant' : 'editor', connection: options.signedOut ? undefined : connection, relatedProjects: options.imported ? [binding] : [],
      ...(options.assistant ? { assistantProjectDir: projectDir, assistant: { workdir: targetDir,
        roots: [{ uri: `file://${targetDir}`, folderPath: targetDir, name: 'Workspace' }] } } : {}) } }); apps.push(app);
  const token = new URL(app.url).hash.slice('#session='.length);
  const post = async (message: object) => nativeFetch(`${app.origin}/api/message`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) }).then(response => response.json());
  const state = async () => (await post({ type: 'ready' })).messages[0] as { serverData: ProjectServerState; kanban?: { serverDataIssue?: unknown } };
  const settled = async () => {
    let result!: Awaited<ReturnType<typeof state>>;
    await vi.waitFor(async () => { result = await state(); expect(result.serverData.checking).toBe(false); });
    return result;
  };
  return { app, project, projectDir, pkg, targetDir, targetInfo, binding, runtime, remote, records, post, state, settled,
    intercept: (handler: NonNullable<typeof intercept>) => { intercept = handler; } };
}

it.each(['local', 'both'] as const)('opens the built-in assistant with %s storage without creating a personal Server project, including after logout', async mode => {
  const f = await fixture('conversation', { projectId: DEVELOPER_ASSISTANT_PROJECT_ID, assistant: true, mode, status: 404 });
  const expected = { checking: false, blocking: false, checks: [{ id: 'project', projectId: DEVELOPER_ASSISTANT_PROJECT_ID, stage: 'builtin', status: 'passed' }] };
  expect((await f.settled()).serverData).toEqual(expected);
  await f.post({ type: 'project-server-check' });
  expect((await f.settled()).serverData).toEqual(expected);
  const configuration = await f.post({ type: 'project-configuration', call: { action: 'get' } });
  expect(configuration.messages[0].value.canManagePublication).not.toBe(true);
  expect(configuration.messages[0].value.publication).toBeUndefined();
  await expect(f.app.configurations.dispatch({ action: 'publication.save', revision: configuration.messages[0].value.revision })).rejects.toThrow('online');
  expect(f.remote.mock.calls.every(([url]) => url.endsWith('/api/auth/me'))).toBe(true);
  await f.app.setHostConnection(undefined);
  expect((await f.settled()).serverData).toEqual(expected);
  await f.post({ type: 'send', text: 'Local assistant', params: {}, attachments: [] });
  await f.app.controller.idle();
  expect(f.runtime.run).toHaveBeenCalledOnce();
});

it('opens the built-in assistant without a Server account', async () => {
  const f = await fixture('conversation', { projectId: DEVELOPER_ASSISTANT_PROJECT_ID, assistant: true, mode: 'local', signedOut: true });
  expect((await f.settled()).serverData).toMatchObject({ checking: false, checks: [{ stage: 'builtin', status: 'passed' }] });
  expect((await f.state()).serverData.issue).toBeUndefined();
  expect(f.remote).not.toHaveBeenCalled();
});

it.each([
  { projectId: DEVELOPER_ASSISTANT_PROJECT_ID, mode: 'local' as const },
  { assistant: true, mode: 'local' as const },
  { projectId: DEVELOPER_ASSISTANT_PROJECT_ID, assistant: true, mode: 'server' as const },
  { projectId: DEVELOPER_ASSISTANT_PROJECT_ID, assistant: true, mode: 'local' as const, related: true },
])('keeps ordinary registration checks for non-builtin contexts or declared Server dependencies: %j', async options => {
  const f = await fixture('conversation', { ...options, status: 404 });
  const state = (await f.settled()).serverData;
  expect(state.issue).toMatchObject({ kind: 'project-unavailable' });
  expect(state.checks?.[0]).toMatchObject({ stage: 'registration', status: 'action-required' });
  expect(f.remote.mock.calls.some(([url]) => url.endsWith(`/api/projects/${f.project.id}`))).toBe(true);
});

it.each(['workflow', 'conversation', 'kanban'] as const)('checks %s registration on opening without a message or data request', async kind => {
  const f = await fixture(kind, { status: 404 });
  const state = await f.settled();
  expect(state.serverData).toMatchObject({ checking: false, issue: { kind: 'project-unavailable' },
    checks: [{ id: 'project', status: 'action-required', stage: 'registration' }] });
  for (let index = 0; index < 3; index++) await f.state();
  expect(f.remote.mock.calls.filter(([url]) => url.endsWith(`/api/projects/${id}`))).toHaveLength(1);
  expect(f.remote.mock.calls.some(([url]) => url.includes('related-project-revisions'))).toBe(false);
  expect(f.runtime.run).not.toHaveBeenCalled(); expect(f.runtime.kanbanBridge).not.toHaveBeenCalled();
  expect(f.remote.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET' && init?.body === undefined)).toBe(true);
  expect(JSON.stringify(state.serverData)).not.toContain(connection.accessToken);
});

it.each(['workflow', 'conversation', 'kanban'] as const)('checks %s imports before related registration and updates the checklist after import', async kind => {
  const f = await fixture(kind, { related: true });
  let state = await f.settled();
  expect(state.serverData.checks).toMatchObject([{ status: 'passed' }, { stage: 'import', status: 'action-required',
    issue: { kind: 'related-import-required', relatedProjectImported: false } }]);
  expect(f.remote.mock.calls.some(([url]) => url.endsWith(targetId))).toBe(false);
  f.records.get(targetId)!.status = 404;
  await f.app.setHostRelatedProjects([f.binding]);
  state = await f.settled();
  expect(state.serverData.issue).toMatchObject({ kind: 'project-unavailable', projectId: targetId, relatedProjectImported: true });
  expect(state.serverData.checks?.[1]).toMatchObject({ stage: 'registration', status: 'action-required' });
  f.records.get(targetId)!.status = 200;
  f.records.get(targetId)!.info = { ...f.targetInfo, relatedProjects: [] };
  await f.post({ type: 'project-server-check' }); state = await f.settled();
  expect(state.serverData.checks?.[1]).toMatchObject({ stage: 'relationship', issue: { kind: 'related-setup-required' } });
  f.records.get(targetId)!.info = f.targetInfo;
  await f.post({ type: 'project-server-check' }); state = await f.settled();
  expect(state.serverData.issue).toBeUndefined();
  expect(state.serverData.checks?.map(check => check.status)).toEqual(['passed', 'passed']);
  expect(f.runtime.run).not.toHaveBeenCalled(); expect(f.runtime.kanbanBridge).not.toHaveBeenCalled();
  expect(f.remote.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
});

it.each(['workflow', 'conversation', 'kanban'] as const)('does not block local %s features while showing registration and missing imports in advance', async kind => {
  const f = await fixture(kind, { mode: 'local', related: true, signedOut: true });
  const state = await f.settled();
  expect(state.serverData).toMatchObject({ blocking: false, issue: { kind: 'sign-in-required' },
    checks: [{ status: 'action-required' }, { stage: 'import', status: 'action-required' }] });
  expect(f.remote).not.toHaveBeenCalled();
  if (kind === 'kanban') {
    expect(state.kanban?.serverDataIssue).toBeUndefined();
  } else {
    await f.post(kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'Local operation', params: {}, attachments: [] });
    await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
    expect(f.runtime.run).toHaveBeenCalledOnce();
  }
});

it('cancels stale related checks when an imported folder changes identity', async () => {
  const f = await fixture('conversation', { related: true, imported: true });
  expect((await f.settled()).serverData.issue).toBeUndefined();
  let finish!: (response: Response) => void, signal: AbortSignal | undefined;
  f.intercept((url, init) => url.endsWith(targetId) ? new Promise(resolve => { finish = resolve; signal = init?.signal as AbortSignal; }) : undefined);
  const checking = f.post({ type: 'project-server-check' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await writeFile(path.join(f.targetDir, 'package.json'), JSON.stringify({ id }));
  await f.app.setHostRelatedProjects([f.binding]);
  expect(signal?.aborted).toBe(true);
  finish(new Response('', { status: 404 })); await checking;
  expect((await f.settled()).serverData.issue).toMatchObject({ kind: 'related-import-required', relatedProjectImported: false });
});

it('does not infer required data grants from registration or reject a deliberate restrictive grant', async () => {
  const f = await fixture('workflow', { related: true, imported: true });
  f.records.get(targetId)!.info = { ...f.targetInfo, relatedProjects: [{ alias: 'application', projectId: id,
    grantToRelatedProject: { read: { mode: 'none' }, write: { mode: 'none' } } }] };
  await f.post({ type: 'project-server-check' });
  expect((await f.settled()).serverData.issue).toBeUndefined();
  expect(f.remote.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
});

it.each(['workflow', 'conversation'] as const)('does not repeat a healthy startup pass when running %s later', async kind => {
  const f = await fixture(kind);
  expect((await f.settled()).serverData.issue).toBeUndefined();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  await f.post(kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'A deliberate run', params: {}, attachments: [] });
  await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
  expect(f.runtime.run).toHaveBeenCalledOnce();
  expect(f.remote.mock.calls.filter(([url]) => url.endsWith(`/api/projects/${id}`))).toHaveLength(1);
});

it('keeps drafts editable while an explicit registration recheck is pending', async () => {
  const f = await fixture('conversation'); await f.settled();
  let finish!: (response: Response) => void;
  f.intercept(url => url.endsWith(`/api/projects/${id}`) ? new Promise(resolve => { finish = resolve; }) : undefined);
  const checking = f.post({ type: 'project-server-check' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await f.post({ type: 'draft', text: 'Keep editing during checks', attachments: [] });
  const during = (await f.post({ type: 'ready' })).messages[0];
  expect(during.serverData.checking).toBe(true);
  expect(during.sessions[0].draft.text).toBe('Keep editing during checks');
  finish(Response.json({ errCode: 0, data: { id } })); await checking;
  expect(f.runtime.run).not.toHaveBeenCalled();
});

it('opens only one Kanban revision subscription after each successful check pass', async () => {
  const f = await fixture('kanban'); await f.settled();
  const subscriptions = () => f.remote.mock.calls.filter(([url]) => url.endsWith('/related-project-revisions'));
  await vi.waitFor(() => expect(subscriptions()).toHaveLength(1));
  await f.post({ type: 'kanban-refresh' });
  await vi.waitFor(() => expect(subscriptions()).toHaveLength(2));
  expect(f.remote.mock.calls.filter(([url]) => url.endsWith(`/api/projects/${id}`))).toHaveLength(2);
});

it.each(['workflow', 'conversation'] as const)('rechecks the current %s declarations and storage mode after a local edit', async kind => {
  const f = await fixture(kind, { related: true, imported: true }); await f.settled();
  const info = { ...f.pkg.steamHarness.projectInfo, dataStorage: { mode: 'local' }, relatedProjects: [] };
  await writeFile(path.join(f.projectDir, 'package.json'), JSON.stringify({ ...f.pkg, steamHarness: { ...f.pkg.steamHarness, projectInfo: info } }));
  f.records.get(id)!.status = 404;
  const relatedReads = f.remote.mock.calls.filter(([url]) => url.endsWith(targetId)).length;
  await f.post({ type: 'project-server-check' });
  const state = await f.settled();
  expect(state.serverData).toMatchObject({ blocking: false, issue: { kind: 'project-unavailable' } });
  expect(state.serverData.checks).toHaveLength(1);
  expect(f.app.project.projectInfo?.relatedProjects).toEqual([]);
  expect(f.remote.mock.calls.filter(([url]) => url.endsWith(targetId))).toHaveLength(relatedReads);
  expect(f.runtime.run).not.toHaveBeenCalled();
  await f.post(kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'Local work', params: {}, attachments: [] });
  await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
  expect(f.runtime.run).toHaveBeenCalledOnce();
});

it.each(['id', 'projectType'] as const)('requires reopening after a manifest %s change instead of checking a different identity', async field => {
  const f = await fixture('workflow'); await f.settled();
  const pkg = field === 'id' ? { ...f.pkg, id: targetId } : { ...f.pkg, steamHarness: { ...f.pkg.steamHarness, projectType: 'conversation' } };
  await writeFile(path.join(f.projectDir, 'package.json'), JSON.stringify(pkg));
  f.remote.mockClear();
  const result = await f.post({ type: 'project-server-check' });
  expect(result.message).toContain('Reopen');
  expect(f.app.project).toMatchObject({ id, projectType: 'workflow' });
  expect(f.remote).not.toHaveBeenCalled(); expect(f.runtime.run).not.toHaveBeenCalled();
});

it.each(['workflow', 'conversation', 'kanban'] as const)('allows a local-storage %s to request a new identity without changing storage or uploading', async kind => {
  const f = await fixture(kind, { mode: 'local', status: 404 }); await f.settled();
  const allocatedId = '6903bffe-9938-4a24-824e-7a2b729c9c46';
  f.intercept((url, init) => {
    if (url.includes('/api/groups?')) return Promise.resolve(Response.json({ errCode: 0, data: { items: [], total: 0 } }));
    if (url.endsWith('/api/projects') && init?.method === 'POST') return Promise.resolve(Response.json({ errCode: 0, data: { projectId: allocatedId, projectType: kind } }));
  });
  const creation = new ProjectServerCreation(f.app.project, () => connection, () => 'user', () => f.app.kanbanController?.serverDataIssue ?? { kind: 'project-unavailable' });
  const context = await creation.prepare();
  expect(f.remote.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  expect(await creation.confirm({ token: context.token, confirmed: true, name: 'Local app' })).toBe(allocatedId);
  const request = f.remote.mock.calls.find(([, init]) => init?.method === 'POST')!;
  const body = JSON.parse(String(request[1]?.body));
  expect(body.projectInfo.dataStorage.mode).toBe('local');
  expect(body).not.toHaveProperty('projectId'); expect(body).not.toHaveProperty('files');
  expect(f.runtime.run).not.toHaveBeenCalled();
  creation.close();
});

it('invalidates Server Kanban method instances during checks and rejects stale publication and invocation', async () => {
  const f = await fixture('kanban'); await f.settled();
  const controller = f.app.kanbanController!;
  controller.methods.connect('client');
  const instance = { type: 'kanban-method-state', nonce: controller.preview.nonce, clientId: 'client', instanceId: 'instance', ready: true,
    configurationId: controller.configuration().id, presentation: { mode: 'fullscreen' }, methods: [{ name: 'tasks.list', description: 'List tasks', inputSchema: { type: 'object' }, readOnly: true }] };
  await controller.handle(instance); expect(controller.methods.list()).toHaveLength(1);
  let finish!: (response: Response) => void;
  f.intercept(url => url.endsWith(`/api/projects/${id}`) ? new Promise(resolve => { finish = resolve; }) : undefined);
  const checking = f.post({ type: 'project-server-check' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(controller.methods.list()).toEqual([]);
  await controller.handle(instance); expect(controller.methods.list()).toEqual([]);
  await expect(controller.handle({ type: 'kanban-methods', action: 'invoke', call: { instanceId: 'instance', configurationId: instance.configurationId, method: 'tasks.list', args: {} } })).rejects.toThrow('setup');
  finish(Response.json({ errCode: 0, data: { id } })); await checking;
  expect(f.runtime.kanbanBridge).not.toHaveBeenCalled();
});
