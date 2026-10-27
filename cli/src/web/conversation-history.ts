import { userSettingsJsonReplacer } from './user-settings';
import { createHash } from 'node:crypto';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationSession } from './workflow-types';
import type { ConversationOwnership } from './conversation-ownership';

interface History { sessions?: ConversationSession[]; activeId?: string; selectionVersion?: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, userSettingsJsonReplacer)).digest('hex');
const stamp = (info: { mtimeMs: number; size: number; ino: number }) => `${info.mtimeMs}:${info.size}:${info.ino}`;
interface StoredSession { content: string }
interface StoredHistory { stamp: string; sessions: Map<string, StoredSession>; activeId?: string; selectionVersion?: number }

/** Merge only this service's changed sessions under a short cross-process lock. */
export class ConversationHistory {
  private versions: Map<string, string>;
  private stamp = '';
  private cached?: StoredHistory;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly filename: string, saved: History, private readonly ownership: ConversationOwnership) {
    this.versions = new Map((saved.sessions ?? []).map(session => {
      ownership.rememberScope(session.id, session.agentOwnerId ?? session.id);
      return [session.id, digest(session)];
    }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<StoredHistory> {
    try {
      if (this.cached?.stamp === stamp(await stat(this.filename))) return this.cached;
      // Read and stat one handle: an atomic rename in another service must not
      // associate the bytes of one revision with the stamp of another.
      const file = await open(this.filename, 'r');
      try {
        const history: History = JSON.parse(await file.readFile('utf8'));
        return this.cached = { stamp: stamp(await file.stat()), activeId: history.activeId, selectionVersion: history.selectionVersion,
          sessions: new Map((history.sessions ?? []).map(session => [session.id, {
            content: JSON.stringify(session, userSettingsJsonReplacer),
          }])) };
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.cached = { stamp: '', sessions: new Map() };
    }
  }

  private decode(history: StoredHistory): History {
    return { sessions: [...history.sessions.values()].map(session => JSON.parse(session.content)), activeId: history.activeId, selectionVersion: history.selectionVersion };
  }
  read(): Promise<History> { return this.enqueue(async () => this.decode(await this.load())); }

  refresh(acquired: Set<string> = new Set()): Promise<History | undefined> {
    return this.enqueue(async () => {
      const stored = await this.load();
      if (!stored.stamp || stored.stamp === this.stamp && !acquired.size) return;
      const history = this.decode(stored); this.stamp = stored.stamp;
      for (const session of history.sessions ?? []) {
        this.ownership.rememberScope(session.id, session.agentOwnerId ?? session.id);
        if (!this.ownership.owns(session.id) || acquired.has(this.ownership.scope(session.id))) this.versions.set(session.id, digest(session));
      }
      return history;
    });
  }

  save(sessions: ConversationSession[], activeId: string): Promise<void> {
    const incoming = new Set(sessions.map(session => session.id));
    const changes = new Map<string, StoredSession & { version: string }>();
    // Capture before the first await. Only writable or newly-created sessions
    // need snapshots; unrelated histories remain immutable serialized fragments.
    for (const session of sessions) {
      const scope = session.agentOwnerId ?? session.id;
      this.ownership.rememberScope(session.id, scope);
      if (this.ownership.owns(session.id) || !this.versions.has(session.id)) {
        const content = JSON.stringify(session, userSettingsJsonReplacer);
        changes.set(session.id, { content, version: createHash('sha256').update(content).digest('hex') });
      }
    }
    return this.enqueue(() => this.write(changes, incoming, activeId));
  }

  private async write(changes: Map<string, StoredSession & { version: string }>, incoming: Set<string>, activeId: string): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const lock = new DatabaseSync(`${this.filename}.lock.sqlite`);
    const started = Date.now();
    try {
      for (;;) {
        try { lock.exec('BEGIN EXCLUSIVE'); break; }
        catch (error) {
          if ((error as { errcode?: number }).errcode !== 5 || Date.now() - started > 10_000) throw error;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      const history = await this.load();
      const versions = new Map(this.versions);
      const merged = new Map(history.sessions);
      let changed = !history.stamp || history.activeId !== activeId || history.selectionVersion !== 1;
      for (const id of versions.keys()) if (!incoming.has(id) && this.ownership.owns(id)) {
        changed = merged.delete(id) || changed; versions.delete(id);
      }
      for (const [id, session] of changes) {
        if ((!merged.has(id) && !this.versions.has(id) || this.ownership.owns(id)) && (session.version !== this.versions.get(id) || !merged.has(id))) {
          merged.set(id, session); versions.set(id, session.version); changed = true;
        }
      }
      if (!changed) { this.versions = versions; return; }
      const temporary = `${this.filename}.${process.pid}.tmp`;
      const file = await open(temporary, 'w', 0o600);
      let writtenStamp: string;
      try {
        await file.writeFile('{"sessions":[');
        let first = true;
        for (const session of merged.values()) {
          if (!first) await file.writeFile(',');
          await file.writeFile(session.content); first = false;
        }
        await file.writeFile(`],"activeId":${JSON.stringify(activeId)},"selectionVersion":1}`);
        writtenStamp = stamp(await file.stat());
      } finally { await file.close(); }
      await rename(temporary, this.filename);
      this.cached = { stamp: writtenStamp, sessions: merged, activeId, selectionVersion: 1 };
      // Skip a poll of our own write only after all merged external history has
      // been observed. Otherwise refresh must still deliver that history.
      if (this.stamp === history.stamp) this.stamp = writtenStamp;
      this.versions = versions;
    } finally { lock.close(); }
  }
}
