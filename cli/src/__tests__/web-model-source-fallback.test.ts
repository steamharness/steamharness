import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AGENT_MODELS_CONFIGURATION_KEY as key } from '@steamharness/project-configuration';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startEntryWebServer } from '../web/server';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

it('falls back to project models in standalone Web and follows later host capability changes through real workers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-source-fallback-'));
  const projectId = crypto.randomUUID(), configurationKey = createHash('sha256').update(`${projectId}:main`).digest('hex');
  const calls: { model: string; key?: string }[] = [];
  let app: Awaited<ReturnType<typeof startEntryWebServer>> | undefined;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ model: body.model, key: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'answer', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.end(chunk({ role: 'assistant', content: `Answer ${body.model}` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: projectId, name: 'model-modes', version: '1.0.0', devDependencies: { steamharness: await resolveHarnessVersion() }, defaultEntry: 'main', entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
    await writeFile(path.join(directory, 'index.ts'), `
      const project = steamharness.createAgentConversationProject({ modelSource: 'user-settings', tools: [] });
      export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: project,
        createInput(context) { return steamharness.createAgentProjectInput(context); }
      });
    `);
    app = await startEntryWebServer({ projectDir: directory, dataDir: path.join(directory, 'data') });
    const token = new URL(app.url).hash.slice('#session='.length);
    const post = async (message: object) => {
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result.messages;
    };
    const binding = () => app!.project.fields.find(field => field.name === 'model')?.userSetting;
    const hasProjectModels = () => app!.configurations.state.fields.some(field => field.name === key);
    const project = { id: 'project', name: 'Project model', source: 'third-party' as const, apiKind: 'openai-completions' as const, model: 'project-model', baseUrl: `${origin}/v1`, apiKey: 'fixture-project-key' };
    const host = { ...project, id: 'host', name: 'Settings model', model: 'host-model', apiKey: 'fixture-host-key' };
    expect(binding()).toBeUndefined(); expect(hasProjectModels()).toBe(true);
    const state = app.configurations.state;
    await post({ type: 'project-configuration', call: { action: 'save', id: state.activeConfigurationId, revision: state.revision, values: { [key]: [project] } } });
    const resolve = async (id: string) => {
      const result = (await post({ type: 'resolve', params: {}, requestId: id }))[0];
      expect(result.error).toBeUndefined(); return result.params.model;
    };
    expect((await resolve('standalone')).resolvedOptions).toEqual([{ value: project.id, label: project.name, description: project.model }]);
    const send = async (text: string) => {
      await post({ type: 'send', text, params: {}, attachments: [] }); await app!.controller.idle();
      const answer = app!.controller.current.messages.at(-1);
      expect(answer?.status, answer?.error).toBe('success');
    };
    await send('Standalone');
    await app.setHostUserSettings({ agent: { permissionPolicy: 'auto', models: [host] } });
    expect(binding()?.key).toBe('agent.model'); expect(hasProjectModels()).toBe(false);
    expect((await resolve('studio')).resolvedOptions).toEqual([{ value: host.id, label: host.name, description: host.model }]);
    await send('Studio');
    await app.setHostUserSettings({ agent: { permissionPolicy: 'auto', models: [] } });
    expect(binding()?.key).toBe('agent.model'); expect(hasProjectModels()).toBe(false);
    expect((await resolve('empty-studio')).resolvedOptions).toEqual([]);
    expect(JSON.stringify(await post({ type: 'ready' }))).not.toContain('fixture-project-key');
    expect(calls).toHaveLength(2);
    await app.setHostUserSettings({ agent: { permissionPolicy: 'auto' } });
    expect(binding()).toBeUndefined(); expect(hasProjectModels()).toBe(true);
    expect((await resolve('standalone-again')).value).toBe(project.id);
    await send('Standalone again');
    expect(calls).toEqual([
      { model: project.model, key: `Bearer ${project.apiKey}` },
      { model: host.model, key: `Bearer ${host.apiKey}` },
      { model: project.model, key: `Bearer ${project.apiKey}` },
    ]);
    expect(JSON.stringify(app.project)).not.toContain('fixture-project-key');
    expect(JSON.stringify(app.controller.current)).not.toContain('fixture-host-key');
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    const configurations = path.join(os.homedir(), '.steamharness', 'configurations');
    for (const suffix of ['.json', '.json.lock.sqlite']) await rm(path.join(configurations, configurationKey + suffix), { force: true });
    await rm(path.join(configurations, 'snapshots', configurationKey), { recursive: true, force: true });
  }
}, 40_000);
