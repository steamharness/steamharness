import type { WebConnection } from './runtime';
import type { AccountState } from './workflow-auth-client';
import { t } from './localization';
import { readProjectInfo, resolveProjectRelatedProjectAccess, isProjectAccessAllowed, isProjectDataStorageLocationAllowed } from '@steamharness/project-info';
import type { Project } from './workflow-types';

export interface ProjectServerIssue {
  kind: 'checking' | 'sign-in-required' | 'project-unavailable' | 'access-denied' | 'setup-required' | 'connection-unavailable' | 'related-setup-required' | 'related-import-required';
  serverUrl?: string;
  projectId?: string;
  relatedProjectAlias?: string;
  /** Verified local binding supplied by a host. Absent for standalone sessions. */
  relatedProjectImported?: boolean;
}
export interface ProjectServerCheck {
  id: string;
  projectId: string;
  relatedProjectAlias?: string;
  stage: 'import' | 'registration' | 'relationship';
  status: 'checking' | 'passed' | 'action-required' | 'waiting';
  issue?: ProjectServerIssue;
}
export interface ProjectServerState { checking: boolean; issue?: ProjectServerIssue; blocking?: boolean; checks?: ProjectServerCheck[] }
export type ProjectServerInspector = (connection: WebConnection | undefined, signal: AbortSignal,
  publish: (checks: ProjectServerCheck[]) => void, unavailable: ProjectServerIssue) => Promise<ProjectServerCheck[]>;

export interface ProjectServerAccessFailure {
  serverUrl: string; projectId: string; relatedProjectAlias?: string; status?: number;
  operation?: string; key?: string; storageKind?: 'kv' | 'persistent_value';
}

/** Accept only structured storage failures for this project's configured Server and declarations. */
export function projectServerAccessFailure(metadata: Record<string, unknown> | undefined, project: Project, connection: WebConnection | undefined): ProjectServerAccessFailure | undefined {
  if (!metadata || !connection || metadata.code !== 'PROJECT_SERVER_ACCESS_FAILED' || metadata.serverUrl !== connection.serverUrl || typeof metadata.projectId !== 'string') return;
  const related = typeof metadata.relatedProjectAlias === 'string' ? metadata.relatedProjectAlias : undefined;
  if (related ? typeof metadata.consumerProjectId !== 'string' || metadata.consumerProjectId.toLowerCase() !== project.id.toLowerCase() || !project.projectInfo?.relatedProjects.some(relation => relation.alias === related && relation.projectId.toLowerCase() === String(metadata.projectId).toLowerCase())
    : metadata.projectId.toLowerCase() !== project.id.toLowerCase() || metadata.consumerProjectId !== undefined) return;
  return { serverUrl: connection.serverUrl, projectId: metadata.projectId, relatedProjectAlias: related,
    status: typeof metadata.status === 'number' ? metadata.status : undefined,
    storageKind: metadata.storageKind === 'kv' || metadata.storageKind === 'persistent_value' ? metadata.storageKind : undefined,
    operation: typeof metadata.operation === 'string' ? metadata.operation : undefined, key: typeof metadata.key === 'string' ? metadata.key : undefined };
}

interface ServerProject { id: string; projectInfo?: unknown; access?: { capabilities?: string[] } }

/** These responses need a user action, rather than another connection attempt. */
export function projectServerIssue(status: number, serverUrl: string): ProjectServerIssue | undefined {
  if (status === 401) return { kind: 'sign-in-required', serverUrl };
  if (status === 403) return { kind: 'access-denied', serverUrl };
  if (status === 404) return { kind: 'project-unavailable', serverUrl };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: 'setup-required', serverUrl };
}

/** Only the project endpoint can establish that the project itself is unavailable. */
export async function checkProjectServer(projectId: string, connection: WebConnection, signal: AbortSignal): Promise<ProjectServerIssue | undefined> {
  return (await readServerProject(projectId, connection, signal)).issue;
}

export async function readServerProject(projectId: string, connection: WebConnection, signal: AbortSignal): Promise<{ issue?: ProjectServerIssue; project?: ServerProject }> {
  const serverUrl = connection.serverUrl;
  const response = await fetch(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${connection.accessToken}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  try {
    const issue = projectServerIssue(response.status, serverUrl);
    if (issue) return { issue };
    if (!response.ok) return { issue: { kind: 'connection-unavailable', serverUrl } };
    let value;
    try { value = await response.json(); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (value?.errCode !== 0 || typeof value.data?.id !== 'string' || value.data.id.toLowerCase() !== projectId.toLowerCase()) return { issue: { kind: 'setup-required', serverUrl } };
    return { project: value.data };
  } finally { await response.body?.cancel().catch(() => undefined); }
}

export async function checkProjectStorageFailure(projectId: string, failure: ProjectServerAccessFailure, connection: WebConnection, signal: AbortSignal): Promise<ProjectServerIssue | undefined> {
  // The storage API authorizes the consumer first. A related-storage 404 does
  // not establish that its target is missing.
  const current = await readServerProject(projectId, connection, signal);
  if (current.issue) return current.issue;
  const issue = (kind: ProjectServerIssue['kind'], related = false): ProjectServerIssue => ({ kind, serverUrl: connection.serverUrl,
    ...(related ? { projectId: failure.projectId, relatedProjectAlias: failure.relatedProjectAlias } : {}) });
  const write = failure.operation !== undefined && failure.operation !== 'get';
  if (write && current.project?.access?.capabilities && !current.project.access.capabilities.includes('writeData')) return issue('access-denied');
  try {
    if (current.project?.projectInfo && !isProjectDataStorageLocationAllowed(readProjectInfo({ steamHarness: { projectInfo: current.project.projectInfo } }), 'server')) return issue('setup-required');
  } catch { return issue('setup-required'); }
  if (failure.relatedProjectAlias) {
    const target = await readServerProject(failure.projectId, connection, signal);
    if (target.issue) return { ...target.issue, projectId: failure.projectId, relatedProjectAlias: failure.relatedProjectAlias };
    if (write && target.project?.access?.capabilities && !target.project.access.capabilities.includes('writeData')) return issue('access-denied', true);
    try {
      const consumerInfo = readProjectInfo({ steamHarness: { projectInfo: current.project?.projectInfo } });
      const targetInfo = readProjectInfo({ steamHarness: { projectInfo: target.project?.projectInfo } });
      if (!isProjectDataStorageLocationAllowed(targetInfo, 'server')) return issue('setup-required', true);
      const access = resolveProjectRelatedProjectAccess({ consumerProjectId: projectId, consumerProjectInfo: consumerInfo, targetProjectId: failure.projectId, targetProjectInfo: targetInfo, alias: failure.relatedProjectAlias });
      if (!access || (!write && failure.key === undefined && access.grant.read.mode === 'none')
        || (failure.key !== undefined && (!isProjectAccessAllowed(write ? access.grant.write : access.grant.read, failure.key)
          || (failure.operation === 'compare-and-set' && !isProjectAccessAllowed(access.grant.read, failure.key))))) return issue('related-setup-required', true);
    } catch { return issue('related-setup-required', true); }
  }
  // Project records alone do not prove that the data endpoint is available.
  // Probe a failed read without replaying any mutation or workflow execution.
  if (failure.operation !== 'get' || !failure.storageKind || failure.key === undefined) return;
  const response = await fetch(`${connection.serverUrl}/api/project-storage`, {
    method: 'POST', headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(failure.relatedProjectAlias ? { consumerProjectId: projectId, alias: failure.relatedProjectAlias } : { projectId }),
      storageKind: failure.storageKind, operation: 'get', entry: { scope: 'project', key: failure.key, ...(!failure.relatedProjectAlias ? { projectId } : {}) } }),
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  try {
    const related = !!failure.relatedProjectAlias;
    if (response.status === 401) return issue('sign-in-required');
    if (response.status === 403) return issue('access-denied', related);
    if (!response.ok) return issue(response.status === 408 || response.status === 429 || response.status >= 500 ? 'connection-unavailable' : 'setup-required', related);
    let value;
    try { value = await response.json(); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (value?.errCode !== 0 || typeof value.data?.exists !== 'boolean') return issue('setup-required', related);
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
  private failure?: ProjectServerAccessFailure;
  private unavailable: ProjectServerIssue = { kind: 'sign-in-required' };
  get blocking(): boolean { return this.state.blocking !== false; }
  get ready(): boolean { return !this.disposed && this.checkedAt > 0 && !this.state.checking && !this.state.issue && !!this.connection(); }
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
    this.request?.abort(); this.pending = undefined; clearTimeout(this.retry); this.checkedAt = 0;
    if (this.disposed) return;
    if (account.status === 'checking') {
      if (!this.connection()) this.failure = undefined;
      this.state = { ...this.state, checking: true, issue: undefined, checks: this.state.checks?.map(check => ({ ...check, status: 'checking', issue: undefined })) };
      this.changed(); return;
    }
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
    this.state = { ...this.state, checking: this.options.inspect ? true : !this.ready, ...(this.options.inspect ? { issue: undefined } : {}) }; this.changed();
    const task = (async () => {
      let issue: ProjectServerIssue | undefined;
      let checks: ProjectServerCheck[] | undefined;
      try {
        if (this.options.inspect) {
          checks = await this.options.inspect(connection, abort.signal, checks => {
            if (abort.signal.aborted || this.disposed) return;
            this.state = { ...this.state, checks, issue: checks.find(check => check.issue)?.issue }; this.changed();
          }, this.unavailable);
          issue = checks.find(check => check.issue)?.issue;
          const failure = this.failure;
          if (!abort.signal.aborted && failure?.relatedProjectAlias && !checks.some(check => check.relatedProjectAlias === failure.relatedProjectAlias
            && check.projectId.toLowerCase() === failure.projectId.toLowerCase())) this.failure = undefined;
        }
        if (connection && !issue) issue = this.failure ? await checkProjectStorageFailure(this.projectId, this.failure, connection, abort.signal)
          : this.options.inspect ? undefined : await checkProjectServer(this.projectId, connection, abort.signal);
      }
      catch { issue = { kind: 'connection-unavailable', serverUrl: connection?.serverUrl ?? this.unavailable.serverUrl }; }
      if (abort.signal.aborted || this.disposed) return;
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
    if (this.disposed || !connection || current?.serverUrl !== connection.serverUrl || current.accessToken !== connection.accessToken || this.state.checking || this.state.issue) {
      throw Object.assign(new Error(t('Project data is unavailable. Follow the Server setup guidance and choose Check again.')), { code: 'PROJECT_SERVER_SETUP_REQUIRED' });
    }
  }
  assertAvailable(): void {
    if (!this.ready) throw Object.assign(new Error(t('Project data is unavailable. Follow the Server setup guidance and choose Check again.')), { code: 'PROJECT_SERVER_SETUP_REQUIRED' });
  }
  close(): void { this.disposed = true; this.request?.abort(); clearTimeout(this.retry); }
}

/** Keep the lifecycle checklist consistent with a later, operation-specific failure. */
export function projectServerStateWithIssue(state: ProjectServerState, issue: ProjectServerIssue | undefined, projectId: string): ProjectServerState {
  if (!issue || !state.checks) return { ...state, issue };
  const targetId = issue.projectId ?? projectId;
  const matches = (check: ProjectServerCheck) => check.projectId.toLowerCase() === targetId.toLowerCase()
    && (!issue.relatedProjectAlias || check.relatedProjectAlias === issue.relatedProjectAlias)
    && (!!issue.relatedProjectAlias === !!check.relatedProjectAlias);
  const stage = issue.kind === 'related-import-required' || issue.relatedProjectImported === false ? 'import' : issue.kind === 'related-setup-required' ? 'relationship' : 'registration';
  const checks: ProjectServerCheck[] = state.checks.map(check => matches(check) ? { ...check, stage, status: 'action-required', issue } : check);
  if (!checks.some(matches)) checks.push({ id: issue.relatedProjectAlias ? `related:${issue.relatedProjectAlias}` : 'project', projectId: targetId,
    relatedProjectAlias: issue.relatedProjectAlias, stage, status: 'action-required', issue });
  return { ...state, issue, checks };
}
