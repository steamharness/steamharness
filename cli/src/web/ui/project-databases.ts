import { DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN } from '@steamharness/database-spaces';
import type { DatabaseManagementState } from '../database-management';
import type { Project } from '../workflow-types';
import { t } from '../localization';
import { iconHtml } from './ui';

type Host = { postMessage(message: Record<string, any>): unknown };
type Pending = { id: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const text = (tag: string, value: string, className = '') => { const element = document.createElement(tag); element.textContent = value; element.className = className; return element; };
const iconButton = (icon: string, label: string, action: () => void) => {
  const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.className = 'database-icon-button'; button.innerHTML = iconHtml(icon); button.onclick = action; return button;
};

/** Project references only. Data and host authorization open in the native host. */
export class ProjectDatabases {
  private readonly lifecycle = new AbortController();
  private root?: HTMLElement;
  private content?: HTMLElement;
  private error?: HTMLElement;
  private project?: Project;
  private state?: DatabaseManagementState;
  private pending?: Pending;
  private connected = true;

  constructor(private readonly bridge: Host) {
    addEventListener('message', event => {
      if (event.source !== null && event.source !== window.parent) return;
      const message = event.data;
      if (message?.type === 'connection') {
        this.connected = message.status === 'connected';
        if (!this.connected) this.finish(undefined, new Error(t('Connection interrupted.')));
      }
      if (!this.pending || message?.requestId !== this.pending.id) return;
      if (message.type === 'databases-result' || message.type === 'database-open-result') this.finish(message.value, message.error ? new Error(message.error) : undefined);
      else if (message.type === 'error') this.finish(undefined, new Error(message.message));
    }, { signal: this.lifecycle.signal });
    addEventListener('pagehide', event => { if (!event.persisted) this.dispose(); }, { signal: this.lifecycle.signal });
  }
  mount(container: HTMLElement, project: Project): () => void {
    this.unmount(); this.project = project; this.state = undefined;
    const root = this.root = document.createElement('div'); root.className = 'project-databases'; container.append(root);
    this.render(); void this.run({ action: 'get' });
    return () => { if (this.root === root) this.unmount(); };
  }
  private unmount() {
    this.finish(undefined, new Error(t('Database view closed.'))); this.root = undefined; this.content = undefined; this.error = undefined;
  }
  dispose() { this.unmount(); this.lifecycle.abort(); }
  private setBusy(busy: boolean) {
    if (!this.root) return;
    this.root.setAttribute('aria-busy', String(busy));
    for (const control of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
      if (busy) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; }
      else if (control.dataset.wasDisabled !== undefined) { control.disabled = control.dataset.wasDisabled === 'true'; delete control.dataset.wasDisabled; }
    }
  }
  private finish(value?: unknown, error?: Error) {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer); this.setBusy(false);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  private send(value: Record<string, unknown>, type = 'databases'): Promise<any> {
    if (!this.root) return Promise.reject(new Error(t('Database view closed.')));
    if (!this.connected) return Promise.reject(new Error(t('Connection interrupted.')));
    if (this.pending) return Promise.reject(new Error(t('Wait for the current database operation to finish.')));
    if (this.error) { this.error.hidden = true; this.error.textContent = ''; }
    const id = crypto.randomUUID(); this.setBusy(true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending?.id === id) this.finish(undefined, new Error(t('The request timed out. Check the current status.'))); }, 20_000);
      this.pending = { id, resolve, reject, timer };
      const failed = (error: unknown) => { if (this.pending?.id === id) this.finish(undefined, error instanceof Error ? error : new Error(String(error))); };
      try { void Promise.resolve(this.bridge.postMessage({ type, requestId: id, projectUri: this.project?.uri, ...value })).catch(failed); }
      catch (error) { failed(error); }
    });
  }
  private async run(value: Record<string, unknown>, type = 'databases') {
    const root = this.root;
    try {
      const result = await this.send(value, type);
      if (root !== this.root) return;
      if (type === 'databases') { this.state = result; this.render(); }
    } catch (error) {
      if (root !== this.root || !this.error) return;
      this.error.hidden = false; this.error.textContent = error instanceof Error ? error.message : String(error);
      if (!this.state && this.content) this.content.textContent = t('Choose Refresh to retry.');
    }
  }
  private render() {
    if (!this.root || !this.project) return;
    this.root.replaceChildren();
    const heading = text('div', '', 'database-section-heading');
    heading.append(text('strong', t('Project databases')));
    const controls = text('div', '', 'database-actions');
    controls.append(iconButton('link', t('Link database'), () => this.bindingForm()), iconButton('refresh', t('Refresh'), () => void this.run({ action: 'get' })));
    heading.append(controls); this.root.append(heading);
    this.error = text('p', '', 'database-error'); this.error.hidden = true; this.error.setAttribute('role', 'status'); this.root.append(this.error);
    this.content = text('div', '', 'database-content'); this.root.append(this.content);
    if (!this.state) { this.content.append(text('p', t('Loading databases...'), 'database-muted')); return; }
    if (!this.state.requirements.length) this.content.append(text('p', t('No databases are linked to this entry.'), 'database-muted'));
    for (const requirement of this.state.requirements) {
      const card = text('div', '', 'database-card'); card.dataset.alias = requirement.alias;
      const header = text('div', '', 'database-card-heading');
      header.insertAdjacentHTML('beforeend', iconHtml('database'));
      const name = text('div', '', 'database-name'); name.append(text('h4', requirement.space?.name ?? requirement.alias), text('span', requirement.alias, 'database-muted')); header.append(name);
      const actions = text('div', '', 'database-actions');
      actions.append(iconButton('go-to-file', t('Browse data in host'), () => void this.run({ alias: requirement.alias }, 'database-open')));
      if (!this.state.environmentOverrides.includes(requirement.alias)) actions.append(iconButton('edit', t('Change database'), () => this.bindingForm(requirement.alias, requirement.databaseId)));
      actions.append(iconButton('copy', t('Copy database ID'), () => { void this.bridge.postMessage({ type: 'copy', text: requirement.databaseId }); }));
      header.append(actions); card.append(header);
      const metadata = text('div', '', 'database-metadata');
      const status = text('span', t(requirement.status === 'bound' ? 'Connected' : 'Needs attention'), 'database-badge'); status.dataset.status = requirement.status === 'bound' ? 'connected' : 'attention'; metadata.append(status);
      if (requirement.space) metadata.append(text('span', t(requirement.space.host === 'local' ? 'This computer' : 'Server'), 'database-muted'));
      card.append(metadata, text('code', requirement.databaseId, 'database-id'));
      if (requirement.error) card.append(text('p', requirement.error, 'database-error'));
      if (this.state.environmentOverrides.includes(requirement.alias)) card.append(text('p', t('This database reference is set by the environment.'), 'database-muted'));
      const usage = text('div', '', 'database-entry-usage');
      for (const entry of this.state.entries.filter(entry => entry.databases.some(database => database.alias === requirement.alias))) {
        const badge = text('span', entry.name, 'database-entry'); badge.dataset.current = String(entry.entryId === this.project.entryId); usage.append(badge);
      }
      card.append(usage); this.content.append(card);
    }
    this.content.append(text('p', t('Request and approve database access in Studio or Server Web. CLI approval commands are also available.'), 'database-muted'));
  }
  private bindingForm(alias = '', databaseId = '') {
    if (!this.content) return;
    this.content.querySelector('.database-form')?.remove();
    const form = document.createElement('form'); form.className = 'database-form';
    const input = (label: string, value: string) => {
      const field = document.createElement('label'); field.append(text('span', label)); const control = document.createElement('input'); control.value = value; control.setAttribute('aria-label', label); control.required = true; field.append(control); form.append(field); return control;
    };
    const name = input(t('Database alias'), alias); name.readOnly = !!alias; name.pattern = DATABASE_IDENTIFIER_PATTERN.source;
    const id = input(t('Database ID'), databaseId); id.pattern = DATABASE_UUID_PATTERN.source;
    const actions = text('div', '', 'database-actions'); const save = iconButton('check', t('Save database reference'), () => {}); save.type = 'submit';
    actions.append(save, iconButton('close', t('Cancel'), () => form.remove())); form.append(actions);
    form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void this.run({ action: 'bind', alias: name.value.trim(), databaseId: id.value.trim() }); };
    this.content.prepend(form); (alias ? id : name).focus();
  }
}
