import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalRuntimePersistence } from 'steamharness/runtime-storage';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startEntryWebServer } from '../web/server';
import { createJsonSummaryDraft } from '../project-templates';
import { previewRunDraft } from '../web/workflow-draft';
import type { ConversationMessage, ConversationSession } from '../web/workflow-types';

const linkCore = async (directory: string) => {
  await mkdir(path.join(directory, 'node_modules'));
  await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
};
const json = (value: object) => ({ 'Content-Type': 'application/json', body: JSON.stringify(value) });

it('ships the exact Bot transformation as self-contained Workflow source', async () => {
  const template = await readFile(new URL('../project-templates/workflow-draft/json-summary.ts', import.meta.url));
  const core = await readFile(path.join(await resolveHarnessRoot(), 'src/workflow/json-summary.ts'));
  expect(template).toEqual(core);
});

it('requires a successful local tool receipt, never assistant text, Shell output or IM history', () => {
  const operation = { kind: 'json-summary-v1', id: 'a'.repeat(24), groupBy: 'status' };
  const message: ConversationMessage = { role: 'assistant', id: randomUUID(), content: JSON.stringify(operation), status: 'success', items: [
    { content: JSON.stringify(operation), metadata: { kind: 'agent-answer' } },
    { content: { tool: 'shell', status: 'success', output: { details: { workflowDraftOperation: operation } } }, metadata: { kind: 'agent-part', partType: 'tool' } },
    { content: { tool: 'bot_json_summary', status: 'failed', output: { details: { workflowDraftOperation: operation } } }, metadata: { kind: 'agent-part', partType: 'tool' } },
  ] };
  const session = { id: randomUUID(), title: 'Local', messages: [message] } as ConversationSession;
  expect(previewRunDraft(session, message)).toEqual({ steps: [], excluded: [
    { tool: 'model-response', count: 1 }, { tool: 'shell', count: 1 }, { tool: 'bot_json_summary', count: 1 },
  ] });
  expect(previewRunDraft(session, { ...message, status: 'waiting_for_input' })).toBeUndefined();
  expect(previewRunDraft({ ...session, origin: 'host' }, message)).toBeUndefined();
});

it('drafts a real Bot tool result and runs the independent Workflow with new JSON input', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-workflow-draft-'))), bot = path.join(root, 'bot'), dataDir = path.join(root, 'web');
  const projectId = randomUUID(), versions = { harness: await resolveHarnessVersion(), cli: await resolveHarnessVersion() };
  const apps: Awaited<ReturnType<typeof startEntryWebServer>>[] = [];
  vi.stubEnv('STEAMHARNESS_WEB_HOST', 'studio'); vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  const persistence = createLocalRuntimePersistence({ directory: path.join(dataDir, 'projects', projectId, 'entries', 'main', 'runtime') });
  const workspace = persistence.botFiles!({ projectId, entryId: 'main' })!;
  const input = `${(await workspace.list(undefined, 0, 1)).temp}/old-source.json`;
  await workspace.write(input, '[{"status":"old"}]', false);
  await persistence.close();
  let called = false;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const invoke = !body.messages.some((message: { role: string }) => message.role === 'tool');
    called ||= invoke && body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'bot_json_summary');
    const event = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'summary', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(event(invoke ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_summary_call', type: 'function', function: { name: 'bot_json_summary', arguments: JSON.stringify({ path: input, groupBy: 'status' }) } }] }
      : { role: 'assistant', content: 'Summary complete' }, null) + event({}, invoke ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  try {
    await mkdir(bot); await linkCore(bot);
    await writeProjectFixture(path.join(bot, 'package.json'), JSON.stringify({ id: projectId, name: 'Bot fixture', type: 'module', version: '1.0.0',
      devDependencies: { steamharness: versions.harness }, entries: [{ entryId: 'main', type: 'bot', name: 'Bot', root: '.', entry: 'index.ts' }], defaultEntry: 'main' }));
    await writeFile(path.join(bot, 'index.ts'), `export const executor = steamharness.defineBot({ engine: 'agent', agent: {
      provider: 'openai', model: 'fixture', apiKind: 'openai-completions', apiKey: 'fixture-credential',
      baseUrl: 'http://127.0.0.1:${(model.address() as { port: number }).port}/v1', tools: [],
      paramOptions: { fields: { provider: false, model: false } },
    } });`);
    const app = await startEntryWebServer({ projectDir: bot, dataDir, host: { surface: 'editor', localBotArtifacts: true } }); apps.push(app);
    const bearer = new URL(app.url).hash.slice('#session='.length);
    const request = (route: string, value: object, authorized = true) => {
      const body = json(value);
      return fetch(`${app.origin}/api/${route}`, { method: 'POST', headers: { 'Content-Type': body['Content-Type'], ...(authorized && { Authorization: `Bearer ${bearer}` }) }, body: body.body });
    };
    expect((await request('message', { type: 'send', text: 'Summarize the selected file', params: {}, attachments: [] })).status).toBe(200);
    await vi.waitFor(() => expect(app.controller.current.messages.at(-1)?.status).toBe('success'), { timeout: 15_000 });
    expect(called).toBe(true);
    const source = { sessionId: app.controller.current.id, messageId: app.controller.current.messages.at(-1)!.id };
    expect((await request('workflow-draft', source, false)).status).toBe(401);
    expect((await request('workflow-draft', { ...source, messageId: 'unavailable' })).status).toBe(404);
    const draft = await (await request('workflow-draft', source)).json();
    expect(draft.steps).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{24}$/u), kind: 'json-summary-v1', groupBy: 'status', outputName: 'summary.json' }]);
    expect(JSON.stringify(draft)).not.toContain(input);
    const repo = { name: 'New summary', parentDirectory: root, versions, options: { groupBy: 'stage', outputName: 'New report.json' } };
    await expect(createJsonSummaryDraft({ ...repo, signal: AbortSignal.abort() })).rejects.toHaveProperty('name', 'AbortError');
    await expect(createJsonSummaryDraft({ ...repo, options: { outputName: '../unsafe.json' } })).rejects.toThrow('without folders');
    expect(await readdir(root)).not.toContain(repo.name);
    const saved = await createJsonSummaryDraft(repo);
    expect(saved.id).not.toBe(projectId);
    await expect(createJsonSummaryDraft(repo)).rejects.toHaveProperty('code', 'directory-exists');
    for (const file of await readdir(saved.directory)) {
      const text = await readFile(path.join(saved.directory, file), 'utf8');
      for (const value of ['fixture-credential', input, projectId, 'summary.complete']) expect(text).not.toContain(value);
    }
    const runtime = await import('../web/runtime');
    await linkCore(saved.directory);
    const worker = runtime.createWebRuntime(saved.directory, dataDir, () => undefined);
    try {
      const inspected = await worker.inspect([saved.directory]);
      expect(inspected.errors).toEqual([]);
      const project = { ...inspected.projects[0], uri: saved.directory };
      const scope = randomUUID();
      const [file] = await worker.uploadFiles(project, scope, [{ name: 'new-source.json', mimeType: 'application/json', data: Buffer.from('[{"stage":"new"},{"stage":"new"},{}]').toString('base64') }]);
      const result = await worker.run({ project, runId: scope, conversationId: scope, entrypointId: 'main', args: ['--source', JSON.stringify(file)] }, () => {});
      expect(result.status, JSON.stringify(result.result)).toBe('success');
      expect(result.files?.[0]?.name).toBe('New report.json');
      const output = await worker.readFile(project, result.files![0].id);
      expect(JSON.parse(await readFile(output.path, 'utf8'))).toEqual({ rowCount: 3, groupBy: 'stage', groups: [{ value: 'new', count: 2 }, { missing: true, count: 1 }] });
    } finally { worker.dispose(); }
  } finally {
    for (const app of apps) await app.close();
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  }
}, 40_000);
