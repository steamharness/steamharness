import { t } from './localization';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import {
  createDefaultKanbanValues, sanitizeKanbanValues, createInjectedKanbanParams, createKanbanBridgeError, parseKanbanBridgeCall,
  readKanbanArtifactConfig, parseKanbanManifestText, consumeKanbanRelatedProjectRevisionStream,
  type KanbanConfiguration, type KanbanInjectedConfiguration, type KanbanParamDefinition, type KanbanRelatedProjectRevision,
} from '@steamharness/kanban-project';
import { KanbanPreview } from './kanban-preview';
import { KanbanMethodHub } from './kanban-methods';
import { getCurrentLocale } from '@steamharness/i18n';
import { localKanbanRelatedProjects, readProjectInfo, webProjectDataDirectory } from './kanban-data';
import type { WebConnection } from './runtime';
import type { Project, Runtime } from './workflow-types';
import { requestStudioAnalysis } from './local-analysis';

type Message = Record<string, any>;
interface Workspace { version: 1; revision: number; configurations: KanbanConfiguration[]; activeConfigurationId?: string }
interface Hooks { changed(): void; emit(message: Record<string, unknown>): void; connection(): WebConnection | undefined; log(message: string): void }

export class KanbanController {
  workspace: Workspace = { version: 1, revision: 0, configurations: [] };
  params: KanbanParamDefinition[] = [];
  preview!: KanbanPreview;
  relatedProjectRevisions: KanbanRelatedProjectRevision[] = [];
  missingRelatedProjectAliases: string[] = [];
  relatedProjectWarning = '';
  private pendingSave = Promise.resolve();
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
  private readonly historyPath: string;
  readonly methods: KanbanMethodHub;
  constructor(readonly project: Project, private readonly runtime: Runtime, private readonly storageDir: string, private readonly hooks: Hooks) {
    this.historyPath = path.join(webProjectDataDirectory(storageDir, project.folderPath), 'kanban.json');
    this.methods = new KanbanMethodHub(() => this.configuration(), message => hooks.emit(message));
  }
  get current(): KanbanConfiguration | undefined { return this.workspace.configurations.find(item => item.id === this.workspace.activeConfigurationId); }
  configuration(): KanbanInjectedConfiguration {
    const active = this.current;
    return active ? { id: active.id, name: active.name, params: createInjectedKanbanParams(this.params, active.values) } : { id: '', name: '', params: {} };
  }
  state() { return { ...this.workspace, params: this.params, configuration: this.configuration(), preview: { url: this.preview.url, nonce: this.preview.nonce }, relatedProjectRevisions: this.relatedProjectRevisions, missingRelatedProjectAliases: this.missingRelatedProjectAliases, relatedProjectWarning: this.relatedProjectWarning }; }
  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.historyPath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.configurations) || saved.configurations.some((item: KanbanConfiguration) => typeof item.id !== 'string' || typeof item.name !== 'string' || !item.values || typeof item.values !== 'object')) { throw new Error('Invalid Kanban configuration history.'); }
      this.workspace = { ...saved, revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0 };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    await this.refresh();
    try {
      this.watcher = watch(this.project.folderPath, { recursive: true }, (_event, filename) => {
        const file = String(filename).replaceAll('\\', '/');
        const data = path.relative(this.project.folderPath, webProjectDataDirectory(this.storageDir, this.project.folderPath)).replaceAll('\\', '/');
        if (!file || file.split('/').some(part => part.startsWith('.') || part === 'node_modules') || file.startsWith(`${data}/`)) { return; }
        const artifact = this.project.kanban!.artifactDir;
        if (file !== 'package.json' && file !== 'kanban.json' && artifact !== '.' && file !== artifact && !file.startsWith(`${artifact}/`)) { return; }
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
    let params: KanbanParamDefinition[];
    try { params = parseKanbanManifestText(await readFile(path.join(this.project.folderPath, 'kanban.json'), 'utf8')).params; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } params = []; }
    const workspace = structuredClone(this.workspace);
    for (const item of workspace.configurations) { item.values = sanitizeKanbanValues(params, item.values); }
    if (!workspace.configurations.length && params.length) { this.create(workspace, params); }
    workspace.activeConfigurationId = workspace.configurations.find(item => item.id === workspace.activeConfigurationId)?.id ?? workspace.configurations[0]?.id;
    workspace.revision++; await this.persist(workspace);
    this.workspace = workspace; this.params = params;
    this.project.kanban = artifact; this.project.projectInfo = projectInfo; this.project.fields = params;
    this.newPreview();
    this.authenticationChanged();
    await this.updateLocalRevisions(); this.hooks.changed();
  }
  private newPreview(): void { this.generation++; this.methods.clear(); this.preview = new KanbanPreview(this.project.folderPath, this.project.kanban!, () => this.configuration()); }
  private create(workspace: Workspace, params: KanbanParamDefinition[], values = createDefaultKanbanValues(params), name?: string): KanbanConfiguration {
    if (!name) { let index = 1; while (workspace.configurations.some(item => item.name === t("Configuration {0}", index))) { index++; } name = t("Configuration {0}", index); }
    const date = new Date().toISOString(), item = { id: randomUUID(), name, values: { ...values }, createdAt: date, updatedAt: date };
    workspace.configurations.push(item); workspace.activeConfigurationId = item.id; return item;
  }
  async persist(workspace = this.workspace): Promise<void> {
    const content = JSON.stringify(workspace);
    this.pendingSave = this.pendingSave.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.historyPath), { recursive: true }); const temp = `${this.historyPath}.${process.pid}.tmp`;
      await writeFile(temp, content, { mode: 0o600 }); await rename(temp, this.historyPath);
    });
    return this.pendingSave;
  }
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
    if (message.type !== 'kanban-configuration') { throw new Error(`Unsupported Kanban action: ${message.type}`); }
    return this.update(() => this.configure(message));
  }
  private async configure(message: Message): Promise<Message[]> {
    if (message.revision !== this.workspace.revision) { throw new Error('Kanban configuration changed. Try again.'); }
    const workspace = structuredClone(this.workspace);
    const action = String(message.action), item = workspace.configurations.find(item => item.id === message.id);
    let previewChanged = false;
    if (!['create', 'duplicate', 'rename', 'save', 'select', 'delete'].includes(action)) { throw new Error('Unknown Kanban configuration action.'); }
    if (action !== 'create' && !item) { throw new Error('Kanban configuration no longer exists.'); }
    switch (action) {
      case 'create': if (!this.params.length) { throw new Error('The project does not define parameters.'); } this.create(workspace, this.params); previewChanged = true; break;
      case 'duplicate': this.create(workspace, this.params, sanitizeKanbanValues(this.params, item!.values), `${item!.name} (copy)`); previewChanged = true; break;
      case 'rename': {
        if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 200) { throw new Error('Invalid configuration name.'); }
        item!.name = message.name.trim(); item!.updatedAt = new Date().toISOString(); break;
      }
      case 'save': {
        if (!message.values || typeof message.values !== 'object' || Array.isArray(message.values) || Object.values(message.values).some(value => typeof value !== 'string')) { throw new Error('Invalid Kanban parameters.'); }
        item!.values = sanitizeKanbanValues(this.params, message.values); item!.updatedAt = new Date().toISOString(); break;
      }
      case 'select': workspace.activeConfigurationId = item!.id; previewChanged = true; break;
      case 'delete': {
        if (workspace.configurations.length <= 1) { throw new Error('The last configuration cannot be deleted.'); }
        workspace.configurations = workspace.configurations.filter(value => value !== item);
        if (item!.id === workspace.activeConfigurationId) { workspace.activeConfigurationId = workspace.configurations[0].id; previewChanged = true; } break;
      }
    }
    workspace.revision++; await this.persist(workspace); this.workspace = workspace;
    if (previewChanged) { this.newPreview(); } this.hooks.changed();
    return [{ type: 'kanban-updated', requestId: message.requestId, kanban: this.state() }];
  }
  async bridge(call: Parameters<NonNullable<Runtime['kanbanBridge']>>[1]): Promise<unknown> {
    if (this.disposed) { throw new Error('Kanban has closed.'); }
    if (call.operation === 'runtime.getLocale') { return getCurrentLocale(); }
    const generation = this.generation;
    let result: unknown;
    if (call.operation === 'studio.getLocalAnalysis') {
      const abort = new AbortController(); this.requests.add(abort);
      try { result = await requestStudioAnalysis(process.env, abort.signal); }
      finally { this.requests.delete(abort); }
    } else if (this.project.projectInfo?.dataStorage?.mode === 'server' || call.operation.startsWith('files.')) {
      const connection = this.hooks.connection();
      if (!connection) { throw Object.assign(new Error('SteamHarness Server login is required.'), { code: call.operation.startsWith('files.') ? 'KANBAN_FILE_UNAVAILABLE' : 'KANBAN_BRIDGE_UNAVAILABLE' }); }
      const abort = new AbortController(); this.requests.add(abort);
      try {
        const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(this.project.id)}/kanban/bridge`, { method: 'POST', headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ call }), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(call.operation.startsWith('files.') ? 120_000 : 15_000)]) });
        const value = await response.json();
        if (!response.ok || value.errCode !== 0) { throw Object.assign(new Error('Kanban Server operation failed.'), { code: call.operation.startsWith('files.') ? 'KANBAN_FILE_UNAVAILABLE' : 'KANBAN_DATA_OPERATION_FAILED' }); }
        result = value.data ?? null;
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
    this.connectServerRevisions();
  }
  private connectServerRevisions(): void {
    if (this.project.projectInfo?.dataStorage?.mode !== 'server' || this.disposed) { return; }
    this.missingRelatedProjectAliases = [];
    const connection = this.hooks.connection();
    if (!connection) { this.relatedProjectWarning = t("Sign in to SteamHarness Server to connect Kanban data."); return; }
    const abort = this.feed = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(this.project.id)}/kanban/related-project-revisions`, { headers: { Authorization: `Bearer ${connection.accessToken}` }, signal: abort.signal, redirect: 'error' });
        if (!response.ok || !response.body) { throw new Error('Kanban related project updates are unavailable.'); }
        const apply = (revisions: KanbanRelatedProjectRevision[]) => { if (!abort.signal.aborted) { this.relatedProjectRevisions = revisions; this.relatedProjectWarning = ''; this.hooks.changed(); } };
        await consumeKanbanRelatedProjectRevisionStream(response.body, { onSnapshot: value => apply(value.revisions), onRevision: value => apply([...this.relatedProjectRevisions.filter(item => item.alias !== value.alias), value]), onUnavailable: () => { throw new Error('Related projects are unavailable.'); } }, abort.signal);
      } catch { if (!abort.signal.aborted) { this.relatedProjectWarning = t("The related project connection was interrupted. Reconnecting."); this.hooks.changed(); } }
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
  async close(): Promise<void> { this.disposed = true; this.watcher?.close(); clearTimeout(this.refreshTimer); this.methods.clear(); clearInterval(this.poll); clearTimeout(this.retry); this.feed?.abort(); for (const request of this.requests) { request.abort(); } await this.updates; await this.pendingSave; }
}
