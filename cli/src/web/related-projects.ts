import path from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createCliRelatedProjectRuntime, type CliRelatedProjectSpec } from '../related-projects';
import { projectDataDirectorySync, webProjectDataDirectory } from './project-data-directory';
import type { ProjectServerIssue } from './project-server-state';
import type { Project } from './workflow-types';

/** Import status describes local availability, independently of data grants. */
export class RelatedProjectImports {
  private imported?: Map<string, string>;
  private generation = 0;
  private disposed = false;

  async update(bindings: readonly CliRelatedProjectSpec[] | undefined): Promise<boolean> {
    const generation = ++this.generation;
    const entries = await Promise.all((bindings ?? []).map(async binding => {
      try {
        const pkg = JSON.parse(await readFile(path.join(binding.projectDir, 'package.json'), 'utf8'));
        if (typeof pkg?.id === 'string') return [binding.alias, pkg.id.toLowerCase()] as const;
      } catch { /* Removed, moved and invalid imports need to be imported again. */ }
      return undefined;
    }));
    if (this.disposed || generation !== this.generation) return false;
    const imported = bindings === undefined ? undefined : new Map(entries.filter(entry => entry !== undefined));
    const changed = JSON.stringify(this.imported && [...this.imported]) !== JSON.stringify(imported && [...imported]);
    this.imported = imported;
    return changed;
  }

  issue(issue: ProjectServerIssue | undefined): ProjectServerIssue | undefined {
    if (!issue?.relatedProjectAlias || !issue.projectId || !this.imported) return issue;
    return { ...issue, relatedProjectImported: this.imported.get(issue.relatedProjectAlias) === issue.projectId.toLowerCase() };
  }

  missingIssue(alias: unknown, project: Project): ProjectServerIssue | undefined {
    const relation = project.projectInfo?.relatedProjects.find(relation => relation.alias === alias);
    if (!relation) return;
    const issue = this.issue({ kind: 'related-import-required', projectId: relation.projectId, relatedProjectAlias: relation.alias });
    return issue?.relatedProjectImported === false ? issue : undefined;
  }

  close(): void { this.disposed = true; ++this.generation; }
}

// Web projects keep separate roots; a relation must use the target's own roots.
export function createWebRelatedProjectRuntime(core: typeof import('steamharness'), options: {
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
    localStorageForProject: directory => {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const root = projectDataDirectorySync(options.storageDir, directory, manifest.id);
      return { kvStoreDir: path.join(root, 'kv'), persistentValueStoreDir: path.join(root, 'values') };
    },
    storageApi: core as unknown as NonNullable<Parameters<typeof createCliRelatedProjectRuntime>[0]['storageApi']>,
    runId: options.runId,
    conversationId: options.conversationId,
    env: process.env,
  });
}
