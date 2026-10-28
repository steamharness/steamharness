import { t } from '../localization';
import { mountEntryWindows } from './entry-windows';
import './aggregate.css';
import { mountDatabaseData } from './database-data';
import { requestAction } from './action-dialog';
type Host = { postMessage(message: Record<string, any>): unknown };
/** All entry types share this project-level navigation and host database UI. */
export function mountAggregateToolbar(host: Host) {
  const title = document.querySelector('.toolbar-actions') ?? document.querySelector('.toolbar');
  const navigation = document.createElement('div'); navigation.className = 'aggregate-navigation';
  navigation.innerHTML = `<button class="aggregate-databases" type="button">${t('Databases')}</button>`;
  if (title) { title.prepend(navigation); mountEntryWindows(navigation); }
  const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog database-dialog';
  dialog.setAttribute('aria-label', t('Databases'));
  dialog.innerHTML = `<header><h2>${t('Databases')}</h2><button type="button" aria-label="${t('Close')}">×</button></header><div class="dialog-body"><p class="database-error" role="alert"></p><div class="database-content"></div><button class="database-refresh" type="button">${t('Check again')}</button></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector<HTMLElement>('.database-content')!, error = dialog.querySelector<HTMLElement>('.database-error')!;
  let project: any, pending: string | undefined;
  let receiveData: ((value: any) => void) | undefined;
  const setBusy = (busy: boolean) => {
    if (busy) dialog.setAttribute('aria-busy', 'true'); else dialog.removeAttribute('aria-busy');
    for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('.dialog-body button, .dialog-body input, .dialog-body select, .dialog-body textarea')) {
      if (busy) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; }
      else { control.disabled = control.dataset.wasDisabled === 'true'; delete control.dataset.wasDisabled; }
    }
  };
  const send = (value: Record<string, any>) => { if (pending) return; pending = crypto.randomUUID(); error.textContent = ''; setBusy(true); void host.postMessage({ type: 'databases', requestId: pending, ...value }); };
  const openDatabases = () => { if (!dialog.open) dialog.showModal(); send({ action: 'get' }); };
  navigation.querySelector<HTMLButtonElement>('.aggregate-databases')!.onclick = openDatabases;
  dialog.querySelector('header button')!.addEventListener('click', () => dialog.close());
  dialog.querySelector<HTMLButtonElement>('.database-refresh')!.onclick = () => send({ action: 'get' });
  const button = (label: string, action: () => void) => { const result = document.createElement('button'); result.type = 'button'; result.textContent = label; result.onclick = action; return result; };
  const input = (placeholder: string, value = '') => { const result = document.createElement('input'); result.placeholder = placeholder; result.setAttribute('aria-label', placeholder); result.value = value; return result; };
  const row = (title: string) => { const result = document.createElement('section'); result.className = 'database-row'; const heading = document.createElement('strong'); heading.textContent = title; result.append(heading); content.append(result); return result; };
  const render = (state: any) => {
    content.replaceChildren();
    if (state.serverError) error.textContent = state.serverError;
    const shared = document.createElement('p');
    shared.textContent = t('Changing an alias updates every entry that uses it.');
    content.append(shared);
    for (const requirement of state.requirements) {
      const section = row(`${requirement.alias} · ${t(requirement.status)}`);
      const databaseId = input(t('Database ID'), requirement.databaseId);
      section.append(databaseId, button(t('Save database reference'), () => send({ action: 'bind', alias: requirement.alias, databaseId: databaseId.value })));
      if (state.environmentOverrides?.includes(requirement.alias)) {
        const detail = document.createElement('p'); detail.textContent = t('This database ID is set by the environment. Update the environment to change it.'); section.append(detail);
        for (const control of section.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) control.disabled = true;
      }
      if (requirement.error) { const detail = document.createElement('p'); detail.textContent = requirement.error; section.append(detail); }
      if (requirement.status === 'bound') {
        section.append(document.createTextNode(`${requirement.space.host} · ${requirement.space.name}`));
        const tools = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = t('Manage data'); tools.append(summary);
        const data = document.createElement('div'); data.className = 'database-data'; tools.append(data); section.append(tools);
        mountDatabaseData(data, (operation, input, receive) => { if (pending) return; receiveData = receive; send({ action: 'data', alias: requirement.alias, operation, input }); });
      }
    }
    const reference = row(t('Add database reference'));
    const alias = input(t('Database alias')), databaseId = input(t('Database ID'));
    reference.append(alias, databaseId, button(t('Save database reference'), () => send({ action: 'bind', alias: alias.value, databaseId: databaseId.value })));
    for (const host of ['local', 'server']) {
      const catalog = state[host]; if (!catalog) continue;
      const application = row(`${host} · ${t('Request database access')}`);
      const requestAlias = input(t('Database alias'), 'data'), name = input(t('New space name'), `${project.aggregateName} / ${project.name}`), space = input(t('Existing space ID'));
      const requestedPermissions = document.createElement('textarea'); requestedPermissions.setAttribute('aria-label', t('Requested permissions'));
      const all = { mode: 'all' }; requestedPermissions.value = JSON.stringify({ kv: { read: all, write: all }, knowledge: { read: all, write: all } }, null, 2);
      const request = (target: Record<string, string>) => { try { send({ action: 'request', host, alias: requestAlias.value, permissions: JSON.parse(requestedPermissions.value), target }); } catch (failure) { error.textContent = String(failure); } };
      application.append(requestAlias, requestedPermissions, name, button(t('Request new space'), () => request({ kind: 'create', name: name.value })), space, button(t('Request shared access'), () => request({ kind: 'access', spaceId: space.value })));
      for (const request of catalog.requests) {
        const section = row(`${host} · ${request.entryId}/${request.alias} · ${t(request.status === 'pending' ? 'Pending approval' : request.status)}`);
        const detail = document.createElement('p'); detail.textContent = `${request.projectId} · ${request.databaseId ?? request.target.name ?? request.target.spaceId}${request.reason ? ' · ' + request.reason : ''}`; section.append(detail);
        if (request.status !== 'pending') continue;
        const permissions = document.createElement('textarea'); permissions.setAttribute('aria-label', t('Approved permissions')); permissions.value = JSON.stringify(request.permissions, null, 2); section.append(permissions);
        const reason = input(t('Review reason'));
        section.append(reason, button(t('Approve'), () => { try { send({ action: 'review', host, databaseRequestId: request.requestId, approve: true, permissions: JSON.parse(permissions.value), reason: reason.value }); } catch (failure) { error.textContent = String(failure); } }), button(t('Reject'), () => send({ action: 'review', host, databaseRequestId: request.requestId, approve: false, reason: reason.value })));
      }
      for (const space of catalog.spaces) {
        const section = row(`${host} · ${space.name}`); const id = document.createElement('code'); id.textContent = space.spaceId; section.append(id);
        for (const grant of catalog.grants.filter((item: any) => item.spaceId === space.spaceId)) {
          const detail = document.createElement('p'); detail.textContent = `${grant.projectId} / ${grant.entryId} · ${t(grant.revokedAt ? 'revoked' : 'active')}`; section.append(detail);
          if (!grant.revokedAt) {
            for (const action of ['revoke', 'rotate']) section.append(button(t(action === 'revoke' ? 'Revoke' : 'Rotate credentials'), () => {
              void requestAction({ title: t(action === 'revoke' ? 'Revoke database access?' : 'Rotate database credentials?'), description: `${grant.projectId} / ${grant.entryId}`, confirm: t('Confirm'), danger: action === 'revoke' }).then(result => { if (result !== undefined) send({ action, host, grantId: grant.grantId }); });
            }));
            const permissions = document.createElement('textarea'); permissions.setAttribute('aria-label', t('Approved permissions')); permissions.value = JSON.stringify(grant.permissions, null, 2);
            section.append(permissions, button(t('Narrow permissions'), () => { try { send({ action: 'narrow', host, grantId: grant.grantId, permissions: JSON.parse(permissions.value) }); } catch (failure) { error.textContent = String(failure); } }));
          }
        }
      }
    }
  };
  addEventListener('message', event => {
    if (event.source !== null && event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === 'state' && message.project) project = message.project;
    if (!pending || message?.requestId !== pending) return;
    if (message.type === 'databases-result') {
      pending = undefined; setBusy(false);
      const receive = receiveData; receiveData = undefined;
      if (receive) { try { receive(message.value.data); } catch (failure) { error.textContent = String(failure); } }
      else render(message.value);
    }
    else if (message.type === 'error') { pending = undefined; receiveData = undefined; setBusy(false); error.textContent = message.message; }
  });
  return { openDatabases };
}
