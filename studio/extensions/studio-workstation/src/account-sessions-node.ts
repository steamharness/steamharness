import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

export type AccountSessions = Pick<vscode.SecretStorage, 'get' | 'store' | 'delete' | 'onDidChange'>;

/** Local desktop sign-in only. Other extension credentials still use SecretStorage. */
export class LocalAccountSessions implements AccountSessions, vscode.Disposable {
  private readonly directory: string;
  private readonly changes = new vscode.EventEmitter<{ key: string }>();
  readonly onDidChange = this.changes.event;
  private readonly keys = new Map<string, string>();
  private readonly pendingChanges = new Set<string>();
  private ready?: Promise<void>;
  private watcher?: FSWatcher;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(globalStoragePath: string) {
    this.directory = path.join(globalStoragePath, 'account-sessions');
  }

  private async file(key: string): Promise<string> {
    const name = createHash('sha256').update(key).digest('hex') + '.json';
    this.keys.set(name, key);
    this.ready ??= this.open().catch(error => { this.ready = undefined; throw error; });
    await this.ready;
    return path.join(this.directory, name);
  }

  private async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)) {
      throw new Error('Invalid account session storage permissions');
    }
    if (this.disposed) return;
    // Watch the directory so an atomic file replacement or deletion remains observable.
    const watcher = this.watcher = watch(this.directory, { persistent: false }, (_event, filename) => {
      if (filename === null) {
        for (const key of this.keys.values()) this.pendingChanges.add(key);
      } else {
        const key = this.keys.get(filename);
        if (key) this.pendingChanges.add(key);
      }
      if (!this.pendingChanges.size || this.changeTimer) return;
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined;
        const keys = [...this.pendingChanges];
        this.pendingChanges.clear();
        for (const key of keys) this.changes.fire({ key });
      }, 25);
    });
    watcher.on('error', () => {
      watcher.close();
      if (this.watcher === watcher) { this.watcher = undefined; this.ready = undefined; }
    });
  }

  async get(key: string): Promise<string | undefined> {
    const file = await this.file(key);
    try { return await readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async store(key: string, value: string): Promise<void> {
    const file = await this.file(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }

  async delete(key: string): Promise<void> { await rm(await this.file(key), { force: true }); }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    clearTimeout(this.changeTimer);
    this.pendingChanges.clear();
    this.keys.clear();
    this.changes.dispose();
  }
}
