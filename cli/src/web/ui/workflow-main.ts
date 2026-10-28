import { mountAggregateToolbar } from './aggregate';
import { mountProjectConfigurations, projectConfigurationsButton } from './project-configurations';
import { t, locale } from '../localization';
import './style.css';
import './workflow-style.css';
import { acquireProjectHost } from './host';
import { requestAction } from './action-dialog';
import { Fields } from './workflow-fields';
import { ConversationOutput } from './conversation-output';
import { InputPrompt } from './input-prompt';
import { ConversationTools } from './conversation-tools';
import { updateProjectAvatar } from './avatar';
import { iconHtml, iconButton, escapeHtml } from './ui';
import { runStatusLabels as statusLabels, workflowHistoryStatus, updateHistoryStatus, updateRunningCount } from './history-status';
import { aiUsageButton, narrowMenuDismiss, projectInfoButton, toolPermissionsButton } from './toolbar';
import { projectParameters, projectParamValue, type Project, type ParamState, type ParamValues, type Attachment } from '../workflow-types';
import type { Draft, RunRecord } from '../workflow-workspace';
import type { AccountState } from '../workflow-auth-client';
import { layoutProjectGraph } from '../workflow-graph';
import type { ProjectServerState } from '../project-server-state';
import { ProjectServerGuidance } from './project-server-guidance';
import { StateRevisions } from './state-revisions';

interface State {
  project: Project;
  runs: Pick<RunRecord, 'id' | 'title' | 'status' | 'createdAt' | 'entrypointId'>[];
  run?: RunRecord;
  occupiedRun?: RunRecord;
  occupiedId?: string;
  drafts: Record<string, Draft>;
  history: { total: number; hasMore: boolean; query: string };
  running: boolean;
  runningCount?: number;
  account: AccountState;
  authenticationRevision: number;
  serverData?: ProjectServerState;
}
const app = document.querySelector<HTMLElement>('#app')!;
const host = acquireProjectHost();
app.classList.add('workflow-app');
app.innerHTML = `
  <header class="toolbar"><div class="project-title"><button id="menu-toggle" class="icon-button" aria-label="${t("Show runs")}" title="${t("Show runs")}">${iconHtml('layout-sidebar-left')}</button><h1 id="workflow-title">Workflow</h1></div><div class="toolbar-actions"><span id="running-count" class="running-count" hidden></span>${projectConfigurationsButton()}${aiUsageButton()}${toolPermissionsButton()}${projectInfoButton()}</div></header>
  <aside id="project-menu" class="project-menu" aria-label="${t("Runs")}"><div class="menu-heading"><span>${t("Runs")}</span><div class="menu-actions"><button id="history-toggle" class="icon-button" aria-label="${t("Search runs")}" title="${t("Search runs")}">${iconHtml('search')}</button><button id="new" class="icon-button" aria-label="${t("New run")}" title="${t("New run")}">${iconHtml('add')}</button><button id="hide-menu" class="icon-button" aria-label="${t("Hide runs")}" title="${t("Hide runs")}">${iconHtml('chevron-left')}</button></div></div><section id="run-history"><nav id="run-list"></nav><div id="empty-history" class="no-history">${t("No runs")}</div><button id="load-more-history" class="all-history" hidden>${iconHtml('chevron-down')}<span>${t("Load more")}</span></button></section></aside>
  <main><section id="server-guidance" class="project-server-guidance" aria-labelledby="server-guidance-title" role="region" aria-live="polite" hidden></section><div id="error" class="error" role="alert" hidden></div><div id="active-run" class="workflow-active" hidden><button id="show-active" class="workflow-active-link"></button><button id="stop-active" class="icon-button" title="${t("Stop run")}" aria-label="${t("Stop run")}">${iconHtml('debug-stop')}</button></div>
    <div id="workspace-scroll" class="workspace-scroll"><section id="entrypoints" class="workflow-entrypoints" aria-label="${t("Workflow entrypoint")}"></section>
      <section id="run-detail" class="workflow-run" hidden><header class="run-heading"><div><h2 id="run-title"></h2><div id="run-meta"></div></div><div class="run-heading-actions"><button id="rerun" class="icon-button" title="${t("Rerun")}" aria-label="${t("Rerun")}">${iconHtml('debug-restart')}</button><button id="export-run" class="icon-button" title="${t("Export record")}" aria-label="${t("Export record")}">${iconHtml('export')}</button><button id="delete-run" class="icon-button" title="${t("Delete record")}" aria-label="${t("Delete record")}">${iconHtml('trash')}</button></div></header>
      <nav class="workflow-tabs" role="tablist"><button id="tab-result" role="tab" aria-controls="result-view" aria-selected="true">${t("Result")}</button><button id="tab-flow" role="tab" aria-controls="flow-view" aria-selected="false">${t("Graph")}</button><button id="tab-logs" role="tab" aria-controls="logs-view" aria-selected="false">${t("Logs")}</button></nav><div id="run-error" class="error" hidden></div>
      <div id="result-view" role="tabpanel" aria-labelledby="tab-result"><div id="run-output" class="message-content"></div><div id="run-files" class="attachments"></div><div id="run-prompt"></div></div>
      <div id="flow-view" role="tabpanel" aria-labelledby="tab-flow" hidden><div class="graph-toolbar"><button id="zoom-out" class="icon-button" title="${t("Zoom out")}" aria-label="${t("Zoom out")}">${iconHtml('zoom-out')}</button><span id="graph-scale">100%</span><button id="zoom-in" class="icon-button" title="${t("Zoom in")}" aria-label="${t("Zoom in")}">${iconHtml('zoom-in')}</button><button id="fit-graph" class="icon-button" title="${t("Fit graph")}" aria-label="${t("Fit graph")}">${iconHtml('screen-full')}</button></div><div id="graph-viewport"><div id="graph-size"><div id="graph-surface"></div></div></div><div id="graph-diagnostics"></div></div>
      <pre id="logs-view" role="tabpanel" aria-labelledby="tab-logs" hidden></pre></section>
    </div>
    <section id="workflow-form" class="workflow-form" aria-label="${t("Entrypoint parameters")}"><div class="workflow-form-top"><div id="input-mode" class="input-mode" role="group" aria-label="${t("Parameter mode")}"><button data-mode="form" aria-pressed="true">${t("Form")}</button><button data-mode="raw" aria-pressed="false">JSON</button></div><button id="refresh-params" class="icon-button" title="${t("Refresh parameters")}" aria-label="${t("Refresh parameters")}">${iconHtml('refresh')}</button></div><div id="main-fields" class="workflow-main-fields"></div><textarea id="raw-args" aria-label="${t("JSON argument array")}" spellcheck="false" rows="4" hidden></textarea><div id="parameter-error" class="error" role="alert" hidden></div><div class="workflow-form-bottom"><div id="parameter-actions" class="parameter-actions"></div><span id="parameter-status" class="parameter-status" hidden>${iconHtml('loading')}</span><button id="run" class="workflow-run-button">${iconHtml('play')}<span>${t("Run")}</span></button></div></section>
  </main><dialog id="history-dialog" class="conversation-dialog"><header><label class="history-search">${iconHtml('search')}<input id="search-history" type="search" placeholder="${t("Search runs")}" aria-label="${t("Search runs")}"></label><button id="close-history" class="icon-button" title="${t("Close")}" aria-label="${t("Close")}">${iconHtml('close')}</button></header><div id="search-results" class="dialog-body"></div><button id="search-more" class="all-history" hidden>${t("Load more")}</button></dialog>
  <dialog id="node-dialog" class="conversation-dialog"><header><h2 id="node-title"></h2><button id="close-node" class="icon-button" title="${t("Close")}" aria-label="${t("Close")}">${iconHtml('close')}</button></header><pre id="node-detail" class="dialog-body web-preview"></pre></dialog>`;
const configurationPanel = mountProjectConfigurations(host);
const aggregateToolbar = mountAggregateToolbar(host);
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const traceButton = iconButton('history', t("Trace"), () => post({ type: 'trace', runId: state?.run?.id }));
traceButton.id = 'open-trace'; document.querySelector('.run-heading-actions')!.prepend(traceButton);
let state: State | undefined, entrypointId: string | undefined, entrySignature = '', renderedRun = '';
let connected = false, resolving = false, submitting = false, draftsLoaded = false, requestId = 0, revision = -1;
let errorScope = 0, checkingServer = false;
const stateRevisions = new StateRevisions();
const serverBlocked = () => !!state?.serverData && state.serverData.blocking !== false && (state.serverData.checking || !!state.serverData.issue);
const serverGuidance = new ProjectServerGuidance(element('server-guidance'), {
  create: () => { host.postMessage({ type: 'open-project-create' }); },
  databases: () => { if (state) dialogs.projectInfo(state.project, 'databases'); },
  retry: () => { checkingServer = true; controls(); post({ type: 'project-server-check' }); },
});
let paramStates: Record<string, ParamState> = {};
const drafts: Record<string, Draft> = {};
const saved = (host.getState() ?? {}) as { menuOpen?: boolean; entrypointId?: string; tab?: string };
let menuOpen = saved.menuOpen ?? true, tab = 'result', scale = 1, graphWidth = 400, graphHeight = 160, graphSignature = '';
let editTimer: ReturnType<typeof setTimeout> | undefined, searchTimer: ReturnType<typeof setTimeout> | undefined;
let prompt: InputPrompt | undefined, promptKey = '';
const narrow = matchMedia('(max-width: 680px)'), dialogs = new ConversationTools(aggregateToolbar.databases);
const output = new ConversationOutput(element('run-output'), {
  copy: text => host.postMessage({ type: 'copy', text }), plan: text => dialogs.plan(text), file: id => host.postMessage({ type: 'open-file', id }),
  image: (src, title) => dialogs.image(src, title), resource: (card, action, requestId) => post({ type: 'resource', cardId: card.id, runId: state?.run?.id, action, requestId }),
});
const parameters = () => state ? projectParameters(state.project, entrypointId) : { fields: [] };
const draft = (): Draft => drafts[entrypointId ?? ''] ??= { scopeId: '', values: {}, rawArgs: '[]', inputMode: 'form', policies: {} };
const disabled = () => !connected || !!state?.running || submitting || !!state?.project.requiresLogin && state.account.status !== 'authenticated';
const fields = new Fields(element('main-fields'), element('parameter-actions'), {
  openUserSetting: key => host.postMessage({ type: 'open-user-setting', key }),
  values: () => draft().values, states: () => paramStates, disabled, loading: () => resolving,
  modelConfigurationRequired: () => configurationPanel.needsAgentModels(), configureModel: () => parameters().fields.some(field => field.userSetting?.key === 'agent.model') ? host.postMessage({ type: 'open-user-setting', key: 'agent.model' }) : configurationPanel.openAgentModels(),
  change: (name, value) => { draft().values[name] = value; fields.update(); scheduleResolve({ kind: 'param', paramName: name }); },
  file: name => post({ type: 'attach', entrypointId, paramName: name, accept: parameters().fields.find(field => field.name === name)?.accept }),
});
function clearError(invalidate = true): void {
  if (invalidate) { ++errorScope; }
  element('error').textContent = ''; element('error').hidden = true;
}
function post(message: Record<string, unknown>): void {
  if (['workflow-select', 'workflow-run', 'workflow-rerun', 'workflow-resume'].includes(String(message.type))) { clearError(); }
  if (message.type === 'workflow-select') { submitting = false; controls(); }
  host.postMessage({ projectUri: state?.project.uri, entrypointId, ...message, errorScope });
}
function persist(): void { host.setState({ menuOpen, entrypointId, tab }); }
function menu(open: boolean): void {
  menuOpen = open; app.classList.toggle('menu-open', open); element('menu-toggle').hidden = open;
  element('menu-toggle').setAttribute('aria-expanded', String(open));
  persist();
}
menu(menuOpen); narrow.addEventListener('change', () => menu(menuOpen));
function scheduleResolve(trigger: Record<string, unknown>): void {
  ++requestId; resolving = !!parameters().paramResolver?.enabled; controls(); clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    if (serverBlocked()) { resolving = false; post({ type: 'workflow-draft', params: draft().values, rawArgs: draft().rawArgs, inputMode: draft().inputMode }); controls(); }
    else resolve(trigger);
  }, 200);
}
function resolve(trigger: Record<string, unknown> = { kind: 'init' }): void {
  if (!state || !connected || serverBlocked() || state.project.requiresLogin && state.account.status !== 'authenticated') { return; }
  resolving = true; controls();
  post({ type: 'resolve', requestId: ++requestId, params: draft().values, rawArgs: draft().rawArgs, inputMode: draft().inputMode, trigger });
}
function selectEntrypoint(id?: string): void {
  if (editTimer && state && entrypointId !== id) { post({ type: 'workflow-draft', params: draft().values, rawArgs: draft().rawArgs, inputMode: draft().inputMode }); }
  clearTimeout(editTimer); ++requestId; clearError(); submitting = false; fields.close(); entrypointId = id;
  paramStates = {}; const current = draft();
  for (const field of parameters().fields) { current.values[field.name] ??= projectParamValue(field, field.defaultValue ?? (field.type === 'boolean' ? 'false' : '')); }
  const detail = Array.from(element('entrypoints').querySelectorAll<HTMLDetailsElement>('.workflow-entry')).find(detail => detail.dataset.entrypoint === (id ?? ''));
  if (detail) {
    for (const other of Array.from(element('entrypoints').querySelectorAll<HTMLDetailsElement>('.workflow-entry'))) { if (other !== detail) { other.open = false; } }
    detail.open = true; detail.append(element('workflow-form'));
  }
  element<HTMLTextAreaElement>('raw-args').value = current.rawArgs;
  element('parameter-error').hidden = true; fields.render(parameters()); controls(); persist(); resolve();
}
function renderEntrypoints(): void {
  if (!state) { return; }
  const signature = JSON.stringify([state.project.id, state.project.entrypoints, state.project.fields]);
  if (signature === entrySignature) { return; }
  entrySignature = signature; const form = element('workflow-form'); form.remove(); const root = element('entrypoints'); root.replaceChildren();
  const entries = state.project.entrypoints.length ? [...state.project.entrypoints].sort((a, b) => (a.group?.order ?? 0) - (b.group?.order ?? 0)) : [{ id: '', title: state.project.name, fields: state.project.fields }];
  const defaultId = state.project.defaultEntrypoint ?? entries[0]?.id;
  const groups = new Map<string, HTMLElement>();
  for (const entry of entries) {
    let parent: HTMLElement = root;
    if (entry.group) {
      if (!groups.has(entry.group.id)) {
        const group = document.createElement('details'); group.className = 'workflow-group'; group.open = entries.some(item => item.id === defaultId && item.group?.id === entry.group!.id);
        const summary = document.createElement('summary'); summary.textContent = entry.group.title; group.append(summary); root.append(group); groups.set(entry.group.id, group);
      }
      parent = groups.get(entry.group.id)!;
    }
    const detail = document.createElement('details'); detail.className = 'workflow-entry'; detail.dataset.entrypoint = entry.id;
    const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml('chevron-right')}<span>${escapeHtml(entry.title || entry.id)}</span>${entry.id === defaultId ? `<small>${t("Default")}</small>` : ''}`;
    summary.addEventListener('click', event => { if (!detail.open) { event.preventDefault(); selectEntrypoint(entry.id || undefined); } });
    detail.append(summary);
    if (entry.description) { const description = document.createElement('p'); description.textContent = entry.description; detail.append(description); }
    parent.append(detail);
  }
  root.append(form);
  selectEntrypoint(entries.some(entry => entry.id === saved.entrypointId) ? saved.entrypointId : defaultId || undefined);
}
function controls(): void {
  if (state) { updateProjectAvatar(element('project-info'), state.project); }
  serverGuidance.update(state?.serverData, state?.project.id ?? '', { connected, working: checkingServer || !!state?.serverData?.checking, canCreate: !state?.project.assistant });
  element<HTMLButtonElement>('run').disabled = disabled() || resolving || serverBlocked();
  element<HTMLButtonElement>('rerun').disabled = disabled() || serverBlocked();
  element<HTMLButtonElement>('delete-run').disabled = !connected || state?.run?.id === state?.occupiedId;
  element<HTMLButtonElement>('stop-active').disabled = !connected;
  element<HTMLButtonElement>('refresh-params').disabled = !connected || resolving || serverBlocked();
  element<HTMLTextAreaElement>('raw-args').disabled = disabled();
  element('raw-args').hidden = draft().inputMode !== 'raw'; element('main-fields').hidden = draft().inputMode !== 'form';
  element('parameter-actions').hidden = draft().inputMode !== 'form'; element('parameter-status').hidden = !resolving;
  element('workflow-form').setAttribute('aria-busy', String(resolving));
  for (const button of Array.from(element('input-mode').querySelectorAll<HTMLButtonElement>('button'))) { button.setAttribute('aria-pressed', String(button.dataset.mode === draft().inputMode)); button.disabled = disabled(); }
  if (draft().inputMode === 'form') { fields.update(); }
  element('usage').hidden = state?.account.status !== 'authenticated';
  element<HTMLButtonElement>('tools').disabled = !connected;
  element('tools').hidden = false;
  prompt?.setBusy(!connected || serverBlocked() || state?.run?.status === 'running' || submitting);
  app.dataset.connection = connected ? 'connected' : 'disconnected';
}
function historyRows(root: HTMLElement): void {
  const existing = new Map(Array.from(root.children).map(row => [(row as HTMLElement).dataset.runId!, row as HTMLButtonElement]));
  for (const [index, run] of (state?.runs ?? []).entries()) {
    let row = existing.get(run.id);
    if (!row) {
      row = document.createElement('button'); row.dataset.runId = run.id;
      const label = document.createElement('span'); label.className = 'session-title';
      const meta = document.createElement('small'); meta.className = 'run-list-meta';
      const status = document.createElement('span'); status.className = 'history-status';
      meta.append(status, document.createElement('time')); row.append(label, meta);
      row.onclick = () => { fields.close(); post({ type: 'workflow-select', id: run.id }); element<HTMLDialogElement>('history-dialog').close(); };
    }
    existing.delete(run.id);
    row.className = `session workflow-history-row${state?.run?.id === run.id ? ' active' : ''}`;
    row.title = run.title;
    row.setAttribute('aria-current', String(state?.run?.id === run.id));
    row.children[0].textContent = run.title;
    const [status, time] = Array.from(row.children[1].children) as HTMLElement[];
    updateHistoryStatus(status, workflowHistoryStatus(run.status));
    time.textContent = new Date(run.createdAt).toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const current = root.children[index] ?? null;
    if (current !== row) { root.insertBefore(row, current); }
  }
  for (const row of existing.values()) { row.remove(); }
}
function changeTab(value: string): void {
  tab = value;
  for (const name of ['result', 'flow', 'logs']) { element(`${name}-view`).hidden = tab !== name; element(`tab-${name}`).setAttribute('aria-selected', String(tab === name)); }
  if (value === 'flow') { renderGraph(); } persist();
}
function renderGraph(): void {
  if (!state?.run || tab !== 'flow') { return; }
  const signature = JSON.stringify([state.run.id, state.run.nodes, state.run.entrypointId]);
  if (signature === graphSignature) { return; }
  const first = !graphSignature; graphSignature = signature;
  const graph = layoutProjectGraph(state.project, state.run.entrypointId, state.run); graphWidth = graph.width; graphHeight = graph.height;
  const surface = element('graph-surface'); surface.replaceChildren(); surface.style.width = `${graph.width}px`; surface.style.height = `${graph.height}px`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', String(graph.width)); svg.setAttribute('height', String(graph.height)); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<defs><marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>';
  for (const edge of graph.edges) {
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', edge.points.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' ')); path.setAttribute('class', 'graph-edge'); path.setAttribute('marker-end', 'url(#workflow-arrow)'); svg.append(path);
    if (edge.label && edge.points[1]) { const text = document.createElementNS(svg.namespaceURI, 'text'); text.setAttribute('x', String(edge.points[1].x + 6)); text.setAttribute('y', String(edge.points[1].y)); text.textContent = edge.label; svg.append(text); }
  }
  surface.append(svg);
  for (const node of graph.nodes) {
    const button = document.createElement('button'); button.className = `graph-node graph-${node.kind}`; button.dataset.status = node.status ?? 'idle'; button.dataset.executionId = node.executionId ?? '';
    button.style.left = `${node.x - node.width / 2}px`; button.style.top = `${node.y - node.height / 2}px`; button.style.width = `${node.width}px`; button.style.height = `${node.height}px`;
    button.innerHTML = `${iconHtml(node.kind === 'branch' ? 'git-compare' : node.kind === 'loop' ? 'sync' : node.status === 'success' ? 'pass' : node.status === 'running' ? 'loading' : 'symbol-method')}<span>${escapeHtml(node.label)}</span><small>${escapeHtml(statusLabels[node.status ?? ''] ?? '')}</small>`;
    button.title = node.label; button.onclick = () => {
      element('node-title').textContent = node.label; element('node-detail').textContent = JSON.stringify(node.detail ?? {}, null, 2); element<HTMLDialogElement>('node-dialog').showModal();
    }; surface.append(button);
  }
  element('graph-diagnostics').textContent = graph.diagnostics.join('\n'); if (first) { zoom(Math.max(0.6, Math.min(1, (element('graph-viewport').clientWidth - 16) / graphWidth))); } else { zoom(scale); }
}
function zoom(value: number): void {
  scale = Math.min(2, Math.max(0.2, value)); element('graph-surface').style.transform = `scale(${scale})`;
  element('graph-size').style.width = `${graphWidth * scale}px`; element('graph-size').style.height = `${graphHeight * scale}px`; element('graph-scale').textContent = `${Math.round(scale * 100)}%`;
}
function fitGraph(): void { zoom(Math.min(1, (element('graph-viewport').clientWidth - 16) / graphWidth, (element('graph-viewport').clientHeight - 16) / graphHeight)); }
function renderRun(): void {
  const run = state?.run;
  element('entrypoints').hidden = !!run; element('run-detail').hidden = !run;
  if (!run) { if (renderedRun) { fields.close(); } renderedRun = ''; controls(); return; }
  if (renderedRun !== run.id) { renderedRun = run.id; tab = 'result'; graphSignature = ''; prompt = undefined; promptKey = ''; element('run-prompt').replaceChildren(); }
  element('run-title').textContent = run.title;
  const usage = run.tokenUsage?.display ? run.tokenUsage.run : undefined;
  const tokens = usage && (usage.totalTokens ?? (Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)));
  element('run-meta').textContent = [statusLabels[run.status] ?? run.status, new Date(run.createdAt).toLocaleString(locale()),
    run.durationMs === undefined ? '' : `${(run.durationMs / 1000).toFixed(1)}s`, tokens === undefined ? '' : `${tokens} tokens`].filter(Boolean).join(' \u00b7 ');
  element('run-error').textContent = run.error ?? ''; element('run-error').hidden = !run.error;
  const files = run.files;
  output.update({ id: run.id, role: 'assistant', content: run.items.length || run.report?.result?.data === undefined ? '' : JSON.stringify(run.report.result.data, null, 2),
    items: run.items, status: run.status, pendingInput: run.pendingInput, resolvedInputs: run.resolvedInputs, submittingInput: run.submittingInput,
    events: run.events, timers: run.timers }, state!.project.id, state!.project.entryId, run.scopeId, files, 'local');
  const pendingLabel = element('run-output').querySelector('.pending > span:last-child'); if (pendingLabel) { pendingLabel.textContent = t("Running..."); }
  element('run-files').replaceChildren(...files.map(file => {
    const button = iconButton('file', file.name, () => host.postMessage({ type: 'open-file', id: file.id })); button.className = 'workflow-file';
    button.append(document.createTextNode(file.name)); return button;
  }));
  const key = run.pendingInput ? `${run.id}:${run.pendingInput.requestId}` : '';
  if (key !== promptKey) {
    promptKey = key; element('run-prompt').replaceChildren(); prompt = undefined;
    if (run.pendingInput) {
      prompt = new InputPrompt(run.pendingInput, {
        submit: values => { submitting = true; controls(); post({ type: 'workflow-resume', id: run.id, requestId: run.pendingInput!.requestId, values }); },
        stop: () => post({ type: 'workflow-stop' }),
        files: name => post({ type: 'attach', runId: run.id, requestId: run.pendingInput!.requestId, paramName: name, entrypointId: run.entrypointId }),
      }); element('run-prompt').append(prompt.root);
    }
  }
  element('logs-view').textContent = run.logs || t("No logs"); changeTab(tab); controls();
}
function applyState(next: State): void {
  // State can arrive before the current request finishes, including a save failure.
  if (state?.project.uri !== next.project.uri || state?.run?.id !== next.run?.id) { clearError(false); }
  const serverChanged = serverBlocked() !== (!!next.serverData && next.serverData.blocking !== false && (next.serverData.checking || !!next.serverData.issue));
  const authChanged = revision !== next.authenticationRevision; revision = next.authenticationRevision; state = next;
  if (authChanged) { dialogs.closeUsage(); }
  if (!draftsLoaded) {
    for (const key of Object.keys(drafts)) { delete drafts[key]; }
    Object.assign(drafts, structuredClone(next.drafts)); draftsLoaded = true;
  }
  element('workflow-title').textContent = next.project.name;
  const runningCount = next.runningCount ?? Number(next.occupiedRun?.status === 'running');
  updateRunningCount(element('running-count'), runningCount, t('Running workflows: {0}', runningCount));
  historyRows(element('run-list')); historyRows(element('search-results'));
  element('empty-history').hidden = next.runs.length > 0; element('load-more-history').hidden = element('search-more').hidden = !next.history.hasMore;
  element('active-run').hidden = !next.occupiedRun;
  if (next.occupiedRun) { element('show-active').textContent = `${next.occupiedRun.title} \u00b7 ${statusLabels[next.occupiedRun.status] ?? next.occupiedRun.status}`; }
  submitting = false;
  app.dataset.runState = next.running ? next.occupiedRun?.pendingInput ? 'waiting' : 'running' : 'idle';
  renderEntrypoints(); renderRun();
  if (authChanged || serverChanged) { ++requestId; resolving = false; if (authChanged) paramStates = {}; resolve(); controls(); }
}
element('menu-toggle').onclick = () => menu(true); element('hide-menu').onclick = () => menu(false);
document.querySelector('main')!.addEventListener('click', narrowMenuDismiss(narrow, () => menuOpen, () => menu(false)));
element('new').onclick = () => { post({ type: 'workflow-select' }); fields.close(); };
element('show-active').onclick = () => post({ type: 'workflow-select', id: state?.occupiedId });
element('stop-active').onclick = () => post({ type: 'workflow-stop' });
element('load-more-history').onclick = element('search-more').onclick = () => post({ type: 'workflow-history', query: state?.history.query, more: true });
element('history-toggle').onclick = () => { element<HTMLDialogElement>('history-dialog').showModal(); element<HTMLInputElement>('search-history').focus(); };
element('close-history').onclick = () => element<HTMLDialogElement>('history-dialog').close();
element<HTMLDialogElement>('history-dialog').addEventListener('close', () => { element<HTMLInputElement>('search-history').value = ''; post({ type: 'workflow-history', query: '' }); });
element('search-history').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => post({ type: 'workflow-history', query: element<HTMLInputElement>('search-history').value }), 200); });
element('refresh-params').onclick = () => resolve();
for (const button of Array.from(element('input-mode').querySelectorAll<HTMLButtonElement>('button'))) { button.onclick = () => { draft().inputMode = button.dataset.mode as 'form' | 'raw'; controls(); scheduleResolve({ kind: 'init' }); }; }
element('raw-args').addEventListener('input', () => { draft().rawArgs = element<HTMLTextAreaElement>('raw-args').value; scheduleResolve({ kind: 'input' }); });
element('run').onclick = () => {
  if (disabled() || resolving || serverBlocked()) { return; } clearTimeout(editTimer); ++requestId; submitting = true; controls();
  post({ type: 'workflow-run', params: draft().values, inputMode: draft().inputMode, rawArgs: draft().rawArgs });
};
element('rerun').onclick = () => { submitting = true; controls(); post({ type: 'workflow-rerun', id: state?.run?.id }); };
element('export-run').onclick = () => post({ type: 'workflow-export', id: state?.run?.id });
element('delete-run').onclick = async () => {
  const id = state?.run?.id;
  if (id && await requestAction({ title: t("Delete this run?"), confirm: t("Delete"), danger: true }) !== undefined) { post({ type: 'workflow-delete', id }); }
};
for (const name of ['result', 'flow', 'logs']) { element(`tab-${name}`).onclick = () => changeTab(name); }
element('zoom-in').onclick = () => zoom(scale + 0.1); element('zoom-out').onclick = () => zoom(scale - 0.1); element('fit-graph').onclick = fitGraph;
element('close-node').onclick = () => element<HTMLDialogElement>('node-dialog').close();
element('tools').onclick = () => dialogs.permissions(parameters(), draft().policies, policies => { draft().policies = structuredClone(policies); post({ type: 'tool-policy', policies }); });
element('usage').onclick = () => dialogs.usage(requestId => post({ type: 'usage', requestId }));
element('project-info').onclick = () => { if (state) { fields.close(); dialogs.projectInfo(state.project); } };
addEventListener('message', event => {
  if (event.source !== null && event.source !== window.parent) return;
  const message = event.data;
  if (message?.type === 'project-server-checked') { checkingServer = false; controls(); return; }
  if (message?.type === 'state' && message.project?.projectType === 'workflow') {
    if (!stateRevisions.accept(message)) return;
    applyState(message);
  }
  else if (message?.type === 'connection') {
    const restored = !connected && message.status === 'connected'; connected = message.status === 'connected'; controls(); if (restored) { resolve(); }
    if (!connected) { checkingServer = false; dialogs.closeUsage(); }
  } else if (message?.type === 'params' && message.requestId === requestId && message.entrypointId === entrypointId) {
    resolving = false;
    if (message.error) { element('parameter-error').textContent = message.error; element('parameter-error').hidden = false; }
    else { element('parameter-error').hidden = true; paramStates = message.params ?? {}; draft().values = message.values ?? draft().values; }
    controls();
  } else if (message?.type === 'attachments') {
    if (message.runId && prompt && message.requestId === prompt.request.requestId) { prompt.fileValue(message.paramName, JSON.stringify(message.files)); }
    else if (message.entrypointId === entrypointId) {
      const field = parameters().fields.find(field => field.name === message.paramName);
      if (field) { const files = (message.files as Attachment[]).map(({ previewUrl: _, ...file }) => file); draft().values[field.name] = JSON.stringify(field.multiple ? files : files[0] ?? null); fields.update(); scheduleResolve({ kind: 'param', paramName: field.name }); }
    }
  } else if (message?.type === 'usage') { dialogs.usageResult(message.requestId, message.usage); }
  else if (message?.type === 'error') {
    if (message.requestType === 'project-server-check') checkingServer = false;
    if (message.requestType === 'resource' && message.requestId) { return; }
    if (message.requestType === 'usage') { dialogs.usageResult(message.requestId, undefined, message.message); return; }
    if (message.errorScope !== undefined && message.errorScope !== errorScope) { return; }
    submitting = false; resolving = false; controls();
    if (!message.silent) { element('error').textContent = message.message; element('error').hidden = false; }
    if (message.requestType === 'workflow-resume') { prompt?.setBusy(false, message.message); }
  }
});
host.postMessage({ type: 'ready' });
