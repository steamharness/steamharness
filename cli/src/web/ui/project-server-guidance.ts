import type { ProjectServerIssue } from '../project-server-state';
import { t } from '../localization';
import './project-server-guidance.css';

export class ProjectServerGuidance {
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly server: HTMLElement;
  private readonly project: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly upload: HTMLButtonElement;
  private readonly create: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private signature = '';
  constructor(private readonly container: HTMLElement, actions: { account(): void; create(): void; upload(): void; retry(): void }) {
    container.innerHTML = `<div class="project-server-guidance-body">
      <h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p>
      <dl><dt>${t("Server")}</dt><dd id="server-guidance-server"></dd><dt>${t("Project ID")}</dt><dd id="server-guidance-project"></dd><dt id="server-guidance-alias-label" hidden>${t('Related project')}</dt><dd id="server-guidance-alias" hidden></dd></dl>
      <ol id="server-guidance-steps"></ol>
      <div class="project-server-guidance-actions"><button id="server-guidance-create" type="button" hidden>${t('New project on Server...')}</button><button id="server-guidance-upload" type="button" hidden>${t('Upload source (optional)...')}</button><button id="server-guidance-account" type="button">${t("Account / Server")}</button><button id="server-guidance-retry" type="button">${t("Check again")}</button></div>
    </div>`;
    const find = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#server-guidance-${id}`)!;
    this.title = find('title'); this.description = find('description'); this.server = find('server'); this.project = find('project'); this.steps = find('steps');
    this.upload = find('upload'); this.create = find('create'); this.retry = find('retry');
    find<HTMLButtonElement>('account').onclick = actions.account;
    this.upload.onclick = actions.upload; this.create.onclick = actions.create; this.retry.onclick = actions.retry;
  }
  update(issue: ProjectServerIssue | undefined, projectId: string, options: { connected: boolean; working: boolean; uploadAvailable: boolean }): void {
    this.container.hidden = !issue;
    if (!issue) { this.signature = ''; return; }
    this.retry.disabled = !options.connected || options.working;
    this.upload.disabled = !options.connected || options.working;
    const currentProject = !issue.projectId || issue.projectId.toLowerCase() === projectId.toLowerCase();
    this.create.disabled = !options.connected || options.working;
    this.create.hidden = !currentProject || issue.kind !== 'project-unavailable';
    this.upload.hidden = !options.uploadAvailable || !currentProject || issue.kind !== 'project-unavailable';
    const signature = JSON.stringify([issue, projectId]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.server.textContent = issue.serverUrl || t("Not connected"); this.project.textContent = issue.projectId || projectId;
    const alias = this.container.querySelector<HTMLElement>('#server-guidance-alias')!;
    alias.textContent = issue.relatedProjectAlias ?? ''; alias.hidden = !issue.relatedProjectAlias;
    this.container.querySelector<HTMLElement>('#server-guidance-alias-label')!.hidden = !issue.relatedProjectAlias;
    let steps: string[];
    if (issue.kind === 'checking') {
      this.title.textContent = t('Checking project Server');
      this.description.textContent = t('Checking sign-in and project access. Your local history and drafts remain available.');
      steps = [];
    } else if (issue.kind === 'sign-in-required') {
      this.title.textContent = t("Sign in to load project data");
      this.description.textContent = t('This project accessed Server storage. Sign in to the Server that contains the affected project.');
      steps = [t("Open Account / Server and sign in or verify your account."), t("After completing setup, choose Check again.")];
    } else if (issue.kind === 'access-denied') {
      this.title.textContent = t("Project access is required");
      this.description.textContent = t('Your current account cannot perform this data operation. Check access to the project shown below.');
      steps = [t("Ask the project owner to grant your account access, or use Account / Server to switch accounts or Servers."), t("After completing setup, choose Check again.")];
    } else if (issue.kind === 'connection-unavailable') {
      this.title.textContent = t("Cannot connect to the project Server");
      this.description.textContent = t("Project data is temporarily unavailable. Your local history and drafts are preserved.");
      steps = [t("Check your network and the Server address in Account / Server. The connection will retry automatically."), t("After completing setup, choose Check again.")];
    } else if (issue.kind === 'related-setup-required') {
      this.title.textContent = t('Related project authorization is required');
      this.description.textContent = t('Both projects must declare the relationship, and the target project must grant access to the requested data.');
      steps = [t('Open the related project shown below and check its Server Project Info and data grants with the owner.'), t('After completing setup, choose Check again.')];
    } else {
      this.title.textContent = issue.kind === 'project-unavailable' ? t("Project unavailable on this Server") : t("Complete the Server project setup");
      this.description.textContent = issue.kind === 'project-unavailable'
        ? t("This project could not be found or accessed on the connected Server. Importing a local folder does not create a Server project.")
        : t('The Server rejected this project data connection. Check the Server version, project type, and storage settings.');
      steps = issue.kind === 'project-unavailable' ? [t('Check the Server address. If this project exists on another Server, switch to it from Account / Server.'),
        currentProject ? t('If this is the correct Server, choose New project on Server and confirm a project with the same ID. Source upload is optional.')
          : t('Open the related local project and choose New project on Server with the project ID shown below. Source upload is optional.'),
        t("If the project already exists, ask its owner to check your access."), t("After completing setup, choose Check again.")]
        : [t('Check the Server version and the Server Project Info. Ask the project owner to update the project type, storage settings, or related project grants if needed.'), t("After completing setup, choose Check again.")];
    }
    this.steps.replaceChildren(...steps.map(text => { const step = document.createElement('li'); step.textContent = text; return step; }));
  }
}
