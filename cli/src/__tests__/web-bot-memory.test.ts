import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startEntryWebServer } from '../web/server';
import type { Project, Runtime } from '../web/workflow-types';

it('a native Studio host advertises upgrade and refuses management if the project SDK cannot journal Bot writes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'steamharness-memory-upgrade-')));
  const directory = path.join(root, 'project'), dataDir = path.join(root, 'data');
  const id = randomUUID(), entryId = 'agent';
  const entry = { entryId, type: 'bot' as const, root: '.', entry: 'index.ts', name: 'Legacy Agent' };
  const project: Project = { id, entryId, defaultEntry: entryId, projectType: 'bot', uri: '', folderPath: directory, entryRoot: directory,
    name: entry.name, aggregateName: entry.name, entries: [entry], fields: [], entrypoints: [], conversation: { engine: 'agent' } };
  const runtime: Runtime = { available: true, inspect: async () => ({ projects: [project], errors: [] }), resolveParams: async () => ({}),
    run: async () => ({ status: 'success' }), uploadFiles: async () => [], readFile: async () => { throw new Error('File unavailable'); },
    deleteFiles: async () => {}, deleteConversation: async () => {}, cancelConversation: async () => {}, cancel() {}, dispose() {} };
  vi.stubEnv('STEAMHARNESS_WEB_HOST', 'studio');
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', ''); vi.stubEnv('STEAMHARNESS_SERVER_URL', '');
  let app: Awaited<ReturnType<typeof startEntryWebServer>> | undefined;
  try {
    await mkdir(directory);
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id, name: 'legacy-agent', defaultEntry: entryId, entries: [entry] }));
    await writeFile(path.join(directory, 'index.ts'), 'export {};');
    app = await startEntryWebServer({ projectDir: directory, dataDir, entryId, runtime, host: { surface: 'editor', localBotArtifacts: true } });
    const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session');
    const post = (route: string, value: object) => fetch(`${app!.origin}/api/${route}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const ready = await (await post('message', { type: 'ready' })).json();
    expect(ready.messages).toContainEqual(expect.objectContaining({ type: 'state', botMemory: 'upgrade' }));
    const blocked = await post('bot-memory', { action: 'save', category: 'fixture', key: 'blocked', content: 'not written' });
    expect(blocked.status).toBe(404);
    expect(await blocked.json()).toEqual({ code: 'BOT_MEMORY_UNAVAILABLE' });
  } finally {
    await app?.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
});
