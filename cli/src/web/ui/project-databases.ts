import { DATABASE_IDENTIFIER_PATTERN, type DatabaseHost, type DatabasePermissions, type DatabaseRequest } from '@steamharness/database-spaces';
import type { DatabaseManagementState } from '../database-management';
import type { Project } from '../workflow-types';
import { t } from '../localization';
import { mountDatabaseData } from './database-data';
import { databasePermissionsEditor, databasePermissionsView } from './database-permissions';
import { requestAction } from './action-dialog';
import { iconHtml } from './ui';

type Host = { postMessage(message: Record<string, any>): unknown };
type Requirement = DatabaseManagementState['requirements'][number];
type Pending = { id: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const hostName = (host: DatabaseHost) => host === 'local' ? t('This computer') : t('Server');
const text = (tag: string, value: string, className = '') => { const element = document.createElement(tag); element.textContent = value; element.className = className; return element; };
const button = (label: string, action: () => void, className = '') => {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.className = className; element.onclick = action; return element;
};
const permissions = (): DatabasePermissions => ({ kv: { read: { mode: 'all' }, write: { mode: 'all' } }, knowledge: { read: { mode: 'all' }, write: { mode: 'all' } } });

/** One host bridge, mounted lazily inside Project information for every entry type. */
export class ProjectDatabases {
  private readonly lifecycle = new AbortController();
  private root?: HTMLElement;
  private content?: HTMLElement;
  private error?: HTMLElement;
  private project?: Project;
  private state?: DatabaseManagementState;
  private pending?: Pending;
  private connected = true;
  private view: 'databases' | 'access' | 'data' = 'databases';
  private host: DatabaseHost = 'local';
  private allProjects = false;
  private selectedAlias?: string;
  private disposeData?: () => void;

  constructor(private readonly bridge: Host) {
    addEventListener('message', event => {
      if (event.source !== null && event.source !== window.parent) return;
      const message = event.data;
      if (message?.type === 'connection') {
        this.connected = message.status === 'connected';
        if (!this.connected) this.finish(undefined, new Error(t('Connection interrupted.')));
      }
      if (message?.type === 'state' && this.project && message.project?.id === this.project.id && message.project.entryId === this.project.entryId) this.project = message.project;
      if (!this.pending || message?.requestId !== this.pending.id) return;
      if (message.type === 'databases-result') this.finish(message.value);
      else if (message.type === 'error') this.finish(undefined, new Error(message.message));
    }, { signal: this.lifecycle.signal });
    addEventListener('pagehide', event => { if (!event.persisted) this.dispose(); }, { signal: this.lifecycle.signal });
  }

  mount(container: HTMLElement, project: Project): () => void {
    this.unmount(); this.project = project; this.state = undefined; this.view = 'databases';
    const root = this.root = document.createElement('div'); root.className = 'project-databases'; container.append(root);
    this.render(); this.run({ action: 'get' });
    return () => { if (this.root === root) this.unmount(); };
  }

  private unmount() {
    this.disposeData?.(); this.disposeData = undefined;
    this.finish(undefined, new Error(t('Database view closed.'))); this.root = undefined; this.content = undefined; this.error = undefined;
  }
  dispose() { this.unmount(); this.lifecycle.abort(); }

  private setBusy(busy: boolean) {
    if (!this.root) return;
    this.root.setAttribute('aria-busy', String(busy));
    for (const control of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')) {
      if (busy) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; }
      else if (control.dataset.wasDisabled !== undefined) { control.disabled = control.dataset.wasDisabled === 'true'; delete control.dataset.wasDisabled; }
    }
  }
  private finish(value?: unknown, error?: Error) {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer); this.setBusy(false);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  private send(value: Record<string, unknown>): Promise<any> {
    if (!this.root) return Promise.reject(new Error(t('Database view closed.')));
    if (!this.connected) return Promise.reject(new Error(t('Connection interrupted.')));
    if (this.pending) return Promise.reject(new Error(t('Wait for the current database operation to finish.')));
    if (this.error) { this.error.hidden = true; this.error.textContent = ''; }
    const id = crypto.randomUUID(); this.setBusy(true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(undefined, new Error(t('The request timed out. Check the current status.'))), value.action === 'data' ? 120_000 : 20_000);
      this.pending = { id, resolve, reject, timer };
      const failed = (error: unknown) => { if (this.pending?.id === id) this.finish(undefined, error instanceof Error ? error : new Error(String(error))); };
      try { void Promise.resolve(this.bridge.postMessage({ type: 'databases', requestId: id, projectUri: this.project?.uri, ...value })).catch(failed); }
      catch (error) { failed(error); }
    });
  }
  private run(value: Record<string, unknown>, notice?: string) {
    const root = this.root;
    void this.send(value).then(state => {
      if (!root || this.root !== root) return;
      if (!this.state) this.host = state.requirements.find((requirement: Requirement) => requirement.space)?.space?.host ?? 'local';
      this.state = state; this.render();
      if (notice) { const message = text('p', notice, 'database-notice'); message.setAttribute('role', 'status'); this.content!.prepend(message); }
    }).catch(error => {
      if (!root || this.root !== root || !this.error) return;
      this.error.hidden = false; this.error.textContent = error instanceof Error ? error.message : String(error);
      if (!this.state) this.content?.replaceChildren(text('p', t('Database information could not be loaded. Choose Refresh to retry.'), 'database-muted'));
    });
  }
  private changeView(view: 'databases' | 'access') { this.view = view; this.render(); }

  private render() {
    if (!this.root || !this.project) return;
    this.disposeData?.(); this.disposeData = undefined; this.root.replaceChildren();
    const navigation = document.createElement('div'); navigation.className = 'database-navigation';
    navigation.setAttribute('role', 'group'); navigation.setAttribute('aria-label', t('Database management'));
    for (const [view, label] of [['databases', t('Project databases')], ['access', t('Requests and permissions')]] as const) {
      const tab = button(label, () => this.changeView(view)); tab.setAttribute('aria-pressed', String(this.view === view || this.view === 'data' && view === 'databases')); navigation.append(tab);
    }
    const refresh = button(t('Refresh'), () => this.run({ action: 'get' }), 'database-refresh'); refresh.innerHTML = `${iconHtml('refresh')}<span>${t('Refresh')}</span>`; navigation.append(refresh);
    this.error = text('p', '', 'database-error'); this.error.setAttribute('role', 'alert'); this.error.hidden = true;
    this.content = document.createElement('div'); this.content.className = 'database-content'; this.root.append(navigation, this.error, this.content);
    if (!this.state) { this.content.append(text('p', t('Loading databases...'), 'database-muted')); return; }
    if (this.state.serverError) { const warning = text('p', t('Server databases are unavailable: {0}', this.state.serverError), 'database-error'); this.content.append(warning); }
    if (this.view === 'access') this.renderAccess();
    else if (this.view === 'data' && this.selectedAlias) {
      const requirement = this.state.requirements.find(item => item.alias === this.selectedAlias && item.status === 'bound');
      if (requirement) this.renderData(requirement);
      else { this.view = 'databases'; this.renderDatabases(); }
    } else this.renderDatabases();
  }

  private card(title: string, badge?: string, status?: string) {
    const card = document.createElement('section'); card.className = 'database-card';
    const heading = document.createElement('div'); heading.className = 'database-card-heading'; heading.append(text('h4', title));
    if (badge) { const tag = text('span', badge, 'database-badge'); if (status) tag.dataset.status = status; heading.append(tag); }
    card.append(heading); return card;
  }
  private field(form: HTMLElement, title: string, value = '') {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('input'); input.value = value; input.required = true; input.setAttribute('aria-label', title); label.append(input); form.append(label); return input;
  }
  private form(title: string, parent: HTMLElement) {
    const form = document.createElement('form'); form.className = 'database-form'; form.append(text('h4', title)); parent.append(form); return form;
  }
  private formActions(form: HTMLFormElement, label: string, action: () => void) {
    const actions = document.createElement('div'); actions.className = 'database-actions';
    const save = button(label, () => {}, 'database-primary'); save.type = 'submit';
    actions.append(save, button(t('Cancel'), () => form.remove())); form.append(actions);
    form.onsubmit = event => { event.preventDefault(); action(); };
  }
  private bindForm(parent: HTMLElement, alias = '', databaseId = '', editing = false) {
    parent.querySelector('.database-form')?.remove();
    const form = this.form(editing ? t('Change database') : t('Link an approved database'), parent);
    const name = this.field(form, t('Database alias'), alias); name.readOnly = editing; name.pattern = DATABASE_IDENTIFIER_PATTERN.source;
    const id = this.field(form, t('Database ID'), databaseId);
    form.append(text('p', t('Changing an alias updates every entry that uses it.'), 'database-muted'));
    this.formActions(form, t('Save database reference'), () => {
      this.view = 'databases'; this.run({ action: 'bind', alias: name.value, databaseId: id.value }, t('Database reference saved. Host authorization is checked separately.'));
    });
    (editing ? id : name).focus();
  }

  private renderDatabases() {
    const content = this.content!, state = this.state!, project = this.project!;
    const intro = document.createElement('div'); intro.className = 'database-section-heading';
    intro.append(text('div', t('Databases used by {0}', project.name)), button(t('Link database'), () => this.bindForm(add), 'database-primary'));
    content.append(intro, text('p', t('Data access uses this entry’s host permissions. Other entries may share the same database.'), 'database-muted'));
    const add = document.createElement('div'); content.append(add);
    if (!state.requirements.length) {
      const empty = document.createElement('div'); empty.className = 'database-empty'; empty.innerHTML = iconHtml('database');
      empty.append(text('strong', t('No databases linked')), text('p', t('Link an approved database, or request one from its host.')),
        button(t('Request database access'), () => { this.changeView('access'); this.requestForm(); })); content.append(empty);
    }
    for (const requirement of state.requirements) {
      const bound = requirement.status === 'bound';
      const card = this.card(requirement.alias, bound ? t('Connected') : t('Needs authorization'), bound ? 'connected' : 'attention'); card.dataset.alias = requirement.alias;
      if (requirement.space) card.append(text('p', `${requirement.space.name} · ${hostName(requirement.space.host)}`, 'database-card-subtitle'));
      const id = text('code', requirement.databaseId, 'database-id'); id.setAttribute('aria-label', t('Database ID')); card.append(id);
      const entries = (state.entries ?? project.entries).filter(entry => entry.databases.some(database => database.alias === requirement.alias));
      const usage = document.createElement('div'); usage.className = 'database-entry-usage'; usage.append(text('span', t('Used by')));
      for (const entry of entries) { const badge = text('span', entry.name, 'database-entry'); badge.title = entry.entryId; badge.dataset.current = String(entry.entryId === project.entryId); usage.append(badge); }
      card.append(usage);
      if (requirement.permissions) { const details = document.createElement('details'); details.className = 'database-permission-details'; details.append(text('summary', t('Current entry permissions')), databasePermissionsView(requirement.permissions)); card.append(details); }
      if (!bound) {
        card.append(text('p', t('This entry needs active authorization from the database host.'), 'database-warning'));
        if (requirement.error) { const details = document.createElement('details'); details.append(text('summary', t('Error details')), text('p', requirement.error, 'database-muted')); card.append(details); }
      }
      const actions = document.createElement('div'); actions.className = 'database-actions';
      if (bound) actions.append(button(t('Browse data'), () => this.browse(requirement), 'database-primary'));
      else actions.append(button(t('Request access'), () => { this.changeView('access'); this.requestForm(requirement); }, 'database-primary'));
      if (state.environmentOverrides?.includes(requirement.alias)) card.append(text('p', t('This database ID is set by the environment. Update the environment to change it.'), 'database-muted database-environment'));
      else actions.append(button(t('Change database'), () => this.bindForm(card, requirement.alias, requirement.databaseId, true)));
      card.append(actions); content.append(card);
    }
  }

  private browse(requirement: Requirement) {
    this.view = 'data'; this.selectedAlias = requirement.alias; this.render();
  }
  private renderData(requirement: Requirement) {
    const content = this.content!;
    const header = document.createElement('div'); header.className = 'database-section-heading';
    header.append(button(t('Back to databases'), () => this.changeView('databases')), text('strong', `${requirement.alias} · ${requirement.space?.name ?? ''}`));
    content.append(header, text('p', t('Changes are shared with every entry using this database.'), 'database-muted'));
    const data = document.createElement('div'); data.className = 'database-data'; content.append(data);
    this.disposeData = mountDatabaseData(data, async (operation, input) => (await this.send({ action: 'data', alias: requirement.alias, operation, input })).data);
  }

  private renderAccess() {
    const state = this.state!, content = this.content!;
    content.append(text('p', t('Hosts approve access for each project and entry. Linking an ID does not grant permissions.'), 'database-muted'));
    const toolbar = document.createElement('div'); toolbar.className = 'database-access-toolbar';
    const label = document.createElement('label'); label.textContent = t('Database host');
    const host = document.createElement('select'); host.setAttribute('aria-label', t('Database host'));
    for (const value of ['local', 'server'] as const) {
      const option = document.createElement('option'); option.value = value; option.textContent = hostName(value); option.disabled = value === 'server' && !state.server; host.append(option);
    }
    if (this.host === 'server' && !state.server) this.host = 'local';
    host.value = this.host; host.onchange = () => { this.host = host.value as DatabaseHost; this.render(); }; label.append(host);
    const scope = document.createElement('select'); scope.setAttribute('aria-label', t('Authorization scope'));
    for (const [value, title] of [['entry', t('Current entry')], ['all', t('All projects')]]) { const option = document.createElement('option'); option.value = value!; option.textContent = title!; scope.append(option); }
    scope.value = this.allProjects ? 'all' : 'entry'; scope.onchange = () => { this.allProjects = scope.value === 'all'; this.render(); };
    toolbar.append(label, scope, button(t('Request database access'), () => this.requestForm(), 'database-primary')); content.append(toolbar);
    const forms = document.createElement('div'); forms.className = 'database-request-form-container'; content.append(forms);
    const catalog = state[this.host]; if (!catalog) return;
    content.append(text('h4', t('Access requests'), 'database-list-title'));
    const visible = (consumer: { projectId: string; entryId: string }) => this.allProjects || consumer.projectId === this.project!.id && consumer.entryId === this.project!.entryId;
    const requests = catalog.requests.filter(visible);
    if (!requests.length) content.append(text('p', t('No access requests for this entry.'), 'database-muted'));
    for (const request of [...requests].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'))) this.renderRequest(request);
    content.append(text('h4', t('Host authorizations'), 'database-list-title'));
    const grants = catalog.grants.filter(visible);
    if (!grants.length) content.append(text('p', t('No host authorizations for this entry.'), 'database-muted'));
    for (const grant of grants) {
      const space = catalog.spaces.find(space => space.spaceId === grant.spaceId);
      const card = this.card(space?.name ?? grant.spaceId, grant.revokedAt ? t('Revoked') : t('Active'), grant.revokedAt ? 'attention' : 'connected');
      const entryName = grant.projectId === this.project!.id ? this.project!.entries.find(entry => entry.entryId === grant.entryId)?.name ?? grant.entryId : grant.entryId;
      card.append(text('p', t('Entry: {0}', entryName), 'database-muted'));
      if (this.allProjects) card.append(text('p', grant.projectId, 'database-muted'));
      card.append(text('code', grant.spaceId, 'database-id'), databasePermissionsView(grant.permissions));
      if (!grant.revokedAt) {
        const controls = document.createElement('details'); controls.className = 'database-grant-controls'; controls.append(text('summary', t('Manage authorization')));
        const actions = document.createElement('div'); actions.className = 'database-actions';
        actions.append(button(t('Narrow permissions'), () => {
          controls.querySelector('.database-form')?.remove(); const form = this.form(t('Narrow permissions'), controls);
          const read = databasePermissionsEditor(form, grant.permissions, t('Approved permissions'), true);
          form.append(text('p', t('Permissions can only be reduced. Request new access to add permissions.'), 'database-muted'));
          this.formActions(form, t('Save permissions'), () => this.run({ action: 'narrow', host: this.host, grantId: grant.grantId, permissions: read() }));
        }));
        for (const action of ['rotate', 'revoke'] as const) actions.append(button(action === 'rotate' ? t('Rotate credentials') : t('Revoke access'), () => {
          const host = this.host, root = this.root;
          void requestAction({ title: action === 'revoke' ? t('Revoke database access?') : t('Rotate database credentials?'), confirm: t('Confirm'), danger: action === 'revoke',
            description: action === 'revoke' ? t('Entry {0} will lose access to this database. Stored data will be kept.', grant.entryId) : t('Existing credentials for entry {0} will become invalid. The host will refresh its authorization.', grant.entryId) })
            .then(result => { if (result !== undefined && this.root === root) this.run({ action, host, grantId: grant.grantId }); });
        }, action === 'revoke' ? 'database-danger' : ''));
        controls.append(actions); card.append(controls);
      }
      content.append(card);
    }
  }

  private requestForm(requirement?: Requirement) {
    if (requirement) {
      const host = requirement.space?.host ?? (this.state?.server?.spaces.some(space => space.spaceId === requirement.databaseId) ? 'server' : 'local');
      if (host !== this.host) { this.host = host; this.render(); }
    }
    if (this.view !== 'access') this.changeView('access');
    const parent = this.content!.querySelector<HTMLElement>('.database-request-form-container')!; parent.replaceChildren();
    const form = this.form(t('Request database access'), parent);
    form.append(text('p', t('Requesting entry: {0}', this.project!.name), 'database-muted'));
    const alias = this.field(form, t('Database alias'), requirement?.alias ?? this.state?.requirements.find(item => item.status !== 'bound')?.alias ?? 'data'); alias.pattern = DATABASE_IDENTIFIER_PATTERN.source;
    const label = document.createElement('label'); label.textContent = t('Request type');
    const target = document.createElement('select'); target.setAttribute('aria-label', t('Request type'));
    for (const [value, name] of [['create', t('Create a database')], ['access', t('Access an existing database')]]) { const option = document.createElement('option'); option.value = value!; option.textContent = name!; target.append(option); }
    target.value = requirement ? 'access' : 'create'; label.append(target); form.append(label);
    const name = this.field(form, t('Database name'), `${this.project!.aggregateName} / ${this.project!.name}`);
    const id = this.field(form, t('Existing database ID'), requirement?.databaseId);
    const update = () => {
      name.parentElement!.hidden = target.value !== 'create'; name.required = target.value === 'create';
      id.parentElement!.hidden = target.value !== 'access'; id.required = target.value === 'access';
    };
    target.onchange = update; update();
    const read = databasePermissionsEditor(form, permissions(), t('Requested permissions'));
    form.append(text('p', this.host === 'local' ? t('This computer’s user reviews the request before a database is created or shared.') : t('The database owner or a Server administrator reviews the request.'), 'database-muted'));
    this.formActions(form, t('Submit request'), () => this.run({ action: 'request', host: this.host, alias: alias.value, permissions: read(),
      target: target.value === 'create' ? { kind: 'create', name: name.value } : { kind: 'access', spaceId: id.value } }, t('Request submitted. Access starts after host approval.')));
    alias.focus();
  }

  private renderRequest(request: DatabaseRequest) {
    const card = this.card(request.target.kind === 'create' ? request.target.name : request.alias,
      request.status === 'pending' ? t('Pending approval') : request.status === 'approved' ? t('Approved') : t('Rejected'), request.status === 'pending' ? 'attention' : request.status === 'approved' ? 'connected' : undefined);
    card.append(text('p', `${request.entryId} · ${request.alias}`, 'database-card-subtitle'));
    if (this.allProjects) card.append(text('p', request.projectId, 'database-muted'));
    if (request.databaseId || request.target.kind === 'access') card.append(text('code', request.databaseId ?? (request.target as { spaceId: string }).spaceId, 'database-id'));
    if (request.reason) card.append(text('p', request.reason, 'database-muted'));
    if (request.status === 'pending') {
      card.append(databasePermissionsView(request.permissions), button(t('Review request'), () => {
        card.querySelector('.database-form')?.remove(); const form = this.form(t('Review request'), card);
        const read = databasePermissionsEditor(form, request.permissions, t('Approved permissions'), true);
        const reason = this.field(form, t('Review reason')); reason.required = false;
        this.formActions(form, t('Approve'), () => this.run({ action: 'review', host: this.host, databaseRequestId: request.requestId, approve: true, permissions: read(), reason: reason.value }));
        const reject = button(t('Reject'), () => this.run({ action: 'review', host: this.host, databaseRequestId: request.requestId, approve: false, reason: reason.value }), 'database-danger'); form.querySelector('.database-actions')!.append(reject);
      }));
    } else if (request.status === 'approved' && request.databaseId && request.projectId === this.project!.id && request.entryId === this.project!.entryId) {
      card.append(button(t('Use this database'), () => { this.changeView('databases'); this.bindForm(this.content!, request.alias, request.databaseId); }, 'database-primary'));
    }
    this.content!.append(card);
  }
}
