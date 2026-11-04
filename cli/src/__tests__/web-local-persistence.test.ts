import { testDataDirectory } from './test-data-directory';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startEntryWebServer } from '../web/server';
import type { Project, Runtime } from '../web/workflow-types';

const services: Awaited<ReturnType<typeof startEntryWebServer>>[] = [];
const directories: { directory: string; projectId: string }[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const { directory, projectId } of directories.splice(0)) {
    const key = createHash('sha256').update(`${projectId}:main`).digest('hex');
    const config = path.join(os.homedir(), '.steamharness', 'configurations', `${key}.json`);
    for (const suffix of ['', '.lock.sqlite', '.lock.sqlite-wal', '.lock.sqlite-shm']) await rm(`${config}${suffix}`, { force: true });
    await rm(path.join(os.homedir(), '.steamharness', 'configurations', 'snapshots', key), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

it('persists and reopens offline history through the default host backend without runtime-storage HTTP requests', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'steamharness-local-history-'));
  const projectId = randomUUID();
  directories.push({ directory, projectId });
  const entry = { entryId: 'main', name: 'Offline', type: 'conversation' as const, root: '.', entry: 'index.ts', databases: [] };
  const project: Project = { id: projectId, entryId: 'main', aggregateName: 'Offline', defaultEntry: 'main', entries: [entry],
    entryRoot: directory, folderPath: directory, uri: '', name: 'Offline', projectType: 'conversation', databases: [], fields: [], entrypoints: [] };
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: projectId, name: 'offline-history', version: '0.1.0', entries: [entry], defaultEntry: 'main' }));
  await writeFile(path.join(directory, 'index.ts'), 'export {};');
  const runtime: Runtime = {
    available: true, inspect: vi.fn(async () => ({ projects: [project], errors: [] })),
    resolveParams: vi.fn(async () => ({ params: {} })),
    run: vi.fn(async request => ({ status: 'success', runId: request.runId, output: { items: [{ id: 'answer', title: 'Answer', content: 'Offline reply', contentType: 'markdown' }] } })),
    cancel: vi.fn(), dispose: vi.fn(), uploadFiles: vi.fn(async () => []), readFile: vi.fn(async () => { throw new Error('Unknown file.'); }),
    deleteFiles: vi.fn(async () => {}), readResource: vi.fn(async () => null), cancelConversation: vi.fn(async () => {}), deleteConversation: vi.fn(async () => {}),
  };
  const originalFetch = globalThis.fetch;
  const remoteRequests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (new URL(url).hostname === '127.0.0.1') return originalFetch(input, init);
    remoteRequests.push(url);
    if (url.endsWith('/api/auth/me')) return Response.json({ errCode: 0, data: { profile: { userId: 'local-user', email: 'local@example.test', displayName: 'Local' } } });
    if (url.endsWith(`/api/projects/${projectId}`)) return Response.json({ errCode: 0, data: { id: projectId } });
    throw new Error(`Unexpected network access: ${url}`);
  });
  const start = async () => {
    const app = await startEntryWebServer({ projectDir: directory, dataDir: path.join(testDataDirectory(directory)), runtime, host: { surface: 'editor' } });
    services.push(app);
    const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session');
    const auth = await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const cookie = auth.headers.get('set-cookie')!.split(';')[0];
    const post = (message: object) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    return { app, post };
  };
  const first = await start();
  const sessionId = first.app.controller!.current.id;
  const response = await first.post({ type: 'send', sessionId, requestId: randomUUID(), text: 'Local message', params: {}, attachments: [] });
  expect(response.status, await response.text()).toBe(200);
  await first.app.controller!.idle();
  expect(runtime.run).toHaveBeenCalledOnce();
  expect(first.app.controller!.current.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: 'Local message' }), expect.objectContaining({ role: 'assistant', content: 'Offline reply', status: 'success' }),
  ]));
  expect((await first.post({ type: 'navigate', clientId: randomUUID(), requestId: 1, id: sessionId, updates: [{ id: sessionId, draft: { text: 'Saved offline draft', attachments: [] } }] })).status).toBe(200);
  expect(remoteRequests).toEqual([]);
  await first.app.close(); services.splice(services.indexOf(first.app), 1);
  const sqlite = path.join(testDataDirectory(directory), 'projects', projectId, 'entries', 'main', 'runtime', 'history.sqlite');
  expect((await readFile(sqlite)).subarray(0, 15).toString()).toBe('SQLite format 3');

  const second = await start();
  const restored = second.app.controller!.sessions.find(session => session.id === sessionId)!;
  expect(restored.draft?.text).toBe('Saved offline draft');
  expect(restored.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Offline reply', status: 'success' })]));
  await second.app.setHostConnection({ serverUrl: 'https://host.example.test', accessToken: 'test-account' });
  await second.app.setHostConnection(undefined);
  expect(second.app.controller!.sessions.find(session => session.id === sessionId)?.draft?.text).toBe('Saved offline draft');
  expect(remoteRequests.some(url => url.includes('/api/runtime-storage'))).toBe(false);
});
