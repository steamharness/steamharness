import type { WebConnection } from './runtime';
import type { AccountState } from './workflow-auth-client';
import { t } from './localization';

export interface ProjectServerIssue {
  kind: 'checking' | 'sign-in-required' | 'project-unavailable' | 'access-denied' | 'setup-required' | 'connection-unavailable';
  serverUrl?: string;
}
export interface ProjectServerState { checking: boolean; issue?: ProjectServerIssue }

/** These responses need a user action, rather than another connection attempt. */
export function projectServerIssue(status: number, serverUrl: string): ProjectServerIssue | undefined {
  if (status === 401) return { kind: 'sign-in-required', serverUrl };
  if (status === 403) return { kind: 'access-denied', serverUrl };
  if (status === 404) return { kind: 'project-unavailable', serverUrl };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: 'setup-required', serverUrl };
}

/** Only the project endpoint can establish that the project itself is unavailable. */
export async function checkProjectServer(projectId: string, connection: WebConnection, signal: AbortSignal): Promise<ProjectServerIssue | undefined> {
  const serverUrl = connection.serverUrl;
  const response = await fetch(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${connection.accessToken}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  try {
    const issue = projectServerIssue(response.status, serverUrl);
    if (issue) return issue;
    if (!response.ok) return { kind: 'connection-unavailable', serverUrl };
    let value;
    try { value = await response.json(); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (value?.errCode !== 0 || typeof value.data?.id !== 'string' || value.data.id.toLowerCase() !== projectId.toLowerCase()) return { kind: 'setup-required', serverUrl };
  } finally { await response.body?.cancel().catch(() => undefined); }
}

/** Read-only checks never create projects, replay runs, or resume queued inputs. */
export class ProjectServerConnection {
  state: ProjectServerState = { checking: true };
  private request?: AbortController;
  private pending?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private checkedAt = 0;
  get ready(): boolean { return !this.disposed && this.checkedAt > 0 && !this.state.issue && !!this.connection(); }
  constructor(private readonly projectId: string, private readonly connection: () => WebConnection | undefined, private readonly changed: () => void) {}
  authenticationChanged(account: AccountState): void {
    this.request?.abort(); this.pending = undefined; clearTimeout(this.retry); this.checkedAt = 0;
    if (this.disposed) return;
    if (account.status === 'checking') {
      this.state = { checking: true, ...(this.state.issue?.serverUrl === account.serverUrl ? { issue: this.state.issue } : {}) };
      this.changed(); return;
    }
    if (this.connection()) { void this.refresh(); return; }
    this.state = { checking: false, issue: {
      kind: account.status === 'error' ? 'connection-unavailable' : 'sign-in-required', serverUrl: account.serverUrl,
    } };
    this.changed();
  }
  refresh(): Promise<void> {
    if (this.disposed || !this.connection()) return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.retry);
    const connection = this.connection()!, abort = this.request = new AbortController();
    this.state = { ...this.state, checking: !this.ready }; this.changed();
    const task = (async () => {
      let issue: ProjectServerIssue | undefined;
      try { issue = await checkProjectServer(this.projectId, connection, abort.signal); }
      catch { issue = { kind: 'connection-unavailable', serverUrl: connection.serverUrl }; }
      if (abort.signal.aborted || this.disposed) return;
      this.checkedAt = Date.now(); this.state = { checking: false, issue }; this.changed();
      if (!issue || issue.kind === 'connection-unavailable') {
        this.retry = setTimeout(() => { void this.refresh(); }, issue ? 5_000 : 30_000); this.retry.unref();
      }
    })().finally(() => { if (this.pending === task) this.pending = undefined; });
    this.pending = task;
    return task;
  }
  async assertReady(): Promise<void> {
    const connection = this.connection();
    if (this.pending) await this.pending;
    else if (!this.state.issue && Date.now() - this.checkedAt >= 5_000) await this.refresh();
    const current = this.connection();
    if (this.disposed || !connection || current?.serverUrl !== connection.serverUrl || current.accessToken !== connection.accessToken || this.state.checking || this.state.issue) {
      throw Object.assign(new Error(t('Project data is unavailable. Follow the Server setup guidance and choose Check again.')), { code: 'PROJECT_SERVER_SETUP_REQUIRED' });
    }
  }
  assertAvailable(): void {
    if (!this.ready) throw Object.assign(new Error(t('Project data is unavailable. Follow the Server setup guidance and choose Check again.')), { code: 'PROJECT_SERVER_SETUP_REQUIRED' });
  }
  close(): void { this.disposed = true; this.request?.abort(); clearTimeout(this.retry); }
}
