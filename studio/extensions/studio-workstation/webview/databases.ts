import { t } from './localization';
import { escapeHtml, iconHtml } from './ui';
import './databases.css';
declare function acquireVsCodeApi(): { postMessage(message: object): void; getState(): any; setState(state: object): void };
const vscode = acquireVsCodeApi(), saved = vscode.getState() ?? {};
const app = document.querySelector<HTMLElement>('#databases-app')!;
app.innerHTML = `<header><strong>${t('Databases')}</strong><div class="database-actions"><button id="manage" class="manage-button">${t('Manage resources in Server')}</button><button id="refresh" class="icon-button" aria-label="${t('Refresh')}">${iconHtml('refresh')}</button></div></header><div class="database-filters"><label class="select-control"><select id="filter" aria-label="${t('Resource type')}"><option value="all">${t('All resources')}</option><option value="databases">${t('Relational databases')}</option><option value="knowledge-bases">${t('Knowledge bases')}</option><option value="project">${t('Used by this project')}</option></select>${iconHtml('chevron-down')}</label><label class="database-search">${iconHtml('search')}<input id="search" type="search" aria-label="${t('Search databases')}" placeholder="${t('Search databases')}"></label></div><p class="database-context">${t('Models, table data and account access are managed by Server.')}</p><div id="status" role="status"></div><div id="error" role="alert"></div><button id="login" hidden>${t('Sign in')}</button><nav id="database-list" aria-label="${t('Databases')}"></nav>`;
const filter = document.querySelector<HTMLSelectElement>('#filter')!, search = document.querySelector<HTMLInputElement>('#search')!, list = document.querySelector<HTMLElement>('#database-list')!;
filter.value = ['all', 'databases', 'knowledge-bases', 'project'].includes(saved.filter) ? saved.filter : 'all'; search.value = saved.search ?? '';
let state: any;
function render() {
  if (!state) return;
  document.querySelector('#error')!.textContent = state.error ?? '';
  document.querySelector<HTMLButtonElement>('#login')!.hidden = state.authenticated;
  document.querySelector<HTMLButtonElement>('#refresh')!.disabled = state.loading;
  const rows = state.databases.filter((row: any) => (filter.value === 'all' || filter.value === row.kind || filter.value === 'project' && row.usage.length) && `${row.name} ${row.id}`.toLowerCase().includes(search.value.trim().toLowerCase()));
  document.querySelector('#status')!.textContent = state.loading ? t('Loading') : t('{0} databases', rows.length);
  list.replaceChildren();
  for (const row of rows) {
    const button = document.createElement('button'); button.className = 'database-child'; button.type = 'button';
    button.innerHTML = `${iconHtml(row.kind === 'knowledge-bases' ? 'book' : 'database')}<span>${escapeHtml(row.name)}</span><code>${escapeHtml(row.id)}</code>`;
    button.onclick = () => vscode.postMessage({ type: 'open', key: row.key }); list.append(button);
  }
  if (!rows.length && !state.loading && !state.error) list.textContent = t('No matching databases.');
}
for (const id of ['manage', 'refresh', 'login']) document.querySelector<HTMLButtonElement>(`#${id}`)!.onclick = () => vscode.postMessage({ type: id });
for (const control of [filter, search]) control.oninput = () => { vscode.setState({ filter: filter.value, search: search.value }); render(); };
addEventListener('message', event => { if (event.data?.type === 'databases-state') { state = event.data; render(); } });
vscode.postMessage({ type: 'ready' });
