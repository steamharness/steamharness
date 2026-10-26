import type { KanbanServerIssue } from '../kanban-server-state';
import { t } from '../localization';

export class KanbanServerGuidance {
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly server: HTMLElement;
  private readonly project: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly upload: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private signature = '';
  constructor(private readonly container: HTMLElement, actions: { account(): void; upload(): void; retry(): void }) {
    container.innerHTML = `<div class="kanban-server-guidance-body">
      <h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p>
      <dl><dt>${t("Server")}</dt><dd id="server-guidance-server"></dd><dt>${t("Project ID")}</dt><dd id="server-guidance-project"></dd></dl>
      <ol id="server-guidance-steps"></ol>
      <div class="kanban-server-guidance-actions"><button id="server-guidance-upload" type="button" hidden>${t("Upload project...")}</button><button id="server-guidance-account" type="button">${t("Account / Server")}</button><button id="server-guidance-retry" type="button">${t("Check again")}</button></div>
    </div>`;
    const find = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#server-guidance-${id}`)!;
    this.title = find('title'); this.description = find('description'); this.server = find('server'); this.project = find('project'); this.steps = find('steps');
    this.upload = find('upload'); this.retry = find('retry');
    find<HTMLButtonElement>('account').onclick = actions.account;
    this.upload.onclick = actions.upload; this.retry.onclick = actions.retry;
  }
  update(issue: KanbanServerIssue | undefined, projectId: string, options: { connected: boolean; working: boolean; uploadAvailable: boolean }): void {
    this.container.hidden = !issue;
    if (!issue) { this.signature = ''; return; }
    this.retry.disabled = !options.connected || options.working;
    this.upload.disabled = !options.connected || options.working;
    this.upload.hidden = !options.uploadAvailable || !['project-unavailable', 'setup-required'].includes(issue.kind);
    const signature = JSON.stringify([issue, projectId]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.server.textContent = issue.serverUrl || t("Not connected"); this.project.textContent = projectId;
    let steps: string[];
    if (issue.kind === 'sign-in-required') {
      this.title.textContent = t("Sign in to load project data");
      this.description.textContent = t("This project uses Server storage. Sign in to the Server that contains this project.");
      steps = [t("Open Account / Server and sign in or verify your account."), t("After completing setup, choose Check again.")];
    } else if (issue.kind === 'access-denied') {
      this.title.textContent = t("Project access is required");
      this.description.textContent = t("Your current account cannot access this project's data on the connected Server.");
      steps = [t("Ask the project owner to grant your account access, or use Account / Server to switch accounts or Servers."), t("After completing setup, choose Check again.")];
    } else {
      this.title.textContent = issue.kind === 'project-unavailable' ? t("Project unavailable on this Server") : t("Complete the Server project setup");
      this.description.textContent = issue.kind === 'project-unavailable'
        ? t("This project could not be found or accessed on the connected Server. Importing a local folder does not create a Server project.")
        : t("The Server rejected this project's data connection. Check its uploaded source, project type, and storage settings.");
      steps = [t("Check the Server address. If you uploaded this project to another Server, switch to it from Account / Server."),
        t("If this is the correct Server, upload this project with the same project ID. In Studio, use Upload Project from the project's menu."),
        t("If the project already exists, ask its owner to check your access."), t("After completing setup, choose Check again.")];
    }
    this.steps.replaceChildren(...steps.map(text => { const step = document.createElement('li'); step.textContent = text; return step; }));
  }
}
