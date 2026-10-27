import type { Project } from './workflow-types';
import type { WebSession } from './workflow-cli-types';
import { RecoverableWebSession } from './workflow-session';

interface Host {
  references: number;
  abort: AbortController;
  pending: Promise<RecoverableWebSession>;
}
/** One recoverable process per aggregate and assistant scope, leased by entry tabs. */
export class AggregateWebHostPool {
  private readonly hosts = new Map<string, Host>();
  constructor(private readonly started: (session: WebSession) => void = () => {}) {}
  async acquire(key: string, project: Pick<Project, 'entryId'>, start: (port: number | undefined, signal: AbortSignal) => Promise<WebSession>, signal?: AbortSignal): Promise<WebSession> {
    signal?.throwIfAborted();
    let host = this.hosts.get(key);
    if (!host) {
      const abort = new AbortController();
      host = { references: 0, abort, pending: Promise.resolve(undefined as never) };
      const created = host;
      created.pending = start(undefined, abort.signal).then(async session => {
        if (abort.signal.aborted) { await session.close(); throw abort.signal.reason; }
        const shared = new RecoverableWebSession(session, (port, signal) => start(port, AbortSignal.any([signal, abort.signal])));
        this.started(shared);
        return shared;
      }).catch(error => { if (this.hosts.get(key) === created) this.hosts.delete(key); throw error; });
      this.hosts.set(key, created);
    }
    host.references++;
    const selected = host;
    let released = false, shared: RecoverableWebSession | undefined;
    let finish!: () => void;
    const closed = new Promise<void>(resolve => { finish = resolve; });
    const release = async () => {
      if (released) return closed;
      released = true;
      signal?.removeEventListener('abort', aborted);
      try {
        if (--selected.references === 0) {
          if (this.hosts.get(key) === selected) this.hosts.delete(key);
          selected.abort.abort();
          await selected.pending.then(session => session.close(), () => undefined);
        }
      } finally { finish(); }
    };
    const aborted = () => { void release(); };
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      shared = await Promise.race([selected.pending, new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else closed.then(() => reject(signal?.reason ?? new Error('Project tab closed.')));
      })]);
      signal?.throwIfAborted();
      const current = shared;
      if (!current.ready.project.entries.some(entry => entry.entryId === project.entryId)) throw new Error('Project entry is no longer registered.');
      return {
        get ready() {
          const ready = current.ready;
          const url = new URL(ready.url); url.pathname = `/entries/${project.entryId}/`;
          return { ...ready, url: url.href };
        },
        closed, close: release, reconnect: () => current.reconnect(),
        updateAuth: connection => current.updateAuth(connection),
        updateUserSettings: settings => current.updateUserSettings(settings),
        updateResourceProjects: projects => current.updateResourceProjects(projects),
        onReconnect: callback => current.onReconnect(callback),
        onExit: callback => current.onExit(callback),
      };
    } catch (error) { await release(); throw error; }
  }
  async close(): Promise<void> {
    const hosts = [...this.hosts.values()]; this.hosts.clear();
    await Promise.all(hosts.map(async host => { host.abort.abort(); await host.pending.then(session => session.close(), () => undefined); }));
  }
}
