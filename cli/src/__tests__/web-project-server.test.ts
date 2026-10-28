import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectServerConnection, checkProjectServer, projectServerAccessFailure } from '../web/project-server-state';
import { ProjectServerCreation } from '../web/project-server-create';
import { startEntryWebServer as startWebServer } from '../web/server';
import { readProjectInfo } from '../web/kanban-data';
import type { Project, Runtime } from '../web/workflow-types';
import type { ProjectServerCheck } from '../web/project-server-state';

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
