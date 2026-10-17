import * as vscode from 'vscode';
import { projectId, type ProjectType } from './projects';
import type { WorkflowLauncher } from './workflow-cli-types';

interface Detection { type?: ProjectType; version?: string; checked: number; pending?: Promise<ProjectType | undefined> }
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

  constructor(private readonly launcher: WorkflowLauncher, private readonly log: (message: string) => void = () => undefined) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,*.ts}');
    this.subscriptions.push(watcher, watcher.onDidChange(uri => this.invalidate(uri)), watcher.onDidCreate(uri => this.invalidate(uri)),
      watcher.onDidDelete(uri => this.invalidate(uri)), vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.refresh(); } }));
  }

  get(uri: string): ProjectType | undefined {
    void this.resolve(uri);
    return this.cache.get(uri)?.type;
  }

  getVersion(uri: string): string | undefined { void this.resolve(uri); return this.cache.get(uri)?.version; }

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

  async resolveMany(uris: string[]): Promise<Array<{ uri: string; projectType?: ProjectType; version?: string }>> {
    const queue = [...new Set(uris)], results: Array<{ uri: string; projectType?: ProjectType; version?: string }> = [];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) { results.push({ uri, projectType: await this.resolve(uri), version: this.cache.get(uri)?.version }); }
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
    let version: string | undefined;
    const pending = this.detect(root, value => { version = value; }).then(type => {
      if (this.disposed) { return undefined; }
      if (generation !== this.generation) { return this.resolve(uri); }
      const changed = entry.type !== type || entry.version !== version;
      entry.type = type;
      entry.version = version;
      if (changed) { this.publish(); }
      return type;
    }, error => { this.log(`Project icon ${uri}: ${String(error)}`); return entry.type; }).finally(() => {
      if (entry.pending === pending) { entry.pending = undefined; entry.checked = Date.now(); }
    });
    entry.pending = pending;
    return pending;
  }

  private publish(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.disposed) { this.changes.fire(); } }, 100);
  }

  private async detect(root: vscode.Uri, setVersion: (version?: string) => void): Promise<ProjectType | undefined> {
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
    if (!projectId(pkg?.id)) { return undefined; }
    setVersion(typeof pkg.version === 'string' ? pkg.version : undefined);
    if (pkg.workflowCode?.projectType === 'kanban') { return 'kanban'; }
    if (!this.launcher.analyzeProjectType) { return undefined; }
    const sources: Array<{ name: string; text: string }> = [];
    let bytes = 0, entries = 0;
    const visit = async (directory: vscode.Uri, depth: number): Promise<void> => {
      if (depth > 8) { throw new Error('Project source depth limit exceeded.'); }
      const children = (await vscode.workspace.fs.readDirectory(directory)).sort(([a], [b]) => a.localeCompare(b));
      for (const [name, type] of children) {
        if (this.disposed) { return; }
        if (++entries > 2_000) { throw new Error('Project source scan limit exceeded.'); }
        if (name.startsWith('.') || ignored.has(name)) { continue; }
        const uri = vscode.Uri.joinPath(directory, name);
        if (type === vscode.FileType.Directory) { await visit(uri, depth + 1); }
        else if (type === vscode.FileType.File && name.endsWith('.ts') && !name.endsWith('.d.ts')) {
          const text = await read(uri); bytes += text.length;
          if (sources.length >= 200 || bytes > 8_388_608) { throw new Error('Project source size limit exceeded.'); }
          sources.push({ name: uri.path.slice(root.path.length + 1), text });
        }
      }
    };
    await visit(root, 0);
    if (this.disposed) { return undefined; }
    return this.launcher.analyzeProjectType(sources);
  }

  dispose(): void {
    this.disposed = true; ++this.generation; clearTimeout(this.timer); clearTimeout(this.refreshTimer);
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.changes.dispose(); this.cache.clear();
  }
}
