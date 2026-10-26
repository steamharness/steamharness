import { readConfigurationFile } from './configuration-files';
import { readCachedConfigurationFile, createLocalProjectConfigurationStore } from 'steamharness';
import { configurationSnapshot, type ProjectConfigurationState } from '@steamharness/project-configuration';
import { t } from './localization';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import {
  createKanbanBridgeError, parseKanbanBridgeCall,
  readKanbanArtifactConfig, consumeKanbanRelatedProjectRevisionStream,
  type KanbanInjectedConfiguration, type KanbanParamDefinition, type KanbanRelatedProjectRevision,
} from '@steamharness/kanban-project';
import { KanbanPreview } from './kanban-preview';
import { KanbanMethodHub } from './kanban-methods';
import { getCurrentLocale } from '@steamharness/i18n';
import { localKanbanRelatedProjects, readProjectInfo, webProjectDataDirectory } from './kanban-data';
import type { WebConnection } from './runtime';
import type { Project, Runtime } from './workflow-types';
import { requestStudioAnalysis } from './local-analysis';
import { checkProjectServer, checkProjectStorageFailure, projectServerIssue, type ProjectServerIssue } from './project-server-state';

type Message = Record<string, any>;
interface Hooks { changed(): void; emit(message: Record<string, unknown>): void; connection(): WebConnection | undefined; log(message: string): void }

export class KanbanController {
  workspace!: ProjectConfigurationState;
  params: KanbanParamDefinition[] = [];
  preview!: KanbanPreview;
  relatedProjectRevisions: KanbanRelatedProjectRevision[] = [];
  missingRelatedProjectAliases: string[] = [];
  relatedProjectWarning = '';
  serverDataIssue?: ProjectServerIssue;
  private updates = Promise.resolve();
  private poll?: ReturnType<typeof setInterval>;
  private feed?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private generation = 0;
  private polling = false;
  private watcher?: FSWatcher;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private readonly requests = new Set<AbortController>();
  readonly methods: KanbanMethodHub;
  constructor(readonly project: Project, private readonly runtime: Runtime, private readonly storageDir: string, private readonly hooks: Hooks) {
    this.methods = new KanbanMethodHub(() => this.configuration(), message => hooks.emit(message));
  }
  configuration(): KanbanInjectedConfiguration {
    const snapshot = configurationSnapshot(this.workspace, undefined, false);
    return { id: snapshot.id, name: snapshot.name, params: snapshot.values };
  }
  configurationChanged(state: ProjectConfigurationState): void {
    this.workspace = state;
    if (this.preview) { this.newPreview(); this.hooks.changed(); }
  }
  state() { return { ...this.workspace, params: this.params, configuration: this.configuration(), preview: { url: this.preview.url, nonce: this.preview.nonce }, relatedProjectRevisions: this.relatedProjectRevisions, missingRelatedProjectAliases: this.missingRelatedProjectAliases, relatedProjectWarning: this.relatedProjectWarning, serverDataIssue: this.serverDataIssue }; }
  async initialize(): Promise<void> {
    this.workspace ??= await (await createLocalProjectConfigurationStore(this.project.folderPath)).read();
    await this.refresh();
    try {
      this.watcher = watch(this.project.folderPath, { recursive: true }, (_event, filename) => {
        const file = String(filename).replaceAll('\\', '/');
        const data = path.relative(this.project.folderPath, webProjectDataDirectory(this.storageDir, this.project.folderPath)).replaceAll('\\', '/');
        if (!file || file.split('/').some(part => part.startsWith('.') || part === 'node_modules') || file.startsWith(`${data}/`)) { return; }
        const artifact = this.project.kanban!.artifactDir;
        if (file !== 'package.json' && file !== 'configuration.json' && artifact !== '.' && file !== artifact && !file.startsWith(`${artifact}/`)) { return; }
        clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => void this.refresh().catch(error => this.hooks.log(String(error))), 400);
      });
      this.watcher.on('error', error => this.hooks.log(String(error)));
    } catch (error) { this.hooks.log(String(error)); }
    this.poll = setInterval(() => { if (!this.polling && this.project.projectInfo?.dataStorage?.mode !== 'server') { this.polling = true; void this.updateLocalRevisions().catch(error => this.hooks.log(String(error))).finally(() => { this.polling = false; }); } }, 2_000);
    this.poll.unref();
  }
  refresh(): Promise<void> {
    clearTimeout(this.refreshTimer);
    return this.refreshing ??= this.update(() => this.load()).finally(() => { this.refreshing = undefined; });
  }
  private update<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.updates.then(() => {
      if (this.disposed) { throw new Error('Kanban has closed.'); }
      return operation();
    });
    this.updates = task.then(() => undefined, () => undefined);
    return task;
  }
  private async load(): Promise<void> {
    const pkg = JSON.parse(await readFile(path.join(this.project.folderPath, 'package.json'), 'utf8'));
    const artifact = readKanbanArtifactConfig(pkg);
    const projectInfo = readProjectInfo(pkg);
    this.params = [];
    this.project.kanban = artifact; this.project.projectInfo = projectInfo;
    this.newPreview();
    this.authenticationChanged();
    await this.updateLocalRevisions(); this.hooks.changed();
  }
  private newPreview(): void { this.generation++; this.methods.clear(); this.preview = new KanbanPreview(this.project.folderPath, this.project.kanban!, () => this.configuration()); }
  async handle(message: Message): Promise<Message[]> {
    if (message.type === 'kanban-method-state') { if (message.nonce !== this.preview.nonce) { throw new Error('Kanban preview changed.'); } this.methods.publish(message); return []; }
    if (message.type === 'kanban-method-reply') { this.methods.reply(message); return []; }
    if (message.type === 'kanban-methods') { return [{ type: 'kanban-methods-result', requestId: message.requestId, value: message.action === 'list' ? this.methods.list() : message.action === 'invoke' ? await this.methods.invoke(message.call) : (() => { throw new Error('Invalid Kanban methods action.'); })() }]; }
    if (message.type === 'kanban-bridge') {
      try {
        if (message.nonce !== this.preview.nonce) { throw Object.assign(new Error('Kanban preview changed.'), { code: 'KANBAN_BRIDGE_SESSION_INVALID' }); }
        const value = await this.bridge(parseKanbanBridgeCall(message.call));
        return [{ type: 'kanban-bridge-result', requestId: message.requestId, ok: true, value }];
      } catch (error) { return [{ type: 'kanban-bridge-result', requestId: message.requestId, ok: false, error: createKanbanBridgeError(error) }]; }
    }
    if (message.type === 'kanban-refresh') { await this.refresh(); return [{ type: 'kanban-updated', requestId: message.requestId, kanban: this.state() }]; }
    throw new Error(`Unsupported Kanban action: ${message.type}`);
  }
  async bridge(call: Parameters<NonNullable<Runtime['kanbanBridge']>>[1]): Promise<unknown> {
    if (this.disposed) { throw new Error('Kanban has closed.'); }
    if (call.operation === 'runtime.getLocale') { return getCurrentLocale(); }
    if(call.operation==='files.readFile') {const cached=await readCachedConfigurationFile(this.project.folderPath,String(call.input.fileId));if(cached)return cached;}
    const generation = this.generation;
    let result: unknown;
    if (call.operation === 'studio.getLocalAnalysis') {
      const abort = new AbortController(); this.requests.add(abort);
      try { result = await requestStudioAnalysis(process.env, abort.signal); }
      finally { this.requests.delete(abort); }
    } else if (this.project.projectInfo?.dataStorage?.mode === 'server' || call.operation.startsWith('files.')) {
      const connection = this.hooks.connection();
      if (!connection) { throw Object.assign(new Error('SteamHarness Server login is required.'), { code: call.operation.startsWith('files.') ? 'KANBAN_FILE_UNAVAILABLE' : 'KANBAN_BRIDGE_UNAVAILABLE' }); }
      if (this.project.projectInfo?.dataStorage?.mode === 'server' && this.serverDataIssue) { throw Object.assign(new Error('Kanban Server setup is required.'), { code: 'KANBAN_BRIDGE_UNAVAILABLE' }); }
      const abort = new AbortController(); this.requests.add(abort);
      try {
        const file = call.operation === 'files.readFile' ? await readConfigurationFile(this.project.id, this.workspace, String(call.input.fileId), connection, { target: this.workspace.template?.projectVersion, signal: abort.signal }) : undefined;
        if (file) { result = file; }
        else {
          const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(this.project.id)}/kanban/bridge`, { method: 'POST', headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ call }), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(call.operation.startsWith('files.') ? 120_000 : 15_000)]) });
          const value = await response.json();
          if (!response.ok || value.errCode !== 0) {
            if (!call.operation.startsWith('files.') && [401, 403, 404, 409].includes(response.status)) {
              const relation = call.operation.startsWith('relatedProject.') ? this.project.projectInfo?.relatedProjects.find(item => item.alias === call.input.alias) : undefined;
              const issue = await checkProjectStorageFailure(this.project.id, {
                serverUrl: connection.serverUrl, projectId: relation?.projectId ?? this.project.id, relatedProjectAlias: relation?.alias,
                status: response.status, operation: ['kv.getValue', 'relatedProject.kv.getValue', 'knowledge.listDocuments', 'knowledge.getDocument', 'knowledge.searchDocuments', 'knowledge.readDocumentLines'].includes(call.operation) ? 'get' : 'set',
                key: typeof call.input.key === 'string' ? call.input.key : undefined,
              }, connection, abort.signal);
              if (!abort.signal.aborted && generation === this.generation && !this.disposed) {
                this.serverDataIssue = issue ?? { kind: 'setup-required', serverUrl: connection.serverUrl }; this.hooks.changed();
              }
            }
            throw Object.assign(new Error('Kanban Server operation failed.'), { code: call.operation.startsWith('files.') ? 'KANBAN_FILE_UNAVAILABLE' : 'KANBAN_DATA_OPERATION_FAILED' });
          }
          result = value.data ?? null;
        }
      } finally { this.requests.delete(abort); }
    } else {
      if (!this.runtime.kanbanBridge) { throw new Error('Project Core does not support Kanban data.'); }
      result = await this.runtime.kanbanBridge(this.project, call);
    }
    if (generation !== this.generation || this.disposed) { throw Object.assign(new Error('Kanban preview changed.'), { code: 'KANBAN_BRIDGE_SESSION_INVALID' }); }
    return result;
  }
  authenticationChanged(): void {
    this.generation++; this.methods.clear(); for (const request of this.requests) { request.abort(); } this.feed?.abort(); clearTimeout(this.retry);
    this.relatedProjectRevisions = []; this.relatedProjectWarning = '';
    if (this.project.projectInfo?.dataStorage?.mode !== 'server' || this.serverDataIssue?.serverUrl !== this.hooks.connection()?.serverUrl) { this.serverDataIssue = undefined; }
    this.connectServerRevisions();
  }
  private connectServerRevisions(): void {
    if (this.project.projectInfo?.dataStorage?.mode !== 'server' || this.disposed) { return; }
    this.missingRelatedProjectAliases = [];
    const connection = this.hooks.connection();
    if (!connection) { this.serverDataIssue = { kind: 'sign-in-required' }; return; }
    const abort = this.feed = new AbortController();
    void (async () => {
      let unavailable = false;
      try {
        const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(this.project.id)}/kanban/related-project-revisions`, { headers: { Authorization: `Bearer ${connection.accessToken}` }, signal: abort.signal, redirect: 'error' });
        if (abort.signal.aborted) { await response.body?.cancel().catch(() => undefined); return; }
        let issue = projectServerIssue(response.status, connection.serverUrl);
        if (response.status === 404) {
          await response.body?.cancel().catch(() => undefined);
          issue = await checkProjectServer(this.project.id, connection, abort.signal) ?? { kind: 'setup-required', serverUrl: connection.serverUrl };
          if (abort.signal.aborted) return;
          if (issue.kind === 'connection-unavailable') throw new Error('Project availability could not be checked.');
        }
        if (issue) {
          this.serverDataIssue = issue; this.relatedProjectWarning = ''; this.hooks.changed();
          await response.body?.cancel().catch(() => undefined);
          return;
        }
        if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error('Kanban related project updates are unavailable.'); }
        this.serverDataIssue = undefined; this.relatedProjectWarning = ''; this.hooks.changed();
        const apply = (revisions: KanbanRelatedProjectRevision[]) => { if (!abort.signal.aborted) { this.relatedProjectRevisions = revisions; this.relatedProjectWarning = ''; this.hooks.changed(); } };
        await consumeKanbanRelatedProjectRevisionStream(response.body, { onSnapshot: value => apply(value.revisions), onRevision: value => apply([...this.relatedProjectRevisions.filter(item => item.alias !== value.alias), value]), onUnavailable: () => { unavailable = true; throw new Error('Related projects are unavailable.'); } }, abort.signal);
      } catch {
        if (unavailable && !abort.signal.aborted) {
          try {
            let issue = await checkProjectServer(this.project.id, connection, abort.signal);
            for (const relation of this.project.projectInfo?.relatedProjects ?? []) {
              if (issue || abort.signal.aborted) break;
              issue = await checkProjectStorageFailure(this.project.id, { serverUrl: connection.serverUrl,
                projectId: relation.projectId, relatedProjectAlias: relation.alias, operation: 'get' }, connection, abort.signal);
            }
            if (!abort.signal.aborted && issue && issue.kind !== 'connection-unavailable') {
              this.serverDataIssue = issue; this.relatedProjectWarning = ''; this.hooks.changed(); return;
            }
          } catch { /* A temporary diagnostic failure follows the connection retry path. */ }
        }
        if (!abort.signal.aborted) { this.relatedProjectWarning = t("The related project connection was interrupted. Reconnecting."); this.hooks.changed(); }
      }
      if (!abort.signal.aborted && !this.disposed) { this.retry = setTimeout(() => this.connectServerRevisions(), 5_000); this.retry.unref(); }
    })();
  }
  private async updateLocalRevisions(): Promise<void> {
    if (this.project.projectInfo?.dataStorage?.mode === 'server' || this.disposed) { return; }
    const generation = this.generation, { info, projects } = await localKanbanRelatedProjects(this.project);
    const missing = info.relatedProjects.filter(item => !projects.has(item.alias)).map(item => item.alias);
    const revisions = await Promise.all([...projects].sort(([left], [right]) => left.localeCompare(right)).map(async ([alias, target]) => {
      const hash = createHash('sha256'), root = path.join(webProjectDataDirectory(this.storageDir, target.folderPath), 'kv');
      const visit = async (directory: string) => { for (const item of (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) { if (item.name.startsWith('.') || item.name.endsWith('.lock') || item.name.endsWith('.tmp')) { continue; } const file = path.join(directory, item.name); if (item.isDirectory()) { await visit(file); } else if (item.isFile()) { const info = await stat(file).catch(() => undefined); hash.update(`${file}:${info?.size}:${info?.mtimeMs}`); } } };
      await visit(root); return { alias, revision: hash.digest('hex') };
    }));
    if (generation !== this.generation || this.disposed) { return; }
    if (JSON.stringify([missing, revisions]) !== JSON.stringify([this.missingRelatedProjectAliases, this.relatedProjectRevisions])) { this.missingRelatedProjectAliases = missing; this.relatedProjectRevisions = revisions; this.hooks.changed(); }
  }
  async close(): Promise<void> { this.disposed = true; this.watcher?.close(); clearTimeout(this.refreshTimer); this.methods.clear(); clearInterval(this.poll); clearTimeout(this.retry); this.feed?.abort(); for (const request of this.requests) { request.abort(); } await this.updates; }
}
