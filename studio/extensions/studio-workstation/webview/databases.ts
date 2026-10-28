import { t } from './localization';
import { escapeHtml, iconHtml } from './ui';
import './databases.css';
declare function acquireVsCodeApi(): { postMessage(message: object): void; getState(): any; setState(state: object): void };
const vscode = acquireVsCodeApi(), saved = vscode.getState() ?? {};
const app = document.querySelector<HTMLElement>('#databases-app')!;
const iconButton = (id: string, icon: string, label: string) => `<button id="${id}" class="icon-button" type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${iconHtml(icon)}</button>`;
app.innerHTML = `<header><strong>${t('Databases')}</strong><div class="database-actions">${iconButton('database-request', 'add', t('Request database'))}${iconButton('database-review', 'checklist', t('Database approvals'))}${iconButton('database-grants', 'shield', t('Database permissions'))}${iconButton('database-refresh', 'refresh', t('Refresh'))}</div></header>
  <div class="database-filters"><label class="select-control"><select id="database-filter" aria-label="${t('Database filter')}"><option value="project">${t('Used by this project')}</option><option value="local">${t('Local databases')}</option><option value="server">${t('Server databases')}</option><option value="all">${t('All databases')}</option></select>${iconHtml('chevron-down')}</label>
  <div class="database-search">${iconHtml('search')}<input id="database-search" type="search" placeholder="${t('Search databases')}" aria-label="${t('Search databases')}"></div></div>
  <div id="database-project" class="database-context"></div><div id="database-status" role="status"></div><div id="database-error" role="alert" hidden></div>
  <button id="database-login" hidden>${t('Sign in')}</button><nav id="database-list" aria-label="${t('Databases')}"></nav>`;
const filter = document.querySelector<HTMLSelectElement>('#database-filter')!, query = document.querySelector<HTMLInputElement>('#database-search')!;
const list = document.querySelector<HTMLElement>('#database-list')!, error = document.querySelector<HTMLElement>('#database-error')!, status = document.querySelector<HTMLElement>('#database-status')!;
let state: any, selected = saved.selected ?? '';
filter.value = ['project', 'local', 'server', 'all'].includes(saved.filter) ? saved.filter : 'project'; query.value = saved.query ?? '';
const persist = () => vscode.setState({ filter: filter.value, query: query.value, selected });
function render() {
  if (!state) return;
  const search = query.value.trim().toLowerCase();
  const databases = state.databases.filter((database: any) => (filter.value === 'project' ? database.usage.length : filter.value === 'all' || database.host === filter.value) && (!search || [database.name, database.spaceId, ...database.usage.map((item: any) => item.alias)].join(' ').toLowerCase().includes(search)));
  list.setAttribute('aria-busy', String(state.loading));
  status.textContent = state.loading ? t('Loading') : t('{0} databases', databases.length);
  error.textContent = state.error || (filter.value !== 'local' ? state.serverError : '') || ''; error.hidden = !error.textContent;
  document.querySelector<HTMLElement>('#database-project')!.textContent = filter.value === 'project' ? state.project ?? t('No project selected') : '';
  document.querySelector<HTMLElement>('#database-login')!.hidden = state.authenticated || !['server', 'all'].includes(filter.value);
  for (const id of ['database-request', 'database-review', 'database-grants', 'database-refresh']) document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = state.loading;
  const expanded = new Set([...list.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.dataset.key));
  list.replaceChildren();
  if (!databases.length && !state.loading && !error.textContent) { list.innerHTML = `<div class="database-empty">${filter.value === 'project' ? t('This project has no linked databases.') : t('No matching databases.')}</div>`; return; }
  for (const database of databases) {
    const group = document.createElement('details'); group.className = 'database-tree'; group.dataset.key = database.key; group.open = expanded.has(database.key) || database.key === selected;
    const open = (kind: string) => { selected = database.key; persist(); vscode.postMessage({ type: 'open', key: database.key, kind, filter: filter.value }); };
    group.innerHTML = `<summary>${iconHtml('chevron-right')}<button class="database-title" type="button" title="${escapeHtml(database.spaceId)}" ${database.available ? '' : 'disabled'}>${iconHtml(database.host === 'server' ? 'cloud' : 'database')}<span>${escapeHtml(database.name)}</span></button><span class="database-host">${database.available ? database.host === 'server' ? t('Server') : t('Local') : t('Unavailable')}</span></summary>
      <div class="database-id">${escapeHtml(database.spaceId)}</div>${database.usage.length ? `<div class="database-usage">${escapeHtml([...new Set(database.usage.map((item: any) => `${item.name} / ${item.alias}`))].join(' · '))}</div>` : ''}
      <button class="database-child" data-kind="kv" type="button" ${database.available ? '' : 'disabled'}>${iconHtml('key')}<span>KV</span>${iconHtml('go-to-file')}</button>
      <button class="database-child" data-kind="knowledge" type="button" ${database.available ? '' : 'disabled'}>${iconHtml('book')}<span>${t('Knowledge base')}</span>${iconHtml('go-to-file')}</button>`;
    group.querySelector<HTMLButtonElement>('.database-title')!.onclick = event => { event.preventDefault(); group.open = true; open('kv'); };
    for (const child of group.querySelectorAll<HTMLButtonElement>('.database-child')) child.onclick = () => open(child.dataset.kind!);
    list.append(group);
  }
}
filter.onchange = () => { persist(); render(); };
query.oninput = () => { persist(); render(); };
for (const action of ['request', 'review', 'grants', 'refresh', 'login']) document.querySelector<HTMLButtonElement>(`#database-${action}`)!.onclick = () => vscode.postMessage({ type: action });
addEventListener('message', event => { if (event.data?.type === 'databases-state') { state = event.data; render(); } });
vscode.postMessage({ type: 'ready' });
