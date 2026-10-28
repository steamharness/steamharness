import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalDatabaseRegistry, createLocalDatabaseResolver, createDatabasesContext } from 'steamharness';
import { startEntryWebServer } from '../web/server';
import { ProjectServerConnection } from '../web/project-server-state';
import { projectStartupInspector } from '../web/project-startup-checks';
import type { Project, ProjectKind, Runtime } from '../web/workflow-types';

const id = 'aaa10f6d-c322-461a-aecd-56d644d227c5';
const permissions = { kv: { read: { mode: 'all' as const }, write: { mode: 'all' as const } }, knowledge: { read: { mode: 'all' as const }, write: { mode: 'all' as const } } };
const apps: Awaited<ReturnType<typeof startEntryWebServer>>[] = [], folders: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(kind: ProjectKind, database = true) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'database-startup-'))); folders.push(directory);
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  const requirement = { alias: 'data', databaseId: crypto.randomUUID() };
  const registration = { entryId: 'main', name: 'Main', type: kind, root: '.', entry: kind === 'kanban' ? 'index.html' : 'index.ts', databases: database ? [requirement] : [] };
  const pkg = { id, name: 'Application', steamHarness: { defaultEntry: 'main', entries: [{...registration,databases:registration.databases.map(database=>database.alias)}] } };
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(pkg));
  if (database) await writeFile(path.join(directory, 'config.json'), JSON.stringify({version:1,databases:{data:requirement.databaseId}}));
  await writeFile(path.join(directory, registration.entry), kind === 'kanban' ? '<html></html>' : 'export {};');
  const project: Project = { id, entryId: 'main', uri: directory, folderPath: directory, entryRoot: directory, name: 'Main', aggregateName: pkg.name,
    defaultEntry: 'main', entries: [registration], databases: registration.databases, projectType: kind, fields: [{name:'subject',type:'string',flag:'--subject'}], entrypoints: [], ...(kind === 'kanban' ? { kanban: { artifactDir: '.', entry: 'index.html' } } : {}) };
  const runtime: Runtime = { available: true, inspect: vi.fn(async () => ({ projects: [project], errors: [] })), resolveParams: vi.fn(async () => ({ params: {} })),
    run: vi.fn(async () => ({ status: 'success' })), kanbanBridge: vi.fn(), uploadFiles: vi.fn(async () => []), readFile: vi.fn(), readResource: vi.fn(),
    deleteFiles: vi.fn(), deleteConversation: vi.fn(), cancelConversation: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
  const app = await startEntryWebServer({ projectDir: directory, dataDir: path.join(directory, 'history'), runtime }); apps.push(app);
  const capability = new URL(app.url).hash.slice('#session='.length);
  const post = (body: object) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = () => post({ type: 'ready' }).then(r => r.json()).then(r => r.messages[0]);
  const settled = async () => { let result: any; await vi.waitFor(async () => { result = await state(); expect(result.serverData.checking).toBe(false); }); return result; };
  return { app, runtime, post, state, settled, directory, project, pkg, registry: new LocalDatabaseRegistry() };
}
it.each(['workflow', 'conversation', 'kanban'] as const)('opens unbound %s with management available and does not create a space', async kind => {
  const f = await fixture(kind);
  expect((await f.settled()).serverData).toMatchObject({ blocking: true, checks: [{ stage: 'database', status: 'action-required', database: 'data' }] });
  expect(f.registry.read().spaces).toEqual([]);
  const action = kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'Run', params: {}, attachments: [] };
  if (kind !== 'kanban') expect((await f.post(action)).status).toBe(400);
  expect((await f.post({ type: 'databases', action: 'get' })).ok).toBe(true);
  expect(f.runtime.run).not.toHaveBeenCalled();
});
it.each(['workflow', 'conversation'] as const)('preserves %s drafts through request, approval, binding and revocation', async kind => {
  const f = await fixture(kind); await f.settled();
  const draft = kind === 'workflow' ? { type: 'workflow-draft', params: { subject: 'Keep' } } : { type: 'draft', text: 'Keep', attachments: [] };
  await f.post(draft);
  expect((await f.post({ type: 'databases', action: 'request', host: 'local', alias: 'data', permissions, target: { kind: 'create', name: 'Data' } })).ok).toBe(true);
  const pending = f.registry.read().requests[0]!;
  expect(pending.status).toBe('pending'); expect(f.registry.read().spaces).toEqual([]);
  expect((await f.post({ type: 'databases', action: 'review', host: 'local', databaseRequestId: pending.requestId, approve: true })).ok).toBe(true);
  expect((await f.settled()).serverData.issue).toBeDefined();
  const approved = f.registry.read().requests[0]!;
  expect((await f.post({ type: 'databases', action: 'bind', host: 'local', alias: 'data', databaseId: approved.databaseId })).ok).toBe(true);
  expect((await f.settled()).serverData.issue).toBeUndefined(); expect(f.runtime.run).not.toHaveBeenCalled();
  const state = await f.state();
  if (kind === 'workflow') expect(state.drafts[''].values.subject).toBe('Keep'); else expect(state.sessions[0].draft.text).toBe('Keep');
  const action = kind === 'workflow' ? { type: 'workflow-run', params: {} } : { type: 'send', text: 'Run', params: {}, attachments: [] };
  expect((await f.post(action)).ok).toBe(true);
  await (kind === 'workflow' ? f.app.projectController!.idle() : f.app.controller!.idle());
  expect(f.runtime.run).toHaveBeenCalledOnce();
  const grant = f.registry.read().grants[0]!;
  await f.post({ type: 'databases', action: 'revoke', host: 'local', grantId: grant.grantId });
  expect((await f.settled()).serverData.issue).toBeDefined();
  expect((await f.post(action)).status).toBe(400); expect(f.registry.read().spaces).toHaveLength(1);
});
it.each(['workflow', 'conversation', 'kanban'] as const)('runs %s without a database or Server registration', async kind => {
  const f = await fixture(kind, false);
  // A mapping used by another entry is not a requirement of this entry.
  await writeFile(path.join(f.directory, 'config.json'), JSON.stringify({version:1,databases:{unused:crypto.randomUUID()}}));
  expect((await f.settled()).serverData).toMatchObject({ blocking: false, checks: [] });
});
it('recovers from a previous data error by checking the live grant rather than replaying a mutation', async () => {
  const f = await fixture('workflow'); await f.settled();
  const request = f.registry.request({ projectId: id, entryId: 'main', alias: 'data', permissions, target: { kind: 'create', name: 'Data' } });
  const approved = f.registry.review(request.requestId, { approve: true });
  f.project.databases[0]!.databaseId = approved.databaseId!;
  const db = createDatabasesContext({ projectId: id, entryId: 'main', requirements: f.project.databases, resolver: createLocalDatabaseResolver(f.registry) });
  const connection = { serverUrl: 'https://unused.test', accessToken: 'token' };
  const monitor = new ProjectServerConnection(id, () => connection, vi.fn(), { inspect: projectStartupInspector(f.project, alias => db.get(alias).getBinding()) });
  try {
    await monitor.reportFailure({ ...connection, projectId: id, entryId: 'main', database: 'data', status: 403 });
    expect(monitor.state.issue).toBeUndefined();
    f.registry.revoke(f.registry.read().grants[0]!.grantId); await monitor.refresh();
    expect(monitor.state.issue).toMatchObject({ kind: 'setup-required', database: 'data' });
  } finally { monitor.close(); }
});
