import * as vscode from 'vscode';
import { readProjectCardMetadataFromPackageJson } from '@steamharness/project-card-metadata';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { readProjectManifest, selectProjectEntry } from '@steamharness/project-manifest';
import type { ProjectType } from './projects';
import type { Launcher } from './workflow-cli-types';

interface Detection { type?: ProjectType; version?: string; avatarUrl?: string; checked: number; pending?: Promise<ProjectType | undefined> }
const ignored = new Set(['node_modules', 'dist', 'out', 'build', 'vendor', 'upstream']);

/** Reads declarations only. Recent folders must never supply executable inspection code. */
export class ProjectIcons implements vscode.Disposable {
  private readonly cache = new Map<string, Detection>();
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;

  constructor(_launcher: Launcher, private readonly log: (message: string) => void = () => undefined) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,*.ts}');
    this.subscriptions.push(watcher, watcher.onDidChange(uri => this.invalidate(uri)), watcher.onDidCreate(uri => this.invalidate(uri)),
      watcher.onDidDelete(uri => this.invalidate(uri)), vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.refresh(); } }));
  }

  get(uri: string): ProjectType | undefined {
    void this.resolve(uri);
    return this.cache.get(uri)?.type;
  }

  getVersion(uri: string): string | undefined { void this.resolve(uri); return this.cache.get(uri)?.version; }
  getAvatarUrl(uri: string): string | undefined { void this.resolve(uri); return this.cache.get(uri)?.avatarUrl; }

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

  async resolveMany(uris: string[]): Promise<Array<{ uri: string; projectType?: ProjectType; version?: string; avatarUrl?: string }>> {
    const queue = [...new Set(uris)], results: Array<{ uri: string; projectType?: ProjectType; version?: string; avatarUrl?: string }> = [];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) { results.push({ uri, projectType: await this.resolve(uri), version: this.cache.get(uri)?.version, avatarUrl: this.cache.get(uri)?.avatarUrl }); }
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
    let manifest: Record<string, unknown> | undefined;
    const pending = this.detect(root, value => { manifest = value; }).then(type => {
      if (this.disposed) { return undefined; }
      if (generation !== this.generation) { return this.resolve(uri); }
      const version = typeof manifest?.version === 'string' ? manifest.version : undefined;
      const avatarUrl = type && manifest ? projectAvatarDataUrl(readProjectCardMetadataFromPackageJson(manifest, type), type) : undefined;
      const changed = entry.type !== type || entry.version !== version || entry.avatarUrl !== avatarUrl;
      entry.type = type;
      entry.version = version;
      entry.avatarUrl = avatarUrl;
      if (changed) { this.publish(); }
      return type;
    }).catch(error => { this.log(`Project icon ${uri}: ${String(error)}`); return entry.type; }).finally(() => {
      if (entry.pending === pending) { entry.pending = undefined; entry.checked = Date.now(); }
    });
    entry.pending = pending;
    return pending;
  }

  private publish(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.disposed) { this.changes.fire(); } }, 100);
  }

  private async detect(root: vscode.Uri, setManifest: (manifest: Record<string, unknown>) => void): Promise<ProjectType | undefined> {
    if (!['file', 'vscode-remote'].includes(root.scheme)) { return undefined; }
    const read = async (uri: vscode.Uri): Promise<string> => {
      if ((await vscode.workspace.fs.stat(uri)).size > 1_048_576) { throw new Error('Project declaration is too large.'); }
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    };
    let pkg;
    try { pkg = JSON.parse(await read(vscode.Uri.joinPath(root, 'package.json'))); }
    catch (error) {
      if (error instanceof SyntaxError || (error as vscode.FileSystemError).code === 'FileNotFound') { return undefined; }
      throw error;
    }
    try {
      const manifest = readProjectManifest(pkg);
      setManifest(pkg);
      return selectProjectEntry(manifest).type;
    } catch { return undefined; }
  }

  dispose(): void {
    this.disposed = true; ++this.generation; clearTimeout(this.timer); clearTimeout(this.refreshTimer);
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.changes.dispose(); this.cache.clear();
  }
}
