import type { ProjectServerIssue, ProjectServerState } from '../project-server-state';
import { t } from '../localization';
import './project-server-guidance.css';
interface GuidanceOptions { connected: boolean; working: boolean; canCreate?: boolean; serverUrl?: string; entryId?: string }
export class ProjectServerGuidance {
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly checks: HTMLElement;
  private readonly create: HTMLButtonElement;
  private readonly databases: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly account: HTMLButtonElement;
  private readonly information: HTMLButtonElement;
  private readonly server: HTMLAnchorElement;
  private readonly rows = new Map<string, HTMLElement>();
  constructor(private readonly container: HTMLElement, actions: { create(): void; databases(): void; account(): void; information(): void; retry(): void }) {
    container.innerHTML = `<div class="project-server-guidance-body"><h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p><p id="server-guidance-steps"></p><ul id="server-checks-list" class="project-checks-list"></ul><details><summary>${t('Connection details')}</summary><dl><dt>${t('Server')}</dt><dd id="server-guidance-server-url"></dd><dt>${t('Project ID')}</dt><dd id="server-guidance-project-id"></dd><dt>${t('Entry')}</dt><dd id="server-guidance-entry-id"></dd></dl></details><div class="project-server-guidance-actions"><button type="button" id="server-guidance-create">${t('Create project')}</button><button type="button" id="server-guidance-databases">${t('View linked databases')}</button><button type="button" id="server-guidance-account">${t('Account / Server settings')}</button><button type="button" id="server-guidance-information">${t('Project information')}</button><a id="server-guidance-server" target="_blank" rel="noopener noreferrer">${t('Open Server project')}</a><button type="button" id="server-guidance-retry">${t('Check again')}</button></div></div>`;
    this.title = container.querySelector('h2')!; this.description = container.querySelector('p')!; this.checks = container.querySelector('ul')!;
    this.steps = container.querySelector('#server-guidance-steps')!;
    this.create = container.querySelector('#server-guidance-create')!;
    this.databases = container.querySelector('#server-guidance-databases')!;
    this.retry = container.querySelector('#server-guidance-retry')!;
    this.account = container.querySelector('#server-guidance-account')!;
    this.information = container.querySelector('#server-guidance-information')!;
    this.server = container.querySelector('#server-guidance-server')!;
    this.create.onclick = actions.create; this.databases.onclick = actions.databases; this.retry.onclick = actions.retry;
    this.account.onclick = actions.account; this.information.onclick = actions.information;
  }
  update(state: ProjectServerState | undefined, projectId: string, options: GuidanceOptions) {
    const hidden = !state?.issue || state.issue.kind === 'checking';
    if (this.container.hidden !== hidden) this.container.hidden = hidden;
    this.container.setAttribute('aria-busy', String(options.working));
    if (!state) return;
    const issue = state.issue;
    text(this.title, issue?.kind === 'sign-in-required' ? t('Sign in to load project data') : issue?.kind === 'connection-unavailable' ? t('Cannot connect to the project Server') : issue?.kind === 'access-denied' ? t('Project access is required') : issue?.database ? t('Database binding requires attention') : t('Complete the Server project setup'));
    text(this.description, description(issue));
    text(this.steps, issue?.kind === 'sign-in-required' ? t('Open Account / Server settings, select the Server shown below and sign in. Then choose Check again.')
      : issue?.kind === 'access-denied' ? t('Open the Server project to check access, or ask its owner to grant your current account access. Then choose Check again.')
      : issue?.kind === 'project-unavailable' ? t('Check the Server and project ID in Connection details. If this project already exists, ask its owner to check access. Create a project only to start a new application with a new ID.')
      : issue?.database ? t('Open Project information → Databases to check the affected resource. Manage resource permissions in Server, then choose Check again.')
      : issue?.status || issue?.kind === 'setup-required' ? t('Open the Server project to check its registered entries. If it cannot open, ask the Server administrator to check project registration and Server logs. Then choose Check again.')
      : t('Check your network or contact the Server administrator. The connection will retry automatically.'));
    const serverUrl = safeServerUrl(issue?.serverUrl ?? options.serverUrl);
    text(this.container.querySelector('#server-guidance-server-url')!, serverUrl?.href.replace(/\/$/, '') ?? t('Not connected'));
    text(this.container.querySelector('#server-guidance-project-id')!, issue?.projectId ?? projectId);
    text(this.container.querySelector('#server-guidance-entry-id')!, issue?.entryId ?? options.entryId ?? '—');
    hiddenElement(this.server, !serverUrl || !(issue?.projectId ?? projectId));
    if (!this.server.hidden && serverUrl) {
      serverUrl.pathname = `${serverUrl.pathname.replace(/\/$/, '')}/detail/${encodeURIComponent(issue?.projectId ?? projectId)}`;
      if (this.server.href !== serverUrl.href) this.server.href = serverUrl.href;
    } else this.server.removeAttribute('href');
    const statusLabels = { checking: 'Checking...', passed: 'Passed', 'action-required': 'Action required', waiting: 'Waiting' };
    const checks = state.checks ?? [];
    for (const [id, row] of this.rows) if (!checks.some(check => check.id === id)) { row.remove(); this.rows.delete(id); }
    checks.forEach((check, index) => {
      let row = this.rows.get(check.id);
      if (!row) { row = document.createElement('li'); row.className = 'project-server-check'; row.append(document.createElement('span'), document.createElement('span')); this.rows.set(check.id, row); }
      text(row.firstElementChild!, check.database ?? t(check.stage === 'registration' ? 'Server project registration' : 'Current application'));
      text(row.lastElementChild!, t(statusLabels[check.status])); row.dataset.status = check.status;
      if (this.checks.children[index] !== row) this.checks.insertBefore(row, this.checks.children[index] ?? null);
    });
    hiddenElement(this.create, issue?.kind !== 'project-unavailable' || options.canCreate === false);
    hiddenElement(this.databases, !issue?.database);
    this.create.disabled = this.retry.disabled = !options.connected || options.working;
    this.databases.disabled = this.account.disabled = this.information.disabled = !options.connected;
  }
}

function text(element: Element, value: string): void { if (element.textContent !== value) element.textContent = value; }
function hiddenElement(element: HTMLElement, value: boolean): void { if (element.hidden !== value) element.hidden = value; }
function safeServerUrl(value: string | undefined): URL | undefined {
  try { const url = new URL(value!); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url; } catch { /* No navigable Server was selected. */ }
}
function description(issue: ProjectServerIssue | undefined): string {
  if (issue?.kind === 'sign-in-required') return t('Please sign in to the project Server.');
  if (issue?.kind === 'access-denied') return t("Your current account cannot access this project's data on the connected Server.");
  if (issue?.kind === 'project-unavailable') return t('This project could not be found or accessed on the connected Server. Importing a local folder does not create a Server project.');
  if (issue?.status) return t('The Server returned HTTP {0} while checking this project.', issue.status);
  if (issue?.database) return t('Check database links in Project information. Manage requests and permissions in Studio or Server Web.');
  if (issue?.reason === 'invalid-project-response') return t('The Server response does not contain a valid project registration. Check the Server version and registered entries.');
  if (issue?.kind === 'connection-unavailable') return t('Project data is temporarily unavailable. Your local history and drafts are preserved.');
  return t('The Server rejected this project data connection. Check the Server version, project type, and storage settings.');
}
