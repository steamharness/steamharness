import { bindProjectKnowledgeBase } from 'steamharness';
import path from 'node:path';
import { PROJECT_CONFIG_ENV, selectProjectEntry } from '@steamharness/project-manifest';
import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import { databaseManagementRequest } from '../database-management';
import { generateDatabases } from '../database-generation';
import type { WebConnection } from './runtime';
import type { Project } from './workflow-types';
import { ServerReadCache } from './server-read-cache';
export interface DatabaseManagementState {
  projectId: string; entryId: string; entries: Project['entries']; serverUrl?: string;
  requirements: { alias: string; databaseId: string; kind: 'databases' | 'knowledge-bases'; status: 'bound' | 'invalid'; space?: { name: string; host: 'server' }; error?: string }[];
  environmentOverrides: string[];
}
/** Both resource types require the selected Server account. No local database resolver. */
export class DatabaseManagement {
  private readonly reads = new ServerReadCache(5_000);
  private readonly checks = new ServerReadCache(0);
  private identity?: string;
  constructor(private readonly project: Project, private readonly connection: () => WebConnection | undefined) {}
  private currentConnection() {
    const connection = this.connection();
    const identity = connection ? JSON.stringify([connection.serverUrl, connection.accessToken]) : undefined;
    if (identity !== this.identity) { this.reads.clear(); this.checks.clear(); this.identity = identity; }
    if (!connection) throw new Error('Sign in to SteamHarness Server to manage database resources.');
    return connection;
  }
  private async request<T = any>(kind: 'databases' | 'knowledge-bases', endpoint: string, method = 'GET', body?: unknown, cached = true): Promise<T> {
    const connection = this.currentConnection(), identity = this.identity;
    const load = () => databaseManagementRequest<T>({ server: connection.serverUrl, token: connection.accessToken }, endpoint, method, body, kind, 15_000);
    if (method !== 'GET') { this.reads.clear(); this.checks.clear(); }
    try {
      const value = method === 'GET' ? await (cached ? this.reads : this.checks).read(`${identity}:${kind}:${endpoint}`, load) : await load();
      this.currentConnection();
      if (identity !== this.identity) throw new Error('Resource access changed. Open the card again.');
      return value;
    } catch (error) { this.reads.clear(); this.checks.clear(); throw error; }
    finally { if (method !== 'GET') { this.reads.clear(); this.checks.clear(); } }
  }
  async refreshDeclaration() {
    const manifest = await readProjectManifestFromDirectory(this.project.folderPath);
    if (manifest.projectId !== this.project.id) throw new Error('Project identity changed. Reopen the project.');
    const entry = selectProjectEntry(manifest, this.project.entryId);
    if (entry.type !== this.project.projectType || path.resolve(this.project.folderPath, entry.root) !== this.project.entryRoot) throw new Error('Project entry changed. Reopen the project.');
    this.project.databases = entry.databases; this.project.knowledgeBases = entry.knowledgeBases ?? []; this.project.entries = manifest.entries;
  }
  async assertBound(alias: string, kind: 'databases' | 'knowledge-bases' = 'databases') {
    await this.refreshDeclaration();
    const requirement = kind === 'knowledge-bases' ? this.project.knowledgeBases?.find(item => item.alias === alias) : undefined;
    const bindings = await this.request<any[]>(kind, this.bindingsEndpoint(), 'GET', undefined, false);
    const binding = bindings.find(item => item.alias === alias && (kind === 'databases' || item.knowledgeBaseId === requirement?.knowledgeBaseId));
    if (!binding) throw new Error('Bind this resource alias on the selected Server first.');
    return { ...binding, space: { host: 'server' } };
  }
  private bindingsEndpoint() {
    return `/bindings?${new URLSearchParams({ projectId: this.project.id, entryId: this.project.entryId })}`;
  }
  async state(fresh = false): Promise<DatabaseManagementState> {
    if (fresh) this.reads.clear();
    await this.refreshDeclaration();
    this.currentConnection(); const identity = this.identity;
    const [bindings, knowledgeBindings] = await Promise.all([
      this.project.databases.length ? this.request<any[]>('databases', this.bindingsEndpoint()) : Promise.resolve([]),
      this.project.knowledgeBases?.length ? this.request<any[]>('knowledge-bases', this.bindingsEndpoint()) : Promise.resolve([]),
    ]);
    const declared = [...this.project.databases.map(alias => ({ alias, databaseId: bindings.find(item => item.alias === alias)?.databaseId ?? '', kind: 'databases' as const })), ...(this.project.knowledgeBases ?? []).map(item => ({ alias: item.alias, databaseId: item.knowledgeBaseId, kind: 'knowledge-bases' as const }))];
    const requirements = await Promise.all(declared.map(async requirement => {
      try {
        if (!requirement.databaseId) throw new Error('Bind this alias on the selected Server first.');
        const selectedBindings = requirement.kind === 'databases' ? bindings : knowledgeBindings;
        if (!selectedBindings.some(binding => binding.alias === requirement.alias && (binding.databaseId ?? binding.knowledgeBaseId) === requirement.databaseId)) throw new Error('Bind this alias on the selected Server first.');
        const resource = await this.request(requirement.kind, `/${requirement.databaseId}`);
        return { ...requirement, status: 'bound' as const, space: { name: resource.name, host: 'server' as const } };
      } catch (error) { return { ...requirement, status: 'invalid' as const, error: error instanceof Error ? error.message : String(error) }; }
    }));
    this.currentConnection(); if (identity !== this.identity) throw new Error('Resource access changed. Open the card again.');
    const override = JSON.parse(process.env[PROJECT_CONFIG_ENV] ?? '{}');
    return { projectId: this.project.id, entryId: this.project.entryId, entries: this.project.entries, requirements, environmentOverrides: [...Object.keys(override.knowledgeBases ?? {})], serverUrl: this.connection()?.serverUrl };
  }
  async dispatch(message: Record<string, any>) {
    await this.refreshDeclaration(); if (message.action === 'get') return this.state(message.fresh === true);
    if (message.action !== 'bind' || !['databases', 'knowledge-bases'].includes(message.kind)) throw new Error('Select a resource type and bind an alias.');
    const consumer = { projectId: this.project.id, entryId: this.project.entryId, alias: message.alias };
    if (message.kind === 'knowledge-bases') {
      await this.request('knowledge-bases', '/bindings', 'POST', { ...consumer, knowledgeBaseId: message.databaseId });
      await bindProjectKnowledgeBase(this.project.folderPath, this.project.entryId, message.alias, message.databaseId);
    } else {
      const generated = await generateDatabases(this.project.entryRoot), database = generated.databases.find(item => item.alias === message.alias);
      if (!database) throw new Error('Define and generate this database alias before binding it.');
      await this.request('databases', '/bindings', 'POST', { ...consumer, databaseId: message.databaseId, schemaHash: database.schemaHash });
    }
    return this.state();
  }
}
