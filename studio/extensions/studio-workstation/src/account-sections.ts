import type { AccountSectionConnection, AccountSectionProvider, AccountSectionState } from './account-section-types';

interface Entry {
  provider: AccountSectionProvider;
  state: AccountSectionState;
  request?: AbortController;
  pending?: Promise<void>;
  refreshedAt: number;
}

export class AccountSections {
  private readonly entries = new Map<string, Entry>();
  private connection?: AccountSectionConnection;

  constructor(private readonly onChange: (states: AccountSectionState[]) => void) {}

  getStates(): AccountSectionState[] {
    return this.connection ? [...this.entries.values()].map(entry => entry.state) : [];
  }

  getProviders(): { id: string; title: string; icon?: string }[] {
    return [...this.entries.values()].map(({ provider }) => ({ id: provider.id, title: provider.title, icon: provider.icon }));
  }

  register(provider: AccountSectionProvider): { dispose(): void } {
    if (this.entries.has(provider.id)) { throw new Error('Duplicate account section provider.'); }
    const entry: Entry = { provider, state: this.emptyState(provider), refreshedAt: 0 };
    this.entries.set(provider.id, entry);
    return { dispose: () => {
      if (this.entries.get(provider.id) !== entry) { return; }
      entry.request?.abort();
      this.entries.delete(provider.id);
      this.emit();
    } };
  }

  setConnection(connection: AccountSectionConnection | undefined): void {
    if (this.connection?.serverUrl === connection?.serverUrl && this.connection?.accessToken === connection?.accessToken) { return; }
    this.connection = connection && { serverUrl: connection.serverUrl, accessToken: connection.accessToken };
    for (const entry of this.entries.values()) {
      entry.request?.abort();
      entry.request = undefined;
      entry.pending = undefined;
      entry.refreshedAt = 0;
      entry.state = this.emptyState(entry.provider);
    }
    this.emit();
  }

  async refresh(force = false): Promise<void> {
    const connection = this.connection;
    if (!connection) { return; }
    await Promise.all([...this.entries.values()].map(entry => {
      if (entry.pending) { return entry.pending; }
      if (!force && entry.refreshedAt && Date.now() - entry.refreshedAt < 30_000) { return; }
      const request = new AbortController();
      entry.request = request;
      entry.state = { ...entry.state, loading: true, failed: false };
      this.emit();
      const current = (): boolean => !request.signal.aborted && this.connection === connection && this.entries.get(entry.provider.id) === entry;
      entry.pending = Promise.resolve().then(() => entry.provider.load({ ...connection }, request.signal)).then(sections => {
        if (!current()) { return; }
        entry.state = { ...entry.state, sections, updatedAt: new Date().toISOString() };
      }).catch(() => {
        if (current()) { entry.state = { ...entry.state, failed: true }; }
      }).finally(() => {
        if (!current()) { return; }
        entry.refreshedAt = Date.now();
        entry.pending = undefined;
        entry.request = undefined;
        entry.state = { ...entry.state, loading: false };
        this.emit();
      });
      return entry.pending;
    }));
  }

  async runAction(providerId: string, action: string): Promise<void> {
    const entry = this.entries.get(providerId);
    const connection = this.connection;
    if (!entry || !connection || !entry.state.sections.some(section => section.actions?.some(item => item.id === action))) { return; }
    await entry.provider.onAction?.(action, { ...connection });
  }

  private emptyState(provider: AccountSectionProvider): AccountSectionState {
    return { id: provider.id, title: provider.title, sections: [], loading: false, failed: false };
  }

  private emit(): void { this.onChange(this.getStates()); }

  dispose(): void {
    for (const entry of this.entries.values()) { entry.request?.abort(); }
    this.entries.clear();
    this.connection = undefined;
  }
}
