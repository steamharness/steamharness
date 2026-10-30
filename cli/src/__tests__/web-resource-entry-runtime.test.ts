import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalProjectConfigurationStore } from 'steamharness';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { createWebRuntime } from '../web/runtime';
import { startEntryWebServer } from '../web/server';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

it.each(['assistant', 'conversation'] as const)('opens and refreshes a sibling Kanban entry from a real %s runtime', async surface => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'resource-entry-runtime-'))); folders.push(root);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'host'));
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  const workspace = path.join(root, 'workspace'), assistant = path.join(root, 'assistant'), id = randomUUID();
  const conversationSource = `
    const flow = steamharness.defineProject({ run() { return { errCode: 0, errMessage: '' }; } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: flow, createInput() { return {}; } });
    export default flow;
  `;
  for (const directory of [workspace, assistant]) {
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeProjectFixture(path.join(workspace, 'package.json'), JSON.stringify({ id, name: 'Workspace', type: 'module', version: '1.0.0',
    devDependencies: { steamharness: await resolveHarnessVersion() }, defaultEntry: 'agent', entries: [
      { entryId: 'agent', name: 'Agent', type: 'conversation', root: 'agent', entry: 'index.ts', databases: [] },
      { entryId: 'map-2d', name: 'Map', type: 'kanban', root: 'map-2d', entry: 'dist/index.html', configuration: 'configuration.json', databases: [] },
    ] }));
  await writeFile(path.join(workspace, 'agent/index.ts'), conversationSource);
  await mkdir(path.join(workspace, 'map-2d/dist'));
  await writeFile(path.join(workspace, 'map-2d/dist/index.html'), '<!doctype html><html><head></head><body>Sibling map artifact</body></html>');
  await writeFile(path.join(workspace, 'map-2d/configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'mapName', type: 'string' }] }));
  await writeProjectFixture(path.join(assistant, 'package.json'), JSON.stringify({ id: randomUUID(), name: 'Assistant', type: 'module', version: '1.0.0',
    devDependencies: { steamharness: await resolveHarnessVersion() }, defaultEntry: 'main',
    entries: [{ entryId: 'main', name: 'Assistant', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
  await writeFile(path.join(assistant, 'index.ts'), conversationSource);
  const store = await createLocalProjectConfigurationStore(workspace, { entryId: 'map-2d' });
  let state = await store.read();
  const configurationId = state.activeConfigurationId;
  await store.dispatch({ action: 'save', revision: state.revision, id: configurationId, values: { mapName: 'Official map' } });
  state = await store.read();
  await store.dispatch({ action: 'create', revision: state.revision, name: 'Other map' });
  const saved = await store.read();
  const projectDir = surface === 'assistant' ? assistant : workspace, entryId = surface === 'assistant' ? 'main' : 'agent';
  const runtime = createWebRuntime(projectDir, path.join(root, 'history'), () => undefined, { entryId });
  const app = await startEntryWebServer({ projectDir, entryId, dataDir: path.join(root, 'history'), runtime,
    host: surface === 'assistant' ? { surface: 'assistant', assistantProjectDir: assistant,
      assistant: { workdir: workspace, roots: [{ uri: 'file:///workspace', folderPath: workspace, name: 'Workspace' }] } }
      : { surface: 'editor' } });
  const request = async (message: object) => {
    const response = await fetch(new URL('/api/message', app.url), { method: 'POST',
      headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    return { ok: response.ok, body: await response.json() };
  };
  const presentation = { action: 'upsert', cardId: 'official-map', kind: 'kanban', title: 'Official map', pinned: true, preview: true,
    target: { source: 'current', projectId: id, entryId: 'map-2d', configurationId } };
  app.controller!.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
    content: { tool: 'workflow-ui_present_card', input: presentation, status: 'success', output: { content: [{ type: 'text', text: JSON.stringify(presentation) }], details: {} } } }] });
  try {
    const opened = await request({ type: 'resource', messageId: 'answer', cardId: 'official-map', action: 'inline' });
    expect(opened.body, JSON.stringify(opened.body)).toHaveProperty('messages'); expect(opened.ok).toBe(true);
    const preview = opened.body.messages[0], reference = JSON.parse(new URL(preview.url, app.url).searchParams.get('resourceRef')!);
    for (const message of [{ type: 'resource-data', id: preview.id }, { type: 'resource-refresh', reference }]) {
      const result = await request(message);
      expect(result.body, JSON.stringify(result.body)).toHaveProperty('messages'); expect(result.ok).toBe(true);
      const data = result.body.messages[0].data;
      expect(data).toMatchObject({ format: 'kanban', project: { id, entryId: 'map-2d', folderPath: workspace, entryRoot: path.join(workspace, 'map-2d') },
        kanban: { configuration: { id: configurationId, params: { mapName: 'Official map' } } } });
      expect(await (await fetch(new URL(data.kanban.url, app.url))).text()).toContain('Sibling map artifact');
      app.setHostResourceProjects([]);
    }
    expect(await store.read()).toEqual(saved);
    expect(app.project.entryId).toBe(entryId);
    const missing = { ...presentation, cardId: 'missing-entry', target: { ...presentation.target, entryId: 'missing' } };
    app.controller!.current.messages.push({ id: 'missing', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
      content: { tool: 'workflow-ui_present_card', status: 'success', output: missing } }] });
    expect(await request({ type: 'resource', messageId: 'missing', cardId: missing.cardId })).toMatchObject({ ok: false,
      body: { message: 'The resource project is unavailable.' } });
  } finally { await app.close(); }
}, 30_000);
