import { testDataDirectory } from './test-data-directory';
import { createLocalRuntimePersistence, createMemoryRuntimePersistence, emptyRuntimeRecord, type RuntimeHistoryRecord } from 'steamharness/runtime-storage';
import { encodeSession } from '../web/conversation-history';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalActivityWriter, readLocalStudioAnalysis, requestStudioAnalysis, summarizeLocalRuns, type LocalRunSummary } from '../web/local-analysis';
import { webProjectDataDirectory } from '../web/kanban-data';
import type { ConversationSession } from '../web/workflow-types';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
async function fixture(kind: 'workflow'|'bot'|'kanban' = 'workflow') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'local-analysis-'))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const folderPath = path.join(root, 'project'); await mkdir(folderPath);
  const reference = { entryId:'main', id: '8f6a6240-4860-4efc-bd07-932868be2b98', name: 'Imported', uri: pathToFileURL(folderPath).href, folderPath };
  const manifest = { id: reference.id, name: 'Default', version: "0.1.0",  defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:kind,root:'.',entry:kind==='kanban'?'index.html':'index.ts',databases:[] as object[]}], projectInfo: { localizedNames: { en: 'English', 'zh-CN': 'Chinese' } }  };
  await writeProjectFixture(path.join(folderPath, 'package.json'), JSON.stringify(manifest));await writeFile(path.join(folderPath,'index.ts'),'export {};');await writeFile(path.join(folderPath,'index.html'),'<html></html>');
  const storageDir = path.join(testDataDirectory(root)), directory = webProjectDataDirectory(storageDir, reference.id,"main"); await mkdir(directory, { recursive: true });
  const backend = createMemoryRuntimePersistence();
  const persistence = () => backend;
  const snapshot = (now?: number) => readLocalStudioAnalysis({ storageDir, projects: [reference], locale: 'zh-cn', now, persistenceForProject: persistence });
  const revisions = new Map<string, RuntimeHistoryRecord>();
  const history = async (runs: Record<string, unknown>[]) => {
    const lease = await backend.acquire('workflow');
    try {
      for (const previous of await backend.list('run')) if (!runs.some(run => run.id === previous.key)) { await lease.delete(previous); revisions.set(previous.key, { ...previous, revision: previous.revision + 1 }); }
      for (const run of runs) {
        const key = String(run.id), previous = revisions.get(key);
        revisions.set(key, await lease.write({ ...emptyRuntimeRecord('run', key, 'workflow'), revision: previous?.revision ?? 0, state: run }));
      }
    } finally { await lease.close(); }
  };
  const conversations = async (sessions: ConversationSession[]) => {
    for (const session of sessions) {
      const lease = await backend.acquire(session.id);
      try { await lease.write(encodeSession(session, 0)); } finally { await lease.close(); }
    }
  };
  return { root, folderPath, reference, manifest, storageDir, directory, snapshot, history, conversations, persistence, backend };
}

describe('local Studio analysis', () => {
  it('reads all historical runs without parameters, content, credentials or report details', async () => {
    const f = await fixture();
    await f.history(Array.from({ length: 130 }, (_, index) => ({ id: `run-${index}`, title: 'Main', status: 'success', createdAt: index + 1,
      params: { secret: 'private-value' }, logs: 'private-value', report: { durationMs: 3, output: { items: [{ content: 'private-value' }] } } })));
    const value = await f.snapshot(); expect(value.projects[0].name).toBe('Chinese / Main'); expect(value.projects[0].runs).toHaveLength(130);
    expect(value.projects[0].runs[0]).toMatchObject({ id: 'run-129', status: 'success', durationMs: 3 });
    expect(JSON.stringify(value)).not.toContain('private-value'); expect(value.projects[0].live).toBe(false);
  });
  it('merges live activity, preserves waiting and distinguishes unverified or dead services', async () => {
    const f = await fixture(); await f.history([{ id: 'live', status: 'running' }, { id: 'old', status: 'running' }, { id: 'prompt', pendingInput: {}, status: 'interrupted' }]);
    const writer = createLocalActivityWriter(f.directory, { entryId:"main", id: f.reference.id, projectType: 'workflow' }, () => ({ runs: [{ id: 'live', title: 'Main', status: 'running' }], queued: 2 }), () => {});
    cleanup.push(writer.close); await writer.publish();
    const value = (await f.snapshot()).projects[0]; expect(value.live).toBe(true); expect(value.queued).toBe(2); expect(value.projectType).toBe('workflow');
    expect(value.runs.find(run => run.id === 'live')?.status).toBe('running'); expect(value.runs.find(run => run.id === 'old')?.status).toBe('unknown');
    expect(value.runs.find(run => run.id === 'prompt')?.status).toBe('waiting_for_input');
    const expired = (await f.snapshot(Date.now() + 30_000)).projects[0]; expect(expired.live).toBe(false); expect(expired.runs.find(run => run.id === 'live')?.status).toBe('unknown');
    await writer.close(); expect(await readdir(path.join(f.directory, 'activity'))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(f.directory, 'project.json'), 'utf8')).projectType).toBe('workflow');
  });
  it('another idle Studio window cannot overwrite a live run with its stale copy', async () => {
    const f = await fixture(); await f.history([]);
    const states: LocalRunSummary[][] = [[{ id: 'shared', title: 'Active', status: 'running' }], [{ id: 'shared', title: 'Stale', status: 'interrupted' }]];
    for (const runs of states) {
      const writer = createLocalActivityWriter(f.directory, { entryId:"main", id: f.reference.id, projectType: 'workflow' }, () => ({ runs, queued: 0 }), () => {});
      cleanup.push(writer.close); await writer.publish();
    }
    expect((await f.snapshot()).projects[0].runs[0].status).toBe('running');
  });
  it('an idle service never republishes a completed or deleted run from its startup history', async () => {
    const f = await fixture(); await f.history([{ id: 'done', title: 'Done', status: 'success' }]);
    const stale = createLocalActivityWriter(f.directory, { entryId:"main", id: f.reference.id, projectType: 'workflow' }, () => ({ runs: [{ id: 'done', title: 'Old', status: 'interrupted' }], queued: 0 }), () => {});
    cleanup.push(stale.close); await stale.publish();
    expect((await f.snapshot()).projects[0].runs[0].status).toBe('success');
    await f.history([]);
    expect((await f.snapshot()).projects[0].runs).toEqual([]);
  });
  it('uses committed terminal history while live activity remains a temporary projection', async () => {
    const f = await fixture(); await f.history([]);
    let runs: LocalRunSummary[] = [];
    const writer = createLocalActivityWriter(f.directory, { entryId:"main", id: f.reference.id, projectType: 'workflow' }, () => ({ runs, queued: 0 }), () => {});
    cleanup.push(writer.close); await writer.publish();
    runs = [{ id: 'owned', title: 'New run', status: 'running' }]; await writer.publish();
    expect((await f.snapshot()).projects[0].runs[0].status).toBe('running');
    runs[0].status = 'success'; await writer.publish();
    expect((await f.snapshot()).projects[0].runs).toEqual([]);
    await f.history([{ ...runs[0] }]);
    expect((await f.snapshot()).projects[0].runs[0].status).toBe('success');
    await f.history([]);
    expect((await f.snapshot()).projects[0].runs).toEqual([]);
  });
  it('counts a persisted queued input once across multiple service leases', async () => {
    const f = await fixture('bot'); await f.history([]);
    for (let index = 0; index < 2; index++) {
      const writer = createLocalActivityWriter(f.directory, { entryId:"main", id: f.reference.id, projectType: 'bot' }, () => ({ runs: [], queued: 1, queuedInputIds: ['queued-input'] }), () => {});
      cleanup.push(writer.close); await writer.publish();
    }
    expect((await f.snapshot()).projects[0].queued).toBe(1);
  });
  it('uses the current project type when a folder retains history from another type', async () => {
    const f = await fixture('bot'); await f.history([{ id: 'old-workflow', title: 'Old workflow', status: 'success' }]);
    await writeFile(path.join(f.directory, 'project.json'), JSON.stringify({ version: 1, projectId: f.reference.id, entryId:'main', projectType: 'bot' }));
    await f.conversations([{ id: 'chat', title: 'Chat', messages: [
      { id: 'answer', role: 'assistant', content: '', status: 'success', createdAt: 10 },
    ] }]);
    const conversation = (await f.snapshot()).projects[0]; expect(conversation.projectType).toBe('bot');
    expect(conversation.runs.map(run => run.id)).toEqual(['answer']);
    f.manifest.entries[0]!.type='kanban';f.manifest.entries[0]!.entry='index.html';await writeProjectFixture(path.join(f.folderPath,'package.json'),JSON.stringify(f.manifest));
    const board = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects: [{ ...f.reference, projectType: 'kanban' }] });
    expect(board.projects[0].runs).toEqual([]);
    await writeFile(path.join(f.directory, 'runs.json'), 'invalid old history');
    expect((await f.snapshot()).projects[0].availability).toBe('available');
  });
  it('preserves conversation session context when live summaries replace persisted turns', async () => {
    const f = await fixture('bot');
    const sessions: ConversationSession[] = [{ id: 'chat', title: 'Chat', messages: [{ id: 'answer', role: 'assistant', content: '', status: 'running' }] }];
    await f.conversations(sessions);
    const writer = createLocalActivityWriter(f.directory, { entryId:"main", id: f.reference.id, projectType: 'bot' }, () => ({ runs: summarizeLocalRuns(undefined, sessions), queued: 0 }), () => {});
    cleanup.push(writer.close); await writer.publish();
    expect((await f.snapshot()).projects[0].runs[0]).toMatchObject({ id: 'answer', status: 'running', sessionId: 'chat' });
  });
  it('prefers the current workspace reference over an imported alias of the same real folder', async () => {
    const f = await fixture(), link = path.join(f.root, 'link'); await symlink(f.folderPath, link, process.platform === 'win32' ? 'junction' : 'dir');
    const value = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects: [
      { ...f.reference, folderPath: link, uri: pathToFileURL(link).href, inWorkspace: false },
      { ...f.reference, inWorkspace: true, projectType: 'workflow' },
    ] });
    expect(value.projects).toHaveLength(1); expect(value.projects[0]).toMatchObject({ uri: f.reference.uri, inWorkspace: true, projectType: 'workflow' });
  });
  it('accepts matching UUIDs regardless of letter case in activity metadata', async () => {
    const f = await fixture(); await f.history([{ id: 'run', status: 'running' }]);
    const writer = createLocalActivityWriter(f.directory, { entryId:"main", id: f.reference.id.toUpperCase(), projectType: 'workflow' }, () => ({ runs: [{ id: 'run', title: 'Live', status: 'running' }], queued: 0 }), () => {});
    cleanup.push(writer.close); await writer.publish();
    expect((await f.snapshot()).projects[0]).toMatchObject({ live: true, projectType: 'workflow', runs: [{ id: 'run', status: 'running' }] });
  });
  it('reports a confirmed exited service as interrupted while preserving completed history', async () => {
    const f = await fixture(); await f.history([{ id: 'run', status: 'running' }, { id: 'done', status: 'success' }]);
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']); const pid = child.pid; await once(child, 'exit');
    await mkdir(path.join(f.directory, 'activity'));
    await writeFile(path.join(f.directory, 'activity/dead.json'), JSON.stringify({ version: 1, projectId: f.reference.id, entryId:'main', projectType: 'workflow', pid, updatedAt: Date.now(),
      runs: [{ id: 'run', status: 'running' }, { id: 'done', status: 'running' }] }));
    const runs = (await f.snapshot()).projects[0].runs;
    expect(runs.find(run => run.id === 'run')?.status).toBe('interrupted'); expect(runs.find(run => run.id === 'done')?.status).toBe('success');
  });
  it('deduplicates real directories and includes local runs for entries using a Server database', async () => {
    const f = await fixture(), link = path.join(f.root, 'link'); await symlink(f.folderPath, link, process.platform === 'win32' ? 'junction' : 'dir');
    const projects = [f.reference, { ...f.reference, folderPath: link }, { ...f.reference, folderPath: path.join(f.root, 'missing'), uri: 'file:///missing', inWorkspace: true }];
    const value = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects }); expect(value.projects).toHaveLength(2); expect(value.projects.find(project => project.inWorkspace)?.availability).toBe('missing');
    await writeFile(path.join(f.folderPath, 'config.json'), JSON.stringify({version:1,databases:{data:'00000000-0000-4000-8000-000000000001'}}));
    expect((await f.snapshot()).projects).toHaveLength(1);
  });
  it('ignores deleted imported folders while retaining readable history and reporting missing workspace projects', async () => {
    const f = await fixture(); await f.history([{ id: 'local-run', status: 'success' }]);
    const deleted = { ...f.reference, folderPath: path.join(f.root, 'deleted-worktree'), uri: 'file:///deleted-worktree', inWorkspace: false };
    const value = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects: [deleted, f.reference] });
    expect(value.projects).toHaveLength(1);
    expect(value.projects[0]).toMatchObject({ availability: 'available', runs: [{ id: 'local-run' }] });
    await rm(f.folderPath, { recursive: true });
    expect((await f.snapshot()).projects).toEqual([]);
    const current = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects: [{ ...f.reference, inWorkspace: true }] });
    expect(current.projects).toHaveLength(1);
    expect(current.projects[0].availability).toBe('missing');
  });
  it('retains imported folder permission failures', async () => {
    const f = await fixture();
    vi.mocked(fs.realpath).mockRejectedValueOnce(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
    const value = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence,
      projects: [{ ...f.reference, inWorkspace: false }] });
    expect(value.projects).toHaveLength(1);
    expect(value.projects[0].availability).toBe('unreadable');
  });
  it('ignores old standalone registrations after their folders become aggregate entries', async () => {
    const f = await fixture(); await f.history([{ id: 'aggregate-run', status: 'success' }]);
    await writeProjectFixture(path.join(f.folderPath, 'package.json'), JSON.stringify({ ...f.manifest,
      entries: [{ ...f.manifest.entries[0], root: 'child' }] }));
    const child = { ...f.reference, id: '00000000-0000-4000-8000-000000000001', folderPath: path.join(f.folderPath, 'child'), entryId: undefined };
    const value = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects: [child, { ...f.reference, inWorkspace: true }] });
    expect(value.projects).toHaveLength(1);
    expect(value.projects[0]).toMatchObject({ id: f.reference.id, entryId: 'main', availability: 'available', runs: [{ id: 'aggregate-run' }] });
    const current = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects: [{ ...child, inWorkspace: true }] });
    expect(current.projects[0].availability).toBe('unreadable');
  });
  it('ignores imports without a project manifest but still reports a missing manifest in the current workspace', async () => {
    const f = await fixture(); await rm(path.join(f.folderPath, 'steamharness.json'));
    await writeFile(path.join(f.folderPath, 'package.json'), JSON.stringify({ id: f.reference.id, steamHarness: { projectType: 'workflow' } }));
    expect((await f.snapshot()).projects).toEqual([]);
    const current = await readLocalStudioAnalysis({ storageDir: f.storageDir, persistenceForProject: f.persistence, projects: [{ ...f.reference, inWorkspace: true }] });
    expect(current.projects[0].availability).toBe('missing');
  });
  it('reads local history from declarations without resolving deployment database bindings', async () => {
    const f = await fixture(); await f.history([{ id: 'local-run', status: 'success' }]);
    await writeProjectFixture(path.join(f.folderPath, 'package.json'), JSON.stringify({ ...f.manifest,
      entries: [{ ...f.manifest.entries[0], databases: ['data'] }] }));
    expect((await f.snapshot()).projects[0]).toMatchObject({ availability: 'available', runs: [{ id: 'local-run' }] });
    await writeFile(path.join(f.folderPath, 'config.json'), 'invalid deployment configuration');
    expect((await f.snapshot()).projects[0]).toMatchObject({ availability: 'available', runs: [{ id: 'local-run' }] });
  });
  it('keeps malformed root declarations unavailable instead of treating them as retired imports', async () => {
    const f = await fixture();
    for (const document of [null, {}, { ...f.manifest, type: 'workflow', id: undefined }, { ...f.manifest, id: '00000000-0000-4000-8000-000000000001' }]) {
      await writeFile(path.join(f.folderPath, 'steamharness.json'), JSON.stringify(document));
      expect((await f.snapshot()).projects[0].availability).toBe('unreadable');
    }
  });
  it('reports storage errors and changed UUIDs as unavailable without reading old JSON', async () => {
    const f = await fixture(); await writeFile(path.join(f.directory, 'runs.json'), 'broken');
    await f.history([{ id: 'committed', status: 'success' }]);
    expect((await f.snapshot()).projects[0].runs).toMatchObject([{ id: 'committed' }]);
    const list = vi.spyOn(f.backend, 'list').mockRejectedValueOnce(new Error('Database unavailable'));
    expect((await f.snapshot()).projects[0].availability).toBe('unreadable'); list.mockRestore();
    await writeProjectFixture(path.join(f.folderPath, 'package.json'), JSON.stringify({ ...f.manifest, id: 'different' }));
    expect((await f.snapshot()).projects[0].availability).toBe('unreadable');
  });
  it('counts conversation assistant turns once and keeps their session context', async () => {
    const sessions: ConversationSession[] = [{ id: 'session', title: 'Chat', messages: [
      { role: 'user', content: 'private' }, { role: 'assistant', id: 'message', runId: 'run', content: 'private', status: 'success', durationMs: 12 },
    ] }];
    expect(summarizeLocalRuns(undefined, sessions)).toEqual([{ id: 'run', title: 'Chat', status: 'success', durationMs: 12, sessionId: 'session', createdAt: undefined, entrypointId: undefined }]);
  });
  it('marks unsupported statuses unknown and omits timestamps outside the Date range', async () => {
    const f = await fixture(); await f.history([{ id: 'unverified', status: 'future-status', createdAt: 1e30 }]);
    expect((await f.snapshot()).projects[0].runs[0]).toMatchObject({ id: 'unverified', status: 'unknown', createdAt: undefined });
  });
  it('reads default local history without an account and ignores old conversation files', async () => {
    const f = await fixture('bot');
    await writeFile(path.join(f.directory, 'conversations.json'), JSON.stringify({ sessions: [{ id: 'old', title: 'Old', messages: [] }] }));
    expect((await f.snapshot()).projects[0]).toMatchObject({ availability: 'available', runs: [] });
    const local = createLocalRuntimePersistence({ directory: path.join(f.directory, 'runtime') });
    try {
      const lease = await local.acquire('offline');
      try { await lease.write(encodeSession({ id: 'offline', title: 'Local', messages: [{ id: 'reply', role: 'assistant', status: 'success', content: 'Private local reply' }] }, 0)); }
      finally { await lease.close(); }
    } finally { await local.close(); }
    const signedOut = await readLocalStudioAnalysis({ storageDir: f.storageDir, projects: [f.reference] });
    expect(signedOut.projects[0]).toMatchObject({ availability: 'available', runs: [{ id: 'reply', title: 'Local', status: 'success', sessionId: 'offline' }] });
    expect(JSON.stringify(signedOut)).not.toContain('Private local reply');
  });
  it('uses only the authenticated read-only loopback operation and never falls back to Server', async () => {
    await expect(requestStudioAnalysis({})).rejects.toHaveProperty('code', 'KANBAN_BRIDGE_UNAVAILABLE');
    await expect(requestStudioAnalysis({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: 'invalid url', STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: 'token' })).rejects.toHaveProperty('code', 'KANBAN_BRIDGE_UNAVAILABLE');
    await expect(requestStudioAnalysis({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: 'https://example.test/studio-control', STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: 'token' })).rejects.toHaveProperty('code', 'KANBAN_BRIDGE_UNAVAILABLE');
    const calls: unknown[] = [];
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe('Bearer test-token'); let body = ''; for await (const chunk of request) body += chunk;
      calls.push(JSON.parse(body)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, value: { version: 1, projects: [] } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    expect(await requestStudioAnalysis({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: `http://127.0.0.1:${port}/studio-control`, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: 'test-token' })).toEqual({ version: 1, projects: [] });
    expect(calls).toEqual([{ operation: 'studio.analysis.get', input: {}, permissionPolicy: 'read-only' }]);
  });
  it('aborts an in-flight Studio query when its preview closes', async () => {
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    const server = createServer((_request, response) => { received(); response.on('close', () => response.end()); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const abort = new AbortController();
    const query = requestStudioAnalysis({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/studio-control`, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: 'token' }, abort.signal);
    await started; abort.abort();
    await expect(query).rejects.toMatchObject({ name: 'AbortError' });
  }, 20_000);
});
