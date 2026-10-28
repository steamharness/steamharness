import type { ProjectServerState } from '../project-server-state';
import { t } from '../localization';
import './project-server-guidance.css';
interface GuidanceOptions { connected: boolean; working: boolean; canCreate?: boolean }
export class ProjectServerGuidance {
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly checks: HTMLElement;
  private readonly create: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  constructor(private readonly container: HTMLElement, actions: { create(): void; retry(): void }) {
    container.innerHTML = `<div class="project-server-guidance-body"><h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p><ul id="server-checks-list"></ul><div class="project-server-guidance-actions"><button type="button" id="server-guidance-create">${t('Create project')}</button><button type="button" id="server-guidance-retry">${t('Check again')}</button></div></div>`;
    this.title = container.querySelector('h2')!; this.description = container.querySelector('p')!; this.checks = container.querySelector('ul')!;
    [this.create, this.retry] = [...container.querySelectorAll('button')]; this.create.onclick = actions.create; this.retry.onclick = actions.retry;
  }
  update(state: ProjectServerState | undefined, _projectId: string, options: GuidanceOptions) {
    this.container.hidden = !state || !state.checking && !state.issue;
    if (!state) return;
    const issue = state.issue;
    this.title.textContent = state.checking ? t('Application checks') : issue?.database ? t('Database binding requires attention') : issue?.kind==='access-denied'?t('Project access is required'):t('Complete the Server project setup');
    this.description.textContent = issue?.database ? t('Open Databases to request, approve or restore access.') : issue?.kind === 'sign-in-required' ? t('Please sign in to the project Server.') : issue?.kind === 'project-unavailable' ? t('Register this aggregate project on the selected Server.') : issue?.kind === 'access-denied' ? t('Project access is required') : t('After completing setup, choose Check again.');
    this.checks.replaceChildren(...(state.checks ?? []).map(check => { const row = document.createElement('li'); row.textContent = `${check.database ?? t('Current application')} · ${t(check.status)}`; return row; }));
    this.create.hidden = issue?.kind !== 'project-unavailable' || options.canCreate === false;
    this.create.disabled = this.retry.disabled = !options.connected || options.working;
  }
}
