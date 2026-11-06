import type { RuntimeHistoryLease, RuntimePersistence } from 'steamharness/runtime-storage';
import { t } from './localization';

export interface ConversationAccess { readOnly: boolean; reason?: 'pending' | 'opened' | 'running' }
interface Owner { lease: RuntimeHistoryLease; clients: Map<string, string>; executing: boolean; running: boolean; retained: number }

/** Persistence owners protect execution across windows, processes and restarts. */
export class ConversationOwnership {
  private readonly owners = new Map<string, Owner>();
  private readonly pending = new Map<string, Promise<Owner | undefined>>();
  private readonly conflicts = new Set<string>();
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly selections = new Map<string, string>();
  private readonly writerGroups = new Map<string, string>();
  private readonly disconnects = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly acquired = new Set<string>();
  private readonly scopes = new Map<string, string>();
  private closed = false;
  private epoch = 0;
  constructor(private readonly persistence: () => RuntimePersistence | undefined, private readonly resolveScope: (id: string) => string = id => id,
    private readonly changed: () => void = () => undefined, private readonly lost: (scope: string, error: unknown) => void = () => undefined) {}

  scope(id: string): string {
    const scope = this.resolveScope(id);
    if (scope !== id) this.scopes.set(id, scope);
    return this.scopes.get(id) ?? scope;
  }
  rememberScope(id: string, scope: string): void { this.scopes.set(id, scope); }
  shareWriter(clientId: string, groupId: string): void { this.writerGroups.set(clientId, groupId); }
  private writer(clientId: string): string { return this.writerGroups.get(clientId) ?? clientId; }
  owns(id: string): boolean {
    const scope = this.scope(id), owner = this.owners.get(scope);
    if (!owner) return false;
    try { owner.lease.assertOwned(); return true; }
    catch (error) { this.release(scope); this.lost(scope, error); return false; }
  }
  lease(id: string): RuntimeHistoryLease {
    if (!this.owns(id)) throw new Error(t('This conversation is open or running in another window. You can read it here or start a new conversation.'));
    return this.owners.get(this.scope(id))!.lease;
  }
  takeAcquired(): Set<string> { const acquired = new Set(this.acquired); this.acquired.clear(); return acquired; }
  async acquire(id: string): Promise<Owner | undefined> {
    if (this.closed) return;
    const scope = this.scope(id);
    if (this.owns(id)) return this.owners.get(scope);
    const existing = this.pending.get(scope); if (existing) return existing;
    const persistence = this.persistence(); if (!persistence) return;
    const epoch = this.epoch;
    let acquiredLease: RuntimeHistoryLease | undefined;
    const pending = (async () => {
      await this.releasing.get(scope);
      if (this.closed || epoch !== this.epoch) return;
      return acquiredLease = await persistence.acquire(scope, error => {
        if (epoch === this.epoch && (!acquiredLease || this.owners.get(scope)?.lease === acquiredLease)) {
          this.release(scope); this.lost(scope, error);
        }
      });
    })().then(async lease => {
      if (!lease) return;
      if (this.closed || epoch !== this.epoch) { await lease.close(); return; }
      const owner = { lease, clients: new Map<string, string>(), executing: false, running: false, retained: 0 };
      this.conflicts.delete(scope);
      this.owners.set(scope, owner); this.acquired.add(scope); this.changed(); return owner;
    }).catch(error => {
      if (epoch === this.epoch) {
        if ((error as { code?: string }).code === 'RUNTIME_STORAGE_OWNER_CONFLICT') {
          // Publish the confirmed conflict once; subsequent snapshots may retry acquisition.
          if (!this.conflicts.has(scope)) { this.conflicts.add(scope); this.changed(); }
        } else this.lost(scope, error);
      }
      return undefined;
    }).finally(() => { if (this.pending.get(scope) === pending) this.pending.delete(scope); });
    this.pending.set(scope, pending); return pending;
  }
  select(clientId: string, id: string): ConversationAccess {
    clearTimeout(this.disconnects.get(clientId)); this.disconnects.delete(clientId);
    const previous = this.selections.get(clientId);
    if (previous !== id) { if (previous) this.releaseClient(previous, clientId); this.selections.set(clientId, id); }
    if (!this.owns(id)) {
      void this.acquire(id).then(owner => {
        if (!owner) return;
        if (this.selections.get(clientId) === id && !owner.clients.has(id)) owner.clients.set(id, this.writer(clientId));
        else if (!owner.clients.size && !owner.executing && !owner.retained) this.release(this.scope(id));
      });
      return { readOnly: true, reason: this.conflicts.has(this.scope(id)) ? 'opened' : 'pending' };
    }
    const owner = this.owners.get(this.scope(id))!;
    const writer = owner.clients.get(id);
    if (writer && writer !== this.writer(clientId)) return { readOnly: true, reason: owner.running ? 'running' : 'opened' };
    owner.clients.set(id, this.writer(clientId)); return { readOnly: false };
  }
  async assertWritable(id: string, clientId?: string): Promise<void> {
    const owner = await this.acquire(id), writer = owner?.clients.get(id);
    if (!owner || clientId && writer && writer !== this.writer(clientId)) throw new Error(t('This conversation is open or running in another window. You can read it here or start a new conversation.'));
    owner.lease.assertOwned(); if (clientId) owner.clients.set(id, this.writer(clientId));
  }
  async hold(id: string): Promise<() => void> {
    const owner = await this.acquire(id);
    if (!owner) throw new Error(t('This conversation is open or running in another window. You can read it here or start a new conversation.'));
    owner.retained++;
    return () => { owner.retained--; };
  }
  execute(id: string): boolean {
    if (!this.owns(id)) { void this.acquire(id); return false; }
    this.owners.get(this.scope(id))!.executing = true; return true;
  }
  async independent(id: string): Promise<() => void> {
    const previous = this.scopes.get(id) ?? id; this.scopes.set(id, id);
    const owner = await this.acquire(id);
    if (!owner) { this.scopes.set(id, previous); throw new Error(t('This conversation is open or running in another window. You can read it here or start a new conversation.')); }
    owner.retained++;
    const parent = this.owners.get(previous), client = parent?.clients.get(id);
    if (client && previous !== id) { parent!.clients.delete(id); owner.clients.set(id, client); }
    return () => { owner.retained--; if (!owner.retained && !owner.executing && !owner.clients.size) this.release(id); };
  }
  update(executing: Set<string>, running: Set<string>): void {
    for (const [id, owner] of this.owners) {
      if (!this.owns(id)) continue;
      owner.executing = executing.has(id); owner.running = running.has(id);
      if (!owner.retained && !owner.executing && !owner.clients.size) this.release(id);
    }
  }
  disconnect(clientId: string, changed: () => void): void {
    clearTimeout(this.disconnects.get(clientId));
    this.disconnects.set(clientId, setTimeout(() => {
      this.detach(clientId);
      changed();
    }, 1_000));
  }
  /** A destroyed view cannot reconnect; release its writer without the SSE grace period. */
  detach(clientId: string): void {
    clearTimeout(this.disconnects.get(clientId)); this.disconnects.delete(clientId); this.selections.delete(clientId);
    for (const owner of this.owners.values()) for (const [id, writer] of owner.clients) if (writer === this.writer(clientId)) this.releaseClient(id, clientId);
    this.writerGroups.delete(clientId);
  }
  private releaseClient(id: string, clientId: string): void {
    const writer = this.writer(clientId);
    if ([...this.selections].some(([other, selected]) => other !== clientId && selected === id && this.writer(other) === writer)) return;
    for (const [scope, owner] of this.owners) {
      if (owner.clients.get(id) !== writer) continue;
      owner.clients.delete(id); if (!owner.retained && !owner.executing && !owner.clients.size) this.release(scope);
    }
  }
  private release(id: string): void {
    const owner = this.owners.get(id); this.owners.delete(id); this.acquired.delete(id);
    if (!owner) return;
    const epoch = this.epoch;
    const closing = owner.lease.close().catch(error => { if (epoch === this.epoch) this.lost(id, error); })
      .finally(() => { if (this.releasing.get(id) === closing) this.releasing.delete(id); });
    this.releasing.set(id, closing);
  }
  async reset(): Promise<void> {
    this.epoch++; this.scopes.clear(); this.acquired.clear(); this.conflicts.clear(); this.selections.clear(); this.writerGroups.clear();
    const owners = [...this.owners.values()]; this.owners.clear();
    const pending = [...this.pending.values()]; this.pending.clear();
    const releasing = [...this.releasing.values()];
    await Promise.allSettled([...owners.map(owner => owner.lease.close()), ...pending, ...releasing]);
  }
  async close(): Promise<void> {
    this.closed = true; for (const timer of this.disconnects.values()) clearTimeout(timer); this.disconnects.clear(); await this.reset();
  }
}
