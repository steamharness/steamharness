import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { t } from './localization';

export interface ConversationAccess { readOnly: boolean; reason?: 'opened' | 'running' }
interface Owner { database: DatabaseSync; clients: Map<string, string>; executing: boolean; running: boolean }

/** OS-released locks: a crashed window cannot leave a lease that blocks recovery. */
export class ConversationOwnership {
  private readonly owners = new Map<string, Owner>();
  private readonly selections = new Map<string, string>();
  private readonly disconnects = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly acquired = new Set<string>();
  private readonly scopes = new Map<string, string>();
  private closed = false;

  constructor(private readonly directory: string, private readonly resolveScope: (id: string) => string = id => id) { mkdirSync(directory, { recursive: true }); }

  scope(id: string): string {
    const scope = this.resolveScope(id);
    if (scope !== id) this.scopes.set(id, scope);
    return this.scopes.get(id) ?? scope;
  }
  rememberScope(id: string, scope: string): void { this.scopes.set(id, scope); }

  owns(id: string): boolean { return this.owners.has(this.scope(id)); }
  takeAcquired(): Set<string> { const acquired = new Set(this.acquired); this.acquired.clear(); return acquired; }

  private acquire(id: string): Owner | undefined {
    if (this.closed) return;
    id = this.scope(id);
    const current = this.owners.get(id);
    if (current) return current;
    const filename = path.join(this.directory, `${createHash('sha256').update(id).digest('hex')}.sqlite`);
    const database = new DatabaseSync(filename);
    try {
      database.exec('PRAGMA busy_timeout = 0');
      database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      database.close();
      if ((error as { errcode?: number }).errcode === 5) return;
      throw error;
    }
    const owner = { database, clients: new Map<string, string>(), executing: false, running: false };
    this.owners.set(id, owner);
    this.acquired.add(id);
    return owner;
  }

  select(clientId: string, id: string): ConversationAccess {
    clearTimeout(this.disconnects.get(clientId)); this.disconnects.delete(clientId);
    const previous = this.selections.get(clientId);
    if (previous !== id) {
      if (previous) this.releaseClient(previous, clientId);
      this.selections.set(clientId, id);
    }
    const owner = this.acquire(id);
    if (!owner) return { readOnly: true, reason: 'opened' };
    const writer = owner.clients.get(id);
    if (writer && writer !== clientId) return { readOnly: true, reason: owner.running ? 'running' : 'opened' };
    owner.clients.set(id, clientId);
    return { readOnly: false };
  }

  assertWritable(id: string, clientId?: string): void {
    const owner = this.acquire(id);
    const writer = owner?.clients.get(id);
    if (!owner || clientId && writer && writer !== clientId) throw new Error(t('This conversation is open or running in another window. You can read it here or start a new conversation.'));
    if (clientId) owner.clients.set(id, clientId);
  }

  execute(id: string): boolean {
    const owner = this.acquire(id);
    if (!owner) return false;
    owner.executing = true;
    return true;
  }

  update(executing: Set<string>, running: Set<string>): void {
    for (const [id, owner] of this.owners) {
      owner.executing = executing.has(id); owner.running = running.has(id);
      if (!owner.executing && !owner.clients.size) this.release(id);
    }
  }

  disconnect(clientId: string, changed: () => void): void {
    clearTimeout(this.disconnects.get(clientId));
    // A brief reconnect must retain its writer; a closed page releases it.
    this.disconnects.set(clientId, setTimeout(() => {
      this.disconnects.delete(clientId);
      this.selections.delete(clientId);
      for (const owner of this.owners.values()) for (const [id, writer] of owner.clients) if (writer === clientId) this.releaseClient(id, clientId);
      changed();
    }, 1_000));
  }

  private releaseClient(id: string, clientId: string): void {
    for (const [scope, owner] of this.owners) {
      if (owner.clients.get(id) !== clientId) continue;
      owner.clients.delete(id);
      if (!owner.executing && !owner.clients.size) this.release(scope);
    }
  }

  private release(id: string): void {
    const owner = this.owners.get(id);
    this.owners.delete(id); this.acquired.delete(id); owner?.database.close();
  }

  close(): void {
    this.closed = true;
    for (const timer of this.disconnects.values()) clearTimeout(timer);
    this.disconnects.clear(); this.selections.clear();
    for (const id of this.owners.keys()) this.release(id);
  }
}
