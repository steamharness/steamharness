import { LocalDatabaseRegistry, createLocalDatabaseResolver, createRemoteDatabaseResolver, databaseHostRequest, bindProjectDatabase, createDatabasesContext, executeDatabaseOperation, type DatabaseResolver } from 'steamharness';
import path from 'node:path';
import { PROJECT_CONFIG_ENV, selectProjectEntry } from '@steamharness/project-manifest';
import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import type { DatabasePermissions, DatabaseRequirement, DatabaseSpace } from '@steamharness/database-spaces';
import type { DatabaseCatalogState } from '@steamharness/database-spaces/catalog';
import type { WebConnection } from './runtime';
import type { Project } from './workflow-types';

export interface DatabaseManagementState {
  projectId: string;
  entryId: string;
  entries: Project['entries'];
  requirements: (DatabaseRequirement & { status: 'bound' | 'invalid'; space?: DatabaseSpace; permissions?: DatabasePermissions; error?: string })[];
  environmentOverrides: string[];
  local: DatabaseCatalogState;
  server?: DatabaseCatalogState;
  serverError?: string;
}

/** Trusted host operations. Project workers can use grants, but cannot approve requests. */
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
    const connection = this.connection();
    let server: DatabaseCatalogState | undefined, serverError: string | undefined;
    try { if (connection) server = await databaseHostRequest<DatabaseCatalogState>({ serverUrl: connection.serverUrl, token: connection.accessToken }, ''); }
    catch (error) { serverError = error instanceof Error ? error.message : String(error); }
    const databases = createDatabasesContext({ projectId: this.project.id, entryId: this.project.entryId, requirements: this.project.databases, resolver: this.resolver() });
    const requirements = await Promise.all(this.project.databases.map(async requirement => {
      try { const authorization = await databases.get(requirement.alias).getBinding(); return { ...requirement, status: 'bound' as const, space: authorization.space, permissions: authorization.grant.permissions }; }
      catch (error) { return { ...requirement, status: 'invalid' as const, error: error instanceof Error ? error.message : String(error) }; }
    }));
    const environmentOverrides = Object.keys(JSON.parse(process.env[PROJECT_CONFIG_ENV] ?? '{}').databases ?? {});
    return { projectId: this.project.id, entryId: this.project.entryId, entries: this.project.entries, requirements, environmentOverrides, local: this.registry.read(), server, serverError };
  }
  async dispatch(message: Record<string, any>) {
    await this.refreshDeclaration();
    if (message.action === 'get') return this.state();
    if (message.action === 'data') {
      const database = createDatabasesContext({ projectId: this.project.id, entryId: this.project.entryId,
        requirements: this.project.databases, resolver: this.resolver(), conversationId: message.conversationId }).get(String(message.alias));
      return { data: await executeDatabaseOperation(database, String(message.operation), message.input ?? {}) };
    }
    if (message.action === 'bind') {
      await bindProjectDatabase(this.project.folderPath, this.project.entryId, message.alias, message.databaseId);
      return this.state();
    }
    const host = message.host;
    if (host !== 'local' && host !== 'server') throw new Error('Select a local or server database host.');
    const connection = this.connection();
    const remote = <T>(endpoint: string, body?: unknown) => {
      if (!connection) throw new Error('Sign in to the selected database host.');
      return databaseHostRequest<T>({ serverUrl: connection.serverUrl, token: connection.accessToken }, endpoint, body);
    };
    if (message.action === 'request') {
      const input = { projectId: this.project.id, entryId: this.project.entryId, alias: message.alias, permissions: message.permissions, target: message.target };
      if (host === 'local') this.registry.request(input); else await remote('/requests', input);
    } else if (message.action === 'review') {
      if (typeof message.approve !== 'boolean') throw new Error('An explicit approval or rejection is required.');
      const decision = { approve: message.approve, reason: message.reason, permissions: message.permissions as DatabasePermissions | undefined };
      if (host === 'local') this.registry.review(message.databaseRequestId, decision); else await remote(`/requests/${encodeURIComponent(message.databaseRequestId)}/review`, decision);
    } else if (['revoke', 'rotate', 'narrow'].includes(message.action)) {
      if (host === 'local') {
        if (message.action === 'revoke') this.registry.revoke(message.grantId);
        else if (message.action === 'rotate') this.registry.rotate(message.grantId);
        else this.registry.narrow(message.grantId, message.permissions);
      } else await remote(`/grants/${encodeURIComponent(message.grantId)}/${message.action}`, { permissions: message.permissions });
    } else throw new Error('Unknown database management action.');
    return this.state();
  }
}
