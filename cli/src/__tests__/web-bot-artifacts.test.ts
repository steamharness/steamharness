import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalRuntimePersistence, type BotArtifact } from 'steamharness/runtime-storage';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startEntryWebServer } from '../web/server';
import type { WebHostConfiguration } from '../web/host-config';
import { projectDataDirectorySync, folderBotDataRoot } from '../web/project-data-directory';
import type { Project, Runtime } from '../web/workflow-types';

afterEach(() => vi.unstubAllEnvs());

it('authorizes local delivery and keeps the snapshot across chat deletion and host restart, scoped to its Bot', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'steamharness-artifacts-web-')));
  const directory = path.join(root, 'project'), dataDir = path.join(root, 'data');
  const projectId = randomUUID(), entryId = 'main', copyId = randomUUID();
  const entry = { entryId, type: 'bot' as const, root: '.', entry: 'index.ts', name: 'Fixture' };
  const project: Project = { id: projectId, entryId, defaultEntry: entryId, projectType: 'bot', uri: '', folderPath: directory, entryRoot: directory,
    name: 'Fixture', aggregateName: 'Fixture', entries: [entry], fields: [], entrypoints: [], tools: [{ name: 'bot_files_publish', enabled: true, autoApprove: true }] };
  vi.stubEnv('STEAMHARNESS_WEB_HOST', 'studio');
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  vi.stubEnv('STEAMHARNESS_SERVER_URL', '');
  const native: WebHostConfiguration = { surface: 'editor', localBotArtifacts: true, localBotArtifactLabel: 'Fixture' };
  const services: Awaited<ReturnType<typeof startEntryWebServer>>[] = [];
  const stores: ReturnType<typeof createLocalRuntimePersistence>[] = [];
  let artifact: BotArtifact | undefined, reference = '';
  const start = async (host: WebHostConfiguration) => {
    const scoped = host.folderBot ? folderBotDataRoot(dataDir, host.folderBot.id) : dataDir;
    const persistence = createLocalRuntimePersistence({ directory: path.join(projectDataDirectorySync(scoped, directory, projectId, entryId), 'runtime') });
    stores.push(persistence);
    const scope = { projectId, entryId }, files = persistence.botFiles!(scope)!;
    const runtime: Runtime = { available: true, inspect: async () => ({ projects: [project], errors: [] }),
      resolveParams: async () => ({ params: {} }),
      async run(request) {
        if (request.allowBotArtifactPublish) {
          const locations = await files.list(undefined, 0, 10);
          reference = `${locations.artifacts}/report.md`;
          await files.write(reference, 'first report', false);
          artifact = await persistence.botArtifacts!(scope)!.publish({ path: reference }, {
            conversationId: request.conversationId, requestId: 'send', runId: request.runId!, outputId: 'call',
          }, 'one');
        }
        return { status: 'success', runId: request.runId, output: { items: [{ id: 'answer', title: 'Answer', content: 'Done', contentType: 'markdown' }] } };
      },
      uploadFiles: async () => [], readFile: async () => { throw new Error('Missing file'); },
      deleteFiles: async () => {}, deleteConversation: async () => {}, cancelConversation: async () => {}, cancel() {}, dispose() {},
    };
    const app = await startEntryWebServer({ projectDir: directory, entryId, host, runtime, dataDir });
    services.push(app);
    const capability = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session');
    const signed = await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Authorization: `Bearer ${capability}` } });
    const headers = { Origin: app.origin, Cookie: signed.headers.get('set-cookie')!.split(';')[0]! };
    const get = (suffix = '', init: RequestInit = {}) => fetch(`${app.origin}/api/bot-artifacts${suffix}`, { ...init, headers });
    const post = (message: object) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    return { app, get, post, files };
  };
  try {
    await mkdir(directory);
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: projectId, name: 'fixture', version: '0.1.0', defaultEntry: entryId, entries: [entry] }));
    await writeFile(path.join(directory, 'index.ts'), 'import * as steamharness from "steamharness"; export const executor = steamharness.defineBot({ engine: "agent" }); export default executor;');
    const clone = await start({ ...native, folderBot: { id: copyId, projectId, directory, background: false }, localBotArtifactLabel: 'Copy' });
    expect((await fetch(`${clone.app.origin}/api/bot-artifacts`)).status).toBe(401);
    expect(await (await clone.get()).json()).toEqual({ artifacts: [] });
    expect((await clone.post({ type: 'send', text: 'Deliver fixture', params: {}, attachments: [], requestId: randomUUID() })).status).toBe(200);
    await expect.poll(() => artifact?.id).toMatch(/^ba_/);
    await expect.poll(() => clone.app.controller?.running).toBe(false);
    const id = artifact!.id;
    const source = artifact!.source.conversationId;
    const contentUrl = `${clone.app.origin}/api/bot-artifacts/${id}/content`;
    const capability = new URLSearchParams(new URL(clone.app.url).hash.slice(1)).get('session');
    expect((await fetch(contentUrl)).status).toBe(401);
    expect((await fetch(`${contentUrl}?session=${capability}`)).status).toBe(401);
    expect((await fetch(contentUrl, { headers: { Authorization: `Bearer ${capability}`,
      'X-SteamHarness-Preview-Mount': `/p/${'a'.repeat(43)}` } })).status).toBe(404);
    const list = await (await clone.get()).json();
    expect(list.artifacts).toEqual([expect.objectContaining({ id, name: 'report.md', conversationId: source })]);
    expect(JSON.stringify(list)).not.toContain(root);
    await clone.files.write(reference, 'updated source', true);
    const preview = await clone.get(`/${id}/content?preview=1`);
    expect(preview.headers.get('content-type')).toContain('text/plain'); expect(await preview.text()).toBe('first report');
    const original = await start(native);
    expect(await (await original.get()).json()).toEqual({ artifacts: [] });
    expect((await original.get(`/${id}/content`)).status).toBe(404);
    const web = await start({ surface: 'editor', folderBot: { id: copyId, projectId, directory, background: false } });
    expect((await web.get()).status).toBe(404);
    expect((await clone.post({ type: 'session-action', action: 'delete', id: source })).status).toBe(200);
    expect((await (await clone.get(`/${id}`)).json()).conversationId).toBeUndefined();
    await clone.app.close();
    const reopened = await start({ ...native, folderBot: { id: copyId, projectId, directory, background: false } });
    const saved = await reopened.get(`/${id}/content`);
    expect(saved.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(await saved.text()).toBe('first report');
    expect((await reopened.get(`/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await reopened.get(`/${id}`)).status).toBe(404);
    expect((await reopened.get(`/${id}/content`)).status).toBe(404);
    expect((await reopened.files.read(reference, 0)).text).toBe('updated source');
  } finally {
    for (const service of services.reverse()) await service.close();
    for (const store of stores) await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
