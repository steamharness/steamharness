import { afterEach, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeProjectIdentity } from '../project-identity';
import { projectDataDirectory, projectDataDirectorySync, webProjectDataDirectory } from '../web/project-data-directory';
import { ProjectServerCreation } from '../web/project-server-create';
import { readProjectInfo } from '@steamharness/project-info';
import type { Project } from '../web/workflow-types';

const oldId = '8bd4fef2-e083-4201-a89f-6f7d0676df53', newId = '78648759-bcde-4fd5-b3bd-9a2dd46a7192';
const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'project-identity-')); temporary.push(directory);
  const pkg = { id: oldId, name: 'Keep name', scripts: { dev: 'keep this' }, steamHarness: { defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'workflow',root:'.',entry:'index.ts',databases:[]}],  } };
  const source = JSON.stringify(pkg, null, '\t').replaceAll('\n', '\r\n') + '\r\n';
  const filename = path.join(directory, 'package.json'); await writeFile(filename, source);
  return { directory, filename, source, pkg };
}

it('replaces only project identity, preserves formatting, and refuses concurrent edits or cancellation', async () => {
  const f = await fixture();
  await expect(writeProjectIdentity(f.directory, f.source, '111')).rejects.toThrow();
  await expect(writeProjectIdentity(f.directory, f.source, newId, AbortSignal.abort())).rejects.toHaveProperty('name', 'AbortError');
  await writeFile(f.filename, f.source + ' ');
  await expect(writeProjectIdentity(f.directory, f.source, newId)).rejects.toThrow();
  expect(await readFile(f.filename, 'utf8')).toBe(f.source + ' ');
  await writeFile(f.filename, f.source); await writeProjectIdentity(f.directory, f.source, newId);
  const saved = await readFile(f.filename, 'utf8');
  expect(JSON.parse(saved)).toEqual({ ...f.pkg, id: newId }); expect(saved).toContain('\r\n\t');
  expect(await readdir(f.directory)).toEqual(['package.json']);
});

it('isolates history by project and entry without adopting directory metadata', async () => {
 const f=await fixture(),storage=path.join(f.directory,'storage');
 const root=webProjectDataDirectory(storage,oldId,'one');
 expect(await projectDataDirectory(storage,f.directory,oldId,'one')).toBe(root);
 expect(projectDataDirectorySync(storage,f.directory,oldId,'two')).not.toBe(root);
 expect(await projectDataDirectory(storage,f.directory,newId,'one')).not.toBe(root);
 expect(await projectDataDirectory(storage,f.directory,oldId,'one')).toBe(root);
 await expect(projectDataDirectory(storage,f.directory,oldId,'../../escape')).rejects.toThrow();
});

it('prevents competing windows from overwriting each other with different allocated IDs', async () => {
  const f = await fixture(), otherId = '44444444-4444-4444-8444-444444444444';
  const results = await Promise.allSettled([writeProjectIdentity(f.directory, f.source, newId), writeProjectIdentity(f.directory, f.source, otherId)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const expectedId = results[0].status === 'fulfilled' ? newId : otherId;
  expect(JSON.parse(await readFile(f.filename, 'utf8')).id).toBe(expectedId);
  expect(await readdir(f.directory)).toEqual(['package.json']);
});

it('releases the identity lock when its owner crashes so the user can retry', async () => {
  const f = await fixture(), ownerScript = path.join(f.directory, 'lock-owner.mjs');
  await writeFile(ownerScript, `
    import { createHash } from 'node:crypto';
    import { mkdirSync, realpathSync } from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    const directory = realpathSync(process.argv[2]);
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    const root = path.join(os.tmpdir(), 'steamharness-project-identity');
    mkdirSync(root, { recursive: true });
    const database = new DatabaseSync(path.join(root, createHash('sha256').update(key).digest('hex') + '.sqlite'));
    database.exec('BEGIN EXCLUSIVE');
    process.send('locked');
    setInterval(() => {}, 1000);
  `);
  const owner = fork(ownerScript, [f.directory], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(owner, 'message', { signal: AbortSignal.timeout(5_000) });
    await expect(writeProjectIdentity(f.directory, f.source, newId)).rejects.toThrow();
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    await writeProjectIdentity(f.directory, f.source, newId);
    expect(JSON.parse(await readFile(f.filename, 'utf8')).id).toBe(newId);
  } finally { owner.kill('SIGKILL'); }
});

it('locks separate confirmations and reuses an allocated ID when a concurrent manifest edit prevents applying it', async () => {
  const f = await fixture();
  const connection = { serverUrl: 'https://allocation.test', accessToken: 'test-token' };
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:f.directory,databases:[],entries:[{entryId:"main",name:"Main",type:'workflow',root:".",entry:"index.ts",databases:[]}], id: oldId, name: 'Keep name', uri: f.directory, folderPath: f.directory, projectType: 'workflow', fields: [], entrypoints: [], projectInfo: readProjectInfo(f.pkg) };
  const posts: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method === 'POST') { posts.push(JSON.parse(String(options.body))); return Response.json({ errCode: 0, data: { projectId: newId, projectType: 'workflow' } }); }
    return String(url).includes('/api/groups?') ? Response.json({ errCode: 0, data: { items: [], total: 0 } }) : new Response('', { status: 404 });
  });
  let edit = true;
  const creation = new ProjectServerCreation(project, () => connection, () => 'user', () => ({ kind: 'project-unavailable' }), async () => {
    if (edit) { edit = false; await writeFile(f.filename, f.source + ' '); }
  });
  try {
    const a = await creation.prepare(), b = await creation.prepare();
    const first = creation.confirm({ token: a.token, confirmed: true, name: 'Reviewed' });
    await expect(creation.confirm({ token: b.token, confirmed: true, name: 'Other' })).rejects.toThrow('already in progress');
    await expect(first).rejects.toThrow(); expect(posts).toHaveLength(1); expect(posts[0]).not.toHaveProperty('projectId');
    await writeFile(f.filename, f.source);
    await expect(creation.confirm({ token: a.token, confirmed: true, name: 'Changed' })).rejects.toThrow('already allocated');
    expect(await creation.confirm({ token: a.token, confirmed: true, name: 'Reviewed' })).toBe(newId);
    expect(posts).toHaveLength(1); expect(JSON.parse(await readFile(f.filename, 'utf8')).id).toBe(newId);
  } finally { creation.close(); }
});
