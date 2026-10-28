import { t } from '../localization';
import { escapeHtml } from './ui';
import './aggregate.css';
import { mountDatabaseData } from './database-data';
import { requestAction } from './action-dialog';
type Host = { postMessage(message: Record<string, any>): unknown };
/** All entry types share this project-level navigation and host database UI. */
export function mountAggregateToolbar(host: Host) {
  const title = document.querySelector('.project-title') ?? document.querySelector('.toolbar');
  const navigation = document.createElement('div'); navigation.className = 'aggregate-navigation';
  navigation.innerHTML = `<span class="aggregate-name"></span><select aria-label="${t('Project window')}"></select><button type="button">${t('Databases')}</button>`;
  title?.append(navigation);
  const select = navigation.querySelector('select')!, name = navigation.querySelector('span')!;
  const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog database-dialog';
  dialog.setAttribute('aria-label', t('Databases'));
  dialog.innerHTML = `<header><h2>${t('Databases')}</h2><button type="button" aria-label="${t('Close')}">×</button></header><div class="dialog-body"><p class="database-error" role="alert"></p><div class="database-content"></div><button class="database-refresh" type="button">${t('Check again')}</button></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector<HTMLElement>('.database-content')!, error = dialog.querySelector<HTMLElement>('.database-error')!;
  let project: any, aggregate: any, pending: string | undefined;
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
  navigation.querySelector('button')!.onclick = openDatabases;
  dialog.querySelector('header button')!.addEventListener('click', () => dialog.close());
  dialog.querySelector<HTMLButtonElement>('.database-refresh')!.onclick = () => send({ action: 'get' });
  select.onchange = () => {
    const entry = aggregate?.entries.find((entry: any) => entry.entryId === select.value); if (!entry) return;
    if (window.parent !== window) window.parent.postMessage({ type: 'workflow-open-entry', version: 1, projectId: project.id, entryId: entry.entryId }, '*');
    else location.assign(entry.href);
  };
  const button = (label: string, action: () => void) => { const result = document.createElement('button'); result.type = 'button'; result.textContent = label; result.onclick = action; return result; };
  const input = (placeholder: string, value = '') => { const result = document.createElement('input'); result.placeholder = placeholder; result.setAttribute('aria-label', placeholder); result.value = value; return result; };
  const row = (title: string) => { const result = document.createElement('section'); result.className = 'database-row'; const heading = document.createElement('strong'); heading.textContent = title; result.append(heading); content.append(result); return result; };
  const render = (state: any) => {
    content.replaceChildren();
    if (state.serverError) error.textContent = state.serverError;
    for (const requirement of state.requirements) {
      const section = row(`${requirement.alias} · ${requirement.host} · ${t(requirement.status)}`);
      if (requirement.error) { const detail = document.createElement('p'); detail.textContent = requirement.error; section.append(detail); }
      const catalog = state[requirement.host];
      const request = catalog?.requests.find((item: any) => item.projectId === state.projectId && item.entryId === state.entryId && item.alias === requirement.alias && item.status === 'pending');
      if (request) { section.append(document.createTextNode(t('Pending approval'))); continue; }
      if (requirement.status !== 'bound') {
        const approved = catalog?.bindings.filter((item: any) => item.projectId === state.projectId && item.entryId === state.entryId && item.alias === requirement.alias && !catalog.grants.find((grant: any) => grant.grantId === item.grantId)?.revokedAt) ?? [];
        for (const binding of approved) section.append(button(t('Bind approved space'), () => send({ action: 'bind', host: requirement.host, alias: requirement.alias, bindingRef: binding.bindingRef })));
        const name = input(t('New space name'), `${project.aggregateName} / ${project.name}`);
        section.append(name, button(t('Request new space'), () => send({ action: 'request', host: requirement.host, alias: requirement.alias, target: { kind: 'create', name: name.value } })));
        const space = input(t('Existing space ID'));
        section.append(space, button(t('Request shared access'), () => send({ action: 'request', host: requirement.host, alias: requirement.alias, target: { kind: 'access', spaceId: space.value } })));
      } else {
        section.append(document.createTextNode(requirement.space.name));
        const tools = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = t('Manage data'); tools.append(summary);
        const data = document.createElement('div'); data.className = 'database-data'; tools.append(data); section.append(tools);
        mountDatabaseData(data, (operation, input, receive) => { if (pending) return; receiveData = receive; send({ action: 'data', alias: requirement.alias, operation, input }); });
      }
    }
    for (const host of ['local', 'server']) {
      const catalog = state[host]; if (!catalog) continue;
      for (const request of catalog.requests) {
        const section = row(`${host} · ${request.entryId}/${request.alias} · ${t(request.status)}`);
        const detail = document.createElement('p'); detail.textContent = `${request.projectId} · ${request.target.name ?? request.target.spaceId}${request.reason ? ' · ' + request.reason : ''}`; section.append(detail);
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
    if (message?.type === 'state' && message.aggregate) {
      aggregate = message.aggregate; name.textContent = aggregate.name;
      const signature = JSON.stringify(aggregate.entries);
      if (select.dataset.signature !== signature) { select.innerHTML = aggregate.entries.map((entry: any) => `<option value="${escapeHtml(entry.entryId)}">${escapeHtml(entry.name)} · ${escapeHtml(entry.type)} · ${escapeHtml(t(entry.status))}</option>`).join(''); select.dataset.signature = signature; }
      select.value = project.entryId;
    }
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
