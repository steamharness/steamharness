import type { ProjectServerIssue, ProjectServerState } from '../project-server-state';
import { t } from '../localization';
import './project-server-guidance.css';
interface GuidanceOptions { connected: boolean; working: boolean; canCreate?: boolean; serverUrl?: string; entryId?: string }
export class ProjectServerGuidance {
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly checks: HTMLElement;
  private readonly checkSection: HTMLElement;
  private readonly error: HTMLElement;
  private readonly create: HTMLButtonElement;
  private readonly databases: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly account: HTMLButtonElement;
  private readonly server: HTMLButtonElement;
  private readonly rows = new Map<string, HTMLElement>();
  private acting = false;
  private connected = false;
  constructor(private readonly container: HTMLElement, actions: { create(): void | Promise<unknown>; databases(): void; account(): void; information(): void; open(): void | Promise<unknown>; retry(): void }) {
    container.innerHTML = `<div class="project-server-guidance-body"><h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p><p id="server-guidance-steps"></p><section class="project-server-checks" aria-labelledby="server-checks-heading"><h3 id="server-checks-heading">${t('Connection checks')}</h3><ul id="server-checks-list" class="project-checks-list"></ul></section><div class="project-server-guidance-actions"><button type="button" id="server-guidance-create">${t('Create cloud project')}</button><button type="button" id="server-guidance-databases">${t('Configure database')}</button><button type="button" id="server-guidance-account">${t('Sign in')}</button><button type="button" id="server-guidance-server">${t('Open Server project')}</button><button type="button" id="server-guidance-retry">${t('Check again')}</button></div><p id="server-guidance-action-error" class="project-server-action-error" role="alert" hidden></p><details class="project-server-connection-details"><summary>${t('Connection details')}</summary><dl><dt>${t('Server')}</dt><dd id="server-guidance-server-url"></dd><dt>${t('Project ID')}</dt><dd id="server-guidance-project-id"></dd><dt>${t('Entry')}</dt><dd id="server-guidance-entry-id"></dd></dl></details></div>`;
    this.title = container.querySelector('h2')!; this.description = container.querySelector('p')!; this.checks = container.querySelector('ul')!;
    this.steps = container.querySelector('#server-guidance-steps')!;
    this.checkSection = container.querySelector('.project-server-checks')!;
    this.error = container.querySelector('#server-guidance-action-error')!;
    this.create = container.querySelector('#server-guidance-create')!;
    this.databases = container.querySelector('#server-guidance-databases')!;
    this.retry = container.querySelector('#server-guidance-retry')!;
    this.account = container.querySelector('#server-guidance-account')!;
    this.server = container.querySelector('#server-guidance-server')!;
    this.create.onclick = () => { void this.perform(this.create, actions.create); };
    this.server.onclick = () => { void this.perform(this.server, actions.open); };
    this.databases.onclick = actions.databases; this.retry.onclick = actions.retry; this.account.onclick = actions.account;
  }
  private async perform(button: HTMLButtonElement, action: () => void | Promise<unknown>): Promise<void> {
    if (this.acting || button.disabled) return;
    this.acting = true; this.error.hidden = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
    try { await action(); }
    catch (error) { text(this.error, error instanceof Error ? error.message : String(error)); this.error.hidden = false; }
    finally { this.acting = false; button.disabled = !this.connected; button.removeAttribute('aria-busy'); }
  }
  update(state: ProjectServerState | undefined, projectId: string, options: GuidanceOptions) {
    this.connected = options.connected;
    const hidden = !state?.issue || state.issue.kind === 'checking';
    hiddenElement(this.container, hidden);
    this.container.setAttribute('aria-busy', String(options.working));
    if (!state) return;
    const issue = state.issue;
    const missing = issue?.kind === 'project-unavailable', signIn = issue?.kind === 'sign-in-required';
    const database = !!issue?.database;
    text(this.title, missing ? t('Create a cloud project to continue') : signIn ? t('Sign in to load project data')
      : issue?.kind === 'access-denied' ? t('Project access is required') : database ? t('Database connection needs attention')
      : issue?.status && issue.status >= 500 ? t('The project Server returned an error') : t('Cannot connect to the project Server'));
    text(this.description, description(issue));
    text(this.steps, missing ? t('Create a private cloud project under your current account. This assigns a new project ID and opens the new project; existing Server data and permissions are not transferred.')
      : signIn ? t('Sign in to the selected Server, then check the connection again.')
      : issue?.kind === 'access-denied' ? t('Open the cloud project and request access from its owner. After approval, check the connection again.')
      : database ? t('Choose Configure database to check this resource and its authorization, then check the connection again.')
      : issue?.status && issue.status >= 500 || issue?.kind === 'setup-required' ? t('Open the cloud project to check its registration. If that page also fails, ask the Server administrator to repair the project registration using the connection details below. The connection will retry automatically.')
      : t('Check that the Server address below is reachable. The connection will retry automatically; you can also check again now.'));
    const serverUrl = safeServerUrl(issue?.serverUrl ?? options.serverUrl);
    text(this.container.querySelector('#server-guidance-server-url')!, serverUrl?.href.replace(/\/$/, '') ?? t('Not connected'));
    text(this.container.querySelector('#server-guidance-project-id')!, issue?.projectId ?? projectId);
    text(this.container.querySelector('#server-guidance-entry-id')!, issue?.entryId ?? options.entryId ?? '—');
    const statusLabels = { checking: 'Checking...', passed: 'Passed', 'action-required': 'Action required', waiting: 'Waiting' };
    const checks = state.checks ?? [];
    hiddenElement(this.checkSection, !checks.length);
    for (const [id, row] of this.rows) if (!checks.some(check => check.id === id)) { row.remove(); this.rows.delete(id); }
    checks.forEach((check, index) => {
      let row = this.rows.get(check.id);
      if (!row) {
        row = document.createElement('li'); row.className = 'project-server-check';
        const label = document.createElement('span'); label.className = 'project-server-check-label';
        const name = document.createElement('span'); name.className = 'project-server-check-name';
        const kind = document.createElement('span'); kind.className = 'project-server-check-kind'; label.append(name, kind);
        const status = document.createElement('span'); status.className = 'project-server-check-status'; row.append(label, status); this.rows.set(check.id, row);
      }
      text(row.querySelector('.project-server-check-name')!, check.database ?? t(check.stage === 'registration' ? 'Server project registration' : 'Current application'));
      text(row.querySelector('.project-server-check-kind')!, t(check.database
        ? check.id.startsWith('knowledge-bases:') ? 'Knowledge database' : 'Relational database' : 'Cloud project'));
      text(row.lastElementChild!, t(statusLabels[check.status])); row.dataset.status = check.status;
      if (this.checks.children[index] !== row) this.checks.insertBefore(row, this.checks.children[index] ?? null);
    });
    hiddenElement(this.create, !missing || options.canCreate === false);
    hiddenElement(this.databases, !database);
    hiddenElement(this.account, !signIn);
    hiddenElement(this.server, missing || signIn || !serverUrl || !(issue?.projectId ?? projectId));
    const primary = missing ? this.create : signIn ? this.account : database ? this.databases : issue?.kind === 'access-denied' || issue?.status ? this.server : this.retry;
    for (const button of [this.create, this.databases, this.account, this.server, this.retry]) {
      button.classList.toggle('primary', button === primary);
      button.disabled = !options.connected || this.acting || button === this.retry && options.working;
    }
    if (hidden) this.error.hidden = true;
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
  if (issue?.kind === 'project-unavailable') return t('The selected Server could not find or grant access to this project. If it should already exist, check access with its owner before creating a new one.');
  if (issue?.status) return t('The Server returned HTTP {0} while checking this project.', issue.status);
  if (issue?.database) return t('The database resource or its authorization is not ready.');
  if (issue?.reason === 'invalid-project-response') return t('The Server response does not contain a valid project registration. Check the Server version and registered entries.');
  return t('Project data is temporarily unavailable. Your local history and drafts are preserved.');
}
