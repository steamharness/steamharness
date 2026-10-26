import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectServerConnection, checkProjectServer, checkProjectStorageFailure, projectServerAccessFailure } from '../web/project-server-state';
import { ProjectServerCreation } from '../web/project-server-create';
import { startWebServer } from '../web/server';
import { readProjectInfo } from '../web/kanban-data';
import type { Project, Runtime } from '../web/workflow-types';

const id = 'aaa10f6d-c322-461a-aecd-56d644d227c5';
const connection = { serverUrl: 'https://project.test', accessToken: 'private-token' };
const account = { status: 'authenticated' as const, serverUrl: connection.serverUrl, revision: 1 };
const nativeFetch = globalThis.fetch;
const ok = () => new Response(JSON.stringify({ errCode: 0, data: { id } }));
const services: Awaited<ReturnType<typeof startWebServer>>[] = [], folders: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each([[401, 'sign-in-required'], [403, 'access-denied'], [404, 'project-unavailable'], [409, 'setup-required']] as const)(
  'pauses checks for HTTP %s until an explicit recheck and never writes project data', async (status, kind) => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private error details', { status }));
    const monitor = new ProjectServerConnection(id, () => connection, vi.fn());
    try {
      monitor.authenticationChanged(account); await monitor.refresh();
      expect(monitor.state).toEqual({ checking: false, issue: { kind, serverUrl: connection.serverUrl } });
      await expect(monitor.assertReady()).rejects.toThrow('Check again');
      await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledOnce();
      fetcher.mockResolvedValue(ok()); await monitor.refresh();
      await expect(monitor.assertReady()).resolves.toBeUndefined();
      expect(monitor.state).toEqual({ checking: false, issue: undefined });
      for (const [url, options] of fetcher.mock.calls) {
        expect(String(url)).toBe(`${connection.serverUrl}/api/projects/${id}`);
        expect(options?.method ?? 'GET').toBe('GET'); expect(options?.body).toBeUndefined();
        expect(options?.redirect).toBe('error');
      }
      expect(JSON.stringify(monitor.state)).not.toMatch(/private-token|private error/);
    } finally { monitor.close(); }
  },
);

it.each([408, 429, 503, 'network', 'body-interrupted'] as const)('retries temporary %s failures and cancels checks on close', async status => {
  vi.useFakeTimers();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  if (status === 'network') fetcher.mockRejectedValue(new Error('private network detail'));
  else if (status === 'body-interrupted') fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Connection terminated while reading JSON')); } })));
  else fetcher.mockResolvedValue(new Response('', { status }));
  const monitor = new ProjectServerConnection(id, () => connection, vi.fn());
  monitor.authenticationChanged(account); await monitor.refresh();
  expect(monitor.state.issue?.kind).toBe('connection-unavailable');
  fetcher.mockResolvedValue(ok()); await vi.advanceTimersByTimeAsync(5_000);
  expect(monitor.state.issue).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(2);
  monitor.close(); await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(2);
});

it('rejects wrong Server responses and keeps stale account results out of current state', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>wrong service</html>'));
  expect((await checkProjectServer(id, connection, new AbortController().signal))?.kind).toBe('setup-required');
  fetcher.mockResolvedValue(new Response(JSON.stringify({ errCode: 0, data: { id: 'another-project' } })));
  expect((await checkProjectServer(id, connection, new AbortController().signal))?.kind).toBe('setup-required');
  let finish!: (value: Response) => void, signal: AbortSignal | undefined;
  fetcher.mockImplementationOnce(async (_url, options) => {
    signal = options?.signal as AbortSignal;
    return new Promise(resolve => { finish = resolve; });
  }).mockImplementationOnce(async () => ok());
  let active = connection;
  const monitor = new ProjectServerConnection(id, () => active, vi.fn());
  try {
    monitor.authenticationChanged(account);
    const oldCheck = monitor.refresh(), oldRun = expect(monitor.assertReady()).rejects.toThrow('Check again');
    active = { serverUrl: 'https://new.test', accessToken: 'new-private-token' };
    monitor.authenticationChanged({ ...account, serverUrl: active.serverUrl }); await monitor.refresh();
    expect(signal!.aborted).toBe(true);
    finish(new Response('', { status: 404 })); await oldCheck; await oldRun;
    expect(monitor.state).toEqual({ checking: false, issue: undefined });
  } finally { monitor.close(); }
});

it('accepts canonical UUID casing and an unchanged connection refreshed by the account poll', async () => {
  let active = connection, finish!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
  const monitor = new ProjectServerConnection(id.toUpperCase(), () => active, vi.fn());
  try {
    monitor.authenticationChanged(account);
    const run = monitor.assertReady(); active = { ...connection }; finish(ok());
    await expect(run).resolves.toBeUndefined(); expect(monitor.ready).toBe(true);
  } finally { monitor.close(); }
});

async function fixture(kind: 'workflow' | 'conversation', mode: 'local' | 'both' | 'server') {
  const folderPath = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-server-'))); folders.push(folderPath);
  const pkg = { id, name: 'Project', steamHarness: { projectType: kind, projectInfo: { dataStorage: { mode } } } };
  await writeFile(path.join(folderPath, 'package.json'), JSON.stringify(pkg));
  const project: Project = { id, uri: `file://${folderPath}`, folderPath, name: 'Project', projectType: kind,
    fields: [{ name: 'subject', flag: '--subject', type: 'string' }], entrypoints: [], projectInfo: readProjectInfo(pkg) };
  const runtime: Runtime = { available: true, inspect: vi.fn(async () => ({ projects: [project], errors: [] })),
    resolveParams: vi.fn(async () => ({ params: {} })), run: vi.fn(async () => ({ status: 'success' })),
    uploadFiles: vi.fn(async () => []), readFile: vi.fn(), readResource: vi.fn(), deleteFiles: vi.fn(), deleteConversation: vi.fn(), cancelConversation: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
  let status = 404, onRead: ((url: string, options?: RequestInit) => Promise<Response>) | undefined;
  const remote = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (!String(url).startsWith(connection.serverUrl)) return nativeFetch(url, options);
    remote(url, options);
    if (String(url).endsWith('/api/auth/me')) return new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'user', email: 'user@test.com', displayName: 'User' } } }));
    if (onRead) return onRead(String(url), options);
    return status === 200 ? ok() : new Response('private upstream error', { status });
  });
  const app = await startWebServer({ projectDir: folderPath, dataDir: path.join(folderPath, 'data'), runtime, host: { surface: 'editor', connection } }); services.push(app);
  const token = new URL(app.url).hash.slice('#session='.length);
  const post = (message: object) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  const state = async () => (await post({ type: 'ready' }).then(response => response.json())).messages[0];
  return { app, runtime, project, post, state, remote, recover: () => { status = 200; }, hold: (read: (url: string, options?: RequestInit) => Promise<Response>) => { onRead = read; } };
}

it.each(['workflow', 'conversation'] as const)('guides %s setup, preserves drafts, and requires an explicit run after recovery', async kind => {
  const f = await fixture(kind, 'server');
  await vi.waitFor(async () => expect((await f.state()).serverData?.issue?.kind).toBe('project-unavailable'));
  const draft = kind === 'workflow' ? { type: 'workflow-draft', params: { subject: 'Keep this draft' } } : { type: 'draft', text: 'Keep this draft', attachments: [] };
  expect((await f.post(draft)).ok).toBe(true);
  const action = kind === 'workflow' ? { type: 'workflow-run', params: { subject: 'Run' } } : { type: 'send', text: 'Run', params: {}, attachments: [] };
  expect((await f.post(action)).status).toBe(400);
  expect(f.runtime.run).not.toHaveBeenCalled(); expect(f.runtime.resolveParams).not.toHaveBeenCalled();
  const saved = await f.state();
  if (kind === 'workflow') { expect(saved.drafts[''].values.subject).toBe('Keep this draft'); expect(saved.runs).toEqual([]); }
  else { expect(saved.sessions[0].draft.text).toBe('Keep this draft'); expect(saved.sessions[0].messages).toEqual([]); }
  expect((await f.post({ type: kind === 'workflow' ? 'workflow-stop' : 'stop' })).ok).toBe(true);
  f.recover(); const check = await f.post({ type: 'project-server-check' }).then(response => response.json());
  expect(check.messages[0].serverData).toEqual({ checking: false });
  expect(f.runtime.run).not.toHaveBeenCalled();
  if (kind === 'workflow') expect((await f.state()).drafts[''].values.subject).toBe('Keep this draft');
  else expect((await f.state()).sessions[0].draft.text).toBe('Keep this draft');
  expect(f.remote.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  expect((await f.post(action)).ok).toBe(true);
  await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
  expect(f.runtime.run).toHaveBeenCalledOnce();
});

const relatedId = '78648759-bcde-4fd5-b3bd-9a2dd46a7192';
const grant = { read: { mode: 'all' as const }, write: { mode: 'none' as const } };
const accessMetadata = () => ({ code: 'PROJECT_SERVER_ACCESS_FAILED', serverUrl: connection.serverUrl, projectId: relatedId,
  consumerProjectId: id, relatedProjectAlias: 'database', status: 404, storageKind: 'kv', operation: 'get', key: '@index/knowledge.v1' });

it.each(['workflow', 'conversation'] as const)('guides real related Server failures in a both-storage %s without requiring a Server for local work', async kind => {
  const f = await fixture(kind, 'both');
  f.project.projectInfo!.relatedProjects = [{ alias: 'database', projectId: relatedId, grantToRelatedProject: grant }];
  const run = vi.spyOn(f.runtime, 'run').mockResolvedValueOnce({ status: 'failed', error: { message: 'Project or group does not exist.', metadata: accessMetadata() } });
  const action = kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'read database', params: {}, attachments: [] };
  await f.post(action); await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
  await vi.waitFor(async () => expect((await f.state()).serverData?.issue?.kind).toBe('project-unavailable'));
  expect((await f.state()).serverData.blocking).toBe(false);
  expect((await f.state()).serverData.issue.projectId).toBeUndefined(); // Consumer is missing; do not guess it is database.
  expect(f.remote.mock.calls.some(([url]) => String(url).endsWith(relatedId))).toBe(false);
  f.hold(async url => url.endsWith(id) ? new Response(JSON.stringify({ errCode: 0, data: { id, projectInfo: f.project.projectInfo } })) : new Response('', { status: 404 }));
  await f.post({ type: 'project-server-check' });
  expect((await f.state()).serverData.issue).toMatchObject({ kind: 'project-unavailable', projectId: relatedId, relatedProjectAlias: 'database' });
  const create = await f.post({ type: 'project-server-create-prepare' }); expect(create.status).toBe(400);
  expect(f.remote.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  // An unrelated local entrypoint remains a deliberate user action, never a replay.
  run.mockResolvedValue({ status: 'success' }); await f.post(action);
  await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
  expect(run).toHaveBeenCalledTimes(2);
});

it('distinguishes a missing related declaration or grant from missing project records', async () => {
  const f = await fixture('conversation', 'both');
  f.project.projectInfo!.relatedProjects = [{ alias: 'database', projectId: relatedId, grantToRelatedProject: grant }];
  vi.spyOn(f.runtime, 'run').mockResolvedValueOnce({ status: 'failed', result: { error: { message: 'unavailable', metadata: accessMetadata() } } });
  let confirmed = false;
  f.hold(async url => new Response(JSON.stringify({ errCode: 0, data: url.endsWith('/api/project-storage') ? { exists: false } : { id: url.endsWith(id) ? id : relatedId, projectInfo: url.endsWith(id) ? f.project.projectInfo : {
    ...f.project.projectInfo, relatedProjects: confirmed ? [{ alias: 'agent', projectId: id, grantToRelatedProject: grant }] : [],
  } } })));
  await f.post({ type: 'send', text: 'read', params: {}, attachments: [] }); await f.app.controller.idle();
  await vi.waitFor(async () => expect((await f.state()).serverData?.issue?.kind).toBe('related-setup-required'));
  expect((await f.state()).serverData.issue.projectId).toBe(relatedId);
  await f.post({ type: 'project-server-check' }); expect((await f.state()).serverData.issue.kind).toBe('related-setup-required');
  confirmed = true; await f.post({ type: 'project-server-check' }); expect((await f.state()).serverData.issue).toBeUndefined();
  expect(f.runtime.run).toHaveBeenCalledOnce();
});

it.each(['workflow', 'conversation'] as const)('updates %s guidance live after import and revalidates local UUIDs on recheck', async kind => {
  const f = await fixture(kind, 'both');
  f.project.projectInfo!.relatedProjects = [{ alias: 'database', projectId: relatedId, grantToRelatedProject: grant }];
  vi.mocked(f.runtime.run).mockResolvedValueOnce({ status: 'failed', error: { message: 'Related data unavailable', metadata: accessMetadata() } });
  f.hold(async url => Response.json({ errCode: 0, data: { id: url.endsWith(id) ? id : relatedId,
    projectInfo: url.endsWith(id) ? f.project.projectInfo : { dataStorage: { mode: 'both' }, relatedProjects: [] } } }));
  await f.post(kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'read', params: {}, attachments: [] });
  await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
  await vi.waitFor(async () => expect((await f.state()).serverData?.issue).toMatchObject({ kind: 'related-setup-required', relatedProjectImported: false }));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'related-import-')); folders.push(targetDir);
  await writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ id: relatedId.toUpperCase() }));
  const token = new URL(f.app.url).hash.slice('#session='.length);
  const events = await fetch(`${f.app.origin}/api/events?session=${token}`, { signal: AbortSignal.timeout(5_000) });
  const reader = events.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  const untilImported = async (imported: boolean) => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end < 0) { const chunk = await reader.read(); if (chunk.done) throw new Error('Event stream ended'); buffer += decoder.decode(chunk.value, { stream: true }); continue; }
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (data && JSON.parse(data.slice(6)).serverData?.issue?.relatedProjectImported === imported) return;
    }
  };
  try {
    await untilImported(false);
    await f.app.setHostRelatedProjects([{ alias: 'database', projectDir: targetDir }]);
    await untilImported(true);
    expect((await f.state()).serverData.issue.kind).toBe('related-setup-required'); // Importing never grants data access.
    await writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ id }));
    const changed = await f.post({ type: 'project-server-check' }).then(response => response.json());
    expect(changed.messages[0].serverData.issue.relatedProjectImported).toBe(false);
    await writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ id: relatedId }));
    const restored = await f.post({ type: 'project-server-check' }).then(response => response.json());
    expect(restored.messages[0].serverData.issue.relatedProjectImported).toBe(true);
    await f.app.setHostRelatedProjects([]); await untilImported(false);
    expect(JSON.stringify((await f.state()).serverData)).not.toContain(targetDir);
    expect(f.runtime.run).toHaveBeenCalledOnce();
    expect(f.remote.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  } finally { await reader.cancel(); }
});

it.each(['workflow', 'conversation'] as const)('guides a missing local %s import without requiring Server diagnostics or replaying the failed run', async kind => {
  const f = await fixture(kind, 'local');
  f.project.projectInfo!.relatedProjects = [{ alias: 'database', projectId: relatedId, grantToRelatedProject: grant }];
  vi.mocked(f.runtime.run).mockResolvedValueOnce({ status: 'failed', error: { message: 'Unavailable or awaiting confirmation', metadata: { code: 'RELATED_PROJECT_UNAVAILABLE', alias: 'database' } } });
  await f.post(kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'read', params: {}, attachments: [] });
  await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
  const missing = await f.state();
  expect(missing.serverData).toMatchObject({ blocking: false, issue: { kind: 'related-import-required', projectId: relatedId, relatedProjectImported: false } });
  expect(missing.serverData.issue.serverUrl).toBeUndefined();
  await f.post({ type: 'project-server-check' });
  expect((await f.state()).serverData.issue.relatedProjectImported).toBe(false);
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'local-related-import-')); folders.push(targetDir);
  await writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ id: relatedId }));
  await f.app.setHostRelatedProjects([{ alias: 'database', projectDir: targetDir }]);
  expect((await f.state()).serverData.issue).toMatchObject({ kind: 'related-import-required', relatedProjectImported: true });
  await f.post({ type: 'project-server-check' });
  expect((await f.state()).serverData).toBeUndefined();
  expect(f.runtime.run).toHaveBeenCalledOnce();
  expect(f.remote.mock.calls.some(([url]) => String(url).includes('/api/projects/'))).toBe(false);
});

it.each([[404, 'setup-required'], [403, 'access-denied'], [503, 'connection-unavailable']] as const)('keeps data endpoint HTTP %s visible after project records and grants pass', async (status, kind) => {
  const f = await fixture('workflow', 'both');
  f.project.projectInfo!.relatedProjects = [{ alias: 'database', projectId: relatedId, grantToRelatedProject: grant }];
  f.hold(async (url, options) => {
    if (url.endsWith('/api/project-storage')) {
      expect(JSON.parse(String(options?.body))).toEqual({ consumerProjectId: id, alias: 'database', storageKind: 'kv', operation: 'get', entry: { scope: 'project', key: '@index/knowledge.v1' } });
      return new Response('', { status });
    }
    return new Response(JSON.stringify({ errCode: 0, data: { id: url.endsWith(id) ? id : relatedId,
      projectInfo: url.endsWith(id) ? f.project.projectInfo : { dataStorage: { mode: 'both' }, relatedProjects: [{ alias: 'agent', projectId: id, grantToRelatedProject: grant }] } } }));
  });
  const failure = projectServerAccessFailure(accessMetadata(), f.project, connection)!;
  const result = await checkProjectStorageFailure(id, failure, connection, new AbortController().signal);
  expect(result).toMatchObject({ kind, projectId: relatedId, relatedProjectAlias: 'database' });
  expect(f.remote.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  expect(f.runtime.run).not.toHaveBeenCalled();
});

it('checks current-project reads with a bound project ID and never probes a failed mutation', async () => {
  const f = await fixture('workflow', 'both');
  f.hold(async (url, options) => {
    if (url.endsWith('/api/project-storage')) {
      expect(JSON.parse(String(options?.body))).toEqual({ projectId: id, storageKind: 'kv', operation: 'get', entry: { projectId: id, scope: 'project', key: 'board' } });
      return Response.json({ errCode: 0, data: { exists: false } });
    }
    return Response.json({ errCode: 0, data: { id, projectInfo: f.project.projectInfo } });
  });
  const failure = { projectId: id, serverUrl: connection.serverUrl, storageKind: 'kv' as const, operation: 'get', key: 'board' };
  expect(await checkProjectStorageFailure(id, failure, connection, new AbortController().signal)).toBeUndefined();
  expect(await checkProjectStorageFailure(id, { ...failure, operation: 'set' }, connection, new AbortController().signal)).toBeUndefined();
  expect(f.remote.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

it('does not turn ordinary model errors, foreign Servers, or undeclared IDs into project creation guidance', async () => {
  const f = await fixture('workflow', 'both');
  const metadata = accessMetadata();
  expect(projectServerAccessFailure({ status: 404 }, f.project, connection)).toBeUndefined();
  expect(projectServerAccessFailure(metadata, f.project, connection)).toBeUndefined();
  f.project.projectInfo!.relatedProjects = [{ alias: 'database', projectId: relatedId, grantToRelatedProject: grant }];
  expect(projectServerAccessFailure(metadata, { ...f.project, id: id.toUpperCase() }, connection)).toMatchObject({ projectId: relatedId, relatedProjectAlias: 'database' });
  expect(projectServerAccessFailure({ ...metadata, serverUrl: 'https://other.test' }, f.project, connection)).toBeUndefined();
  expect(projectServerAccessFailure({ ...metadata, consumerProjectId: relatedId }, f.project, connection)).toBeUndefined();
  vi.spyOn(f.runtime, 'run').mockResolvedValueOnce({ status: 'failed', result: { error: { message: 'Project or group does not exist.', metadata: { status: 404 } } } });
  await f.post({ type: 'workflow-run', params: {} }); await f.app.projectController!.idle();
  expect((await f.state()).serverData).toBeUndefined();
  expect(f.remote.mock.calls.every(([url]) => String(url).endsWith('/api/auth/me'))).toBe(true);
});

it.each(['workflow', 'conversation'] as const)('creates a %s record only after confirmation and rechecks without uploading or executing', async kind => {
  const f = await fixture(kind, 'server');
  await vi.waitFor(async () => expect((await f.state()).serverData?.issue?.kind).toBe('project-unavailable'));
  let created = false;
  f.hold(async (url, options) => {
    if (url.includes('/api/groups?')) return new Response(JSON.stringify({ errCode: 0, data: { total: 1, items: [{ id: 'group', name: 'Team' }] } }));
    if (url.endsWith('/api/projects') && options?.method === 'POST') {
      expect(JSON.parse(String(options.body))).toEqual({ name: 'Chosen name', projectId: id, projectType: kind, projectInfo: f.project.projectInfo, groupId: 'group', visibility: 'private' });
      created = true; return new Response(JSON.stringify({ errCode: 0, data: { projectId: id } }), { status: 201 });
    }
    return created ? ok() : new Response('', { status: 404 });
  });
  const prepare = () => f.post({ type: 'project-server-create-prepare' }).then(response => response.json()).then(body => body.messages[0].context);
  const cancelled = await prepare(); expect(created).toBe(false);
  await f.post({ type: 'project-server-create-cancel', token: cancelled.token });
  expect((await f.post({ type: 'project-server-create-confirm', token: cancelled.token, confirmed: true, name: 'Chosen name' })).status).toBe(400);
  const context = await prepare(); expect(context.projectId).toBe(id); expect(JSON.stringify(context)).not.toContain('private-token');
  const confirm = { type: 'project-server-create-confirm', token: context.token, confirmed: true, name: 'Chosen name', groupId: 'group', projectId: relatedId };
  expect((await f.post({ ...confirm, confirmed: false })).status).toBe(400); expect(created).toBe(false);
  expect((await f.post({ ...confirm, groupId: 'forged' })).status).toBe(400); expect(created).toBe(false);
  expect((await f.post(confirm)).ok).toBe(true);
  expect((await f.state()).serverData.issue).toBeUndefined();
  expect((await f.post(confirm)).status).toBe(400);
  expect(f.runtime.run).not.toHaveBeenCalled();
  expect(f.remote.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

it.each(['account', 'manifest', 'expiry'] as const)('rejects project creation after %s changes without writing to the Server', async change => {
  const f = await fixture('workflow', 'server');
  await vi.waitFor(async () => expect((await f.state()).serverData?.issue?.kind).toBe('project-unavailable'));
  f.hold(async url => url.includes('/api/groups?') ? new Response(JSON.stringify({ errCode: 0, data: { items: [], total: 0 } })) : new Response('', { status: 404 }));
  const context = (await f.post({ type: 'project-server-create-prepare' }).then(response => response.json())).messages[0].context;
  if (change === 'account') await f.app.setHostConnection(undefined);
  if (change === 'manifest') await writeFile(path.join(f.project.folderPath, 'package.json'), JSON.stringify({ id: relatedId, steamHarness: { projectType: 'workflow', projectInfo: f.project.projectInfo } }));
  if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  expect((await f.post({ type: 'project-server-create-confirm', token: context.token, confirmed: true, name: 'Reviewed' })).status).toBe(400);
  expect(f.remote.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  expect(f.runtime.run).not.toHaveBeenCalled();
});

it('locks concurrent confirmations before reading the manifest and rejects cancellation during validation', async () => {
  const f = await fixture('workflow', 'both');
  f.hold(async (url, options) => url.includes('/api/groups?')
    ? new Response(JSON.stringify({ errCode: 0, data: { items: [], total: 0 } }))
    : options?.method === 'POST' ? new Response(JSON.stringify({ errCode: 0, data: { projectId: id } })) : new Response('', { status: 404 }));
  const creation = new ProjectServerCreation(f.project, () => connection, () => 'user', () => ({ kind: 'project-unavailable', serverUrl: connection.serverUrl }));
  try {
    const context = await creation.prepare(), input = { token: context.token, confirmed: true, name: 'Reviewed' };
    const results = await Promise.allSettled([creation.confirm(input), creation.confirm(input)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('already in progress');
    expect(f.remote.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    const cancelled = await creation.prepare();
    const pending = creation.confirm({ ...input, token: cancelled.token });
    creation.cancel(cancelled.token);
    await expect(pending).rejects.toThrow('confirmation expired');
    expect(f.remote.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  } finally { creation.close(); }
});

it.each(['workflow', 'conversation'] as const)('keeps local and both storage usable for %s without a Server project', async kind => {
  for (const mode of ['local', 'both'] as const) {
    const f = await fixture(kind, mode);
    expect((await f.state()).serverData).toBeUndefined();
    expect(f.remote.mock.calls.every(([url]) => String(url).endsWith('/api/auth/me'))).toBe(true);
    const action = kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'local run', params: {}, attachments: [] };
    expect((await f.post(action)).ok).toBe(true);
    await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller.idle());
    expect(f.runtime.run).toHaveBeenCalledOnce();
    await f.app.close();
  }
});

it.each(['workflow', 'conversation'] as const)('does not start %s after Stop while a Server check is pending', async kind => {
  const f = await fixture(kind, 'server'); f.recover();
  await f.post({ type: 'project-server-check' });
  let finish!: (response: Response) => void;
  f.hold(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
  if (kind === 'workflow') await f.app.projectController!.start({ params: {} });
  else await f.app.controller.send({ text: 'Run', params: {}, attachments: [] });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect((await f.post({ type: kind === 'workflow' ? 'workflow-stop' : 'stop' })).ok).toBe(true);
  finish(ok()); await new Promise(resolve => setImmediate(resolve));
  expect(f.runtime.run).not.toHaveBeenCalled();
  const state = await f.state();
  expect(kind === 'workflow' ? state.run.status : state.sessions[0].messages.at(-1).status).toBe('aborted');
});
