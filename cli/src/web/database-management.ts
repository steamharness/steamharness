import { LocalDatabaseRegistry, createLocalDatabaseResolver, createRemoteDatabaseResolver, bindProjectDatabase, createDatabasesContext, type DatabaseResolver } from 'steamharness';
import path from 'node:path';
import { PROJECT_CONFIG_ENV, selectProjectEntry } from '@steamharness/project-manifest';
import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import type { DatabasePermissions, DatabaseRequirement, DatabaseSpace } from '@steamharness/database-spaces';
import type { WebConnection } from './runtime';
import type { Project } from './workflow-types';

export interface DatabaseManagementState {
  projectId: string;
  entryId: string;
  entries: Project['entries'];
  requirements: (DatabaseRequirement & { status: 'bound' | 'invalid'; space?: DatabaseSpace; permissions?: DatabasePermissions; error?: string })[];
  environmentOverrides: string[];
}

/** CLI Web edits project references; authorization and data management belong to hosts. */
export class DatabaseManagement {
  private readonly registry = new LocalDatabaseRegistry();
  constructor(private readonly project: Project, private readonly connection: () => WebConnection | undefined) {}
  resolver(): DatabaseResolver {
    const local = createLocalDatabaseResolver(this.registry), connection = this.connection();
    const remote = connection && createRemoteDatabaseResolver({ serverUrl: connection.serverUrl, token: connection.accessToken });
    return { resolve: async (requirement, consumer) => await local.resolve(requirement, consumer) ?? remote?.resolve(requirement, consumer) };
  }
  async refreshDeclaration() {
    const manifest = await readProjectManifestFromDirectory(this.project.folderPath);
    if (manifest.projectId !== this.project.id) throw new Error('Project identity changed. Reopen the project.');
    const entry = selectProjectEntry(manifest, this.project.entryId);
    if (entry.type !== this.project.projectType || path.resolve(this.project.folderPath, entry.root) !== this.project.entryRoot) throw new Error('Project entry changed. Reopen the project.');
    this.project.databases = entry.databases;
    this.project.entries = manifest.entries;
  }
  async assertBound(alias: string) {
    await this.refreshDeclaration();
    return createDatabasesContext({projectId:this.project.id,entryId:this.project.entryId,requirements:this.project.databases,resolver:this.resolver()}).get(alias).getBinding();
  }
  async state(): Promise<DatabaseManagementState> {
    await this.refreshDeclaration();
    const databases = createDatabasesContext({ projectId: this.project.id, entryId: this.project.entryId, requirements: this.project.databases, resolver: this.resolver() });
    const requirements = await Promise.all(this.project.databases.map(async requirement => {
      try { const authorization = await databases.get(requirement.alias).getBinding(); return { ...requirement, status: 'bound' as const, space: authorization.space, permissions: authorization.grant.permissions }; }
      catch (error) { return { ...requirement, status: 'invalid' as const, error: error instanceof Error ? error.message : String(error) }; }
    }));
    const environmentOverrides = Object.keys(JSON.parse(process.env[PROJECT_CONFIG_ENV] ?? '{}').databases ?? {});
    return { projectId: this.project.id, entryId: this.project.entryId, entries: this.project.entries, requirements, environmentOverrides };
  }
  async dispatch(message: Record<string, any>) {
    await this.refreshDeclaration();
    if (message.action === 'get') return this.state();
    if (message.action === 'bind') {
      await bindProjectDatabase(this.project.folderPath, this.project.entryId, message.alias, message.databaseId);
      return this.state();
    }
    throw new Error('Manage database access and data in Studio, Server Web, or CLI database commands.');
  }
}
