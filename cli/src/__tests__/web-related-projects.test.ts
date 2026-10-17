import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as core from 'workflow-code';
import { createWebRuntime } from '../web/runtime';
import { createWebRelatedProjectRuntime } from '../web/related-projects';
import { webProjectDataDirectory } from '../web/kanban-data';
import { parseHostRelatedProjects } from '../web/host-config';

const consumerId = '33333333-3333-4333-8333-333333333333';
const targetId = '44444444-4444-4444-8444-444444444444';
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('validates explicit host bindings and rejects relative paths, duplicate aliases and duplicate directories', () => {
  const projectDir = path.join(os.tmpdir(), 'imported-database');
  const binding = { alias: 'database', projectDir };
  expect(parseHostRelatedProjects([binding])).toEqual([binding]);
  expect(parseHostRelatedProjects(undefined)).toEqual([]);
  for (const value of [null, {}, [null], [{ alias: 'Database', projectDir }], [{ alias: 'database', projectDir: '../database' }],
    [binding, binding], [binding, { alias: 'other', projectDir }]]) { expect(() => parseHostRelatedProjects(value)).toThrow('Invalid host related projects'); }
});

it('executes imported related KV, knowledge and entrypoints using the target Web storage, then applies removal and revocation', async () => {
  const fixture = await createFixture();
  const directory = webProjectDataDirectory(fixture.storageDir, fixture.targetDir);
  const store = core.createLocalWorkflowKVStore({ rootDir: path.join(directory, 'kv'), storageKind: 'kv' });
  const kv = core.createWorkflowKVContext({ projectId: targetId, store });
  await kv.setValue('visible:value', 'Imported database value');
  const persistentValue = core.createWorkflowPersistentValueContext({ projectId: targetId,
    store: core.createLocalWorkflowKVStore({ rootDir: path.join(directory, 'values'), storageKind: 'persistent_value' }) });
  await core.createKnowledgeDocument({ persistentValue }, { title: 'Imported document', markdown: '# Target knowledge' });
  let bindings: { alias: string; projectDir: string }[] = [];
  const runtime = createWebRuntime(fixture.consumerDir, fixture.storageDir, () => undefined, () => bindings);
  try {
    const inspection = await runtime.inspect([fixture.consumerDir]);
    expect(inspection.errors).toEqual([]);
    const project = { ...inspection.projects[0], uri: '' };
    const run = () => runtime.run({ project, conversationId: 'related-test', runId: 'related-test', args: [] }, () => {});
    expect((await run()).status).toBe('failed');
    bindings = [{ alias: 'database', projectDir: fixture.targetDir }];
    const report = await run();
    expect(report.status, JSON.stringify(report)).toBe('success');
    expect(report.output?.items?.[0].content).toMatchObject({ value: 'Imported database value',
      documents: { items: [{ title: 'Imported document' }] }, entrypoint: { value: 'Imported database value' } });
    const consumerStore = core.createLocalWorkflowKVStore({ rootDir: path.join(webProjectDataDirectory(fixture.storageDir, fixture.consumerDir), 'kv'), storageKind: 'kv' });
    expect(await consumerStore.getValue({ projectId: targetId, storageKind: 'kv', scope: 'project', key: 'visible:value' })).toBeUndefined();
    bindings = [];
    expect((await run()).status).toBe('failed');
    bindings = [{ alias: 'database', projectDir: fixture.targetDir }];
    const manifest = JSON.parse(await readFile(path.join(fixture.targetDir, 'package.json'), 'utf8'));
    manifest.workflowCode.projectInfo.relatedProjects = [];
    await writeFile(path.join(fixture.targetDir, 'package.json'), JSON.stringify(manifest));
    await expect(run()).rejects.toThrow('not confirmed by both project manifests');
    manifest.id = consumerId;
    await writeFile(path.join(fixture.targetDir, 'package.json'), JSON.stringify(manifest));
    await expect(run()).rejects.toThrow('does not declare related project');
  } finally { runtime.dispose(); }
}, 30_000);

it('uses the project Core for server KV and knowledge and rechecks grants and identities on each access', async () => {
  const fixture = await createFixture('server');
  const namespace = { getValue: vi.fn(async () => 'server value'), setValue: vi.fn(), updateValue: vi.fn() };
  const remoteStore = { getValue: vi.fn(), setValue: vi.fn() };
  const api = { ...core, createRemoteWorkflowRelatedProjectKVStoreFromEnv: vi.fn(() => remoteStore),
    createWorkflowKVContext: vi.fn(() => namespace), createWorkflowPersistentValueContext: vi.fn(() => namespace) };
  const related = createWebRelatedProjectRuntime(api as unknown as typeof core, { projectDir: fixture.consumerDir, storageDir: fixture.storageDir,
    relatedProjects: [{ alias: 'database', projectDir: fixture.targetDir }], runId: 'server-test' });
  expect(related.localResolver?.resolve('database')).toBeUndefined();
  const target = related.serverResolver?.resolve('database');
  expect(target?.persistentValue).toBe(namespace);
  expect(api.createRemoteWorkflowRelatedProjectKVStoreFromEnv).toHaveBeenCalledWith(expect.objectContaining({
    consumerProjectId: consumerId, targetProjectId: targetId, alias: 'database', env: process.env }));
  expect(api.createWorkflowPersistentValueContext).toHaveBeenCalledWith(expect.objectContaining({ store: remoteStore, projectId: targetId }));
  const manifest = JSON.parse(await readFile(path.join(fixture.targetDir, 'package.json'), 'utf8'));
  manifest.workflowCode.projectInfo.relatedProjects = [];
  await writeFile(path.join(fixture.targetDir, 'package.json'), JSON.stringify(manifest));
  expect(related.serverResolver?.resolve('database')).toBeUndefined();
});

async function createFixture(location = 'local') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'web-related-'))); temporary.push(root);
  const consumerDir = path.join(root, 'workspace', 'consumer'), targetDir = path.join(root, 'imported', 'database');
  let coreRoot = path.dirname(fileURLToPath(import.meta.resolve('workflow-code')));
  for (let depth = 0; depth < 8; depth++) {
    try { if (JSON.parse(await readFile(path.join(coreRoot, 'package.json'), 'utf8')).name === 'workflow-code') { break; } } catch {}
    coreRoot = path.dirname(coreRoot);
  }
  const relation = (alias: string, projectId: string) => ({ alias, projectId, grantToRelatedProject: {
    read: { mode: 'all' }, write: { mode: 'none' }, knowledge: { read: { mode: 'all' }, write: { mode: 'none' } }, entrypoints: { mode: 'all' },
  } });
  for (const [directory, id, relatedProjects] of [[consumerDir, consumerId, [relation('database', targetId)]], [targetDir, targetId, [relation('consumer', consumerId)]]] as const) {
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await symlink(coreRoot, path.join(directory, 'node_modules/workflow-code'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ id, name: path.basename(directory), type: 'module',
      workflowCode: { projectInfo: { dataStorage: { mode: directory === targetDir ? location : 'both' }, relatedProjects } } }));
  }
  await writeFile(path.join(consumerDir, 'index.ts'), `
    const flow = workflow.defineWorkflow({ name: 'related-consumer', async run(input, context) {
      const database = context.storage.local.relatedProjects.get('database');
      return { errCode: 0, errMessage: '', value: await database.kv.getValue('visible:value'),
        documents: await database.knowledge.listDocuments(), entrypoint: await database.runEntrypoint('read', []) };
    } });
    export const executor = workflow.defineExecutor({ projectType: 'conversation', workflow: flow,
      createInput() { return {}; } });
  `);
  await writeFile(path.join(targetDir, 'index.ts'), `
    const flow = workflow.defineWorkflow({ name: 'related-target', async run(input, context) {
      return { errCode: 0, errMessage: '', value: await context.storage.local.kv.getValue('visible:value') };
    } });
    export const executor = workflow.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'read',
      entrypoints: [workflow.defineEntrypoint({ id: 'read', title: 'Read', workflow: flow, createInput() { return {}; } })] });
  `);
  return { root, consumerDir, targetDir, storageDir: path.join(root, 'web') };
}
