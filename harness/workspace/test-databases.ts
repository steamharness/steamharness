import { createTestKnowledgeBases } from '../src/__tests__/entry-test-resources';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { createDatabaseConnector, createEntriesContext, readProjectManifestFromDirectorySync, runLocalProjectWithReport, type ProjectManifest } from 'steamharness';
import { createMemoryRuntimePersistence } from 'steamharness/runtime-storage';

/** Disposable runtime persistence, separate from the business resource fixture. */
export function createTestConversationStorage(): import('steamharness').ConversationStateStorage {
  let state: import('steamharness').ConversationState | undefined;
  return {
    async read(initial) { return structuredClone(state ?? initial); },
    async update(initial, change) { state = change(structuredClone(state ?? initial)); return structuredClone(state); },
  };
}

/** Explicit temporary resources for offline example tests. */
export function createApprovedTestContext() {
  const projectId = randomUUID(), entryId = 'main';
  const manifest: ProjectManifest = { projectId, name: 'Example', defaultEntry: entryId, entries: [{ entryId, type: 'workflow', name: 'Example', root: '.', entry: 'index.ts', databases: [] }] };
  return { projectId, entryId, knowledgeBases: createTestKnowledgeBases(projectId, entryId), databases: createDatabaseConnector({ projectId, entryId }),
    entries: createEntriesContext(manifest, { projectId, sourceEntryId: entryId, actor: { isSystemAdmin: false } }, { async list() { return []; }, async run() { throw new Error('No cross-entry calls in this fixture'); } }),
  };
}

/** Copy and bind a sample before a real run. The published sample stays unbound. */
export async function runApprovedProject(options: Parameters<typeof runLocalProjectWithReport>[0], _unused?: unknown, knowledgeResources?: ReturnType<typeof createTestKnowledgeBases>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'example-approved-run-'));
  const projectDir = path.join(directory,'project');
  try {
    await cp(options.projectDir,projectDir,{recursive:true,filter: source => !path.relative(options.projectDir,source).split(path.sep).some(part => ['node_modules','.git','dist','.data','.artifacts'].includes(part))});
    await symlink(path.join(options.projectDir,'node_modules'),path.join(projectDir,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
    const manifest = readProjectManifestFromDirectorySync(projectDir, {});
    const knowledgeBases: Record<string, string> = {};
    const fixtures = new Map(manifest.entries.map(entry => {
      const aliases = (entry.knowledgeBases ?? []).map(base => base.alias);
      for (const alias of aliases) knowledgeBases[alias] ??= randomUUID();
      return [entry.entryId, knowledgeResources ?? createTestKnowledgeBases(manifest.projectId, entry.entryId, aliases)] as const;
    }));
    await writeFile(path.join(projectDir,'config.json'),JSON.stringify({version:1,knowledgeBases}));
    const host = options.storage?.host ?? 'local';
    const bindingIds = new Map<string, string>();
    return await runLocalProjectWithReport({...options,projectDir,knowledgeBaseHost: {
      async resolve(identity) {
        const key = `${identity.entryId}:${identity.alias}`;
        if (!bindingIds.has(key)) bindingIds.set(key, randomUUID());
        return { id: bindingIds.get(key)!, revision: 1, accessRevision: 1, mode: 'write', knowledgeBaseId: identity.knowledgeBaseId };
      },
      async operation<T>(identity, _binding, operation, input: any): Promise<T> {
        const context = fixtures.get(identity.entryId)!.get(identity.alias);
        switch (operation) {
          case 'knowledge.listDocuments': return await context.listDocuments(input) as T;
          case 'knowledge.getDocument': return (await context.getDocument(input.documentId) ?? null) as T;
          case 'knowledge.createDocument': return await context.createDocument(input) as T;
          case 'knowledge.editDocument': return await context.editDocument({ ...input, id: input.documentId }) as T;
          case 'knowledge.deleteDocument': return await context.deleteDocument(input.documentId, input.expectedRevision) as T;
          case 'knowledge.searchDocuments': return await context.searchDocuments(input) as T;
          case 'knowledge.readDocumentLines': return await context.readDocumentLines(input) as T;
          default: throw new Error('Unsupported example fixture operation.');
        }
      },
    },storage: { ...options.storage, host,
      [host]: { ...options.storage?.[host], runtimePersistence: options.storage?.[host]?.runtimePersistence ?? createMemoryRuntimePersistence() } }});
  } finally { await rm(directory,{recursive:true,force:true}); }
}

export function createExampleKnowledgeBases() { return createTestKnowledgeBases(randomUUID(), "main"); }
