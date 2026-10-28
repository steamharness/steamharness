import type { Connection } from './workflow-auth-client';
import type { WebSession, WebSessionExit } from './workflow-cli-types';
import { t } from './localization';
import type { StudioUserSettings } from './user-settings';

/** Keep the page lifetime separate from a CLI process which may have exited. */
export class RecoverableWebSession implements WebSession {
  private exited = false;
  private closing = false;
  private restarting?: Promise<boolean>;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<(exit?: WebSessionExit) => void>();
  private readonly recovered = new Set<() => void>();
  private exit?: WebSessionExit;
  private exitListener: { dispose(): void };
  private finish!: () => void;
  readonly closed = new Promise<void>(resolve => { this.finish = resolve; });
  private auth?: { connection?: Connection };
  private resources?: string[];
  private userSettings?: StudioUserSettings;

  constructor(private current: WebSession, private readonly start: (port: number, signal: AbortSignal) => Promise<WebSession>) {
    this.exitListener = this.watch(current);
  }
  get ready() { return this.current.ready; }
  private watch(session: WebSession) {
    return session.onExit(exit => {
      if (this.closing || session !== this.current) return;
      this.exited = true;
      this.exit = exit;
      for (const listener of this.listeners) listener(exit);
    });
  }
  reconnect(): Promise<boolean> {
    if (this.closing) return Promise.reject(new Error(t('Workflow workspace has closed.')));
    if (this.restarting) return this.restarting;
    // A network failure must never terminate a live CLI or duplicate its owner.
    if (!this.exited) return Promise.resolve(false);
    this.restarting = (async () => {
      const previous = this.current;
      await previous.closed;
      this.controller.signal.throwIfAborted();
      const next = await this.start(Number(new URL(previous.ready.url).port), this.controller.signal);
      if (this.closing || new URL(next.ready.url).origin !== new URL(previous.ready.url).origin || next.ready.project.id !== previous.ready.project.id) {
        await next.close();
        throw new Error(t('Workflow recovery did not restore the original project address.'));
      }
      try {
        if (this.auth) next.updateAuth(this.auth.connection);
        if (this.resources) next.updateResourceProjects(this.resources);
        if (this.userSettings) next.updateUserSettings(this.userSettings);
      } catch (error) { await next.close(); throw error; }
      this.exitListener.dispose();
      this.current = next; this.exited = false; this.exit = undefined; this.exitListener = this.watch(next);
      for (const listener of this.recovered) listener();
      return true;
    })().finally(() => { this.restarting = undefined; });
    return this.restarting;
  }
  updateAuth(connection?: Connection): void { this.auth = { connection }; if (!this.exited) this.current.updateAuth(connection); }
  updateUserSettings(settings: StudioUserSettings): void { this.userSettings = structuredClone(settings); if (!this.exited) this.current.updateUserSettings(this.userSettings); }
  updateResourceProjects(projects: string[]): void {
    this.resources = [...projects]; if (!this.exited) this.current.updateResourceProjects(projects);
  }
  onReconnect(callback: () => void) { this.recovered.add(callback); return { dispose: () => { this.recovered.delete(callback); } }; }
  onExit(callback: (exit?: WebSessionExit) => void) {
    this.listeners.add(callback);
    if (this.exited) queueMicrotask(() => { if (!this.closing && this.exited && this.listeners.has(callback)) callback(this.exit); });
    return { dispose: () => { this.listeners.delete(callback); } };
  }
  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true; this.controller.abort(); this.exitListener.dispose(); this.listeners.clear(); this.recovered.clear();
    try { await this.restarting?.catch(() => undefined); await this.current.close(); }
    finally { this.finish(); }
  }
}
