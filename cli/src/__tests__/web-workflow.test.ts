import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Controller } from '../web/workflow-controller';
import { migrateProjectHistory, projectStorageReferences, type RunRecord, type WorkspaceContract } from '../web/workflow-workspace';
import { layoutProjectGraph } from '../web/workflow-graph';
import { t } from '../web/localization';
import { createWebRuntime } from '../web/runtime';
import { startWebServer } from '../web/server';
import type { Project, Runtime, Report, InputRequest, ConversationSession, ParamState } from '../web/workflow-types';
import { resolveHarnessRoot } from './harness-source';

const services: Awaited<ReturnType<typeof startWebServer>>[] = [], folders: string[] = [];
afterEach(async () => { for (const service of services.splice(0)) { await service.close(); } for (const directory of folders.splice(0)) { await rm(directory, { force: true, recursive: true }); } vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const request: InputRequest = { requestId: 'approval', nodeName: 'approval', title: 'Review', params: [{ name: 'approved', type: 'boolean', required: true }] };
const project: Project = {
  id: '14ab25f6-5a51-4b9b-9a09-df612356fd01', uri: 'file:///test', folderPath: '/test', name: 'Test workflow', projectType: 'workflow', fields: [], defaultEntrypoint: 'main',
  entrypoints: [{ id: 'main', title: 'Main', fields: [{ name: 'subject', flag: '--subject', type: 'string', required: true, defaultValue: 'Default' }], paramResolver: { enabled: true }, tools: [{ name: 'read', enabled: true }] },
    { id: 'other', title: 'Other', fields: [{ name: 'subject', flag: '--subject', type: 'string', defaultValue: 'Other' }] }],
};
function runtime(): Runtime {
  return {
    available: true, inspect: vi.fn(async () => ({ projects: [project], errors: [] })), resolveParams: vi.fn(async () => ({ params: {} })),
    run: vi.fn(async () => ({ status: 'success', output: { items: [] }, nodes: [] })), cancel: vi.fn(), dispose: vi.fn(),
    uploadFiles: vi.fn(async () => []), readFile: vi.fn(async () => { throw new Error('Unknown file'); }),
    deleteFiles: vi.fn(async () => {}), cancelConversation: vi.fn(async () => {}), deleteConversation: vi.fn(async () => {}), readResource: vi.fn(async () => null),
  };
}
function controller(saved: Partial<WorkspaceContract> = {}, legacy?: ConversationSession[]) {
  const executor = runtime(), save = vi.fn(async (_value: WorkspaceContract) => {});
  const controller = new Controller(project, executor, saved, { save, legacy, changed: vi.fn(), log: vi.fn() });
  return { controller, runtime: executor, save };
}
async function service(legacy?: ConversationSession[]) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workflow-workspace-'))); folders.push(directory);
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(directory, 'auth')); vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  const executor = runtime(), descriptor = { ...project, folderPath: directory };
  vi.mocked(executor.inspect).mockResolvedValue({ projects: [descriptor], errors: [] });
  const key = createHash('sha256').update(directory).digest('hex').slice(0, 24), dataDir = path.join(directory, 'data');
  const historyDir = path.join(dataDir, key);
  if (legacy) { await mkdir(historyDir, { recursive: true }); await writeFile(path.join(historyDir, 'conversations.json'), JSON.stringify({ sessions: legacy })); }
  const app = await startWebServer({ projectDir: directory, dataDir, runtime: executor }); services.push(app);
  const token = new URL(app.url).hash.slice('#session='.length);
  const post = (message: object) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  const state = async () => (await post({ type: 'ready' }).then(response => response.json())).messages[0];
  return { app, post, state, runtime: executor, directory, historyDir, dataDir };
}

describe('Workflow workspace controller', () => {
  it('does not persist parameter validation errors across successful runs or a new draft', async () => {
    const { app, post, state, runtime: executor } = await service();
    const invalid = await post({ type: 'workflow-run', entrypointId: 'main', params: { subject: '' } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ message: t('Please enter {0}.', 'subject') });
    expect((await state()).runs).toEqual([]); expect(executor.run).not.toHaveBeenCalled();
    const valid = await post({ type: 'workflow-run', entrypointId: 'other', params: {} });
    expect(valid.status).toBe(200); await app.projectController!.idle();
    const completed = await state();
    expect(completed.run).toMatchObject({ entrypointId: 'other', status: 'success' }); expect(completed.run.error).toBeUndefined();
    await post({ type: 'workflow-select' });
    const fresh = await state(); expect(fresh.run).toBeUndefined(); expect(fresh.error).toBeUndefined();
    expect(fresh.runs).toHaveLength(1); expect(fresh.runs[0].status).toBe('success');
  });

  it('reads a historical trace without changing the selected or occupied run', async () => {
    const { app, post, state } = await service();
    await post({ type: 'workflow-run', entrypointId: 'main', params: { subject: 'First' } }); await app.projectController!.idle();
    const first = (await state()).run;
    await post({ type: 'workflow-run', entrypointId: 'main', params: { subject: 'Second' } }); await app.projectController!.idle();
    const before = await state();
    const reply = await post({ type: 'workflow-trace', id: first.id }).then(response => response.json());
    expect(reply.messages[0]).toMatchObject({ type: 'trace-run', runId: first.id, run: { id: first.id, args: first.args } });
    const after = await state(); expect(after.selectedId).toBe(before.selectedId); expect(after.occupiedId).toBe(before.occupiedId);
    expect((await post({ type: 'workflow-trace', id: 'missing' })).status).toBe(400);
  });
  it('reserves the single project slot during execution and while waiting, even when browsing history', async () => {
    const { controller: c, runtime: r } = controller();
    vi.mocked(r.run).mockResolvedValue({ status: 'waiting_for_input', pendingUserInput: request });
    const first = await c.start({ entrypointId: 'main', params: { subject: 'First' } }); await c.idle();
    await c.select(); expect(c.current).toBeUndefined(); expect(c.running).toBe(true);
    await expect(c.start({ entrypointId: 'other', params: {} })).rejects.toThrow('already running');
    await expect(c.remove(first.id)).rejects.toThrow('Stop');
    await c.stop(); expect(first.status).toBe('aborted'); expect(c.running).toBe(false);
    const second = await c.start({ entrypointId: 'main', params: { subject: 'Second' } }); await c.idle();
    expect(c.runs.map(run => run.id)).toEqual([second.id, first.id]); expect(second.scopeId).not.toBe(first.scopeId);
  });

  it('recovers the same record through Core replay and replaces live output with the authoritative report', async () => {
    const { controller: c, runtime: r } = controller();
    vi.mocked(r.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'prefix', content: 'Before approval' } } });
      emit({ type: 'user_input_requested', ...request });
      return { status: 'waiting_for_input', pendingUserInput: request };
    });
    const record = await c.start({ entrypointId: 'main', params: { subject: 'First' } }); await c.idle();
    vi.mocked(r.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'suffix', content: 'Live suffix' } } });
      return { status: 'success', output: { items: [{ id: 'prefix', content: 'Before approval' }, { id: 'suffix', content: 'Final suffix' }] }, nodes: [{ executionId: 'first', name: 'step', status: 'success' }] };
    });
    await c.resume(record.id, request.requestId, { approved: 'true' }); await c.idle();
    expect(c.runs).toHaveLength(1); expect(record.items.map(item => item.id)).toEqual(['prefix', 'suffix']);
    expect(record.nodes).toHaveLength(1); expect(c.running).toBe(false);
    expect(r.run).toHaveBeenLastCalledWith(expect.objectContaining({ runId: record.id, conversationId: record.scopeId, resumeAfterRequestId: 'approval',
      resolvedInputs: [expect.objectContaining({ values: { approved: true } })] }), expect.any(Function));
    expect(record.resolvedInputs[0].precedingOutputItemIds).toEqual(['prefix']);
    const again = await c.rerun(record.id); await c.idle();
    expect(again.id).not.toBe(record.id); expect(again.args).toEqual(record.args); expect(c.runs).toHaveLength(2);
  });

  it('keeps an unanswered request after a failed resume and clears an empty final output snapshot', async () => {
    const { controller: c, runtime: r } = controller();
    vi.mocked(r.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: request });
    const record = await c.start({ entrypointId: 'main', params: { subject: 'First' } }); await c.idle();
    vi.mocked(r.run).mockRejectedValueOnce(new Error('Network failed'));
    await c.resume(record.id, request.requestId, { approved: 'false' }); await c.idle();
    expect(record.status).toBe('waiting_for_input'); expect(record.pendingInput).toEqual(request); expect(record.resolvedInputs).toEqual([]);
    expect(record.submittingInput).toBeUndefined(); expect(c.running).toBe(true);
    record.items.push({ content: 'Transient output' });
    vi.mocked(r.run).mockResolvedValueOnce({ status: 'success', output: { items: [] } });
    await c.resume(record.id, request.requestId, { approved: 'false' }); await c.idle(); expect(record.items).toEqual([]);
  });

  it.each([{ items: [] }, { items: [{ id: 'prefix', content: 'Before approval' }] }])('persists an unfinished stream when a paused report contains only completed outputs: $items', async ({ items }) => {
    const { controller: c, runtime: r, save } = controller();
    vi.mocked(r.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'prefix', content: 'Before approval' } } });
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'plan', content: 'Inspect project' } } });
      return { status: 'waiting_for_input', output: { items }, pendingUserInput: request };
    });
    const record = await c.start({ entrypointId: 'main', params: { subject: 'Plan' } }); await c.idle();
    expect(record.items.map(item => item.id)).toEqual(['prefix', 'plan']); expect(record.pendingInput).toEqual(request);
    const restored = controller(save.mock.calls.at(-1)![0]);
    expect(restored.controller.runs[0].items).toEqual(record.items);
  });

  it.each(['failed', 'aborted', 'timed_out'])('retains streamed diagnostics when an empty %s report has no final output', async status => {
    const { controller: c, runtime: r } = controller();
    vi.mocked(r.run).mockImplementationOnce(async (_request, emit) => {
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { id: 'partial', content: 'Partial diagnostics' } } });
      return { status, output: { items: [] } };
    });
    const record = await c.start({ entrypointId: 'main', params: { subject: 'Run' } }); await c.idle();
    expect(record).toMatchObject({ status, items: [{ id: 'partial', content: 'Partial diagnostics' }] });
  });

  it.each([
    { result: { data: { errCode: 500, errMessage: 'Offline failure example', output: null } }, error: 'Offline failure example' },
    { result: { error: { message: 'Executor failure' } }, error: 'Executor failure' },
    { result: { data: { errCode: 500, errMessage: '' } }, error: 'Workflow failed.' },
  ])('preserves Core failure messages and releases the occupied slot: $error', async ({ result, error }) => {
    const { controller: c, runtime: r, save } = controller();
    vi.mocked(r.run).mockResolvedValueOnce({ status: 'failed', result });
    const record = await c.start({ entrypointId: 'main', params: { subject: 'Failing run' } }); await c.idle();
    expect(record).toMatchObject({ status: 'failed', error }); expect(c.running).toBe(false);
    expect(save.mock.calls.at(-1)![0].runs[0].error).toBe(error);
    await c.start({ entrypointId: 'other', params: {} }); await c.idle();
    expect(c.runs[0].status).toBe('success');
  });

  it('marks unfinished records interrupted after restart, retaining durable input and independent drafts', async () => {
    const { controller: c, runtime: r, save } = controller();
    await c.updateDraft('other', { values: { subject: 'Other draft' }, rawArgs: '["--subject","Raw"]', inputMode: 'raw' });
    vi.mocked(r.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: request });
    const record = await c.start({ entrypointId: 'main', params: { subject: 'Main draft' } }); await c.idle();
    c.dispose(); await c.persist();
    const next = controller(save.mock.calls.at(-1)![0]);
    expect(next.controller.runs[0].status).toBe('interrupted'); expect(next.controller.runs[0].pendingInput).toEqual(request);
    expect(next.controller.running).toBe(true); expect(next.controller.draft('other').values).toEqual({ subject: 'Other draft' });
    expect(next.controller.draft('main').values).toEqual({ subject: 'Main draft' });
    await next.controller.resume(record.id, request.requestId, { approved: 'true' }); await next.controller.idle(); expect(next.controller.runs[0].status).toBe('success');
  });

  it('cancels an active worker and ignores its late events and final success', async () => {
    const { controller: c, runtime: r } = controller();
    let finish!: (report: Report) => void, emit!: (event: Record<string, unknown>) => void;
    vi.mocked(r.run).mockImplementationOnce((_request, event) => { emit = event; return new Promise(resolve => { finish = resolve; }); });
    const record = await c.start({ entrypointId: 'main', params: { subject: 'Main' } });
    await vi.waitFor(() => expect(r.run).toHaveBeenCalled());
    const stopping = c.stop(); expect(r.cancel).toHaveBeenCalledWith(record.id);
    emit({ type: 'node_started', executionId: 'late', nodeName: 'late' }); finish({ status: 'success', output: { items: [{ content: 'Late output' }] } }); await stopping;
    expect(record.status).toBe('aborted'); expect(record.events).toEqual([]); expect(record.items).toEqual([]); expect(c.running).toBe(false);
  });

  it('does not remove files or scopes shared by drafts, other runs or legacy history', async () => {
    const { controller: c, runtime: r } = controller();
    const first = await c.start({ entrypointId: 'main', params: { subject: 'First' } }); await c.idle();
    const file = { id: `wf_${'a'.repeat(32)}`, name: 'Shared.txt', conversationId: first.scopeId, createdAt: '', kind: 'file' as const, storage: 'local' as const, mimeType: 'text/plain', size: 1 };
    first.files.push(file);
    await c.updateDraft('main', { values: { attachment: JSON.stringify([file]) } });
    vi.mocked(r.readFile).mockResolvedValue({ reference: file, path: '/shared' });
    await c.remove(first.id);
    expect(r.deleteFiles).not.toHaveBeenCalled(); expect(r.deleteConversation).not.toHaveBeenCalled();
    expect(projectStorageReferences(c.workspace.drafts).files.has(file.id)).toBe(true);
    const legacy: ConversationSession[] = [{ id: 'old-scope', title: 'Old', messages: [{ role: 'assistant', content: 'Output', files: [{ ...file, conversationId: 'old-scope' }] }] }];
    const migrated = controller(migrateProjectHistory(legacy), legacy);
    await migrated.controller.remove(migrated.controller.runs[0].id); expect(migrated.runtime.deleteConversation).not.toHaveBeenCalled();
  });

  it('deletes unreferenced managed attachments and the run scope', async () => {
    const { controller: c, runtime: r } = controller();
    const run = await c.start({ entrypointId: 'main', params: { subject: 'Delete' } }); await c.idle();
    const file = { id: `wf_${'b'.repeat(32)}`, name: 'Export.txt', conversationId: run.scopeId, createdAt: '', kind: 'file' as const, storage: 'local' as const, mimeType: 'text/plain', size: 1 };
    run.files.push(file); vi.mocked(r.readFile).mockResolvedValue({ reference: file, path: '/export' });
    await c.remove(run.id); expect(r.deleteFiles).toHaveBeenCalledWith(project, run.scopeId, [file.id]); expect(r.deleteConversation).toHaveBeenCalledWith(project, run.scopeId);
  });

  it('retains legacy conversation storage even when its history has no file references', async () => {
    const legacy: ConversationSession[] = [{ id: 'old-scope', title: 'Old', messages: [{ id: 'old-run', role: 'assistant', content: 'Stored KV result', status: 'success' }] }];
    const { controller: c, runtime: r } = controller(migrateProjectHistory(legacy), legacy);
    await c.remove('old-run');
    expect(c.runs).toEqual([]); expect(r.deleteConversation).not.toHaveBeenCalled();
  });

  it('does not bulk-delete a scope when another record has an unreadable file reference', async () => {
    const { controller: c, runtime: r } = controller();
    const first = await c.start({ entrypointId: 'main', params: { subject: 'First' } }); await c.idle();
    const second = await c.start({ entrypointId: 'main', params: { subject: 'Second' } }); await c.idle();
    second.args.push(`wf_${'c'.repeat(32)}`);
    vi.mocked(r.readFile).mockRejectedValue(new Error('Metadata temporarily unavailable'));
    await c.remove(first.id);
    expect(c.runs).toHaveLength(1); expect(r.deleteConversation).not.toHaveBeenCalled();
  });
});

describe('SteamHarness Web routing and history', () => {
  it('correlates usage replies, permits draft writes and rejects results after account changes', async () => {
    const { app, post } = await service(), realFetch = globalThis.fetch;
    const usage = { balance: 12.34, groups: [] };
    let delayed = false, release: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const address = String(url);
      if (!address.startsWith('https://steamharness.test') && !address.startsWith('https://project.test')) { return realFetch(url, options); }
      if (address.startsWith('https://steamharness.test') && address.endsWith('/api/ai/usage') && delayed) { return new Promise(resolve => { release = resolve; }); }
      const data = address.endsWith('/api/ai/usage') ? usage : { profile: { userId: 'user', email: 'user@example.com', displayName: 'User' } };
      return Promise.resolve(new Response(JSON.stringify({ errCode: 0, data })));
    });
    await app.setHostConnection({ serverUrl: 'https://project.test', accessToken: 'project-token', aiServerUrl: 'https://steamharness.test', aiAccessToken: 'test-usage-token' });
    const current = await post({ type: 'usage', requestId: 'current-usage' }).then(response => response.json());
    expect(current.messages).toEqual([{ type: 'usage', requestId: 'current-usage', usage }]);
    delayed = true;
    const pending = post({ type: 'usage', requestId: 'old-usage' });
    await vi.waitFor(() => expect(release).toBeDefined());
    const saving = post({ type: 'workflow-draft', entrypointId: 'main', params: { subject: 'Edited while loading usage' } });
    try {
      await vi.waitFor(() => expect(app.projectController!.draft('main').values.subject).toBe('Edited while loading usage'));
      await app.setHostConnection(undefined);
    }
    finally { release!(new Response(JSON.stringify({ errCode: 0, data: usage }))); }
    expect((await saving).status).toBe(200);
    const obsolete = await pending;
    expect(obsolete.status).toBe(400);
    expect(await obsolete.json()).toEqual({ message: t("Account changed. Refresh usage.") });
  });

  it('round-trips user-declared credential parameters without changing their names or values', async () => {
    const { app, post, state, runtime: r } = await service();
    app.project.entrypoints = app.project.entrypoints.map(entry => entry.id === 'main' ? { ...entry, fields: [...entry.fields, { name: 'apiKey', flag: '--api-key', type: 'string' }] } : entry);
    vi.mocked(r.resolveParams).mockResolvedValue({ params: { apiKey: { value: 'project-key' } } });
    const resolved = await post({ type: 'resolve', params: { subject: 'Custom', apiKey: 'initial-key' } }).then(response => response.json());
    expect(resolved.messages[0]).toMatchObject({ params: { apiKey: { value: 'project-key' } }, values: { apiKey: 'project-key' } });
    expect((await state()).drafts.main.values.apiKey).toBe('project-key');
    await post({ type: 'workflow-run', params: { subject: 'Custom', apiKey: 'project-key' } }); await app.projectController!.idle();
    const id = app.projectController!.runs[0].id;
    const exported = await post({ type: 'workflow-export', id }).then(response => response.json());
    expect(JSON.parse(exported.messages[0].content).params.apiKey).toBe('project-key');
  });

  it('keeps the newest authenticated account when an older identity is still stopping a task', async () => {
    const { app, state } = await service();
    let release!: () => void;
    vi.spyOn(app.projectController!, 'stop').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (!String(url).startsWith('https://steamharness.test')) { return realFetch(url, options); }
      const userId = new Headers(options?.headers).get('Authorization') === 'Bearer new-token' ? 'New' : 'Old';
      return Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId, email: `${userId}@example.com`, displayName: userId } } })));
    });
    const old = app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'old-token' });
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'new-token' });
    } finally { release(); await old; }
    expect((await state()).account).toMatchObject({ status: 'authenticated', user: { displayName: 'New' } });
  });

  it('uses a separate page and storage, and converts legacy runs once without modifying conversations', async () => {
    const legacy: ConversationSession[] = [{ id: 'old-scope', title: 'Legacy', messages: [
      { role: 'user', content: '["--subject","Old"]', args: ['--subject', 'Old'], entrypointId: 'main' },
      { id: 'old-run', runId: 'old-run', role: 'assistant', content: 'Old output', status: 'success' },
    ] }];
    const { app, post, historyDir, state, runtime: r } = await service(legacy);
    const original = await readFile(path.join(historyDir, 'conversations.json'), 'utf8');
    expect(await fetch(app.origin).then(response => response.text())).toContain('/assets/workflow-workspace.js');
    expect((await state()).runs).toHaveLength(1);
    expect(app.projectController!.runs[0]).toMatchObject({ id: 'old-run', scopeId: 'old-scope', args: ['--subject', 'Old'] });
    await post({ type: 'workflow-run', params: { subject: 'New' } }); await app.projectController!.idle();
    expect(JSON.parse(await readFile(path.join(historyDir, 'runs.json'), 'utf8')).runs).toHaveLength(2);
    expect(await readFile(path.join(historyDir, 'conversations.json'), 'utf8')).toBe(original);
    expect(r.run).toHaveBeenCalledWith(expect.objectContaining({ entrypointId: 'main', args: ['--subject', 'New'] }), expect.any(Function));
    expect((await post({ type: 'send', text: 'Wrong surface' })).status).toBe(400);
    const id = app.projectController!.runs[0].id;
    expect(await post({ type: 'workflow-export', id }).then(response => response.json())).toMatchObject({ messages: [{ type: 'download', name: `workflow-${id}.json` }] });
  });

  it('paginates 30 records at a time and searches using the same history endpoint', async () => {
    const { app, post, state } = await service();
    const c = app.projectController!;
    const run = await c.start({ entrypointId: 'main', params: { subject: 'Seed' } }); await c.idle();
    c.runs.splice(0, 1, ...Array.from({ length: 65 }, (_, index) => ({ ...run, id: String(index), title: `Run ${index}`, createdAt: 65 - index })));
    expect((await state()).runs).toHaveLength(30);
    await post({ type: 'workflow-history', more: true }); expect((await state()).runs).toHaveLength(60);
    await post({ type: 'workflow-history', more: true }); expect((await state()).runs).toHaveLength(65);
    await post({ type: 'workflow-history', query: 'Run 64' }); expect((await state()).runs).toEqual([expect.objectContaining({ id: '64' })]);
    await post({ type: 'workflow-history', query: '' }); expect((await state()).runs).toHaveLength(30);
  });

  it('rejects stale resolver results, keeping drafts isolated per entrypoint and respecting the input mode', async () => {
    const { app, post, runtime: r } = await service();
    let finish!: (value: { params: Record<string, ParamState> }) => void;
    vi.mocked(r.resolveParams).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = post({ type: 'resolve', entrypointId: 'main', requestId: 1, params: { subject: 'Old' } });
    await vi.waitFor(() => expect(r.resolveParams).toHaveBeenCalledTimes(1));
    await post({ type: 'resolve', entrypointId: 'main', requestId: 2, params: { subject: 'New' } });
    finish({ params: { subject: { value: 'Stale' } } });
    expect((await first.then(response => response.json())).messages[0].error).toContain('changed');
    await post({ type: 'resolve', entrypointId: 'other', requestId: 3, params: { subject: 'Other' } });
    expect(app.projectController!.draft('main').values.subject).toBe('New'); expect(app.projectController!.draft('other').values.subject).toBe('Other');
    expect((await post({ type: 'workflow-run', entrypointId: 'other', inputMode: 'raw', rawArgs: '[1]', params: {} })).status).toBe(400);
    await post({ type: 'workflow-run', entrypointId: 'main', inputMode: 'raw', rawArgs: '["--subject","Raw"]', params: {} }); await app.projectController!.idle();
    expect(r.resolveParams).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ inputMode: 'raw', args: ['--subject', 'Raw'] }), 'main');
    expect(r.run).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['--subject', 'Raw'] }), expect.any(Function));
  });

  it('uses only declared tool policies and cancels waiting input when host identity changes', async () => {
    const { app, post, runtime: r, state } = await service();
    await post({ type: 'tool-policy', policies: { read: { enabled: false, autoApprove: false }, injected: { enabled: true } } });
    expect(app.projectController!.draft('main').policies).toEqual({ read: { enabled: false, autoApprove: false } });
    vi.mocked(r.run).mockResolvedValueOnce({ status: 'waiting_for_input', pendingUserInput: request });
    await post({ type: 'workflow-run', params: { subject: 'Wait' } }); await app.projectController!.idle();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => String(url).startsWith('https://steamharness.test')
      ? Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'host', email: 'host@example.com', displayName: 'Host' } } }))) : realFetch(url, options));
    await app.setHostConnection({ serverUrl: 'https://steamharness.test', accessToken: 'private-host-token' });
    expect(app.projectController!.runs[0].status).toBe('aborted');
    const next = await state(); expect(next.account.status).toBe('authenticated'); expect(JSON.stringify(next)).not.toContain('private-host-token');
  });
});

describe('Workflow graph layout', () => {
  it('matches configured titles without assigning every standard input node to the first definition', () => {
    const descriptor: Project = { ...project, entrypoints: [], definitions: { nodes: {
      prepare: { configuredName: 'Prepare', standardName: 'input' }, iteration: { configuredName: 'Iteration', standardName: 'input' },
    } }, execution: { kind: 'sequence', children: [
      { kind: 'node', nodeId: 'prepare', callId: 'prepare-call', standardName: 'input' },
      { kind: 'loop', loopId: 'loop', children: [{ kind: 'node', nodeId: 'iteration', callId: 'iteration-call', standardName: 'input' }] },
    ] } };
    const graph = layoutProjectGraph(descriptor, undefined, { nodes: [
      { name: 'input', metadata: { title: 'Prepare' }, executionId: 'prepare', status: 'success' },
      { name: 'input', metadata: { title: 'Iteration' }, executionId: 'iteration-1', status: 'success' },
      { name: 'input', metadata: { title: 'Iteration' }, executionId: 'iteration-2', status: 'running' },
    ] });
    expect(graph.nodes.filter(node => node.executionId).map(node => [node.label, node.executionId])).toEqual([
      ['Prepare', 'prepare'], ['Iteration #1', 'iteration-1'], ['Iteration #2', 'iteration-2'],
    ]);
    expect(graph.diagnostics).toEqual([]);
  });
  it('retains branches, loops, and distinct repeated execution IDs', () => {
    const descriptor: Project = { ...project, definitions: { nodes: { repeated: { configuredName: 'step' } } }, execution: { kind: 'sequence', children: [
      { kind: 'branch', branchId: 'b', branches: [{ kind: 'if', label: 'Yes', children: [{ kind: 'node', nodeId: 'repeated', callId: 'step-call' }] }, { kind: 'else', label: 'No', children: [] }] },
      { kind: 'loop', loopId: 'l', label: 'Loop', children: [{ kind: 'node', nodeId: 'other', callId: 'other-call' }] },
    ] } };
    const graph = layoutProjectGraph(descriptor, undefined, { nodes: [{ executionId: 'one', name: 'step', status: 'success' }, { executionId: 'two', name: 'step', status: 'running' }] });
    expect(graph.nodes.filter(node => node.executionId).map(node => node.executionId)).toEqual(['one', 'two']);
    expect(graph.nodes.some(node => node.kind === 'branch')).toBe(true); expect(graph.edges.some(edge => edge.label === t('Loop'))).toBe(true);
    expect(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    const fallback = layoutProjectGraph(project, 'main', { nodes: [{ executionId: 'existing', name: 'Existing', status: 'success' }] });
    expect(fallback.nodes[0].executionId).toBe('existing'); expect(fallback.diagnostics.length).toBeGreaterThan(0);
  });
});

it('inspects and executes a real offline workflow with its own Core, streaming, input replay and a managed export', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-')); folders.push(directory);
  await mkdir(path.join(directory, 'node_modules'));
  const harnessRoot = await resolveHarnessRoot();
  await symlink(harnessRoot, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ id: project.id, name: 'Workflow fixture', type: 'module', steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } }));
  await writeFile(path.join(directory, 'index.ts'), `
    const preview = steamharness.createOutputNode({ name: 'preview-node', async *stream() {
      yield steamharness.createOutputItemChunk({ type:'output_item_start', item:{id:'preview',title:'Preview',content:'Before input',contentType:'text'} });
    }, format: stream => steamharness.createOutputPayload({ items: stream.items }) });
    const approval = steamharness.createUserInputNode({name:'approval-node', title:'Approve', params:[{name:'approved',type:'boolean',required:true}]});
    const result = steamharness.createOutputNode({name:'result-node', async format(input, context) {
      const file = await context.files.createFile({name:'result.txt',mimeType:'text/plain',buffer:Buffer.from('Exported')});
      return steamharness.createOutputPayload({items:[...input.items,{id:'final',title:'Final',content:'After input',contentType:'text'}]});
    }});
    const flow = steamharness.defineProject({name:'fixture', async run(input, context) {
      const output = await steamharness.runStreamNode(preview,input,context);
      await steamharness.runNode(approval,input,context);
      return steamharness.runNode(result, output.output, context);
    }});
    export const executor = steamharness.defineExecutor({projectType:'workflow',defaultEntrypoint:'main',entrypoints:[steamharness.defineEntrypoint({id:'main',title:'Main',group:{id:'group',title:'Group'},workflow:flow,
      params:[{name:'subject',flag:'--subject',type:'string',defaultValue:'Subject'}],createInput: context => context.paramValues})]});
  `);
  const executor = createWebRuntime(directory, path.join(directory, 'data'), () => undefined);
  try {
    const inspected = await executor.inspect([directory]); expect(inspected.errors).toEqual([]);
    const descriptor = { ...inspected.projects[0], uri: 'file:///fixture' };
    expect(descriptor.entrypoints[0]).toMatchObject({ group: { id: 'group', title: 'Group' }, execution: { kind: 'sequence' } });
    expect(descriptor.definitions?.nodes).toBeTruthy();
    const events: Record<string, unknown>[] = [];
    const first = await executor.run({ project: descriptor, conversationId: 'scope', runId: 'run', entrypointId: 'main', args: [] }, event => events.push(event));
    expect(first.status).toBe('waiting_for_input'); expect(events.some(event => event.type === 'node_chunk')).toBe(true);
    const pending = first.pendingUserInput!;
    const resumed = await executor.run({ project: descriptor, conversationId: 'scope', runId: 'run', entrypointId: 'main', args: [],
      resumeAfterRequestId: pending.requestId, resolvedInputs: [{ requestId: pending.requestId, nodeName: pending.nodeName, values: { approved: true }, submittedAt: new Date().toISOString(), request: pending }] }, () => {});
    expect(resumed.status).toBe('success'); expect(resumed.output?.items?.map(item => item.id)).toEqual(['preview', 'final']);
    expect(resumed.files).toHaveLength(1); expect(await readFile((await executor.readFile(descriptor, resumed.files![0].id)).path, 'utf8')).toBe('Exported');
  } finally { executor.dispose(); }
}, 30_000);
