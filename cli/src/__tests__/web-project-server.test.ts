import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectServerConnection, checkProjectServer } from '../web/project-server-state';
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
  let status = 404, onRead: (() => Promise<Response>) | undefined;
  const remote = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (!String(url).startsWith(connection.serverUrl)) return nativeFetch(url, options);
    remote(url, options);
    if (String(url).endsWith('/api/auth/me')) return new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'user', email: 'user@test.com', displayName: 'User' } } }));
    if (onRead) return onRead();
    return status === 200 ? ok() : new Response('private upstream error', { status });
  });
  const app = await startWebServer({ projectDir: folderPath, dataDir: path.join(folderPath, 'data'), runtime, host: { surface: 'editor', connection } }); services.push(app);
  const token = new URL(app.url).hash.slice('#session='.length);
  const post = (message: object) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  const state = async () => (await post({ type: 'ready' }).then(response => response.json())).messages[0];
  return { app, runtime, post, state, remote, recover: () => { status = 200; }, hold: (read: () => Promise<Response>) => { onRead = read; } };
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
