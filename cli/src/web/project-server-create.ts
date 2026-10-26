import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readProjectInfo } from '@steamharness/project-info';
import type { Project } from './workflow-types';
import type { WebConnection } from './runtime';
import type { ProjectServerIssue } from './project-server-state';
import { t } from './localization';

export interface ProjectServerCreateContext {
  token: string; serverUrl: string; projectId: string; projectType: string; name: string;
  groups: { id: string; name: string }[];
}
interface Confirmation {
  context: ProjectServerCreateContext; connection: WebConnection; identity: string;
  projectInfo: NonNullable<Project['projectInfo']>; expiresAt: number; busy: boolean; abort: AbortController;
}

/** Preparing/cancelling is read-only. Only a separate, confirmed request creates a record. */
export class ProjectServerCreation {
  private readonly confirmations = new Map<string, Confirmation>();
  private generation = 0;
  constructor(private readonly project: Project, private readonly connection: () => WebConnection | undefined,
    private readonly identity: () => string, private readonly issue: () => ProjectServerIssue | undefined) {}

  async prepare(): Promise<ProjectServerCreateContext> {
    const connection = this.connection(), identity = this.identity(), issue = this.issue(), generation = this.generation;
    if (!connection || !identity) throw new Error(t('Sign in with an account before creating a Server project.'));
    if (this.project.assistant || issue?.kind !== 'project-unavailable' || issue.projectId && issue.projectId.toLowerCase() !== this.project.id.toLowerCase()) {
      throw new Error(t('Open the affected local project to create its Server project.'));
    }
    const pkg = JSON.parse(await readFile(path.join(this.project.folderPath, 'package.json'), 'utf8'));
    if (pkg.id?.toLowerCase() !== this.project.id.toLowerCase() || pkg.steamHarness?.projectType !== this.project.projectType) throw new Error(t('The local project changed. Reopen it before creating a Server project.'));
    const projectInfo = readProjectInfo(pkg);
    if (!projectInfo.dataStorage || projectInfo.dataStorage.mode === 'local') throw new Error(t('This project does not allow Server storage. Check Project Info first.'));
    const abort = new AbortController();
    const existing = await this.request(connection, `/api/projects/${encodeURIComponent(this.project.id)}`, abort.signal, true);
    if (existing.status !== 404) throw new Error(t('The project is already available or needs access. Choose Check again before continuing.'));
    const groups: ProjectServerCreateContext['groups'] = [];
    for (let page = 1; ; page++) {
      const result = await this.request(connection, `/api/groups?minRole=developer&pageSize=100&page=${page}`, abort.signal);
      const data = result.data;
      if (!Array.isArray(data?.items) || !Number.isInteger(data.total) || data.total < 0 || page > 100) throw new Error(t('Could not load project groups. Try again.'));
      for (const group of data.items) {
        if (typeof group?.id !== 'string' || typeof group?.name !== 'string') throw new Error(t('Could not load project groups. Try again.'));
        groups.push({ id: group.id, name: group.name });
      }
      if (groups.length >= data.total || !data.items.length) break;
    }
    this.assertCurrent(connection, identity);
    if (generation !== this.generation) throw new Error(t('Account or Server changed. Open the project creation dialog again.'));
    for (const [token, confirmation] of this.confirmations) if (confirmation.expiresAt <= Date.now()) { confirmation.abort.abort(); this.confirmations.delete(token); }
    if (this.confirmations.size >= 8) throw new Error(t('Close an existing project creation dialog and try again.'));
    const context = { token: randomBytes(24).toString('hex'), serverUrl: connection.serverUrl, projectId: this.project.id,
      projectType: this.project.projectType, name: this.project.name, groups };
    this.confirmations.set(context.token, { context, connection, identity, projectInfo, expiresAt: Date.now() + 10 * 60_000, busy: false, abort });
    return context;
  }

  async confirm(input: { token?: unknown; confirmed?: unknown; name?: unknown; groupId?: unknown }): Promise<void> {
    const confirmation = typeof input.token === 'string' ? this.confirmations.get(input.token) : undefined;
    if (!confirmation || confirmation.expiresAt <= Date.now() || input.confirmed !== true) throw new Error(t('Project creation confirmation expired. Open the dialog again.'));
    if (confirmation.busy) throw new Error(t('Project creation is already in progress.'));
    this.assertCurrent(confirmation.connection, confirmation.identity);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error(t('Enter a project name.'));
    if (input.groupId !== undefined && (typeof input.groupId !== 'string' || !confirmation.context.groups.some(group => group.id === input.groupId))) throw new Error(t('Choose an available project group.'));
    confirmation.busy = true;
    try {
      // Lock before reading: two confirmed requests must not both pass validation.
      const pkg = JSON.parse(await readFile(path.join(this.project.folderPath, 'package.json'), 'utf8'));
      if (pkg.id?.toLowerCase() !== this.project.id.toLowerCase() || pkg.steamHarness?.projectType !== this.project.projectType
        || JSON.stringify(readProjectInfo(pkg)) !== JSON.stringify(confirmation.projectInfo)) throw new Error(t('The local project changed. Reopen it before creating a Server project.'));
      this.assertCurrent(confirmation.connection, confirmation.identity);
      if (this.confirmations.get(confirmation.context.token) !== confirmation || confirmation.expiresAt <= Date.now() || confirmation.abort.signal.aborted) {
        throw new Error(t('Project creation confirmation expired. Open the dialog again.'));
      }
      const result = await this.request(confirmation.connection, '/api/projects', confirmation.abort.signal, false, {
        name: input.name.trim(), projectId: this.project.id, projectType: this.project.projectType,
        projectInfo: confirmation.projectInfo, visibility: 'private', ...(input.groupId ? { groupId: input.groupId } : {}),
      });
      this.assertCurrent(confirmation.connection, confirmation.identity);
      if (result.data?.projectId?.toLowerCase() !== this.project.id.toLowerCase()) throw new Error(t('The Server returned an unexpected project. Choose Check again.'));
      this.confirmations.delete(confirmation.context.token);
    } finally { confirmation.busy = false; }
  }

  cancel(token: unknown): void {
    if (typeof token !== 'string') return;
    this.confirmations.get(token)?.abort.abort(); this.confirmations.delete(token);
  }
  close(): void { this.generation++; for (const token of this.confirmations.keys()) this.cancel(token); }
  private assertCurrent(connection: WebConnection, identity: string): void {
    const current = this.connection();
    if (!identity || identity !== this.identity() || current?.serverUrl !== connection.serverUrl || current.accessToken !== connection.accessToken) throw new Error(t('Account or Server changed. Open the project creation dialog again.'));
  }
  private async request(connection: WebConnection, route: string, signal: AbortSignal, allowMissing = false, body?: unknown): Promise<{ status: number; data?: any }> {
    const response = await fetch(`${connection.serverUrl}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${connection.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    try {
      if (allowMissing && response.status === 404) return { status: 404 };
      if (response.status === 401) throw new Error(t('Sign in with an account before creating a Server project.'));
      if (response.status === 403) throw new Error(t('Your account cannot create a project here. Check the account and project group.'));
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value?.errCode !== 0) throw new Error(t('Could not create the Server project. Check the Server and project group, then try again.'));
      return { status: response.status, data: value.data };
    } finally { await response.body?.cancel().catch(() => undefined); }
  }
}
