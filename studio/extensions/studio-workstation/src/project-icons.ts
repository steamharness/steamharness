import * as vscode from 'vscode';
import { readProjectCardMetadata } from '@steamharness/project-card-metadata';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { readProjectDeclarationWithReader, selectProjectEntry } from '@steamharness/project-manifest';
import type { LibraryArtwork, ProjectType, RecentMetadata, RecentProject } from './projects';
import type { Launcher } from './workflow-cli-types';

interface Detection { type?: ProjectType; metadata?: RecentMetadata; checked: number; pending?: Promise<ProjectType | undefined> }
const ignored = new Set(['node_modules', 'dist', 'out', 'build', 'vendor', 'upstream']);

/** Reads declarations only. Recent folders must never supply executable inspection code. */
export class ProjectIcons implements vscode.Disposable {
  private readonly cache = new Map<string, Detection>();
  private readonly updates = new Map<string, RecentMetadata>();
  private readonly changes = new vscode.EventEmitter<ReadonlyMap<string, RecentMetadata>>();
  readonly onDidChange = this.changes.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;

  constructor(_launcher: Launcher, private readonly log: (message: string) => void = () => undefined, history: RecentProject[] = []) {
    for (const { uri, kind, projectType, avatarUrl, version, artwork, distribution, projectId } of history) {
      if (kind === 'folder') this.cache.set(uri, { type: projectType, metadata: { projectType, avatarUrl, version, artwork, distribution, projectId }, checked: 0 });
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/{steamharness.json,studio-cover.webp,studio-cover.jpg,studio-cover.png,download.json,*.ts}');
    this.subscriptions.push(watcher, watcher.onDidChange(uri => this.invalidate(uri)), watcher.onDidCreate(uri => this.invalidate(uri)),
      watcher.onDidDelete(uri => this.invalidate(uri)), vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.refresh(); } }));
  }

  get(uri: string): ProjectType | undefined {
    void this.resolve(uri);
    return this.cache.get(uri)?.type;
  }

  metadata(uri: string): RecentMetadata | undefined { void this.resolve(uri); return this.cache.get(uri)?.metadata; }
  getVersion(uri: string): string | undefined { return this.metadata(uri)?.version; }
  getAvatarUrl(uri: string): string | undefined { return this.metadata(uri)?.avatarUrl; }

  refresh(): void {
    if (this.disposed) { return; }
    ++this.generation;
    for (const entry of this.cache.values()) { entry.checked = 0; entry.pending = undefined; }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { void this.resolveMany([...this.cache.keys()]); }, 350);
  }

  private invalidate(file: vscode.Uri): void {
    if (file.path.split('/').some(part => ignored.has(part))) { return; }
    if ([...this.cache.keys()].some(uri => file.toString().startsWith(`${uri}/`))) { this.refresh(); }
  }

  async resolveMany(uris: string[]): Promise<Array<RecentMetadata & { uri: string }>> {
    const queue = [...new Set(uris)], results: Array<RecentMetadata & { uri: string }> = [];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) { await this.resolve(uri); results.push({ uri, ...this.cache.get(uri)?.metadata }); }
    }));
    return results;
  }

  private resolve(uri: string): Promise<ProjectType | undefined> {
    if (this.disposed) { return Promise.resolve(undefined); }
    let root: vscode.Uri;
    try { root = vscode.Uri.parse(uri); } catch { return Promise.resolve(undefined); }
    const entry = this.cache.get(uri) ?? { checked: 0 };
    this.cache.set(uri, entry);
    if (entry.pending) { return entry.pending; }
    if (Date.now() - entry.checked < 15_000) { return Promise.resolve(entry.type); }
    const generation = this.generation;
    const pending = this.inspect(root).then(metadata => {
      if (this.disposed) { return undefined; }
      if (generation !== this.generation) { return this.resolve(uri); }
      const changed = JSON.stringify(entry.metadata) !== JSON.stringify(metadata);
      entry.type = metadata.projectType;
      entry.metadata = metadata;
      if (changed) { this.updates.set(uri, metadata); this.publish(); }
      return entry.type;
    }).catch(error => { this.log(`Project icon ${uri}: ${String(error)}`); return entry.type; }).finally(() => {
      if (entry.pending === pending) { entry.pending = undefined; entry.checked = Date.now(); }
    });
    entry.pending = pending;
    return pending;
  }

  private publish(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.disposed) { const updates = new Map(this.updates); this.updates.clear(); this.changes.fire(updates); }
    }, 100);
  }

  private async inspect(root: vscode.Uri): Promise<RecentMetadata> {
    const empty: RecentMetadata = { projectType: undefined, avatarUrl: undefined, version: undefined, projectId: undefined, distribution: undefined, artwork: undefined };
    if (!['file', 'vscode-remote'].includes(root.scheme)) { return empty; }
    const read = async (uri: vscode.Uri): Promise<string> => {
      if ((await vscode.workspace.fs.stat(uri)).size > 1_048_576) { throw new Error('Project declaration is too large.'); }
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    };
    let pkg: Record<string, unknown> | undefined;
    try { pkg = JSON.parse(await read(vscode.Uri.joinPath(root, 'steamharness.json'))); }
    catch (error) {
      if (!(error instanceof SyntaxError) && (error as vscode.FileSystemError).code !== 'FileNotFound') { throw error; }
    }
    const children = await Promise.resolve(vscode.workspace.fs.readDirectory(root)).catch(() => []);
    const files = children.filter(([name, type]) => type === vscode.FileType.File && !name.startsWith('.')).map(([name]) => name).sort();
    const manifest = pkg && await readProjectDeclarationWithReader(pkg, async relative => JSON.parse(await read(vscode.Uri.joinPath(root, relative, 'steamharness.json')))).catch(() => undefined);
    if (!manifest || !pkg) { return { ...empty, artwork: { files: files.slice(0, 3) } }; }
    const projectType = selectProjectEntry(manifest).type;
    const cover = ['studio-cover.webp', 'studio-cover.png', 'studio-cover.jpg'].find(name => files.includes(name));
    const artwork: LibraryArtwork = { entries: manifest.entries.slice(0, 3).map(e => projectAvatarDataUrl(e.projectCard, e.type)) };
    if (cover) {
      const stat = await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, cover))).catch(() => undefined);
      if (stat && stat.size > 0 && stat.size <= 2_000_000) artwork.cover = { name: cover, mtime: stat.mtime };
    }
    const receipt = children.some(([name]) => name === '.steamharness') && await read(vscode.Uri.joinPath(root, '.steamharness', 'download.json')).then(text => JSON.parse(text), () => undefined).catch(() => undefined);
    const downloaded = receipt?.kind === 'steamharness.download' && receipt.version === 1 && receipt.projectId === manifest.projectId && receipt.projectVersion === manifest.version;
    return { projectType, version: manifest.version, projectId: manifest.projectId, artwork,
      distribution: pkg.distribution ? 'release' : downloaded ? 'download' : 'source', avatarUrl: projectAvatarDataUrl(readProjectCardMetadata(pkg, projectType), projectType) };
  }

  dispose(): void {
    this.disposed = true; ++this.generation; clearTimeout(this.timer); clearTimeout(this.refreshTimer);
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.changes.dispose(); this.cache.clear();
  }
}
