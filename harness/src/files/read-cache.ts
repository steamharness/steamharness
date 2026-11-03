/** Per-account, bounded byte snapshots. Callers must validate access before reuse. */
export class FileReadCache<T> {
  private readonly entries = new Map<string, { value: T; size: number }>();
  private size = 0;
  constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly maxEntries = 128) {}
  get(key: string): T | undefined { return this.entries.get(key)?.value; }
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.size -= entry.size; this.entries.delete(key); }
  }
  clear(): void { this.entries.clear(); this.size = 0; }
  set(key: string, value: T, size: number): void {
    this.delete(key);
    if (size > this.maxBytes) return;
    this.entries.set(key, { value, size }); this.size += size;
    while (this.size > this.maxBytes || this.entries.size > this.maxEntries) this.delete(this.entries.keys().next().value!);
  }
}
