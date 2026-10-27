import type { ProjectServerIssue, ProjectServerState, ProjectServerCheck } from '../project-server-state';
import { t } from '../localization';
import './project-server-guidance.css';

interface GuidanceOptions { connected: boolean; working: boolean; canCreate?: boolean }

export class ProjectServerGuidance {
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly server: HTMLElement;
  private readonly project: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly context: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly details: HTMLDetailsElement;
  private readonly create: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private signature = '';
  private checksSignature = '';
  private phase = '';
  private selected?: string;
  private current?: { state: ProjectServerState; projectId: string; options: GuidanceOptions };
  constructor(private readonly container: HTMLElement, actions: { create(): void; retry(): void }) {
    container.innerHTML = `<div class="project-server-guidance-body">
      <details id="server-checks" open><summary id="server-checks-summary" hidden><span id="server-checks-icon" class="codicon" aria-hidden="true"></span><span id="server-checks-title">${t('Application checks')}</span><span id="server-checks-progress"></span></summary>
      <ul id="server-checks-list" class="project-checks-list" hidden></ul>
      <p id="server-checks-note" class="project-checks-note" hidden>${t('Registration, imports and relationship declarations are checked here. Permissions for specific data are checked when used.')}</p>
      <div id="server-guidance-problem">
      <div class="project-server-guidance-context" id="server-guidance-context" hidden><span class="codicon codicon-link" aria-hidden="true"></span><span id="server-guidance-related"></span><span id="server-guidance-stage"></span></div>
      <h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p>
      <details id="server-guidance-details" open><summary hidden>${t('Connection details')}</summary>
      <dl><dt id="server-guidance-server-label">${t("Server")}</dt><dd id="server-guidance-server"></dd><dt>${t("Project ID")}</dt><dd id="server-guidance-project"></dd><dt id="server-guidance-alias-label" hidden>${t('Related project')}</dt><dd id="server-guidance-alias" hidden></dd></dl>
      </details>
      <ol id="server-guidance-steps"></ol>
      <div class="project-server-guidance-actions project-server-create-action"><button id="server-guidance-create" type="button" hidden>${t('Apply for a new application ID...')}</button></div>
      </div></details>
      <div class="project-server-guidance-actions project-server-recheck"><button id="server-guidance-retry" type="button">${t("Check again")}</button></div>
    </div>`;
    const find = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#server-guidance-${id}`)!;
    this.title = find('title'); this.description = find('description'); this.server = find('server'); this.project = find('project'); this.steps = find('steps');
    this.context = find('context'); this.stage = find('stage'); this.details = find('details');
    container.setAttribute('role', 'region'); container.setAttribute('aria-labelledby', this.title.id);
    this.create = find('create'); this.retry = find('retry');
    this.create.onclick = actions.create; this.retry.onclick = actions.retry;
  }
  update(state: ProjectServerState | undefined, projectId: string, options: GuidanceOptions): void {
    this.current = state && { state, projectId, options };
    const checks = state?.checks;
    const lifecycle = !!checks?.length;
    const selected = checks?.find(check => check.id === this.selected && check.issue);
    const issue = selected?.issue ?? state?.issue ?? (state?.checking && !lifecycle ? { kind: 'checking' as const } : undefined);
    const passed = !state?.checking && checks?.every(check => check.status === 'passed');
    this.container.hidden = !issue && (!lifecycle || !!passed);
    if (this.container.hidden) { this.signature = ''; this.phase = ''; return; }
    this.container.toggleAttribute('data-lifecycle', lifecycle);
    this.container.querySelector<HTMLElement>('#server-guidance-problem')!.hidden = !issue;
    const overview = this.container.querySelector<HTMLDetailsElement>('#server-checks')!;
    this.container.querySelector<HTMLElement>('#server-checks-summary')!.hidden = !lifecycle;
    this.container.querySelector<HTMLElement>('#server-checks-list')!.hidden = !lifecycle;
    this.container.querySelector<HTMLElement>('#server-checks-note')!.hidden = !lifecycle;
    if (lifecycle) {
      this.container.querySelector<HTMLElement>('#server-checks-note')!.textContent = checks.every(check => check.stage === 'builtin')
        ? t('Assistant history and memory stay on this device. Server AI still requires account authorization.')
        : t('Registration, imports and relationship declarations are checked here. Permissions for specific data are checked when used.');
      const attention = checks.filter(check => check.status === 'action-required').length;
      const complete = checks.filter(check => check.status === 'passed').length;
      const phase = state?.checking ? 'checking' : attention ? 'action-required' : 'passed';
      if (phase !== this.phase) overview.open = phase !== 'passed';
      this.phase = phase; this.container.dataset.result = phase;
      this.container.querySelector<HTMLElement>('#server-checks-icon')!.className = `codicon codicon-${phase === 'checking' ? 'loading codicon-modifier-spin' : phase === 'passed' ? 'pass' : 'warning'}`;
      this.container.querySelector<HTMLElement>('#server-checks-progress')!.textContent = state?.checking ? t('Checking {0}/{1}', complete, checks.length)
        : attention ? t('{0} need attention', attention) : t('{0}/{1} passed', complete, checks.length);
      this.renderChecks(checks, projectId);
      this.container.setAttribute('aria-labelledby', 'server-checks-title');
    } else {
      overview.open = true; this.phase = ''; delete this.container.dataset.result;
      this.container.setAttribute('aria-labelledby', this.title.id);
    }
    this.retry.disabled = !options.connected || options.working;
    this.create.hidden = true;
    if (!issue) { this.signature = ''; return; }
    const currentProject = !issue.projectId || issue.projectId.toLowerCase() === projectId.toLowerCase();
    const related = !currentProject || !!issue.relatedProjectAlias;
    const scope = related ? 'related' : 'project';
    if (this.container.dataset.scope !== scope || this.project.textContent !== (issue.projectId || projectId)) this.details.open = !related;
    this.container.dataset.scope = scope;
    this.context.hidden = !related;
    this.details.querySelector('summary')!.hidden = !related;
    this.create.disabled = !options.connected || options.working;
    this.create.hidden = related || issue.kind !== 'project-unavailable' || options.canCreate === false;
    const signature = JSON.stringify([issue, projectId, state?.blocking, options.canCreate]);
    if (signature === this.signature) return;
    this.signature = signature;
    const localImport = issue.kind === 'related-import-required';
    this.server.hidden = localImport;
    this.container.querySelector<HTMLElement>('#server-guidance-server-label')!.hidden = localImport;
    this.details.querySelector('summary')!.textContent = localImport ? t('Project details') : t('Connection details');
    this.server.textContent = localImport ? '' : issue.serverUrl || t("Not connected"); this.project.textContent = issue.projectId || projectId;
    const alias = this.container.querySelector<HTMLElement>('#server-guidance-alias')!;
    alias.textContent = issue.relatedProjectAlias ?? ''; alias.hidden = !issue.relatedProjectAlias;
    this.container.querySelector<HTMLElement>('#server-guidance-alias-label')!.hidden = !issue.relatedProjectAlias;
    this.container.querySelector<HTMLElement>('#server-guidance-related')!.textContent = issue.relatedProjectAlias ? t('Related project: {0}', issue.relatedProjectAlias) : t('Related project');
    const needsImport = related && issue.relatedProjectImported === false;
    this.container.dataset.stage = needsImport ? 'import' : localImport ? 'ready' : issue.kind === 'related-setup-required' ? 'authorization' : 'server';
    this.stage.textContent = needsImport ? t('Not imported') : issue.relatedProjectImported ? t('Imported') : t('Check access');
    let steps: string[];
    if (needsImport) {
      this.title.textContent = t('Import the related project first');
      this.description.textContent = localImport
        ? t('The related project is not available locally. Import the matching project folder to continue.')
        : t('The related project has not been imported, or its local folder is unavailable. Import it before checking Server access or data grants.');
      steps = [t('In Studio Related Projects, click "{0}", choose Import Project, and select the folder matching the project ID in the details.', issue.relatedProjectAlias || issue.projectId),
        t('After importing, choose Check again to see the next step.')];
    } else if (localImport) {
      this.title.textContent = t('Related project imported');
      this.description.textContent = t('The local project is available. Check again to dismiss this notice, then manually retry the original operation.');
      steps = [];
    } else if (issue.kind === 'checking') {
      this.title.textContent = t('Checking project Server');
      this.description.textContent = t('Checking sign-in and project access. Your local history and drafts remain available.');
      steps = [];
    } else if (issue.kind === 'sign-in-required') {
      this.title.textContent = state?.blocking === false ? t('Sign in to check application registration') : t("Sign in to load project data");
      this.description.textContent = state?.blocking === false ? t('Local features remain available. Sign in to the current application to check Server registration.') : t('This project needs a signed-in account to access Server storage.');
      steps = [t('Sign in to the current application, then choose Check again.')];
    } else if (issue.kind === 'access-denied') {
      this.title.textContent = related ? t('Related project account access is required') : t("Project access is required");
      this.description.textContent = t('Your current account cannot perform this data operation. Check access to the project shown below.');
      steps = [t('Ask the project owner to grant your current account access.'), t("After completing setup, choose Check again.")];
    } else if (issue.kind === 'connection-unavailable') {
      this.title.textContent = related ? t('Cannot connect to the related project Server') : t("Cannot connect to the project Server");
      this.description.textContent = t("Project data is temporarily unavailable. Your local history and drafts are preserved.");
      steps = [t('Check your network or contact the Server administrator. The connection will retry automatically.'), t("After completing setup, choose Check again.")];
    } else if (issue.kind === 'related-setup-required') {
      this.title.textContent = t('Check related project authorization');
      this.description.textContent = issue.relatedProjectImported
        ? t('The related project is imported. Its import status does not grant this project access to its data.')
        : t('Both projects must declare the relationship, and the target project must grant access to the requested data.');
      steps = [issue.relatedProjectImported === undefined
        ? t('Open the related local project and check both project manifests, relationship declarations, and the data grants required by this operation.')
        : t('Open "{0}" from Related Projects. In Information, check both project IDs, relationship declarations, and the data grants required by this operation.', issue.relatedProjectAlias || issue.projectId),
        t('Ask the project owner to check the corresponding Server Project Info and related project grants.'), t('After completing setup, choose Check again.')];
    } else {
      this.title.textContent = issue.kind === 'project-unavailable'
        ? related ? t('Related project unavailable on this Server') : t("Project unavailable on this Server")
        : related ? t('Check the related project Server settings') : t("Complete the Server project setup");
      this.description.textContent = issue.kind === 'project-unavailable'
        ? related ? t('The related project could not be found or accessed on this Server. Its owner needs to check the Server project record and your account access.')
          : options.canCreate === false ? t('This built-in application uses a managed ID. Ask the Server administrator to check its registration and your account access.')
          : t('This ID is not registered on the connected Server. It cannot be registered as a chosen ID. Apply for a new Server-assigned ID to use this project as a new application.')
        : t('The Server rejected this project data connection. Check the Server version, project type, and storage settings.');
      steps = issue.kind === 'project-unavailable' ? [
        currentProject ? options.canCreate === false ? t('Ask the Server administrator to check the built-in application ID and project registration.')
          : t('Choose Apply for a new application ID. Confirming replaces the local project ID and opens a new application without uploading source.')
          : t('Ask the related project owner to check its registration. If a new application ID is needed, update both projects\' relationship declarations and import the matching project again.'),
        t("If the project already exists, ask its owner to check your access."), t("After completing setup, choose Check again.")]
        : [t('Check the Server version and the Server Project Info. Ask the project owner to update the project type, storage settings, or related project grants if needed.'), t("After completing setup, choose Check again.")];
    }
    this.steps.hidden = !steps.length;
    this.steps.replaceChildren(...steps.map(text => { const step = document.createElement('li'); step.textContent = text; return step; }));
  }

  private renderChecks(checks: ProjectServerCheck[], projectId: string): void {
    const signature = JSON.stringify([checks, projectId]);
    const list = this.container.querySelector('#server-checks-list')!;
    const selectedId = checks.find(check => check.id === this.selected && check.issue)?.id ?? checks.find(check => check.issue)?.id;
    if (this.checksSignature === signature) {
      for (const button of list.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(button.dataset.checkId === selectedId));
      return;
    }
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.checkId : undefined;
    this.checksSignature = signature;
    const rows = checks.map(check => {
      const row = document.createElement('li'); row.dataset.status = check.status;
      const content = document.createElement(check.issue ? 'button' : 'div'); content.className = 'project-check-row';
      if (content instanceof HTMLButtonElement) {
        content.type = 'button'; content.dataset.checkId = check.id; content.setAttribute('aria-pressed', String(check.id === selectedId));
        content.onclick = () => { this.selected = check.id; if (this.current) this.update(this.current.state, this.current.projectId, this.current.options); };
      }
      const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true');
      icon.className = `codicon codicon-${check.status === 'checking' ? 'loading codicon-modifier-spin' : check.status === 'passed' ? 'check' : check.status === 'waiting' ? 'circle-outline' : 'warning'}`;
      const name = document.createElement('span'); name.className = 'project-check-name';
      name.textContent = check.stage === 'builtin' ? t('Built-in assistant')
        : check.relatedProjectAlias ? t('Related project: {0}', check.relatedProjectAlias) : t('Current application');
      name.title = check.projectId;
      const result = document.createElement('span'); result.className = 'project-check-result';
      result.textContent = check.status === 'waiting' ? t('Waiting for registration check') : check.status === 'checking' ? t('Checking...')
        : check.status === 'passed' ? check.stage === 'builtin' ? t('Available locally. No project registration needed.')
          : check.relatedProjectAlias ? t('Registration and relationship checked') : t('Registered on Server')
        : check.stage === 'import' ? t('Import required') : check.stage === 'relationship' ? t('Check relationship declarations')
        : check.issue?.kind === 'project-unavailable' ? t('Registration required') : t('Check Server access');
      content.append(icon, name, result); row.append(content); return row;
    });
    list.replaceChildren(...rows);
    if (focused) [...list.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.checkId === focused)?.focus();
  }
}
