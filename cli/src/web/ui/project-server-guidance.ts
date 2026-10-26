import type { ProjectServerIssue } from '../project-server-state';
import { t } from '../localization';
import './project-server-guidance.css';

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
  constructor(private readonly container: HTMLElement, actions: { create(): void; retry(): void }) {
    container.innerHTML = `<div class="project-server-guidance-body">
      <div class="project-server-guidance-context" id="server-guidance-context" hidden><span class="codicon codicon-link" aria-hidden="true"></span><span id="server-guidance-related"></span><span id="server-guidance-stage"></span></div>
      <h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p>
      <details id="server-guidance-details" open><summary hidden>${t('Connection details')}</summary>
      <dl><dt id="server-guidance-server-label">${t("Server")}</dt><dd id="server-guidance-server"></dd><dt>${t("Project ID")}</dt><dd id="server-guidance-project"></dd><dt id="server-guidance-alias-label" hidden>${t('Related project')}</dt><dd id="server-guidance-alias" hidden></dd></dl>
      </details>
      <ol id="server-guidance-steps"></ol>
      <div class="project-server-guidance-actions"><button id="server-guidance-create" type="button" hidden>${t('New project on Server...')}</button><button id="server-guidance-retry" type="button">${t("Check again")}</button></div>
    </div>`;
    const find = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#server-guidance-${id}`)!;
    this.title = find('title'); this.description = find('description'); this.server = find('server'); this.project = find('project'); this.steps = find('steps');
    this.context = find('context'); this.stage = find('stage'); this.details = find('details');
    container.setAttribute('role', 'region'); container.setAttribute('aria-labelledby', this.title.id);
    this.create = find('create'); this.retry = find('retry');
    this.create.onclick = actions.create; this.retry.onclick = actions.retry;
  }
  update(issue: ProjectServerIssue | undefined, projectId: string, options: { connected: boolean; working: boolean }): void {
    this.container.hidden = !issue;
    if (!issue) { this.signature = ''; return; }
    this.retry.disabled = !options.connected || options.working;
    const currentProject = !issue.projectId || issue.projectId.toLowerCase() === projectId.toLowerCase();
    const related = !currentProject || !!issue.relatedProjectAlias;
    const scope = related ? 'related' : 'project';
    if (this.container.dataset.scope !== scope || this.project.textContent !== (issue.projectId || projectId)) this.details.open = !related;
    this.container.dataset.scope = scope;
    this.context.hidden = !related;
    this.details.querySelector('summary')!.hidden = !related;
    this.create.disabled = !options.connected || options.working;
    this.create.hidden = related || issue.kind !== 'project-unavailable';
    const signature = JSON.stringify([issue, projectId]);
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
      this.title.textContent = t("Sign in to load project data");
      this.description.textContent = t('This project needs a signed-in account to access Server storage.');
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
          : t("This project could not be found or accessed on the connected Server. Importing a local folder does not create a Server project.")
        : t('The Server rejected this project data connection. Check the Server version, project type, and storage settings.');
      steps = issue.kind === 'project-unavailable' ? [
        currentProject ? t('Choose New project on Server and confirm a project with the same ID.')
          : t('Open the related local project and choose New project on Server with the project ID shown below.'),
        t("If the project already exists, ask its owner to check your access."), t("After completing setup, choose Check again.")]
        : [t('Check the Server version and the Server Project Info. Ask the project owner to update the project type, storage settings, or related project grants if needed.'), t("After completing setup, choose Check again.")];
    }
    this.steps.hidden = !steps.length;
    this.steps.replaceChildren(...steps.map(text => { const step = document.createElement('li'); step.textContent = text; return step; }));
  }
}
