import path from 'node:path';
import { createCliRelatedProjectRuntime, type CliRelatedProjectSpec } from '../related-projects';
import { webProjectDataDirectory } from './kanban-data';

// Web projects keep separate roots; a relation must use the target's own roots.
export function createWebRelatedProjectRuntime(core: typeof import('workflow-code'), options: {
  projectDir: string;
  storageDir: string;
  relatedProjects: readonly CliRelatedProjectSpec[];
  runId?: string;
  conversationId?: string;
}) {
  const roots = (projectDir: string) => {
    const directory = webProjectDataDirectory(options.storageDir, projectDir);
    return { kvStoreDir: path.join(directory, 'kv'), persistentValueStoreDir: path.join(directory, 'values') };
  };
  const local = roots(options.projectDir);
  return createCliRelatedProjectRuntime({
    consumerProjectDir: options.projectDir,
    relatedProjects: options.relatedProjects,
    localKvStoreDir: local.kvStoreDir,
    localPersistentValueStoreDir: local.persistentValueStoreDir,
    localStorageForProject: roots,
    storageApi: core as unknown as NonNullable<Parameters<typeof createCliRelatedProjectRuntime>[0]['storageApi']>,
    runId: options.runId,
    conversationId: options.conversationId,
    env: process.env,
  });
}
