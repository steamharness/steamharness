import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationSession } from './workflow-types';
import type { ConversationOwnership } from './conversation-ownership';

interface History { sessions?: ConversationSession[]; activeId?: string; selectionVersion?: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Merge only this service's changed sessions under a short cross-process lock. */
export class ConversationHistory {
  private versions: Map<string, string>;
  private stamp = '';
  constructor(private readonly filename: string, saved: History, private readonly ownership: ConversationOwnership) {
    this.versions = new Map((saved.sessions ?? []).map(session => {
      ownership.rememberScope(session.id, session.agentOwnerId ?? session.id);
      return [session.id, digest(session)];
    }));
  }

  async read(): Promise<History> {
    try { return JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }

  async refresh(acquired: Set<string> = new Set()): Promise<History | undefined> {
    let stamp: string;
    try { const info = await stat(this.filename); stamp = `${info.mtimeMs}:${info.size}:${info.ino}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stamp === this.stamp && !acquired.size) return;
    const history = await this.read(); this.stamp = stamp;
    for (const session of history.sessions ?? []) {
      this.ownership.rememberScope(session.id, session.agentOwnerId ?? session.id);
      if (!this.ownership.owns(session.id) || acquired.has(this.ownership.scope(session.id))) this.versions.set(session.id, digest(session));
    }
    return history;
  }

  async save(sessions: ConversationSession[], activeId: string): Promise<void> {
    for (const session of sessions) this.ownership.rememberScope(session.id, session.agentOwnerId ?? session.id);
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
      const history = await this.read();
      const versions = new Map(this.versions);
      const merged = new Map((history.sessions ?? []).map(session => [session.id, session]));
      const incoming = new Set(sessions.map(session => session.id));
      for (const id of versions.keys()) if (!incoming.has(id) && this.ownership.owns(id)) { merged.delete(id); versions.delete(id); }
      for (const session of sessions) {
        const version = digest(session);
        if ((!merged.has(session.id) && !this.versions.has(session.id) || this.ownership.owns(session.id)) && version !== this.versions.get(session.id)) {
          merged.set(session.id, session); versions.set(session.id, version);
        }
      }
      const saved = { sessions: [...merged.values()], activeId, selectionVersion: 1 };
      const temporary = `${this.filename}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 }); await rename(temporary, this.filename);
      this.versions = versions;
    } finally { lock.close(); }
  }
}
