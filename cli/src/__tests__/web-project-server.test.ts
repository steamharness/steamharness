import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectServerConnection, checkProjectServer, projectServerAccessFailure } from '../web/project-server-state';
import { ProjectServerCreation } from '../web/project-server-create';
import { startEntryWebServer as startWebServer } from '../web/server';
import { readProjectInfo } from '../web/kanban-data';
import type { Project, Runtime } from '../web/workflow-types';
import type { ProjectServerCheck, ProjectServerInspector } from '../web/project-server-state';

const id = 'aaa10f6d-c322-461a-aecd-56d644d227c5';
const connection = { serverUrl: 'https://project.test', accessToken: 'private-token' };
const account = { status: 'authenticated' as const, serverUrl: connection.serverUrl, revision: 1 };
const nativeFetch = globalThis.fetch;
const ok = () => new Response(JSON.stringify({ errCode: 0, data: { id, entries: [] } }));
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

it('preserves the completed failure throughout automatic retries and same-account verification', async () => {
  vi.useFakeTimers();
  const issue = { kind: 'connection-unavailable' as const, serverUrl: connection.serverUrl, status: 500 };
  const failed: ProjectServerCheck[] = [{ id: 'project', projectId: id, stage: 'registration', status: 'action-required', issue }];
  let finish!: (checks: ProjectServerCheck[]) => void, calls = 0;
  const inspect: ProjectServerInspector = async () => ++calls === 1 ? failed : new Promise(resolve => { finish = resolve; });
  const changes: boolean[] = [];
  const monitor = new ProjectServerConnection(id, () => connection, () => changes.push(!!monitor.state.issue), { inspect });
  try {
    monitor.authenticationChanged(account); await monitor.settled(); changes.length = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2); expect(monitor.state.checking).toBe(true);
    expect(monitor.state.issue).toBe(issue); expect(monitor.state.checks).toBe(failed);
    monitor.authenticationChanged({ ...account, status: 'checking' });
    monitor.authenticationChanged(account);
    expect(calls).toBe(2); expect(monitor.state.issue).toBe(issue);
    const blocked = expect(monitor.assertReady()).rejects.toThrow('Check again');
    finish(failed); await monitor.settled(); await blocked;
    expect(changes.every(Boolean)).toBe(true);
    const recovered = monitor.refresh();
    finish(failed.map(check => ({ ...check, status: 'passed', issue: undefined })));
    await recovered; expect(monitor.state.issue).toBeUndefined(); expect(monitor.ready).toBe(true);
  } finally { monitor.close(); }
});

it('keeps a verified page ready during a same-account read check but awaits the result before executing', async () => {
  const passed: ProjectServerCheck[] = [{ id: 'project', projectId: id, stage: 'registration', status: 'passed' }];
  let finish!: (checks: ProjectServerCheck[]) => void;
  const inspect = vi.fn<ProjectServerInspector>().mockResolvedValueOnce(passed).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const monitor = new ProjectServerConnection(id, () => connection, vi.fn(), { inspect });
  try {
    monitor.authenticationChanged(account); await monitor.settled();
    monitor.authenticationChanged({ ...account, status: 'checking' });
    expect(monitor.state.checking).toBe(false); expect(monitor.state.checks).toBe(passed);
    monitor.authenticationChanged(account);
    expect(monitor.state.checking).toBe(false);
    let executed = false; const execute = monitor.assertReady().then(() => { executed = true; });
    await Promise.resolve(); expect(executed).toBe(false);
    finish(passed); await execute; expect(executed).toBe(true);
  } finally { monitor.close(); }
});

it('clears the old identity and ignores its late inspector result after switching accounts', async () => {
  let active: typeof connection | undefined = connection, finish!: (checks: ProjectServerCheck[]) => void;
  const issue = { kind: 'setup-required' as const, database: 'old-private-alias' };
  const failed: ProjectServerCheck[] = [{ id: 'old', projectId: id, stage: 'database', status: 'action-required', issue }];
  const inspect = vi.fn<ProjectServerInspector>().mockResolvedValueOnce(failed).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue([]);
  const monitor = new ProjectServerConnection(id, () => active, vi.fn(), { inspect });
  try {
    monitor.authenticationChanged(account); await monitor.settled();
    const old = monitor.refresh(); active = undefined;
    monitor.authenticationChanged({ ...account, status: 'checking', serverUrl: 'https://new.test' });
    expect(monitor.state.issue).toBeUndefined(); expect(monitor.state.checks).toBeUndefined(); expect(monitor.ready).toBe(false);
    active = { serverUrl: 'https://new.test', accessToken: 'new-token' };
    monitor.authenticationChanged({ ...account, serverUrl: active.serverUrl, user: { userId: 'new-user', email: '', displayName: '' } });
    await monitor.settled(); finish(failed); await old;
    expect(monitor.state.checks).toEqual([]); expect(monitor.state.issue).toBeUndefined();
    expect(JSON.stringify(monitor.state)).not.toContain('old-private-alias');
  } finally { monitor.close(); }
});

it('reports safe HTTP and invalid-response diagnostics without exposing Server response bodies', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private database detail', { status: 500 }));
  expect(await checkProjectServer(id, connection, new AbortController().signal)).toMatchObject({ kind: 'connection-unavailable', status: 500 });
  fetcher.mockResolvedValue(new Response(JSON.stringify({ errCode: 0, data: { id: 123, entries: [] } })));
  const issue = await checkProjectServer(id, connection, new AbortController().signal);
  expect(issue).toMatchObject({ kind: 'setup-required', reason: 'invalid-project-response' });
  expect(JSON.stringify(issue)).not.toMatch(/private|token/);
});

it('creates an explicitly requested personal cloud project without requiring project group selection', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'personal-project-')); folders.push(folder);
  const allocated = '0a462fc3-25d1-494b-b04a-f5f9a66747a5';
  await writeFile(path.join(folder, 'steamharness.json'), JSON.stringify({ id, name: 'Personal project', version: '1.0.0', defaultEntry: 'main',
    entries: [{ entryId: 'main', root: '.', type: 'bot', name: 'Bot', entry: 'index.ts' }] }));
  const project = { id, folderPath: folder, projectType: 'bot', name: 'Personal project' } as Project;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); expect(body.name).toBe('Personal project'); expect(body.groupId).toBeUndefined();
      expect(body.entries[0].type).toBe('bot'); expect(body.projectId).toBeUndefined();
      return Response.json({ errCode: 0, data: { projectId: allocated } }, { status: 201 });
    }
    expect(String(url)).toBe(`${connection.serverUrl}/api/projects/${id}`);
    return Response.json({ errCode: 404 }, { status: 404 });
  });
  const creation = new ProjectServerCreation(project, () => connection, () => 'user', () => ({ kind: 'project-unavailable' }));
  try {
    const context = await creation.prepare(true); expect(context.groups).toEqual([]);
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(await creation.confirm({ token: context.token, confirmed: true, name: context.name })).toBe(allocated);
    expect(JSON.parse(await readFile(path.join(folder, 'steamharness.json'), 'utf8')).id).toBe(allocated);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  } finally { creation.close(); }
});
