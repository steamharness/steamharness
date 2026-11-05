import type { WebConnection } from './runtime';
import type { AccountState } from './workflow-auth-client';
import type { Project } from './workflow-types';
import { t } from './localization';
export interface ProjectServerIssue { kind: 'checking' | 'sign-in-required' | 'project-unavailable' | 'access-denied' | 'setup-required' | 'connection-unavailable'; serverUrl?: string; projectId?: string; entryId?: string; database?: string; status?: number; reason?: 'invalid-project-response' }
export interface ProjectServerCheck { id: string; projectId: string; entryId?: string; database?: string; stage: 'builtin' | 'registration' | 'database'; status: 'checking' | 'passed' | 'action-required' | 'waiting'; issue?: ProjectServerIssue }
export interface ProjectServerState { checking: boolean; issue?: ProjectServerIssue; blocking?: boolean; checks?: ProjectServerCheck[] }
export type ProjectServerInspector = (connection: WebConnection | undefined, signal: AbortSignal, publish: (checks: ProjectServerCheck[]) => void, unavailable: ProjectServerIssue) => Promise<ProjectServerCheck[]>;
export interface ProjectServerAccessFailure { serverUrl: string; projectId: string; entryId: string; database?: string; status?: number }
export function projectServerAccessFailure(metadata: Record<string, unknown> | undefined, project: Project, connection: WebConnection | undefined): ProjectServerAccessFailure | undefined {
  if (!connection || metadata?.code !== 'DATABASE_ACCESS_FAILED') return;
  return { serverUrl: connection.serverUrl, projectId: project.id, entryId: project.entryId, database: typeof metadata.database === 'string' ? metadata.database : undefined, status: typeof metadata.status === 'number' ? metadata.status : undefined };
}
export function projectServerIssue(status: number, serverUrl: string): ProjectServerIssue | undefined {
  if (status === 401) return { kind: 'sign-in-required', serverUrl };
  if (status === 403) return { kind: 'access-denied', serverUrl };
  if (status === 404) return { kind: 'project-unavailable', serverUrl };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: 'setup-required', serverUrl };
}
export async function readServerProject(projectId: string, connection: WebConnection, signal: AbortSignal): Promise<{ issue?: ProjectServerIssue; project?: { id: string; entries: import('@steamharness/project-manifest').ProjectEntry[] } }> {
  const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(projectId)}`, { headers: { Authorization: `Bearer ${connection.accessToken}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  const issue = projectServerIssue(response.status, connection.serverUrl); if (issue) { await response.body?.cancel(); return { issue }; }
  if (!response.ok) { await response.body?.cancel(); return { issue: { kind: 'connection-unavailable', serverUrl: connection.serverUrl, status: response.status } }; }
  const value = await response.json().catch(error => { if (error instanceof SyntaxError) return undefined; throw error; });
  if (value?.errCode !== 0 || typeof value.data?.id !== 'string' || value.data.id.toLowerCase() !== projectId.toLowerCase() || !Array.isArray(value.data.entries)) return { issue: { kind: 'setup-required', serverUrl: connection.serverUrl, reason: 'invalid-project-response' } };
  return { project: value.data };
}
export async function checkProjectServer(projectId: string, connection: WebConnection, signal: AbortSignal) { return (await readServerProject(projectId, connection, signal)).issue; }
/** Read-only checks never create projects, replay runs, or resume queued inputs. */
export class ProjectServerConnection {
  state: ProjectServerState = { checking: true };
  private request?: AbortController;
  private pending?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private checkedAt = 0;
  private authentication?: { connection: WebConnection; userId?: string };
  private failure?: ProjectServerAccessFailure;
  private unavailable: ProjectServerIssue = { kind: 'sign-in-required' };
  get blocking(): boolean { return this.state.blocking !== false; }
  get ready(): boolean { return !this.disposed && this.checkedAt > 0 && !this.state.checking && !this.state.issue && (!!this.connection() || !!this.options.inspect); }
  constructor(private readonly projectId: string, private readonly connection: () => WebConnection | undefined, private readonly changed: () => void,
    private readonly options: { blocking?: boolean; inspect?: ProjectServerInspector } = {}) {
    if (options.blocking === false) this.state.blocking = false;
  }
  reportFailure(failure: ProjectServerAccessFailure): Promise<void> {
    this.failure = failure;
    return this.restart();
  }
  restart(): Promise<void> {
    this.request?.abort(); this.pending = undefined; this.checkedAt = 0;
    return this.refresh();
  }
  settled(): Promise<void> { return this.pending ?? Promise.resolve(); }
  authenticationChanged(account: AccountState): void {
    if (this.disposed) return;
    const connection = this.connection();
    const unchanged = connection && this.authentication && account.status !== 'error' && account.status !== 'expired' && account.status !== 'signed-out'
      && sameConnection(connection, this.authentication.connection) && account.serverUrl.replace(/\/+$/, '') === connection.serverUrl
      && account.user?.userId === this.authentication.userId;
    if (!unchanged) {
      this.request?.abort(); this.pending = undefined; clearTimeout(this.retry); this.checkedAt = 0;
      this.authentication = undefined; this.failure = undefined;
      const blocking = this.state.blocking;
      this.state = { checking: true, ...(blocking === undefined ? {} : { blocking }) };
    }
    if (account.status === 'checking') {
      this.state = { ...this.state, checking: !this.ready };
      this.changed(); return;
    }
    if (connection) this.authentication = { connection: { ...connection }, userId: account.user?.userId };
    this.unavailable = {
      kind: account.status === 'error' ? 'connection-unavailable' : 'sign-in-required', serverUrl: account.serverUrl,
    };
    if (this.connection() || this.options.inspect) { void this.refresh(); return; }
    this.state = { ...this.state, checking: false, issue: this.unavailable };
    this.changed();
  }
  refresh(): Promise<void> {
    if (this.disposed || !this.connection() && !this.options.inspect) return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.retry);
    const connection = this.connection(), abort = this.request = new AbortController();
    // Revalidation keeps the last completed result. Only a new identity loses
    // that result; a timer must not remove guidance or unmount a ready preview.
    this.state = { ...this.state, checking: !this.ready }; this.changed();
    const task = (async () => {
      let issue: ProjectServerIssue | undefined;
      let checks: ProjectServerCheck[] | undefined;
      try {
        if (this.options.inspect) {
          checks = await this.options.inspect(connection, abort.signal, checks => {
            if (abort.signal.aborted || this.disposed || !sameConnection(connection, this.connection())) return;
            this.state = { ...this.state, checks, issue: checks.find(check => check.issue)?.issue }; this.changed();
          }, this.unavailable);
          issue = checks.find(check => check.issue)?.issue;
        }
        // The inspector revalidates the current binding and grant. A previous
        // data error must not keep a repaired or newly approved entry blocked.
        if (this.options.inspect && !issue) this.failure = undefined;
        if (connection && !issue && !this.options.inspect) issue = await checkProjectServer(this.projectId, connection, abort.signal);
      }
      catch { issue = { kind: 'connection-unavailable', serverUrl: connection?.serverUrl ?? this.unavailable.serverUrl }; }
      if (abort.signal.aborted || this.disposed || !sameConnection(connection, this.connection())) return;
      this.checkedAt = Date.now(); this.state = projectServerStateWithIssue({ ...this.state, checking: false, ...(checks ? { checks } : {}) }, issue, this.projectId); this.changed();
      const temporary = issue?.kind === 'connection-unavailable' || checks?.some(check => check.issue?.kind === 'connection-unavailable');
      if ((!this.options.inspect && !issue) || temporary && connection) {
        this.retry = setTimeout(() => { void this.refresh(); }, issue ? 5_000 : 30_000); this.retry.unref();
      }
    })().finally(() => { if (this.pending === task) this.pending = undefined; });
    this.pending = task;
    return task;
  }
  async assertReady(): Promise<void> {
    const connection = this.connection();
    if (this.pending) await this.pending;
    else if (!this.state.issue && (!this.checkedAt || !this.options.inspect && Date.now() - this.checkedAt >= 5_000)) await this.refresh();
    const current = this.connection();
    if (this.disposed || !connection && !this.options.inspect || current?.serverUrl !== connection?.serverUrl || current?.accessToken !== connection?.accessToken || this.state.checking || this.state.issue) {
      throw Object.assign(new Error(t('Project data is unavailable. Follow the Server setup guidance and choose Check again.')), { code: 'PROJECT_SERVER_SETUP_REQUIRED' });
    }
  }
  assertAvailable(): void {
    if (!this.ready) throw Object.assign(new Error(t('Project data is unavailable. Follow the Server setup guidance and choose Check again.')), { code: 'PROJECT_SERVER_SETUP_REQUIRED' });
  }
  close(): void { this.disposed = true; this.request?.abort(); clearTimeout(this.retry); }
}

export function projectServerStateWithIssue(state: ProjectServerState, issue: ProjectServerIssue | undefined, _projectId: string): ProjectServerState { return { ...state, issue }; }

function sameConnection(left: WebConnection | undefined, right: WebConnection | undefined): boolean {
  return left?.serverUrl === right?.serverUrl && left?.accessToken === right?.accessToken;
}
