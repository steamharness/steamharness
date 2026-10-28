import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { LocalDatabaseRegistry, createDatabasesContext, createEntriesContext, createLocalDatabaseResolver, readProjectManifestFromDirectorySync, runLocalProjectWithReport, type KVStore, type ProjectManifest } from 'steamharness';

const permissions = {kv:{read:{mode:'all' as const},write:{mode:'all' as const}},knowledge:{read:{mode:'all' as const},write:{mode:'all' as const}}};
const directories: string[] = [];
afterAll(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive:true,force:true}); });

/** Explicit host approval in isolated test storage; never touches the user's registry. */
export function createApprovedTestContext() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'example-database-context-'));
  directories.push(directory);
  const registry = new LocalDatabaseRegistry(directory);
  const projectId = randomUUID(), entryId = 'main';
  const request = registry.request({projectId,entryId,alias:'data',permissions,target:{kind:'create',name:'Example test'}});
  const {databaseId} = registry.review(request.requestId,{approve:true});
  const requirements = [{alias:'data',databaseId:databaseId!}];
  const manifest: ProjectManifest = {projectId,name:'Example',defaultEntry:entryId,entries:[{entryId,type:'workflow',name:'Example',root:'.',entry:'index.ts',databases:requirements}]};
  return {projectId,entryId,
    databases:createDatabasesContext({projectId,entryId,conversationId:'fixture-thread',requirements,resolver:createLocalDatabaseResolver(registry)}),
    entries:createEntriesContext(manifest,{projectId,sourceEntryId:entryId,actor:{isSystemAdmin:false}}, {
      async list(){throw new Error('No cross-entry calls in this fixture');},async run(){throw new Error('No cross-entry calls in this fixture');},
    }),
  };
}

/** Copy and bind a sample before a real run. The published sample stays unbound. */
export async function runApprovedProject(options: Parameters<typeof runLocalProjectWithReport>[0], databaseStore?: KVStore) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'example-approved-run-'));
  const projectDir = path.join(directory,'project');
  try {
    await cp(options.projectDir,projectDir,{recursive:true,filter: source => !path.relative(options.projectDir,source).split(path.sep).some(part => ['node_modules','.git','dist','.data','.artifacts'].includes(part))});
    await symlink(path.join(options.projectDir,'node_modules'),path.join(projectDir,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
    const manifest = readProjectManifestFromDirectorySync(projectDir, {});
    const registry = new LocalDatabaseRegistry(path.join(directory,'databases'));
    const databases: Record<string, string> = {};
    for (const entry of manifest.entries) for (const requirement of entry.databases) {
      const spaceId = databases[requirement.alias];
      const target = spaceId ? { kind: 'access' as const, spaceId } : { kind: 'create' as const, name: `Test / ${requirement.alias}` };
      const request=registry.request({projectId:manifest.projectId,entryId:entry.entryId,alias:requirement.alias,permissions,target});
      databases[requirement.alias]=registry.review(request.requestId,{approve:true}).databaseId!;
    }
    await writeFile(path.join(projectDir,'config.json'),JSON.stringify({version:1,databases}));
    const resolver=createLocalDatabaseResolver(registry);
    return await runLocalProjectWithReport({...options,projectDir,databaseResolver:{async resolve(requirement,consumer){
      const resolved=await resolver.resolve(requirement,consumer);return resolved && databaseStore ? {...resolved,store:databaseStore} : resolved;
    }}});
  } finally { await rm(directory,{recursive:true,force:true}); }
}
