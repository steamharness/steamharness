import { createLocalProjectConfigurationStore, resolveProjectEntrySync, readCachedConfigurationFile } from 'steamharness';
import { configurationSnapshot, type ProjectConfigurationState } from '@steamharness/project-configuration';
import { watch, type FSWatcher } from 'node:fs';
import { createKanbanBridgeError, parseKanbanBridgeCall, type KanbanInjectedConfiguration, type KanbanParamDefinition, type KanbanDatabaseRevision } from '@steamharness/kanban-project';
import { KanbanPreview } from './kanban-preview';
import { KanbanMethodHub } from './kanban-methods';
import { KanbanDiagnostics, type KanbanReadAttempt } from './kanban-diagnostics';
import { getCurrentLocale } from '@steamharness/i18n';
import type { WebConnection } from './runtime';
import type { Project, Runtime } from './workflow-types';
import { readConfigurationFile } from './configuration-files';
import { requestStudioAnalysis } from './local-analysis';
import type { ProjectServerIssue, ProjectServerState } from './project-server-state';

type Message = Record<string, any>;
interface Hooks { changed(): void; emit(message: Record<string, unknown>): void; connection(): WebConnection | undefined; log(message: string): void; serverIssue?(issue: ProjectServerIssue | undefined): ProjectServerIssue | undefined; serverState?(): ProjectServerState; projectChanged?(): Promise<void> }
export class KanbanController {
  workspace!: ProjectConfigurationState;
  params: KanbanParamDefinition[] = [];
  preview!: KanbanPreview;
  databaseRevisions: KanbanDatabaseRevision[] = [];
  databaseWarning = '';
  serverDataIssue?: ProjectServerIssue;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private disposed = false;
  private generation = 0;
  private readonly requests = new Set<AbortController>();
  private readonly diagnostics = new KanbanDiagnostics();
  readonly methods: KanbanMethodHub;
  constructor(readonly project: Project, private readonly runtime: Runtime, private readonly storageDir: string, private readonly hooks: Hooks) {
    this.methods = new KanbanMethodHub(() => this.configuration(), message => hooks.emit(message));
  }
  configuration(): KanbanInjectedConfiguration { const snapshot = configurationSnapshot(this.workspace, undefined, false); return { id: snapshot.id, name: snapshot.name, params: snapshot.values }; }
  configurationChanged(state: ProjectConfigurationState): void { this.workspace = state; if (this.preview) { this.newPreview(); this.hooks.changed(); } }
  state() { return { ...this.workspace, params: this.params, configuration: this.configuration(), preview: { url: this.preview.url, nonce: this.preview.nonce }, databaseRevisions: this.databaseRevisions, databaseWarning: this.databaseWarning, serverDataIssue: this.serverDataIssue }; }
  async initialize(): Promise<void> {
    this.workspace ??= await (await createLocalProjectConfigurationStore(this.project.folderPath, { entryId: this.project.entryId })).read();
    await this.refresh();
    try {
      this.watcher = watch(this.project.entryRoot, { recursive: true }, (_event, filename) => {
        const file = String(filename).replaceAll('\\', '/');
        if (!file || file.split('/').some(part => part.startsWith('.') || part === 'node_modules')) return;
        clearTimeout(this.timer); this.timer = setTimeout(() => void this.refresh().catch(error => this.hooks.log(String(error))), 400);
      });
      this.watcher.on('error', error => this.hooks.log(String(error)));
    } catch (error) { this.hooks.log(String(error)); }
    this.poll = setInterval(() => { if (!this.polling) { this.polling = true; void this.updateRevisions().finally(() => { this.polling = false; }); } }, 2_000); this.poll.unref();
  }
  async refresh(checkConnections = false): Promise<void> {
    const declaration = resolveProjectEntrySync(this.project.folderPath, this.project.entryId);
    this.project.entryRoot = declaration.rootDir;
    this.project.databases = declaration.registration.databases;
    this.project.kanban = { artifactDir: '.', entry: declaration.registration.entry };
    this.newPreview();
    if (checkConnections) await this.hooks.projectChanged?.();
    this.hooks.changed();
  }
  private newPreview() { this.generation++; this.methods.clear(); this.diagnostics.clear(); this.preview = new KanbanPreview(this.project.entryRoot, this.project.kanban!, () => this.configuration()); }
  async handle(message: Message): Promise<Message[]> {
    if (message.type === 'kanban-diagnostics') {
      const generation = this.generation;
      const result = message.call === undefined ? undefined : await this.methods.invoke(message.call, { readOnly: true });
      if (this.disposed || generation !== this.generation) throw new Error('Kanban preview changed. Read diagnostics again.');
      const { id, name } = this.configuration();
      return [{ type: 'kanban-diagnostics-result', requestId: message.requestId, value: {
        available: true, projectId: this.project.id, entryId: this.project.entryId,
        configuration: { id, name }, generation, instances: this.methods.list(), requests: this.diagnostics.snapshot(),
        ...(message.call === undefined ? {} : { result }),
      } }];
    }
    if (message.type === 'kanban-method-state') { if (message.nonce !== this.preview.nonce) throw new Error('Kanban preview changed.'); this.methods.publish(message); return []; }
    if (message.type === 'kanban-method-reply') { this.methods.reply(message); return []; }
    if (message.type === 'kanban-methods') return [{ type: 'kanban-methods-result', requestId: message.requestId, value: message.action === 'list' ? this.methods.list() : message.action === 'invoke' ? await this.methods.invoke(message.call) : (() => { throw new Error('Invalid Kanban methods action.'); })() }];
    if (message.type === 'kanban-bridge') {
      try { if (message.nonce !== this.preview.nonce) throw Object.assign(new Error('Kanban preview changed.'), { code: 'KANBAN_BRIDGE_SESSION_INVALID' }); return [{ type: 'kanban-bridge-result', requestId: message.requestId, ok: true, value: await this.bridge(parseKanbanBridgeCall(message.call)) }]; }
      catch (error) { return [{ type: 'kanban-bridge-result', requestId: message.requestId, ok: false, error: createKanbanBridgeError(error) }]; }
    }
    if (message.type === 'kanban-refresh') { await this.refresh(true); return [{ type: 'kanban-updated', requestId: message.requestId, kanban: this.state() }]; }
    throw new Error(`Unsupported Kanban action: ${message.type}`);
  }
  async bridge(call: Parameters<NonNullable<Runtime['kanbanBridge']>>[1]): Promise<unknown> {
    if (this.disposed) throw new Error('Kanban has closed.');
    if (call.operation === 'runtime.getLocale') return getCurrentLocale();
    const generation = this.generation;
    const configurationId = this.configuration().id, started = Date.now(), attempts: KanbanReadAttempt[] = [];
    const diagnostic = this.diagnostics.start(call, configurationId, started, attempts);
    const abort = new AbortController(); this.requests.add(abort);
    try {
      let result:unknown;
      if (call.operation === 'files.readFile') {
        attempts.push({ source: 'configuration-cache' });
        result = await readCachedConfigurationFile(this.project.folderPath, String(call.input.fileId), {entryId:this.project.entryId});
        if (result === undefined) result = await readConfigurationFile(this.project.id, this.workspace, String(call.input.fileId), this.hooks.connection(), {
          entryId:this.project.entryId,target:this.workspace.template?.projectVersion,signal:abort.signal,
          onRequest: () => attempts.push({ source: 'configuration-attachment' }),
          onResponse: status => { attempts.at(-1)!.status = status; },
        });
      }
      if (result === undefined) {
        attempts.push({ source: call.operation === 'studio.getLocalAnalysis' ? 'host' : 'database' });
        result = call.operation === 'studio.getLocalAnalysis' ? await requestStudioAnalysis(process.env, abort.signal) : await this.runtime.kanbanBridge!(this.project, call);
      }
      if (generation !== this.generation || this.disposed) throw Object.assign(new Error('Kanban preview changed.'), { code: 'KANBAN_BRIDGE_SESSION_INVALID' });
      this.diagnostics.finish(diagnostic);
      return result;
    } catch (error) {
      this.diagnostics.finish(diagnostic, error);
      throw error;
    } finally { this.requests.delete(abort); }
  }
  authenticationChanged() { this.generation++; this.methods.clear(); this.diagnostics.clear(); for (const request of this.requests) request.abort(); this.databaseRevisions = []; this.databaseWarning = ''; this.serverDataIssue = undefined; }
  projectChecksChanged() { this.hooks.changed(); }
  private async updateRevisions() {
    if (this.disposed || !this.runtime.kanbanBridge) return;
    const generation = this.generation;
    const revisions: KanbanDatabaseRevision[] = []; const errors: string[] = [];
    for (const requirement of this.project.databases) {
      try { revisions.push({ alias: requirement.alias, revision: String(await this.runtime.kanbanBridge(this.project, { requestId: `revision:${requirement.alias}`, operation: 'database.revision', input: { database: requirement.alias } })) }); }
      catch { errors.push(requirement.alias); }
    }
    if (generation !== this.generation || this.disposed) return;
    const warning = errors.length ? `Database access requires attention: ${errors.join(', ')}` : '';
    if (JSON.stringify(revisions) !== JSON.stringify(this.databaseRevisions) || warning !== this.databaseWarning) { this.databaseRevisions = revisions; this.databaseWarning = warning; this.hooks.changed(); }
  }
  async close() { this.disposed = true; this.watcher?.close(); clearTimeout(this.timer); clearInterval(this.poll); this.methods.clear(); this.diagnostics.clear(); for (const request of this.requests) request.abort(); }
}
