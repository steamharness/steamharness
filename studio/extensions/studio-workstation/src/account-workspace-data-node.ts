import { lstatSync, mkdirSync } from 'node:fs';
import { localAccountsDirectory, prepareLocalDirectory } from '@steamharness/project-manifest/node';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isWorkspaceOwner, type AccountWorkspace, type ProjectHistory } from './account-workspace-data';
import { readImportedProjects, readRecentProjects } from './projects';

type Notice = { id: string; title: string; fingerprint?: string; read: boolean; source: 'studio' };
type Inbox = { notices: Notice[]; dismissed: string[]; removed: string[] };
const noticeId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,16}-[a-f0-9-]{36}$/iu.test(value);
const socialId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const readNotice = (value: unknown): Notice | undefined => {
  const { id, title, fingerprint, read } = object(value);
  if (!noticeId(id) || typeof title !== 'string' || typeof read !== 'boolean') return;
  return { id, title: title.slice(0, 500), read, source: 'studio',
    ...(typeof fingerprint === 'string' && /^[a-f0-9]{40}$/u.test(fingerprint) && { fingerprint }) };
};
const readNotices = (value: unknown) => array(value).slice(0, 300).flatMap(row => { const entry = readNotice(row); return entry ? [entry] : []; });
const readInbox = (value: unknown): Inbox => {
  const row = object(value);
  return { notices: readNotices(row.notices), dismissed: array(row.dismissed).filter(socialId).slice(-1000), removed: array(row.removed).filter(noticeId).slice(-1000) };
};

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Invalid Studio account workspace directory.');
}

export class NodeAccountWorkspace implements AccountWorkspace {
  readonly runs: string;
  readonly schedules: string;
  private readonly directory: string;

  constructor(readonly owner: string, private readonly root = localAccountsDirectory()) {
    if (owner !== 'local' && !isWorkspaceOwner(owner)) throw new Error('Invalid Studio workspace owner.');
    this.directory = path.join(root, owner);
    this.runs = this.directory;
    this.schedules = path.join(this.directory, 'schedules');
  }

  prepare(): void {
    this.prepareDirectory();
    privateDirectory(path.join(this.directory, 'projects'));
    privateDirectory(this.schedules);
  }

  private prepareDirectory(): void {
    if (this.root === localAccountsDirectory()) prepareLocalDirectory(this.directory);
    privateDirectory(this.root); privateDirectory(this.directory);
  }

  private use<T>(run: (db: DatabaseSync) => T): T {
    this.prepareDirectory();
    const file = path.join(this.directory, 'workspace.sqlite');
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error('Invalid Studio account workspace database.');
    const db = new DatabaseSync(file, { timeout: 300 });
    try {
      db.exec('CREATE TABLE IF NOT EXISTS workspace (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      return run(db);
    } finally { db.close(); }
  }

  private read<T>(key: string, parse: (value: unknown) => T, db: DatabaseSync): T {
    const row = db.prepare('SELECT value FROM workspace WHERE key = ?').get(key);
    return parse(typeof row?.value === 'string' ? JSON.parse(row.value) : undefined);
  }

  private update<T>(key: string, parse: (value: unknown) => T, edit: (old: T) => T): { value: T; changed: boolean } {
    return this.use(db => {
      db.exec('BEGIN IMMEDIATE');
      const old = this.read(key, parse, db), next = edit(old), value = JSON.stringify(next);
      const changed = JSON.stringify(old) !== value;
      if (changed) db.prepare('INSERT OR REPLACE INTO workspace (key, value) VALUES (?, ?)').run(key, value);
      db.exec('COMMIT');
      return { value: next, changed };
    });
  }

  readHistory(): ProjectHistory { return this.use(db => this.read('projects', history, db)); }
  updateHistory(edit: (old: ProjectHistory) => ProjectHistory): boolean {
    return this.update('projects', history, old => history(edit(old))).changed;
  }

  inbox(input: unknown): { notices: Notice[]; dismissed: string[] } {
    const request = object(input);
    const inbox = request.kind === 'list' ? this.use(db => this.read('inbox', readInbox, db)) : this.update('inbox', readInbox, previous => {
      const { notices, dismissed, removed } = previous;
      if (request.kind === 'add' || request.kind === 'import') {
        const incoming = request.kind === 'import' ? readNotices(request.notices) : readNotices([request.notice]);
        const items = new Map(notices.map(notice => [notice.id, notice]));
        const deleted = new Set(removed);
        for (const notice of incoming) {
          if (deleted.has(notice.id)) continue;
          const existing = items.get(notice.id);
          items.set(notice.id, existing ? { ...existing, read: existing.read || notice.read } : notice);
        }
        return { ...previous, notices: [...items.values()].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 300),
          dismissed: dismissals(dismissed, request.kind === 'import' ? request.dismissed : undefined) };
      }
      if (request.kind === 'dismiss') return { ...previous, dismissed: dismissals(dismissed, request.ids) };
      const ids = new Set(array(request.ids).slice(0, 300).filter(noticeId));
      if (request.kind === 'read' || request.kind === 'read-all') return { ...previous,
        notices: notices.map(row => !row.read && (request.kind === 'read-all' || ids.has(row.id)) ? { ...row, read: true } : row) };
      if (request.kind === 'clear') {
        const deleting = notices.filter(row => row.read && ids.has(row.id)).map(row => row.id);
        return { ...previous, notices: notices.filter(row => !row.read || !ids.has(row.id)), removed: [...new Set([...removed, ...deleting])].slice(-1000) };
      }
      return previous;
    }).value;
    return { notices: inbox.notices, dismissed: inbox.dismissed };
  }
}

function history(value: unknown): ProjectHistory {
  const row = object(value);
  const local = (project: { uri: string }) => { const uri = new URL(project.uri); return uri.protocol === 'file:' && !uri.host && !uri.search && !uri.hash; };
  return { recent: readRecentProjects(row.recent).filter(local).slice(0, 50), imported: readImportedProjects(row.imported).filter(local) };
}

function dismissals(previous: string[], value: unknown): string[] {
  return [...new Set([...previous, ...array(value).slice(0, 1000).filter(socialId)])].slice(-1000);
}
