import { t, locale } from './localization';
import { WorkflowAuthError, normalizeWorkflowServerUrl, type WorkflowConnection } from './workflow-auth-client';

export interface ServerProject {
  id: string; name: string; projectType: string; latest: string | null;
  canManage?: boolean;
  sourceDownload?: { allowed: boolean; available: boolean; target: string | null };
}
export interface ServerProjectVersion {
  version: string; latest: boolean; createdAt?: string; releaseLog?: string; sourceHash?: string;
  createdByProfile?: { displayName: string; email: string };
  dependencies: Array<{ alias: string; projectId: string; delivery: 'included' | 'external'; version?: string }>;
}
export interface ServerProjectVersions {
  id: string; name: string; latest: string | null; versions: ServerProjectVersion[];
}
export interface WorkflowVersionsState {
  type: 'versions-state'; generation: number; signedIn: boolean; loading: boolean; busy: boolean;
  project?: { id: string; name: string; uri: string };
  localVersion?: string; versions: ServerProjectVersion[];
  update?: ProjectVersionStatus;
  canDownload: boolean; transfersAvailable: boolean; error?: string;
}
export interface ProjectVersionStatus {
  status: 'checking' | 'signed-out' | 'unavailable' | 'unpublished' | 'current' | 'upgrade' | 'ahead' | 'different';
  localVersion?: string; serverVersion?: string; canDownload: boolean; checking?: boolean; busy?: boolean;
}
export function compareProjectVersions(local?: string, remote?: string): -1 | 0 | 1 | undefined {
  if (!local || !remote || !/^\d+\.\d+\.\d+$/.test(local) || !/^\d+\.\d+\.\d+$/.test(remote)) { return undefined; }
  const left = local.split('.').map(BigInt), right = remote.split('.').map(BigInt);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) { return left[index] < right[index] ? -1 : 1; }
  }
  return 0;
}
export interface UpdatedServerProject {
  projects: DownloadedServerProject[]; backupDirectory: string;
}
export interface DownloadedServerProject {
  id: string; name: string; version: string; directory: string; role: 'root' | 'dependency';
}
export interface ServerProjectShare {
  id: string; name: string; version: string; createdAt: string; releaseLog?: string; sourceHash: string;
}

export function parseServerProjectShareLink(value: string): { serverUrl: string; id: string; version: string } {
  try {
    const url = new URL(value.trim());
    normalizeWorkflowServerUrl(url.href);
    const match = /^(.*)\/share\/projects\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[2]), version = decodeURIComponent(match[3]);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && /^\d+\.\d+\.\d+$/.test(version)) {
        return { serverUrl: normalizeWorkflowServerUrl(`${url.origin}${match[1]}`), id, version };
      }
    }
  } catch { /* Invalid URLs use the same credential-free error. */ }
  throw new Error(t('Enter a valid project share link.'));
}
export interface ProjectTransferProgress { message: string }
export interface ProjectPreparation {
  jobId: string; workflowId: string; status: 'queued' | 'preparing' | 'success' | 'failed';
  stage: string; failureReason?: string;
  result?: { workflowId: string; sourceHash: string };
}

export class WorkflowProjectServerClient {
  constructor(private readonly connection: WorkflowConnection, private readonly fetcher: typeof fetch = fetch) {}

  async request<T>(apiPath: string, signal: AbortSignal, body?: object): Promise<T> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(`${normalizeWorkflowServerUrl(this.connection.serverUrl)}${apiPath}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { Accept: 'application/json', 'Accept-Language': locale(), Authorization: `Bearer ${this.connection.accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      signal.throwIfAborted();
      throw new WorkflowAuthError(t('Cannot connect to SteamHarness Server. Check the server address and network.'));
    }
    let payload: { errCode: number; errMessage?: string; data?: T };
    try { payload = await response.json() as typeof payload; }
    catch { signal.throwIfAborted(); throw new WorkflowAuthError(t('The server returned an invalid response.'), response.status); }
    signal.throwIfAborted();
    if (!payload || typeof payload !== 'object' || typeof payload.errCode !== 'number') {
      throw new WorkflowAuthError(t('The server returned an invalid response.'), response.status);
    }
    if (!response.ok || payload.errCode !== 0 || payload.data === undefined) {
      const message = response.status === 401 ? t('Sign-in expired. Sign in again.')
        : payload.errMessage || t('SteamHarness Server request failed ({0}).', response.status);
      throw new WorkflowAuthError(message.replaceAll(this.connection.accessToken, '[redacted]'), response.status);
    }
    return payload.data;
  }

  projects(signal: AbortSignal): Promise<ServerProject[]> { return this.request('/api/workflows', signal); }
  versions(id: string, signal: AbortSignal): Promise<ServerProjectVersions> {
    return this.request(`/api/workflows/${encodeURIComponent(id)}/versions`, signal);
  }
  sourceShare(id: string, version: string, signal: AbortSignal): Promise<ServerProjectShare> {
    return this.request(`/api/workflows/${encodeURIComponent(id)}/source-share?target=${encodeURIComponent(version)}`, signal);
  }
}
