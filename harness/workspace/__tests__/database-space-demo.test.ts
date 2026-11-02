import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { bindProjectKnowledgeBase, inspectAggregateProjectStructure, readEntrypointOutput, runLocalProjectWithReport, executeKnowledgeBaseOperation, type KnowledgeBaseHost } from 'steamharness';
import { createMemoryRuntimePersistence } from 'steamharness/runtime-storage';
import { createExampleKnowledgeBases } from '../test-databases';

it('shares an explicitly bound knowledge resource between entries and projects and rejects revoked access', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-demo-'));
  const projectDir = path.join(directory, 'project'), baseId = randomUUID();
  const approved = new Map<string, string>();
  const repository = createExampleKnowledgeBases().get('data');
  const host: KnowledgeBaseHost = {
    async resolve(identity) {
      const id = approved.get(`${identity.projectId}:${identity.entryId}`);
      if (!id || identity.knowledgeBaseId !== baseId) throw new Error('Knowledge access is not approved.');
      return { id, knowledgeBaseId: baseId, revision: 1, accessRevision: 1, mode: 'write' };
    },
    async operation<T>(identity, _binding, operation, input): Promise<T> {
      await host.resolve(identity);
      return executeKnowledgeBaseOperation(repository, operation, input as Record<string, unknown>) as Promise<T>;
    },
  };
  try {
    await cp(path.resolve(import.meta.dirname, '../workflow/database-space-demo'), projectDir, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(projectDir, 'steamharness.json'), 'utf8'));
    const options = (entryId: string, target = projectDir) => ({ projectDir: target, entryId, env: {}, knowledgeBaseHost: host, storage: { host: 'local' as const, local: { kvStoreDir: path.join(directory, 'runtime'), runtimePersistence: createMemoryRuntimePersistence() } } });
    const run = async (entryId: string, action: string, target = projectDir) => {
      const report = await runLocalProjectWithReport({ ...options(entryId, target), args: ['--action', action, '--value', 'shared'] });
      expect(report.status, JSON.stringify(report.result)).toBe('success');
      return report.result.ok ? readEntrypointOutput(report.result.data) as { value: any } : undefined;
    };
    const grant = async (target: string, projectId: string, entryId: string) => {
      approved.set(`${projectId}:${entryId}`, randomUUID());
      await bindProjectKnowledgeBase(target, entryId, 'data', baseId);
    };
    expect(inspectAggregateProjectStructure(projectDir).entries.map(entry => entry.projectType)).toEqual(['workflow', 'workflow']);
    expect((await runLocalProjectWithReport({ ...options('writer'), args: ['--action', 'write'] })).status).toBe('failed');
    await grant(projectDir, manifest.id, 'writer'); await grant(projectDir, manifest.id, 'reader');
    expect((await run('writer', 'write'))?.value).toMatchObject({ markdown: 'shared' });
    expect((await run('reader', 'read'))?.value).toMatchObject({ markdown: 'shared' });
    expect((await run('writer', 'call'))?.value).toMatchObject({ value: { markdown: 'shared' } });
    const otherDir = path.join(directory, 'other'); await cp(projectDir, otherDir, { recursive: true });
    manifest.id = randomUUID(); await writeFile(path.join(otherDir, 'steamharness.json'), JSON.stringify(manifest));
    await grant(otherDir, manifest.id, 'reader');
    expect((await run('reader', 'read', otherDir))?.value).toMatchObject({ markdown: 'shared' });
    approved.delete(`${manifest.id}:reader`);
    expect((await runLocalProjectWithReport(options('reader', otherDir))).status).toBe('failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
