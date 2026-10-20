import { t, locale } from './localization';
import { escapeHtml, iconHtml, markdownHtml } from './ui';
import './resources.css';
import { installContextMenu, type ContextAction } from './context-menu';
import { resourceMenuActions, sameResource } from './resource-context';
import type { ResourceDetail, ResourceKind, ResourcePage, ResourceRequest, ResourceRow, ResourceSource } from '../src/workflow-resources-types';

declare function acquireVsCodeApi(): { postMessage(message: object): void; getState(): Record<string, string> | undefined; setState(state: object): void };

const vscode = acquireVsCodeApi();
const kind = document.body.dataset.resourceKind as ResourceKind;
const knowledge = kind === 'knowledge';
const app = document.querySelector<HTMLDivElement>('#resources-app')!;
const saved = vscode.getState() ?? {};
const button = (id: string, icon: string, label: string): string => `<button id="${id}" class="icon-button" type="button" title="${label}" aria-label="${label}">${iconHtml(icon)}</button>`;
app.innerHTML = `<header class="resource-toolbar">
  <div class="select-control project-select"><select id="resource-project" aria-label="${t("Project")}"></select>${iconHtml('chevron-down')}</div>
  <div class="select-control source-select"><select id="resource-source" aria-label="${t("Data source")}"><option value="local">${t("Local")}</option><option value="server">${t("Server")}</option></select>${iconHtml('chevron-down')}</div>
  ${knowledge ? '' : `<div class="select-control scope-select"><select id="resource-scope" aria-label="${t("Scope")}"><option value="">${t("All scopes")}</option><option value="project">${t("Project")}</option><option value="conversation">${t("Session")}</option></select>${iconHtml('chevron-down')}</div>`}
  <div class="resource-search">${iconHtml('search')}<input id="resource-search" type="search" placeholder="${knowledge ? t("Search document content") : t("Search keys or values")}" aria-label="${t("Search")}"></div>
  <span class="toolbar-spacer"></span><div class="resource-toolbar-actions">${button('resource-new', 'add', knowledge ? t("New document") : t("New key"))}${button('resource-refresh', 'refresh', t("Refresh"))}
  <button id="resource-login" type="button" hidden>${t("Sign in")}</button></div>
  </header>
  <div id="resource-error" role="alert" hidden></div>
  <main class="resource-workspace">
    <section class="resource-list-pane" aria-label="${knowledge ? t("Documents") : t("KV list")}">
      <div id="resource-list" role="listbox" aria-label="${knowledge ? t("Document") : 'Key'}"></div>
      <footer><span id="resource-count"></span>${button('resource-previous', 'chevron-left', t("Previous page"))}${button('resource-next', 'chevron-right', t("Next page"))}</footer>
    </section>
    <section id="resource-detail" class="resource-detail-pane" aria-label="${t("Details")}"><div class="resource-empty">${knowledge ? t("Select a document") : t("Select a key")}</div></section>
  </main>
  <dialog id="resource-confirm"><form method="dialog"><p>${t("Discard unsaved changes?")}</p><div><button value="cancel">${t("Cancel")}</button><button value="discard" class="primary">${t("Discard")}</button></div></form></dialog>`;

const projectSelect = document.querySelector<HTMLSelectElement>('#resource-project')!;
const sourceSelect = document.querySelector<HTMLSelectElement>('#resource-source')!;
const search = document.querySelector<HTMLInputElement>('#resource-search')!;
const scopeSelect = document.querySelector<HTMLSelectElement>('#resource-scope');
const list = document.querySelector<HTMLDivElement>('#resource-list')!;
const detail = document.querySelector<HTMLElement>('#resource-detail')!;
const errorBox = document.querySelector<HTMLElement>('#resource-error')!;
const count = document.querySelector<HTMLElement>('#resource-count')!;
const previous = document.querySelector<HTMLButtonElement>('#resource-previous')!;
const next = document.querySelector<HTMLButtonElement>('#resource-next')!;
const newButton = document.querySelector<HTMLButtonElement>('#resource-new')!;
const login = document.querySelector<HTMLButtonElement>('#resource-login')!;
let generation = -1, serial = 0, listEpoch = 0, detailEpoch = 0;
let projectUri = '', source: ResourceSource | undefined;
let rows: ResourceRow[] = [], currentRow: ResourceRow | undefined, currentDetail: ResourceDetail | undefined;
let cursors: (string | undefined)[] = [undefined], pageIndex = 0;
let dirty = false, authenticated = false, saving = false, readOnly = false;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
search.value = saved.query ?? '';
if (scopeSelect) { scopeSelect.value = saved.scope ?? ''; }
newButton.disabled = true;

function persist(): void { vscode.setState({ query: search.value, scope: scopeSelect?.value ?? '', source: source ?? '', projectUri }); }
const dataContext = (): string => JSON.stringify([generation, projectUri, source]);
const contextVersion = (): string => JSON.stringify([generation, projectUri, source, readOnly, authenticated, saving]);
const copyText = (text: string): void => vscode.postMessage({ type: 'copy', generation, projectUri, text });
const contentText = (value: ResourceDetail): string => knowledge ? value.markdown ?? '' : JSON.stringify(value.value, null, 2) ?? '';
installContextMenu(vscode, target => {
  const item = target.closest<HTMLElement>('.resource-row');
  const row = item ? rows.find(row => row.id === item.dataset.id) : target.closest('#resource-detail') ? currentRow : undefined;
  const area = item ? 'row' : target.closest('#resource-detail') ? 'detail' : 'list';
  if ((area !== 'list' && !row) || !target.closest('.resource-workspace')) { return []; }
  const actions = resourceMenuActions({ kind, source, readOnly, authenticated, saving, hasProject: !!projectUri,
    target: area, editing: !!detail.querySelector('#detail-form') });
  return actions.map(id => ({ id, run: async () => {
    const version = contextVersion();
    try {
      if (id === 'refresh') { document.querySelector<HTMLButtonElement>('#resource-refresh')!.click(); }
      else if (id === 'newKey' || id === 'newDocument') { newButton.click(); }
      else if (row) {
        if (id === 'copyKey' || id === 'copyId') { copyText((knowledge ? row.documentId : row.key) ?? row.id); }
        else if (id === 'copyContent') {
          const value = await request<ResourceDetail | null>({ action: 'get', key: row.key, scope: row.scope, conversationId: row.conversationId, documentId: row.documentId });
          if (version === contextVersion() && value) { copyText(contentText(value)); }
        } else if (id === 'delete') { await remove(row); }
        else if (id === 'open' || id === 'edit') {
          if (await canDiscard() && version === contextVersion() && await select(row) && id === 'edit') { renderDetail(true); }
        }
      }
    } catch (failure) { if (version === contextVersion()) { error((failure as Error).message); } }
  } } satisfies ContextAction));
}, contextVersion);
function error(value?: string): void { errorBox.hidden = !value; errorBox.textContent = value ?? ''; }
function request<T>(input: Omit<ResourceRequest, 'kind'>): Promise<T> {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: value => resolve(value as T), reject });
    vscode.postMessage({ type: 'request', id, generation, projectUri, input: { ...input, source, kind } });
  });
}
async function canDiscard(): Promise<boolean> {
  if (!dirty) { return true; }
  const dialog = document.querySelector<HTMLDialogElement>('#resource-confirm')!;
  if (dialog.open) { return false; }
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true }));
}
function clearDetail(): void {
  ++detailEpoch; currentRow = undefined; currentDetail = undefined; dirty = false;
  detail.innerHTML = `<div class="resource-empty">${knowledge ? t("Select a document") : t("Select a key")}</div>`;
  app.classList.remove('show-detail');
  renderRows();
}
function filters(): Pick<ResourceRequest, 'scope' | 'query' | 'cursor'> {
  return { scope: (scopeSelect?.value || undefined) as ResourceRequest['scope'], query: search.value.trim(), cursor: cursors[pageIndex] };
}
async function load(reset = false): Promise<void> {
  if (!projectUri) { return; }
  const epoch = ++listEpoch;
  const version = generation;
  if (reset) { cursors = [undefined]; pageIndex = 0; }
  error(); app.dataset.loading = 'true'; list.setAttribute('aria-busy', 'true');
  previous.disabled = next.disabled = true;
  if (!rows.length) { list.innerHTML = `<div class="resource-empty">${t("Loading")}</div>`; }
  try {
    const page = await request<ResourcePage>({ action: 'list', ...filters() });
    if (epoch !== listEpoch || version !== generation) { return; }
    source = page.source;
    sourceSelect.innerHTML = page.sources.map(value => `<option value="${value}">${value === 'local' ? t("Local") : t("Server")}</option>`).join('');
    sourceSelect.value = source; sourceSelect.disabled = page.sources.length === 1;
    login.hidden = source !== 'server' || authenticated;
    newButton.disabled = !source || source === 'server' && (!knowledge || !authenticated);
    rows = page.items; renderRows();
    count.textContent = `${page.total} ${page.search ? t("matches") : knowledge ? t("documents") : t("items")} \u00b7 ${pageIndex + 1}`;
    previous.disabled = pageIndex === 0; next.disabled = !page.hasMore;
    if (page.nextCursor) { cursors[pageIndex + 1] = page.nextCursor; }
    if (currentRow && !dirty && !saving) {
      const row = rows.find(row => sameResource(kind, row, currentRow));
      if (row) { await select(row); } else { clearDetail(); }
    }
    persist();
  } catch (failure) {
    if (epoch !== listEpoch || version !== generation) { return; }
    const storage = failure as Error & { source?: ResourceSource; sources?: ResourceSource[] };
    if (storage.source) { source = storage.source; }
    if (storage.sources) {
      sourceSelect.innerHTML = storage.sources.map(value => `<option value="${value}">${value === 'local' ? t("Local") : t("Server")}</option>`).join('');
      sourceSelect.value = source ?? ''; sourceSelect.disabled = storage.sources.length === 1;
    }
    error(storage.message); login.hidden = source !== 'server' || authenticated;
    newButton.disabled = !source || source === 'server' && (!knowledge || !authenticated);
    if (!rows.length) { list.innerHTML = `<div class="resource-empty">${t("Unable to load data")}</div>`; }
  } finally { if (epoch === listEpoch) { app.dataset.loading = 'false'; list.setAttribute('aria-busy', 'false'); } }
}
function renderRows(): void {
  list.replaceChildren();
  if (!rows.length) { list.innerHTML = `<div class="resource-empty">${search.value.trim() ? t("No matching results") : knowledge ? t("No documents") : t("No KV data")}</div>`; return; }
  for (const row of rows) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'resource-row'; item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(row.id === currentRow?.id)); item.dataset.id = row.id;
    const subtitle = knowledge ? row.preview : `${row.scope === 'conversation' ? t("Session") : t("Project")}${row.conversationId ? ` \u00b7 ${row.conversationId}` : ''} \u00b7 ${row.valueType ?? ''}`;
    item.innerHTML = `<span class="row-icon">${iconHtml(knowledge ? 'file-text' : 'key')}</span><span class="row-content"><span class="row-title">${escapeHtml(row.title)}</span><span class="row-subtitle">${escapeHtml(subtitle)}</span></span><span class="row-meta">${knowledge && row.lineNumber ? `L${row.lineNumber}` : !knowledge ? `${row.valueSizeBytes ?? 0} B` : ''}</span>`;
    item.title = `${row.title}\n${row.preview}`;
    item.onclick = async () => { if (await canDiscard()) { await select(row); } };
    item.onkeydown = event => {
      const items = Array.from(list.querySelectorAll<HTMLButtonElement>('.resource-row')); const index = items.indexOf(item);
      const target = event.key === 'ArrowDown' ? items[index + 1] : event.key === 'ArrowUp' ? items[index - 1] : undefined;
      if (target) { event.preventDefault(); target.focus(); }
    };
    list.append(item);
  }
}
async function select(row: ResourceRow): Promise<boolean> {
  const epoch = ++detailEpoch, version = generation;
  currentRow = row; currentDetail = undefined; dirty = false; renderRows(); app.classList.add('show-detail');
  detail.innerHTML = `<div class="resource-empty">${t("Loading")}</div>`;
  try {
    const value = await request<ResourceDetail | null>({ action: 'get', key: row.key, scope: row.scope, conversationId: row.conversationId, documentId: row.documentId });
    if (epoch !== detailEpoch || version !== generation) { return false; }
    if (!value) { throw new Error(t("This item no longer exists. Please refresh.")); }
    currentDetail = value; renderDetail(false); return true;
  } catch (failure) { if (epoch === detailEpoch && version === generation) { error((failure as Error).message); } }
  return false;
}
function renderDetail(edit: boolean, create = false): void {
  const value = currentDetail ?? {};
  const title = knowledge ? value.title ?? '' : value.key ?? '';
  const body = knowledge ? value.markdown ?? '' : JSON.stringify(value.value, null, 2) ?? '';
  const writable = !readOnly && (source === 'local' || source === 'server' && authenticated);
  const editable = writable && (knowledge || source === 'local');
  detail.innerHTML = `<header class="detail-toolbar">${button('detail-back', 'arrow-left', t("Back to list"))}<span class="detail-title" title="${escapeHtml(title)}">${escapeHtml(create ? knowledge ? t("New document") : t("New key") : title)}</span><span id="detail-dirty" hidden>${t("Unsaved")}</span><span class="toolbar-spacer"></span>
    ${edit ? button('detail-save', 'save', t("Save")) + button('detail-cancel', 'close', t("Cancel editing")) : editable ? button('detail-edit', 'edit', t("Edit")) : ''}
    ${!edit ? button('detail-copy', 'copy', t("Copy")) + (writable ? button('detail-delete', 'trash', t("Delete")) : '') : ''}</header>
    ${edit ? `<form id="detail-form" class="detail-form"><div class="detail-fields"><label>${knowledge ? t("Title") : 'Key'}<input id="detail-title-input" value="${escapeHtml(title)}" required ${!knowledge && !create ? 'readonly' : ''}></label>
      ${!knowledge ? `<label>${t("Scope")}<span class="select-control"><select id="detail-scope" ${create ? '' : 'disabled'}><option value="project">${t("Project")}</option><option value="conversation">${t("Session")}</option></select>${iconHtml('chevron-down')}</span></label><label id="detail-conversation-label">${t("Session ID")}<input id="detail-conversation" value="${escapeHtml(value.conversationId ?? '')}" ${create ? '' : 'readonly'}></label>` : ''}</div>
      <textarea id="detail-body" spellcheck="false" aria-label="${knowledge ? 'Markdown' : 'JSON'}">${escapeHtml(body)}</textarea></form>`
    : `<div class="detail-metadata">${knowledge ? escapeHtml(value.id ?? '') : escapeHtml(`${value.scope === 'conversation' ? t("Session") : t("Project")}${value.conversationId ? ` \u00b7 ${value.conversationId}` : ''}`)}${value.updatedAt ? ` \u00b7 ${escapeHtml(new Date(value.updatedAt).toLocaleString(locale()))}` : ''}</div><div class="detail-content">${knowledge ? `<article class="markdown-body">${markdownHtml(body)}</article>` : `<pre>${escapeHtml(body)}</pre>`}</div>`}`;
  document.querySelector<HTMLButtonElement>('#detail-back')!.onclick = async () => { if (await canDiscard()) { clearDetail(); } };
  if (edit) {
    const form = document.querySelector<HTMLFormElement>('#detail-form')!;
    form.oninput = () => { dirty = true; document.querySelector<HTMLElement>('#detail-dirty')!.hidden = false; };
    form.onsubmit = event => { event.preventDefault(); void save(create); };
    const scope = document.querySelector<HTMLSelectElement>('#detail-scope');
    if (scope) {
      scope.value = value.scope ?? (scopeSelect?.value || 'project');
      const update = (): void => { document.querySelector<HTMLElement>('#detail-conversation-label')!.hidden = scope.value !== 'conversation'; };
      scope.onchange = update; update();
    }
    document.querySelector<HTMLButtonElement>('#detail-save')!.onclick = () => { if (form.reportValidity()) { void save(create); } };
    document.querySelector<HTMLButtonElement>('#detail-cancel')!.onclick = async () => { if (await canDiscard()) { dirty = false; if (create) { clearDetail(); } else { renderDetail(false); } } };
    document.querySelector<HTMLTextAreaElement>('#detail-body')!.onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); if (form.reportValidity()) { void save(create); } } };
    document.querySelector<HTMLInputElement>('#detail-title-input')!.focus();
  } else {
    const editButton = document.querySelector<HTMLButtonElement>('#detail-edit');
    if (editButton) { editButton.onclick = () => renderDetail(true); }
    document.querySelector<HTMLButtonElement>('#detail-copy')!.onclick = () => vscode.postMessage({ type: 'copy', generation, projectUri, text: body });
    const deleteButton = document.querySelector<HTMLButtonElement>('#detail-delete');
    if (deleteButton) { deleteButton.onclick = () => void remove(); }
  }
}
async function save(create: boolean): Promise<void> {
  if (saving) { return; }
  const version = generation, context = dataContext();
  const title = document.querySelector<HTMLInputElement>('#detail-title-input')!.value.trim();
  const body = document.querySelector<HTMLTextAreaElement>('#detail-body')!.value;
  const scope = document.querySelector<HTMLSelectElement>('#detail-scope')?.value as ResourceRequest['scope'];
  const conversationId = document.querySelector<HTMLInputElement>('#detail-conversation')?.value.trim();
  try {
    let value: unknown;
    if (!knowledge) { try { value = JSON.parse(body); } catch { throw new Error(t("Enter valid JSON.")); } }
    if (!knowledge && scope === 'conversation' && !conversationId) { throw new Error(t("Please enter a session ID.")); }
    saving = true; document.querySelector<HTMLButtonElement>('#detail-save')!.disabled = true;
    const result = await request<ResourceDetail>({ action: 'save', create, title, markdown: body, key: title, value, scope, conversationId, documentId: currentDetail?.id });
    if (context !== dataContext()) { return; }
    dirty = false; currentDetail = result;
    currentRow = knowledge ? { id: result.id!, documentId: result.id!, title: result.title!, preview: '' }
      : { id: JSON.stringify([result.scope, result.conversationId ?? '', result.key]), key: result.key, scope: result.scope, conversationId: result.conversationId, title, preview: '' };
    renderDetail(false); error(); await load(true);
  } catch (failure) { if (context === dataContext()) { error((failure as Error).message); } }
  finally { if (version === generation) { saving = false; const saveButton = document.querySelector<HTMLButtonElement>('#detail-save'); if (saveButton) { saveButton.disabled = false; } } }
}
async function remove(row = currentRow): Promise<void> {
  if (!row || saving || readOnly || source === 'server' && !authenticated) { return; }
  const context = contextVersion();
  if ((sameResource(kind, row, currentRow) && !await canDiscard()) || context !== contextVersion()) { return; }
  const version = generation, dataVersion = dataContext();
  try {
    saving = true;
    const result = await request<{ cancelled?: boolean }>({ action: 'delete', key: row.key, scope: row.scope, conversationId: row.conversationId, documentId: row.documentId, title: row.title });
    if (dataVersion !== dataContext() || result.cancelled) { return; }
    if (sameResource(kind, row, currentRow)) { clearDetail(); }
    await load(true);
  } catch (failure) { if (dataVersion === dataContext()) { error((failure as Error).message); } }
  finally { if (version === generation) { saving = false; } }
}

document.querySelector<HTMLButtonElement>('#resource-refresh')!.onclick = async () => {
  const context = contextVersion();
  if (!saving && await canDiscard() && context === contextVersion()) { dirty = false; await load(); }
};
newButton.onclick = async () => {
  const context = contextVersion();
  if (projectUri && source && !saving && !readOnly && !newButton.disabled && await canDiscard() && context === contextVersion()) {
    clearDetail(); currentDetail = {}; app.classList.add('show-detail'); renderDetail(true, true);
  }
};
login.onclick = () => vscode.postMessage({ type: 'login' });
projectSelect.onchange = async () => {
  if (await canDiscard()) { vscode.postMessage({ type: 'select', projectUri: projectSelect.value }); } else { projectSelect.value = projectUri; }
};
sourceSelect.onchange = async () => {
  if (await canDiscard()) { source = sourceSelect.value as ResourceSource; rows = []; clearDetail(); await load(true); } else { sourceSelect.value = source ?? ''; }
};
if (scopeSelect) { scopeSelect.onchange = async () => { if (await canDiscard()) { clearDetail(); await load(true); } }; }
let searchTimer: number | undefined;
search.oninput = () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => { if (await canDiscard()) { clearDetail(); await load(true); } }, 250);
};
previous.onclick = async () => { if (pageIndex > 0 && await canDiscard()) { --pageIndex; rows = []; clearDetail(); await load(); } };
next.onclick = async () => { if (await canDiscard()) { ++pageIndex; rows = []; clearDetail(); await load(); } };
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'resources-result') {
    if (message.generation !== generation) { return; }
    const task = pending.get(message.id); if (!task) { return; } pending.delete(message.id);
    if (message.error) { task.reject(Object.assign(new Error(message.error), { source: message.source, sources: message.sources })); } else { task.resolve(message.value); }
  }
  if (message.type === 'resources-state') {
    projectSelect.innerHTML = message.projects.map((project: { uri: string; name: string; version?: string; folderPath: string }) => `<option value="${escapeHtml(project.uri)}" title="${escapeHtml(project.folderPath)}">${escapeHtml([project.name, project.version].filter(Boolean).join(' \u00b7 '))}</option>`).join('');
    projectSelect.value = message.selected ?? ''; authenticated = message.authenticated; readOnly = message.readOnly === true;
    newButton.hidden = readOnly;
    if (generation === message.generation) { return; }
    for (const task of pending.values()) { task.reject(new Error('Project data context changed.')); } pending.clear();
    const changed = projectUri !== message.selected;
    projectUri = message.selected ?? ''; generation = message.generation; saving = false; newButton.disabled = true;
    app.dataset.projectUri = projectUri; rows = []; cursors = [undefined]; pageIndex = 0; ++listEpoch; clearDetail(); error();
    if (changed) { source = saved.projectUri === projectUri ? saved.source as ResourceSource || undefined : undefined; }
    if (message.source) { source = message.source; }
    const focus = message.focus;
    if (focus) { source = focus.source; search.value = ''; if (scopeSelect) { scopeSelect.value = focus.scope ?? ''; } }
    if (projectUri) {
      const version = generation;
      void load(true).then(async () => {
        if (version === generation && focus && (focus.documentId || focus.key)) {
          await select({ id: focus.documentId ?? focus.key, documentId: focus.documentId, key: focus.key, scope: focus.scope,
            conversationId: focus.conversationId, title: focus.documentId ?? focus.key, preview: '' });
        }
      });
    }
    else { list.innerHTML = `<div class="resource-empty">${t("No Workflow project detected")}</div>`; count.textContent = ''; }
  }
});
vscode.postMessage({ type: 'ready' });
