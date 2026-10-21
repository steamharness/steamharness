import { t, locale } from './localization';
import './resources.css';
import './trace.css';
import { traceRows, filterTraceRows, traceDuration, type TraceRow, type TraceLane } from './trace-model';
import type { TracePanelState, TraceTarget } from '../src/workflow-trace-types';
import { TraceAgentView, type AgentTab } from './trace-agent';
import { agentSession } from './trace-agent-model';
import { installContextMenu, type ContextAction } from './context-menu';

interface Host { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void }
const host = (globalThis as unknown as { acquireVsCodeApi(): Host }).acquireVsCodeApi();
const icon = (name: string) => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
const app = document.getElementById('trace-app')!;
app.innerHTML = `<header class="resource-toolbar trace-toolbar">
  <label class="select-control trace-project"><select id="trace-project" aria-label="${t("Project")}"></select>${icon('chevron-down')}</label>
  <label class="select-control trace-session"><select id="trace-session" aria-label="${t("Conversation")}"></select>${icon('chevron-down')}</label>
  <label class="select-control trace-run"><select id="trace-run" aria-label="${t("Runs")}"></select>${icon('chevron-down')}</label>
  <div class="resource-toolbar-actions" id="trace-actions"><button id="trace-current" class="icon-button" title="${t('Follow current conversation')}" aria-label="${t('Follow current conversation')}">${icon('eye')}</button><button id="trace-connect" class="icon-button" title="${t("Load project trace")}" aria-label="${t("Load project trace")}">${icon('debug-start')}</button><button id="trace-more" class="icon-button" title="${t("Load more runs")}" aria-label="${t("Load more runs")}" hidden>${icon('history')}</button></div>
  </header><nav id="trace-tabs" role="tablist" aria-label="${t('Execution views')}"></nav><div id="trace-notice" role="status" hidden></div>
  <section id="trace-execution" role="tabpanel" aria-labelledby="trace-tab-trace"><div class="trace-controls"><div id="trace-modes" role="group" aria-label="${t("Trace view")}">
    <button data-mode="duration" aria-pressed="true">${icon('watch')}<span>${t("Duration")}</span></button><button data-mode="rounds" aria-pressed="false">${icon('list-tree')}<span>${t("Turns")}</span></button><button data-mode="calls" aria-pressed="false">${icon('symbol-method')}<span>${t("Calls")}</span></button></div>
    <label class="resource-search trace-search">${icon('search')}<input id="trace-search" type="search" placeholder="${t("Search trace")}" aria-label="${t("Search trace")}"></label>
    <button id="trace-follow" class="icon-button" title="${t("Follow execution")}" aria-label="${t("Follow execution")}" aria-pressed="true">${icon('arrow-down')}</button>
  </div><section id="trace-timeline" aria-label="${t("Execution timeline")}"></section>
  <div id="trace-scroll"><div id="trace-empty" class="resource-empty"></div><div id="trace-list" aria-label="${t("Execution content")}"></div></div>
  </section><section id="trace-agent" role="tabpanel" tabindex="0" hidden></section>
  <footer><span id="trace-count"></span><span id="trace-status"></span></footer>`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const select = (id: string) => element<HTMLSelectElement>(id);
const scroll = element('trace-scroll');
const labels: Record<TraceLane, string> = { input: t("Input"), model: t("Model"), tool: t("Tool"), node: t("Node"), output: t("Output"), log: t("Logs") };
const statuses: Record<string, string> = { connecting: t("Connecting"), connected: t("Connected"), reconnecting: t("Reconnecting"), offline: t("Offline"), expired: t("Connection expired"), closed: t("Project closed"),
  running: t("Running"), success: t("Completed"), failed: t("Failed"), aborted: t("Stopped"), stopped: t("Stopped"), waiting: t("Waiting for input"), waiting_for_input: t("Waiting for input"), timed_out: t("Timed out"), interrupted: t("Interrupted") };
let state: TracePanelState | undefined;
const saved = (host.getState() ?? {}) as { mode?: string; follow?: boolean; tab?: string; projectUri?: string };
let mode = ['duration', 'rounds', 'calls'].includes(saved.mode ?? '') ? saved.mode! : 'duration', follow = saved.follow ?? true;
const tabs = [['trace', t('Trace'), 'history'], ['tasks', t('Tasks'), 'list-tree'], ['plan', t('Plan'), 'checklist'], ['records', t('Records'), 'notebook'], ['usage', t('Usage'), 'dashboard']] as const;
type Tab = 'trace' | AgentTab;
let tab: Tab = tabs.some(([id]) => id === saved.tab) ? saved.tab as Tab : 'trace';
let reveal = 0;
let query = '', key = '', rows: TraceRow[] = [];
const views = new Map<string, { root: HTMLDetailsElement; signature: string }>();
const post = (message: Record<string, unknown>) => { if (state) { host.postMessage({ generation: state.generation, projectUri: state.selection.projectUri, ...message }); } };
const agent = new TraceAgentView(element('trace-agent'), element('trace-actions'), action => post({ type: 'agent-action', action }), text => post({ type: 'copy', text }));
installContextMenu(host, (target, copy) => {
  if (!target.closest('#trace-app')) { return []; }
  const root = target.closest<HTMLElement>('[data-row-id]');
  const row = rows.find(row => row.id === root?.dataset.rowId);
  const details = target.closest<HTMLDetailsElement>('details.trace-row, details.trace-agent-record');
  const actions: ContextAction[] = [];
  if (details) { actions.push({ id: details.open ? 'collapse' : 'expand', run: () => { details.open = !details.open; } }); }
  if (row) {
    actions.push({ id: 'copyRecord', run: () => copy([row.title, ...row.sections.map(section => `${section.label}\n${section.value}`)].join('\n\n')) });
    if (!details) { actions.unshift({ id: 'open', run: () => focusRow(row.id) }); }
  } else {
    const content = target.closest<HTMLElement>('.trace-task-detail, .trace-agent-record, .trace-plan-document, .trace-agent-fields, .trace-agent-usage');
    if (content?.textContent) { actions.push({ id: 'copyRecord', run: () => copy(content.textContent!) }); }
  }
  return actions;
}, () => JSON.stringify([state?.generation, state?.selection]), target => target.closest('details.trace-row') ?? target);
for (const [id, label, glyph] of tabs) {
  const button = document.createElement('button'); button.id = `trace-tab-${id}`; button.dataset.tab = id;
  button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', id === 'trace' ? 'trace-execution' : 'trace-agent');
  button.innerHTML = `${icon(glyph)}<span>${label}</span>`;
  button.onclick = () => { tab = id; render(); };
  button.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const index = tabs.findIndex(([id]) => id === tab);
    tab = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length][0];
    render(); element(`trace-tab-${tab}`).focus();
  };
  element('trace-tabs').append(button);
}
function options(control: HTMLSelectElement, entries: { value: string; label: string }[], value: string): void {
  const signature = JSON.stringify(entries);
  if (control.dataset.options !== signature) {
    control.replaceChildren(...entries.map(entry => { const option = document.createElement('option'); option.value = entry.value; option.textContent = entry.label; return option; }));
    control.dataset.options = signature;
  }
  control.value = value; control.disabled = entries.length === 0;
}
function selectors(): void {
  if (!state) { return; }
  const snapshot = state.snapshot, selection = state.selection;
  options(select('trace-project'), state.projects.map(project => ({ value: project.uri, label: [project.name, project.version].filter(Boolean).join(' \u00b7 ') })), selection.projectUri ?? '');
  const conversation = snapshot?.project.projectType === 'conversation';
  element('trace-session').parentElement!.hidden = !conversation;
  options(select('trace-session'), [{ value: '', label: t('Current conversation') }, ...(snapshot?.sessions ?? []).map(session => ({ value: session.id, label: session.title }))], selection.sessionId ?? '');
  const session = snapshot?.sessions?.find(session => session.id === (selection.sessionId ?? snapshot.activeId));
  element('trace-current').hidden = !conversation;
  element('trace-current').setAttribute('aria-pressed', String(!selection.sessionId));
  element('trace-run').parentElement!.hidden = snapshot?.durable === true && tab !== 'trace';
  if (conversation) {
    let turn = 0;
    const entries = (session?.messages ?? []).flatMap(message => {
      if (message.role === 'user') { ++turn; return []; }
      return [{ value: message.id ?? '', label: t("Turn {0} \u00B7 {1}", turn, statuses[message.status ?? 'success'] ?? message.status) }];
    });
    options(select('trace-run'), [{ value: '', label: t("All turns") }, ...entries], selection.messageId ?? '');
  } else {
    const runs = [...(snapshot?.runs ?? [])];
    for (const run of [state.run, snapshot?.run, snapshot?.occupiedRun]) { if (run && !runs.some(item => item.id === run.id)) { runs.unshift(run); } }
    options(select('trace-run'), runs.map(run => ({ value: run.id, label: `${run.title} \u00b7 ${run.createdAt ? new Date(run.createdAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : run.id.slice(0, 8)} \u00b7 ${statuses[run.status] ?? run.status}` })), selection.runId ?? snapshot?.selectedId ?? snapshot?.run?.id ?? '');
  }
  element('trace-more').hidden = !snapshot?.history?.hasMore || snapshot?.durable === true && tab !== 'trace';
  element('trace-connect').hidden = !['idle', 'closed', 'expired', 'unsupported'].includes(state.status);
}
function focusRow(id: string): void {
  const view = views.get(id); if (!view) { return; }
  follow = false; preferences(); view.root.open = true; view.root.scrollIntoView({ block: 'center' }); view.root.querySelector('summary')?.focus();
}
function timeline(filtered: TraceRow[]): void {
  const target = element('trace-timeline'); target.replaceChildren();
  const entries = filtered.filter(row => row.lane !== 'log'); target.hidden = !entries.length;
  const timed = entries.filter(row => row.start !== undefined);
  const start = Math.min(...timed.map(row => row.start!));
  const end = Math.max(...timed.map(row => row.end ?? (row.status === 'running' ? Date.now() : row.start!)));
  const span = Math.max(1, end - start), turns = Math.max(1, ...entries.map(row => row.turn));
  const axis = document.createElement('div'); axis.className = 'trace-axis';
  const ticks = mode === 'duration' ? timed.length ? ['0', traceDuration(span / 2), traceDuration(span)] : []
    : mode === 'rounds' ? ['1', t("Turns"), String(turns)] : ['1', t("Calls"), String(entries.length)];
  for (const tick of ticks) { const label = document.createElement('span'); label.textContent = tick; axis.append(label); } target.append(axis);
  for (const lane of ['input', 'model', 'tool', 'node', 'output'] as TraceLane[]) {
    if (!entries.some(row => row.lane === lane)) { continue; }
    const line = document.createElement('div'); line.className = `trace-lane lane-${lane}`;
    const label = document.createElement('span'); label.className = 'lane-label'; label.textContent = labels[lane];
    const track = document.createElement('div'); track.className = 'lane-track';
    for (const [index, row] of entries.entries()) {
      if (row.lane !== lane) { continue; }
      if (mode === 'duration' && row.start === undefined) { continue; }
      const roundEntries = entries.filter(entry => entry.turn === row.turn && entry.lane === lane);
      const position = mode === 'duration' ? (row.start! - start) / span * 100 : mode === 'rounds' ? (row.turn - 1 + roundEntries.indexOf(row) / roundEntries.length) / turns * 100 : index / entries.length * 100;
      const width = mode === 'duration' ? ((row.end ?? (row.status === 'running' ? Date.now() : row.start!)) - row.start!) / span * 100
        : mode === 'rounds' ? 85 / turns / roundEntries.length : 85 / entries.length;
      const bar = document.createElement('button'); bar.className = `trace-bar status-${row.status ?? 'success'}`; bar.dataset.rowId = row.id;
      bar.style.left = `${Math.max(0, Math.min(99.4, position))}%`; bar.style.width = `${Math.min(100 - Math.min(99.4, position), Math.max(.6, width))}%`;
      bar.title = `${row.title}${row.durationMs !== undefined ? ` \u00b7 ${traceDuration(row.durationMs)}` : ''}`; bar.setAttribute('aria-label', bar.title); bar.onclick = () => focusRow(row.id); track.append(bar);
    }
    line.append(label, track); target.append(line);
  }
}
function renderRow(row: TraceRow): HTMLDetailsElement {
  let view = views.get(row.id);
  if (!view) { const root = document.createElement('details'); root.className = 'trace-row'; root.dataset.rowId = row.id; view = { root, signature: '' }; views.set(row.id, view); }
  const signature = JSON.stringify(row);
  if (view.signature === signature) { return view.root; }
  view.signature = signature; view.root.dataset.status = row.status ?? ''; view.root.dataset.lane = row.lane;
  const focused = document.activeElement === view.root.querySelector('summary');
  const summary = document.createElement('summary');
  const badge = document.createElement('span'); badge.className = `trace-badge lane-${row.lane}`; badge.textContent = row.label;
  const title = document.createElement('span'); title.className = 'trace-row-title'; title.textContent = row.title;
  const preview = document.createElement('span'); preview.className = 'trace-preview'; preview.textContent = row.preview.replace(/\s+/g, ' '); preview.title = row.preview.slice(0, 1000);
  const meta = document.createElement('span'); meta.className = 'trace-row-meta';
  meta.textContent = [statuses[row.status ?? ''], traceDuration(row.durationMs)].filter(Boolean).join(' \u00b7 ');
  summary.innerHTML = icon('chevron-right'); summary.append(badge, title, preview, meta);
  const detail = document.createElement('div'); detail.className = 'trace-row-detail';
  const tools = document.createElement('div'); tools.className = 'trace-detail-tools';
  const time = document.createElement('span'); time.textContent = row.start === undefined ? t("Time not recorded") : new Date(row.start).toLocaleString(locale());
  const copy = document.createElement('button'); copy.className = 'icon-button'; copy.title = t("Copy record"); copy.setAttribute('aria-label', copy.title); copy.innerHTML = icon('copy');
  copy.onclick = () => post({ type: 'copy', text: [row.title, ...row.sections.map(section => `${section.label}\n${section.value}`)].join('\n\n') }); tools.append(time, copy); detail.append(tools);
  for (const section of row.sections) {
    const heading = document.createElement('h3'); heading.textContent = section.label;
    const content = document.createElement('pre'); content.textContent = section.value; if (section.error) { content.className = 'trace-error'; } detail.append(heading, content);
  }
  view.root.replaceChildren(summary, detail); if (focused) { summary.focus({ preventScroll: true }); } return view.root;
}
function preferences(): void {
  host.setState({ mode, follow, tab, projectUri: state?.selection.projectUri ?? saved.projectUri }); element('trace-follow').setAttribute('aria-pressed', String(follow));
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
}
function render(): void {
  if (!state) { return; }
  if ((state.reveal ?? 0) > reveal) { reveal = state.reveal!; tab = 'trace'; }
  const activeTab = state.snapshot?.durable ? tab : 'trace';
  element('trace-tabs').hidden = !state.snapshot?.durable;
  for (const [id] of tabs) { const button = element<HTMLButtonElement>(`trace-tab-${id}`); button.setAttribute('aria-selected', String(id === activeTab)); button.tabIndex = id === activeTab ? 0 : -1; }
  element('trace-execution').hidden = activeTab !== 'trace'; element('trace-agent').hidden = activeTab === 'trace';
  element('trace-agent').setAttribute('aria-labelledby', `trace-tab-${activeTab}`);
  agent.update(state, activeTab === 'trace' ? 'tasks' : activeTab, activeTab !== 'trace');
  selectors(); preferences();
  const nextKey = JSON.stringify(state.selection);
  if (key !== nextKey) { key = nextKey; views.clear(); element('trace-list').replaceChildren(); scroll.scrollTop = 0; }
  rows = traceRows(state.snapshot, state.selection, state.run);
  const filtered = filterTraceRows(rows, query, mode), ids = new Set(filtered.map(row => row.id));
  for (const [id, view] of views) { if (!ids.has(id)) { view.root.remove(); views.delete(id); } }
  const list = element('trace-list'); list.querySelectorAll('.trace-turn').forEach(heading => heading.remove());
  let turn = -1;
  for (const row of filtered) {
    if (mode === 'rounds' && turn !== row.turn) { turn = row.turn; const heading = document.createElement('h3'); heading.className = 'trace-turn'; heading.textContent = t("Turn {0}", turn); list.append(heading); }
    list.append(renderRow(row));
  }
  timeline(filtered);
  element('trace-empty').hidden = filtered.length > 0;
  element('trace-empty').textContent = !state.projects.length ? t("No Workflow or Conversation projects") : query ? t("No matching records") : state.loading ? t("Loading trace...") : state.status === 'idle' ? t("No trace loaded") : !state.snapshot ? t("Connecting to project...") : t("No execution records");
  const notice = state.error ?? (state.status === 'unsupported' ? t("The project CLI does not support the trace panel. Update @steamharness/cli.") : ['offline', 'closed', 'expired', 'reconnecting'].includes(state.status) ? statuses[state.status] : '');
  element('trace-notice').hidden = !notice; element('trace-notice').textContent = notice;
  const sessionAgent = agentSession(state).agent;
  element('trace-count').textContent = activeTab === 'trace' ? t("{0} / {1} records \u00B7 {2} tool calls", filtered.length, rows.length, rows.filter(row => row.lane === 'tool').length)
    : !sessionAgent ? t('No task state') : `${sessionAgent.foreground ? t('Responding') : t('Foreground complete')} \u00b7 ${t('Background tasks: {0}', sessionAgent.backgroundCount)}`;
  const active = state.run ?? state.snapshot?.run;
  element('trace-status').textContent = [active ? statuses[active.status] : '', statuses[state.status], traceDuration(active?.durationMs)].filter(Boolean).join(' \u00b7 ');
  if (follow && activeTab === 'trace') { scroll.scrollTop = scroll.scrollHeight; }
}
select('trace-project').onchange = () => post({ type: 'select', projectUri: select('trace-project').value });
select('trace-session').onchange = () => post({ type: 'select', target: { sessionId: select('trace-session').value || undefined } });
element('trace-current').onclick = () => post({ type: 'select', target: {} });
select('trace-run').onchange = () => {
  const target: TraceTarget = state?.snapshot?.project.projectType === 'conversation'
    ? { sessionId: select('trace-session').value || undefined, messageId: select('trace-run').value || undefined }
    : { runId: select('trace-run').value };
  post({ type: 'select', target });
};
let searchTimer: number | undefined;
const search = element<HTMLInputElement>('trace-search');
search.oninput = () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { query = search.value; render(); }, 150);
};
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => { button.onclick = () => { mode = button.dataset.mode!; render(); }; });
element('trace-follow').onclick = () => { follow = !follow; render(); };
element('trace-connect').onclick = () => post({ type: 'connect' }); element('trace-more').onclick = () => post({ type: 'more' });
let renderFrame: number | undefined;
addEventListener('message', event => {
  if (event.data?.type !== 'trace-state' || typeof event.data.generation !== 'number' || state && event.data.generation < state.generation) return;
  state = event.data;
  if (renderFrame === undefined) renderFrame = requestAnimationFrame(() => { renderFrame = undefined; render(); });
});
setInterval(() => { if (state?.snapshot?.running && !document.hidden) { timeline(filterTraceRows(rows, query, mode)); } }, 1000);
host.postMessage({ type: 'ready' });
