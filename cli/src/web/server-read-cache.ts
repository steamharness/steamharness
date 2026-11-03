/** Short-lived display data only. Never use this cache to authorize an operation. */
export class ServerReadCache {
  private readonly entries = new Map<string, { value?: unknown; expiresAt: number; pending?: Promise<unknown> }>();
  constructor(private readonly ttlMs: number, private readonly limit = 128) {}

  clear(): void { this.entries.clear(); }

  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (entry?.pending) return structuredClone(await entry.pending) as T;
    if (entry && entry.expiresAt > Date.now()) return structuredClone(entry.value) as T;
    entry = { expiresAt: 0 };
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    const current = entry;
    current.pending = load().then(value => {
      if (this.entries.get(key) === current) {
        current.value = structuredClone(value);
        current.expiresAt = Date.now() + this.ttlMs;
      }
      return value;
    }).catch(error => {
      if (this.entries.get(key) === current) this.entries.delete(key);
      throw error;
    }).finally(() => { current.pending = undefined; });
    return structuredClone(await current.pending) as T;
  }
}
