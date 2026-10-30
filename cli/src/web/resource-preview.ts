import {readCachedConfigurationFile} from 'steamharness';
import {readConfigurationFile} from './configuration-files';
import { createLocalProjectConfigurationStore } from 'steamharness';
import { applyConfigurationAction,configurationSnapshot, type ProjectConfigurationState } from '@steamharness/project-configuration';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseKanbanBridgeCall, type KanbanInjectedConfiguration,
} from '@steamharness/kanban-project';
import type { ResourceCard } from './resource-cards';
import type { Project, Runtime } from './workflow-types';
import type { WebConnection } from './runtime';
import { KanbanPreview } from './kanban-preview';
import { t, locale } from './localization';

export interface ResourcePreviewData {
  card: ResourceCard;
  project?: Project;
  content?: unknown;
  format?: 'markdown' | 'text' | 'json' | 'image' | 'browser' | 'kanban' | 'project';
  kanban?: { url: string; nonce: string; configuration: KanbanInjectedConfiguration };
}
interface PreviewEntry {
  data: ResourcePreviewData;
  file?: { root: string; filename: string; mimeType: string };
  local?: KanbanPreview;
  remote?: { url: URL; prefix: string; connection: WebConnection };
}

const imageMimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/vnd.microsoft.icon',
};
function insideProject(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Targets come from saved tool results; clients only select a card and an action.
export class ResourcePreviews {
  private readonly entries = new Map<string, PreviewEntry>();
  private generation = 0;
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private readonly configurationReaders = new Map<string, { read(): Promise<ProjectConfigurationState>; revision: number }>();
  constructor(private readonly owner: Project, private readonly runtime: Runtime, private readonly storageDir: string,
    private readonly connection: () => WebConnection | undefined,
    private readonly resourceProjects: () => readonly string[] = () => [], private readonly changed: () => void = () => {}) {}

  clear(): void { this.generation++; this.entries.clear(); this.configurationReaders.clear(); }
  close(): void { this.clear(); clearInterval(this.poll); }
  private watchConfiguration(key: string, revision: number, read: () => Promise<ProjectConfigurationState>): void {
    this.configurationReaders.set(key, { read, revision });
    this.poll ??= setInterval(() => {
      if (this.polling || !this.configurationReaders.size) return;
      this.polling = true;
      const generation = this.generation;
      void Promise.all([...this.configurationReaders.values()].map(async reader => {
        try { return (await reader.read()).revision !== reader.revision; }
        catch { return false; } // A failed request must not publish an uncommitted configuration.
      })).then(changes => {
        if (generation === this.generation && changes.some(Boolean)) { this.clear(); this.changed(); }
      }).finally(() => { this.polling = false; });
    }, 1000);
    this.poll.unref();
  }
  get revision(): number { return this.generation; }

  private async server(id: string, suffix: string, init: RequestInit = {}): Promise<any> {
    const connection = this.connection();
    if (!connection) { throw new Error(t('Please sign in to preview this server resource.')); }
    const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(id)}${suffix}`, {
      ...init, headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || result.errCode !== 0) { throw new Error(result.errMessage || t('You do not have access to this resource.')); }
    return result.data;
  }

  async resolve(card: ResourceCard): Promise<Project | undefined> {
    if (card.kind === 'browser') { return; }
    const id = card.target.projectId ?? this.owner.id;
    const entryId = card.target.entryId ?? this.owner.entryId;
    if (card.target.source === 'server') {
      if (card.kind === 'kv' || card.kind === 'knowledge') {
        if (id.toLowerCase() === this.owner.id.toLowerCase() && entryId === this.owner.entryId) { return this.owner; }
        return { ...this.owner, id, entryId, uri: `workflow-server:${id}/${entryId}`, folderPath: '', name: id, projectType: 'workflow', fields: [], entrypoints: [] };
      }
      const summary = await this.server(id, '');
      const registration = summary.entries.find((entry: any) => entry.entryId === entryId);
      if (!registration) throw new Error(t('The resource project is unavailable.'));
      return { ...this.owner, id, entryId, entries: summary.entries, defaultEntry: summary.defaultEntry,
        uri: `workflow-server:${id}/${entryId}`, folderPath: '', entryRoot: '', aggregateName: summary.name,
        name: registration.name, projectType: registration.type, databases: registration.databases,
        fields: [], entrypoints: [] };
    }
    const workspace = card.kind === 'kanban' || card.kind === 'project' ? this.owner.assistant?.workdir : undefined;
    if (id === this.owner.id) {
      if (!workspace && entryId === this.owner.entryId) { return this.owner; }
      // The dedicated assistant owns the conversation; its workspace owns project previews.
      const root = await realpath(workspace ?? this.owner.folderPath), inspected = await this.runtime.inspect([root], entryId);
      const project = inspected.projects.find(project => path.resolve(project.folderPath) === root && project.entryId === entryId);
      if (!project) { throw new Error(t('The resource project is unavailable.')); }
      return { ...project, uri: pathToFileURL(root).href };
    }
    for (const directory of new Set([...this.resourceProjects(), ...(workspace ? [workspace] : [])])) {
      let root: string, pkg;
      try { root = await realpath(directory); pkg = JSON.parse(await readFile(path.join(root, 'steamharness.json'), 'utf8')); }
      catch { continue; }
      if (String(pkg.id).toLowerCase() !== id.toLowerCase()) { continue; }
      // A resource can belong to another entry than this runtime's conversation.
      const inspected = await this.runtime.inspect([root], entryId);
      const project = inspected.projects.find(project => project.id.toLowerCase() === id.toLowerCase() && project.entryId === entryId);
      if (!project) { throw new Error(t('The resource project is unavailable.')); }
      return { ...project, uri: pathToFileURL(root).href };
    }
    throw new Error(t('The resource project is unavailable. Import or open the target project first.'));
  }

  async open(card: ResourceCard): Promise<{ id: string; data: ResourcePreviewData; url: string }> {
    const generation = this.generation;
    const project = await this.resolve(card);
    const id = randomUUID(), data: ResourcePreviewData = { card, project }, entry: PreviewEntry = { data };
    const target = card.target, scopeId = target.conversationId ?? '';
    if (card.kind === 'kv' || card.kind === 'knowledge') {
      data.content = target.source==='server'
        ? await this.server(project!.id,`/entries/${encodeURIComponent(project!.entryId)}/resources/read`,{method:'POST',body:JSON.stringify({kind:card.kind,database:target.database,scope:target.scope,conversationId:target.conversationId,key:target.key,documentId:target.documentId})})
        : await this.runtime.readResource(project!, scopeId, card.kind, target);
      if (card.kind === 'knowledge' && (data.content === null || data.content === undefined)) { throw new Error(t('This resource no longer exists.')); }
      data.format = card.kind === 'knowledge' && typeof (data.content as { markdown?: unknown }).markdown === 'string' ? 'markdown' : 'json';
    } else if (card.kind === 'file') {
      if (target.source === 'server') { throw new Error(t('Server source files cannot be previewed by this card.')); }
      const root = await realpath(project!.assistant?.workdir ?? project!.folderPath);
      const filename = await realpath(path.resolve(root, target.filePath));
      if (!insideProject(root, filename)) { throw new Error(t('File is outside this project.')); }
      if (!(await stat(filename)).isFile()) { throw new Error(t('The preview target is not a file.')); }
      const mimeType = imageMimeTypes[path.extname(filename).toLowerCase()];
      if (mimeType) {
        entry.file = { root, filename, mimeType };
        data.content = `/resource-assets/${id}/image`; data.format = 'image';
      } else {
        data.content = await readFile(filename, 'utf8'); data.format = /\.mdx?$/i.test(filename) ? 'markdown' : 'text';
      }
    } else if (card.kind === 'browser') {
      data.format = 'browser'; data.content = target.url;
    } else if (card.kind === 'kanban' || project?.projectType === 'kanban' && card.preview !== false) {
      if (project?.projectType !== 'kanban') { throw new Error(t('This project does not provide a Kanban preview.')); }
      let configurations: ProjectConfigurationState;
      if (target.source === 'server') {
        const workspace = await this.server(project.id, `/kanban?entryId=${encodeURIComponent(project.entryId)}`);
        configurations = await this.server(project.id, `/configurations?entryId=${encodeURIComponent(project.entryId)}`);
        this.watchConfiguration(`server:${project.id}:${project.entryId}`, configurations.revision, () => this.server(project.id, `/configurations?entryId=${encodeURIComponent(project.entryId)}`));
        const connection = this.connection()!, url = new URL(workspace.preview.url, `${connection.serverUrl}/`);
        const expected = `/api/projects/${encodeURIComponent(project.id)}/kanban/previews/`;
        if (url.origin !== new URL(connection.serverUrl).origin || !url.pathname.startsWith(expected) || url.search || url.hash) { throw new Error(t('Invalid resource preview URL.')); }
        // The capability URL contains nonce, target and the entry's relative path.
        const segments = url.pathname.slice(expected.length).split('/');
        const assetPrefix = `${expected}${segments.slice(0, 3).join('/')}/`;
        entry.remote = { url, prefix: assetPrefix, connection };
        data.kanban = { url: `/resource-assets/${id}/${url.pathname.slice(assetPrefix.length)}`, nonce: workspace.preview.nonce, configuration: { id: '', name: '', params: {} } };
      } else {
        const store = await createLocalProjectConfigurationStore(project.folderPath, { entryId: project.entryId });
        configurations = await store.read();
        this.watchConfiguration(`local:${project.folderPath}:${project.entryId}`, configurations.revision, () => store.read());
      }
      const configurationId=target.configurationId??configurations.activeConfigurationId;
      const previewState=card.kanban?.mode==='preview'?applyConfigurationAction(configurations,{action:'save',revision:configurations.revision,id:configurationId,values:card.kanban.values},randomUUID):configurations;
      const snapshot = configurationSnapshot(previewState, configurationId, false);
      const configuration = { id: snapshot.id, name: snapshot.name, params: snapshot.values };
      if (!entry.remote) {
        if (!project.kanban) { throw new Error(t('This project does not provide a Kanban preview.')); }
        entry.local = new KanbanPreview(project.entryRoot, project.kanban, () => configuration);
        data.kanban = { url: entry.local.url, nonce: entry.local.nonce, configuration };
      } else { data.kanban!.configuration = configuration; }
      data.format = 'kanban';
    } else { data.format = 'project'; data.content = project; }
    if (generation !== this.generation) { throw new Error(t('Resource access changed. Open the card again.')); }
    if (this.entries.size >= 64) { this.entries.delete(this.entries.keys().next().value!); }
    this.entries.set(id, entry);
    return { id, data, url: `/resource/${id}?projectLocale=${locale()}` };
  }

  get(id: string): ResourcePreviewData {
    const entry = this.entries.get(id);
    if (!entry) { throw new Error(t('Resource access changed. Open the card again.')); }
    return entry.data;
  }

  async asset(url: URL): Promise<{ content: Buffer | string; headers: Record<string, string> } | undefined> {
    const generation = this.generation;
    if (url.pathname.startsWith('/kanban/')) {
      for (const entry of this.entries.values()) {
        if (entry.local && url.pathname.startsWith(`/kanban/${entry.local.nonce}/`)) {
          const asset = await entry.local.asset(url);
          return generation === this.generation ? asset : undefined;
        }
      }
      return;
    }
    const match = /^\/resource-assets\/([^/]+)\/(.+)$/.exec(url.pathname);
    const entry = match ? this.entries.get(match[1]) : undefined;
    if (entry?.file) {
      if (match![2] !== 'image') { return; }
      try {
        // Resolve again so replacing a file or parent directory with a symlink cannot escape its project.
        const filename = await realpath(entry.file.filename);
        if (!insideProject(entry.file.root, filename) || !(await stat(filename)).isFile()) { return; }
        const content = await readFile(filename);
        if (generation !== this.generation || this.entries.get(match![1]) !== entry) { return; }
        return { content, headers: { 'Content-Type': entry.file.mimeType, 'Content-Length': String(content.length),
          'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } };
      } catch { return; }
    }
    const remote = entry?.remote;
    const connection = this.connection();
    if (!remote || remote.connection.serverUrl !== connection?.serverUrl || remote.connection.accessToken !== connection?.accessToken) { return; }
    const asset = decodeURIComponent(match![2]);
    if (asset.includes('\\') || asset.split('/').some(part => part === '..' || !part) || !/\.[a-z\d]+$/i.test(asset)) { return; }
    const address = new URL(`${remote.prefix}${match![2]}`, remote.url.origin);
    const response = await fetch(address, { headers: { Authorization: `Bearer ${remote.connection.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { return; }
    const content = Buffer.from(await response.arrayBuffer());
    if (generation !== this.generation) { return; }
    return { content, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Security-Policy': `${response.headers.get('content-security-policy') ?? "default-src 'none'"}; frame-ancestors 'self' vscode-webview: vscode-file: http://127.0.0.1:* http://localhost:*`,
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } };
  }

  async bridge(id: string, value: unknown): Promise<unknown> {
    const generation = this.generation;
    const data = this.get(id), project = data.project, call = parseKanbanBridgeCall(value);
    if (data.format !== 'kanban' || !project) { throw new Error(t('This project does not provide a Kanban preview.')); }
    // Card previews are temporary and cannot mutate the target's stored data.
    if (!['runtime.getLocale', 'kv.getValue', 'database.revision', 'knowledge.listDocuments', 'knowledge.getDocument', 'knowledge.searchDocuments', 'knowledge.readDocumentLines', 'files.readFile'].includes(call.operation)) {
      throw new Error(t('This resource preview is read-only.'));
    }
    if (call.operation === 'runtime.getLocale') { return locale(); }
    if(call.operation==='files.readFile'&&project.folderPath) {
      const fileId=String(call.input.fileId),cached=await readCachedConfigurationFile(project.folderPath,fileId,{entryId:project.entryId});if(cached)return cached;
      const state=await(await createLocalProjectConfigurationStore(project.folderPath, { entryId: project.entryId })).read();
      const file=await readConfigurationFile(project.id,state,fileId,this.connection(),{entryId:project.entryId,target:state.template?.projectVersion});if(file)return file;
    }
    let result: unknown;
    if (data.card.target.source === 'server') {
      result = await this.server(project.id, '/kanban/bridge', { method: 'POST', body: JSON.stringify({ call, entryId: project.entryId }) });
    } else {
      if (!this.runtime.kanbanBridge) { throw new Error(t('The resource project is unavailable.')); }
      result = await this.runtime.kanbanBridge(project, call);
    }
    if (generation !== this.generation) { throw new Error(t('Resource access changed. Open the card again.')); }
    return result;
  }
}
