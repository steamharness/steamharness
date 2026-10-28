import type { ProjectServerState } from '../project-server-state';
import { t } from '../localization';
import './project-server-guidance.css';
interface GuidanceOptions { connected: boolean; working: boolean; canCreate?: boolean }
export class ProjectServerGuidance {
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly checks: HTMLElement;
  private readonly create: HTMLButtonElement;
  private readonly databases: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  constructor(private readonly container: HTMLElement, actions: { create(): void; databases(): void; retry(): void }) {
    container.innerHTML = `<div class="project-server-guidance-body"><h2 id="server-guidance-title"></h2><p id="server-guidance-description"></p><ul id="server-checks-list"></ul><div class="project-server-guidance-actions"><button type="button" id="server-guidance-create">${t('Create project')}</button><button type="button" id="server-guidance-databases">${t('View linked databases')}</button><button type="button" id="server-guidance-retry">${t('Check again')}</button></div></div>`;
    this.title = container.querySelector('h2')!; this.description = container.querySelector('p')!; this.checks = container.querySelector('ul')!;
    this.create = container.querySelector('#server-guidance-create')!;
    this.databases = container.querySelector('#server-guidance-databases')!;
    this.retry = container.querySelector('#server-guidance-retry')!;
    this.create.onclick = actions.create; this.databases.onclick = actions.databases; this.retry.onclick = actions.retry;
  }
  update(state: ProjectServerState | undefined, _projectId: string, options: GuidanceOptions) {
    this.container.hidden = !state || !state.checking && !state.issue;
    if (!state) return;
    const issue = state.issue;
    this.title.textContent = state.checking ? t('Application checks') : issue?.database ? t('Database binding requires attention') : issue?.kind==='access-denied'?t('Project access is required'):t('Complete the Server project setup');
    this.description.textContent = issue?.database ? t('Check database links in Project information. Manage requests and permissions in Studio or Server Web.') : issue?.kind === 'sign-in-required' ? t('Please sign in to the project Server.') : issue?.kind === 'project-unavailable' ? t('Register this aggregate project on the selected Server.') : issue?.kind === 'access-denied' ? t('Project access is required') : t('After completing setup, choose Check again.');
    const statusLabels = { checking: 'Checking...', passed: 'Passed', 'action-required': 'Action required', waiting: 'Waiting' };
    this.checks.replaceChildren(...(state.checks ?? []).map(check => { const row = document.createElement('li'); row.textContent = `${check.database ?? t('Current application')} · ${t(statusLabels[check.status])}`; return row; }));
    this.create.hidden = issue?.kind !== 'project-unavailable' || options.canCreate === false;
    this.databases.hidden = !issue?.database;
    this.create.disabled = this.databases.disabled = this.retry.disabled = !options.connected || options.working;
  }
}
