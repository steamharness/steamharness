/** A restarted service has its own revision sequence. Retired services stay stale. */
export class StateRevisions {
  private source?: string;
  private revision = -1;
  private readonly retired = new Set<string>();
  accept(message: { serverInstanceId?: string; stateRevision?: number }): boolean {
    const source = message.serverInstanceId;
    if (source && source !== this.source) {
      if (this.retired.has(source)) return false;
      if (this.source) this.retired.add(this.source);
      this.source = source; this.revision = -1;
    }
    if (this.source && !source) return false;
    if (typeof message.stateRevision !== 'number') return true;
    if (message.stateRevision <= this.revision) return false;
    this.revision = message.stateRevision;
    return true;
  }
}
