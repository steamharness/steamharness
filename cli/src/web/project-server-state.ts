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
export interface ProjectServerState { checking: boolean; issue?: ProjectServerIssue; blocking?: boolean }

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

async function readServerProject(projectId: string, connection: WebConnection, signal: AbortSignal): Promise<{ issue?: ProjectServerIssue; project?: ServerProject }> {
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
  get blocking(): boolean { return this.state.blocking !== false; }
  get ready(): boolean { return !this.disposed && this.checkedAt > 0 && !this.state.issue && !!this.connection(); }
  constructor(private readonly projectId: string, private readonly connection: () => WebConnection | undefined, private readonly changed: () => void, options: { blocking?: boolean } = {}) {
    if (options.blocking === false) this.state.blocking = false;
  }
  reportFailure(failure: ProjectServerAccessFailure): Promise<void> {
    this.failure = failure; this.request?.abort(); this.pending = undefined; this.checkedAt = 0;
    return this.refresh();
  }
  authenticationChanged(account: AccountState): void {
    this.request?.abort(); this.pending = undefined; clearTimeout(this.retry); this.checkedAt = 0;
    if (this.disposed) return;
    if (account.status === 'checking') {
      this.state = { ...this.state, checking: true, issue: this.state.issue?.serverUrl === account.serverUrl ? this.state.issue : undefined };
      this.changed(); return;
    }
    if (this.connection()) { void this.refresh(); return; }
    this.state = { ...this.state, checking: false, issue: {
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
      try { issue = this.failure ? await checkProjectStorageFailure(this.projectId, this.failure, connection, abort.signal) : await checkProjectServer(this.projectId, connection, abort.signal); }
      catch { issue = { kind: 'connection-unavailable', serverUrl: connection.serverUrl }; }
      if (abort.signal.aborted || this.disposed) return;
      this.checkedAt = Date.now(); this.state = { ...this.state, checking: false, issue }; this.changed();
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
