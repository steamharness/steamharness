import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalDatabaseRegistry, createLocalDatabaseResolver, createDatabasesContext } from 'steamharness';
import { startEntryWebServer } from './web-test-storage';
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
  const registration = { entryId: 'main', name: 'Main', type: kind, root: '.', entry: kind === 'kanban' ? 'index.html' : 'index.ts', databases: [], knowledgeBases: database ? [{alias: 'data', knowledgeBaseId: requirement.databaseId}] : [] };
  const pkg = { id, name: 'Application', version: "0.1.0",  defaultEntry: 'main', entries: [{...registration,databases:[],knowledgeBases:registration.knowledgeBases.map(base=>base.alias)}]  };
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify(pkg));
  if (database) await writeFile(path.join(directory, 'config.json'), JSON.stringify({version:1,knowledgeBases:{data:requirement.databaseId}}));
  await writeFile(path.join(directory, registration.entry), kind === 'kanban' ? '<html></html>' : 'export {};');
  const project: Project = { id, entryId: 'main', uri: directory, folderPath: directory, entryRoot: directory, name: 'Main', aggregateName: pkg.name,
    defaultEntry: 'main', entries: [registration], databases: registration.databases, knowledgeBases:registration.knowledgeBases, projectType: kind, fields: [{name:'subject',type:'string',flag:'--subject'}], entrypoints: [], ...(kind === 'kanban' ? { kanban: { artifactDir: '.', entry: 'index.html' } } : {}) };
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
it.each(['workflow', 'conversation', 'kanban'] as const)('opens an unbound %s knowledge requirement without creating local data', async kind => {
  const f = await fixture(kind);
  expect((await f.settled()).serverData).toMatchObject({blocking:true, checks:[{stage:'database',status:'action-required',database:'data'}]});
  expect(f.registry.read().spaces).toEqual([]);
  if (kind !== 'kanban') expect((await f.post(kind === 'workflow' ? {type:'workflow-run',params:{}} : {type:'send',text:'Run',params:{},attachments:[]})).status).toBe(400);
  expect(f.runtime.run).not.toHaveBeenCalled();
});
it.each(['workflow', 'conversation'] as const)('keeps %s drafts when a removed local management request is rejected', async kind => {
  const f = await fixture(kind); await f.settled();
  await f.post(kind === 'workflow' ? {type:'workflow-draft',params:{subject:'Keep'}} : {type:'draft',text:'Keep',attachments:[]});
  expect((await f.post({type:'databases',action:'request',host:'local',alias:'data',target:{kind:'create',name:'Data'}})).status).toBe(400);
  const state = await f.state();
  if (kind === 'workflow') expect(state.drafts[''].values.subject).toBe('Keep'); else expect(state.sessions[0].draft.text).toBe('Keep');
  expect(f.registry.read().spaces).toEqual([]); expect(f.runtime.run).not.toHaveBeenCalled();
});
it.each(['workflow', 'conversation', 'kanban'] as const)('runs %s without a declared knowledge resource', async kind => {
  const f = await fixture(kind, false);
  await writeFile(path.join(f.directory,'config.json'),JSON.stringify({version:1,knowledgeBases:{unused:crypto.randomUUID()}}));
  expect((await f.settled()).serverData).toMatchObject({blocking:false,checks:[]});
});
it('checks live knowledge bindings after refresh and never retries the original mutation', async () => {
  const f = await fixture('workflow'); let revoked=false;
  const verify=vi.fn(async (_alias:string,kind?:string)=>{ expect(kind).toBe('knowledge-bases'); if(revoked) throw new Error('Revoked'); return {}; });
  const monitor=new ProjectServerConnection(id,()=>undefined,vi.fn(),{inspect:projectStartupInspector(f.project,verify)});
  try {
    await monitor.refresh(); expect(monitor.state.issue).toBeUndefined();
    revoked=true; await monitor.refresh(); expect(monitor.state.issue).toMatchObject({kind:'setup-required',database:'data'});
    expect(f.runtime.run).not.toHaveBeenCalled();
  } finally {monitor.close();}
});
