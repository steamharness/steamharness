import { Chart, DoughnutController, ArcElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip } from 'chart.js';
import { createElement, RefreshCw, Download, LayoutDashboard, TableProperties, List, ChevronLeft, ChevronRight } from 'lucide';
import { analyze, csv, formatTimestamp, runStatuses, projectTypes } from './model.js';
import { translations } from './locales.js';

Chart.register(DoughnutController, ArcElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip);
const app = document.querySelector('#app');
let locale = 'en', t = translations(locale), snapshot, view = 'overview', page = 0, pending, automatic = true, signature = '', initializing = true;
const filters = { days: 0, type: '', project: '', status: '', search: '' };
const charts = new Map();
const colors = ['#2878c7', '#168878', '#d28b24', '#969ca6', '#cc5261', '#5b8a50', '#7b7478', '#747b84'];
const statusColors = ['#2878c7', '#d28b24', '#168878', '#cc5261', '#969ca6', '#a77617', '#7b7478', '#747b84'];
const el = (tag, text, attributes = {}) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attributes)) { node.setAttribute(key, value); } return node;
};
const formatNumber = value => new Intl.NumberFormat(locale).format(value);
const time = formatTimestamp;
const duration = value => typeof value === 'number' ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s` : '-';
const iconButton = (icon, title, action) => {
  const node = el('button', undefined, { type: 'button', title, 'aria-label': title });
  node.append(createElement(icon, { width: 17, height: 17, 'aria-hidden': 'true' })); node.onclick = action; return node;
};
function badge(value) { return el('span', t[value] ?? t.unknown, { class: `badge ${value}` }); }
function select(label, values, value, change) {
  const node = el('select', undefined, { 'aria-label': label });
  for (const [id, name] of values) { node.append(new Option(name, id)); }
  node.value = value; node.onchange = () => { change(node.value); page = 0; render(); }; return node;
}
function buildShell() {
  app.replaceChildren();
  const header = el('header'), heading = el('div');
  heading.append(el('h1', t.title), el('span', t.scope, { class: 'scope' }));
  const actions = el('div', undefined, { class: 'header-actions' });
  const auto = el('label', undefined, { class: 'auto-refresh' }), input = el('input', undefined, { type: 'checkbox' });
  input.checked = automatic; input.onchange = () => { automatic = input.checked; }; auto.append(input, el('span', t.autoRefresh));
  actions.append(auto, iconButton(RefreshCw, t.refresh, () => refresh()), iconButton(Download, t.export, exportData));
  header.append(heading, actions);
  const meta = el('div', undefined, { class: 'meta', id: 'meta', 'aria-live': 'polite' });
  const notice = el('div', undefined, { class: 'notice', id: 'notice', role: 'status', hidden: '' });
  const toolbar = el('div', undefined, { class: 'toolbar' }), tabs = el('nav', undefined, { 'aria-label': t.title, class: 'tabs' });
  for (const [id, icon] of [['overview', LayoutDashboard], ['projects', TableProperties], ['runs', List]]) {
    const tab = el('button', undefined, { type: 'button', 'data-view': id });
    tab.append(createElement(icon, { width: 16, height: 16, 'aria-hidden': 'true' }), el('span', t[id]));
    tab.onclick = () => { view = id; page = 0; if (view !== 'runs') { filters.project = ''; filters.status = ''; } render(); }; tabs.append(tab);
  }
  toolbar.append(tabs, select(t.allTime, [['0', t.allTime], ['7', t.days7], ['30', t.days30]], String(filters.days), value => { filters.days = Number(value); }));
  const controls = el('div', undefined, { class: 'filters', id: 'filters' });
  const content = el('div', undefined, { id: 'content' });
  app.append(header, meta, notice, toolbar, controls, content);
}
function destroyCharts() { for (const chart of charts.values()) chart.destroy(); charts.clear(); }
function renderFilters() {
  const parent = document.querySelector('#filters'); parent.replaceChildren(); parent.hidden = view === 'overview';
  const search = el('input', undefined, { type: 'search', placeholder: t.search, 'aria-label': t.search }); search.value = filters.search;
  search.oninput = () => { filters.search = search.value; page = 0; renderContent(); }; parent.append(search);
  parent.append(select(t.allTypes, [['', t.allTypes], ...projectTypes.map(type => [type, t[type]])], filters.type, value => { filters.type = value; }));
  if (view === 'runs') {
    const projects = select(t.allProjects, [['', t.allProjects], ...(snapshot?.projects ?? []).map(project => [project.uri, project.name])], filters.project, value => { filters.project = value; });
    projects.id = 'project-filter'; parent.append(projects);
    parent.append(select(t.allStatuses, [['', t.allStatuses], ...runStatuses.map(status => [status, t[status]])], filters.status, value => { filters.status = value; }));
  }
}
function render() {
  for (const node of app.querySelectorAll('[data-view]')) node.setAttribute('aria-current', node.dataset.view === view ? 'page' : 'false');
  renderFilters(); renderContent();
}
function table(headings, rows) {
  const wrapper = el('div', undefined, { class: 'table-scroll', tabindex: '0' }), node = el('table'), head = el('thead'), tr = el('tr');
  for (const title of headings) tr.append(el('th', title, { scope: 'col' })); head.append(tr); node.append(head);
  const body = el('tbody');
  for (const cells of rows) {
    const row = el('tr'); for (const value of cells) { const cell = el('td'); cell.append(value instanceof Node ? value : document.createTextNode(String(value))); row.append(cell); } body.append(row);
  }
  if (!rows.length) { const row = el('tr'); row.append(el('td', view === 'projects' ? t.noProjects : t.noRuns, { colspan: headings.length, class: 'empty' })); body.append(row); }
  node.append(body); wrapper.append(node); return wrapper;
}
function projectState(project) {
  return project.availability !== 'available' ? project.availability : project.runs.some(run => run.status === 'running') ? 'running'
    : project.runs.some(run => run.status === 'waiting_for_input') ? 'waiting_for_input' : project.runs.some(run => run.status === 'unknown') ? 'unknown' : 'idle';
}
function pagination(total) {
  const count = Math.max(1, Math.ceil(total / 50)); page = Math.min(page, count - 1);
  const footer = el('div', undefined, { class: 'pagination' });
  const previous = iconButton(ChevronLeft, t.previous, () => { page--; renderContent(); }); previous.disabled = page === 0;
  const next = iconButton(ChevronRight, t.next, () => { page++; renderContent(); }); next.disabled = page + 1 >= count;
  footer.append(el('span', `${formatNumber(total)} ${t.records}`), previous, el('span', `${t.page} ${page + 1} / ${count}`), next); return footer;
}
function chartSection(title, id) {
  const section = el('section', undefined, { class: 'chart-section' }); section.append(el('h2', title));
  const canvas = el('canvas', undefined, { id, role: 'img', 'aria-label': title });
  const frame = el('div', undefined, { class: 'chart-frame' }); frame.append(canvas); section.append(frame); return section;
}
function drawChart(id, type, labels, values, palette = colors) {
  const text = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
  const canvas = document.querySelector(`#${id}`);
  canvas.setAttribute('aria-label', labels.map((name, index) => `${name}: ${values[index]}`).join(', '));
  const chart = new Chart(canvas, { type, data: { labels, datasets: [{ data: values, backgroundColor: palette, borderColor: type === 'line' ? palette[0] : 'transparent',
    borderWidth: type === 'line' ? 2 : 0, pointRadius: 3, tension: 0.15 }] }, options: { responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: true } },
    ...(type === 'line' ? { scales: { x: { grid: { display: false }, ticks: { color: text, maxTicksLimit: 7 } }, y: { beginAtZero: true, ticks: { color: text, precision: 0 } } } } : { cutout: '72%' }) } });
  charts.set(id, chart);
}
function legend(values, palette = colors) {
  const list = el('ul', undefined, { class: 'legend' });
  Object.entries(values).forEach(([key, value], index) => {
    const row = el('li'), swatch = el('i'); swatch.style.backgroundColor = palette[index];
    row.append(swatch, el('span', t[key]), el('strong', formatNumber(value))); list.append(row);
  }); return list;
}
function renderContent() {
  const content = document.querySelector('#content'); destroyCharts(); content.replaceChildren();
  if (!snapshot) { content.append(el('div', initializing || pending ? t.loading : t.unavailable, { class: 'empty' })); return; }
  const data = analyze(snapshot, view === 'overview' ? { days: filters.days } : filters);
  if (view === 'overview') {
    const stats = el('dl', undefined, { class: 'stats' });
    for (const [key, value] of [['totalProjects', snapshot.projects.length], ['running', data.active.filter(run => run.status === 'running').length],
      ['waiting_for_input', data.active.filter(run => run.status === 'waiting_for_input').length], ['queued', data.queued], ['totalRuns', data.runs.length],
      ['successRate', data.successRate === null ? '-' : `${(data.successRate * 100).toFixed(1)}%`], ['averageDuration', duration(data.averageDuration)]]) {
      const item = el('div'); item.append(el('dt', t[key]), el('dd', typeof value === 'number' ? formatNumber(value) : value)); stats.append(item);
    }
    const plots = el('div', undefined, { class: 'plots' });
    const types = chartSection(t.projectTypes, 'types-chart'), statuses = chartSection(t.runResults, 'statuses-chart');
    types.append(legend(data.types)); statuses.append(legend(data.statuses, statusColors)); plots.append(types, statuses, chartSection(t.trend, 'trend-chart'));
    const active = el('section', undefined, { class: 'active' }); active.append(el('h2', t.active));
    const list = el('ul', undefined, { class: 'active-list' });
    for (const run of data.active) { const item = el('li'); item.append(badge(run.status), el('strong', run.project.name), el('span', run.title), el('time', time(run.createdAt))); list.append(item); }
    if (!data.active.length) list.append(el('li', t.noActive, { class: 'muted' })); active.append(list);
    content.append(stats, plots, active);
    drawChart('types-chart', 'doughnut', Object.keys(data.types).map(key => t[key]), Object.values(data.types));
    drawChart('statuses-chart', 'doughnut', Object.keys(data.statuses).map(key => t[key]), Object.values(data.statuses), statusColors);
    drawChart('trend-chart', 'line', data.days.map(day => new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(day.start)), data.days.map(day => day.count));
  } else {
    const records = view === 'projects' ? data.projects : data.runs;
    const footer = pagination(records.length);
    const rows = records.slice(page * 50, (page + 1) * 50).map(item => {
      if (view === 'projects') {
        const runs = data.runs.filter(run => run.project.uri === item.uri);
        const label = el('div', undefined, { class: 'project-name' }); label.append(el('strong', item.name), el('small', t[item.inWorkspace ? 'inWorkspace' : 'imported']));
        const folder = el('span', item.folderPath, { class: 'folder', title: item.folderPath });
        return [label, t[item.projectType] ?? t.unknown, badge(projectState(item)), formatNumber(runs.length), time(runs[0]?.createdAt), folder];
      }
      const name = el('div', undefined, { class: 'project-name' }); name.append(el('strong', item.title), el('small', item.id, { title: item.id }));
      return [name, item.project.name, badge(item.status), time(item.createdAt), duration(item.durationMs), item.entrypointId || '-'];
    });
    content.append(table(view === 'projects' ? [t.name, t.type, t.state, t.count, t.lastRun, t.path]
      : [t.runTitle, t.name, t.state, t.createdAt, t.duration, t.entrypoint], rows), footer);
  }
  document.querySelector('#meta').textContent = `${t.updated} ${time(snapshot.generatedAt)}${snapshot.serverExcluded ? ` · ${t.serverExcluded}: ${snapshot.serverExcluded}` : ''}${data.unavailable ? ` · ${t.partial}: ${data.unavailable}` : ''}`;
}
async function refresh() {
  if (pending) return pending;
  app.setAttribute('aria-busy', 'true');
  const notice = document.querySelector('#notice');
  pending = (async () => {
    try {
      if (!window.workflowCodeKanban?.studio) throw new Error('unavailable');
      const next = await window.workflowCodeKanban.studio.getLocalAnalysis();
      if (next?.version !== 1 || !Array.isArray(next.projects)) throw new Error('invalid snapshot');
      const first = !snapshot;
      const since = filters.days ? next.generatedAt - filters.days * 86_400_000 : 0;
      const visibleRuns = since ? next.projects.map(project => project.runs.filter(run => run.createdAt >= since).map(run => run.id)) : undefined;
      const nextSignature = JSON.stringify([next.projects, next.serverExcluded, new Date(next.generatedAt).toDateString(), visibleRuns]);
      const changed = nextSignature !== signature; signature = nextSignature; snapshot = next; notice.hidden = true;
      if (first) render(); else if (changed) {
        const projects = document.querySelector('#project-filter');
        if (projects) {
          const options = [['', t.allProjects], ...snapshot.projects.map(project => [project.uri, project.name])];
          if (JSON.stringify([...projects.options].map(option => [option.value, option.text])) !== JSON.stringify(options)) {
            projects.replaceChildren(...options.map(([value, name]) => new Option(name, value))); projects.value = filters.project;
            if (projects.value !== filters.project) filters.project = '';
          }
        }
        renderContent();
      } else {
        const data = analyze(snapshot);
        document.querySelector('#meta').textContent = `${t.updated} ${time(snapshot.generatedAt)}${snapshot.serverExcluded ? ` · ${t.serverExcluded}: ${snapshot.serverExcluded}` : ''}${data.unavailable ? ` · ${t.partial}: ${data.unavailable}` : ''}`;
      }
    } catch {
      notice.textContent = snapshot ? t.stale : t.unavailable; notice.hidden = false;
      if (!snapshot) document.querySelector('#content').replaceChildren(el('div', t.unavailable, { class: 'empty' }));
    }
  })().finally(() => { app.setAttribute('aria-busy', 'false'); pending = undefined; }); return pending;
}
function exportData() {
  if (!snapshot) return;
  const data = analyze(snapshot, view === 'overview' ? { days: filters.days } : filters);
  const rows = view === 'projects'
    ? [[t.name, t.type, t.state, t.count, t.path], ...data.projects.map(project => [project.name, t[project.projectType] ?? t.unknown, t[projectState(project)], data.runs.filter(run => run.project.uri === project.uri).length, project.folderPath])]
    : [[t.runId, t.runTitle, t.name, t.state, t.createdAt, t.duration, t.entrypoint], ...data.runs.map(run => [run.id, run.title, run.project.name, t[run.status], run.createdAt ? new Date(run.createdAt).toISOString() : '', run.durationMs, run.entrypointId])];
  const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = el('a', undefined, { href: url, download: `studio-${view}-${new Date().toISOString().slice(0, 10)}.csv` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
buildShell(); render();
try { locale = await window.workflowCodeKanban.getRuntimeLocale(); } catch { locale = navigator.language; }
t = translations(locale); document.documentElement.lang = locale; document.title = t.title; buildShell(); render();
await refresh(); initializing = false;
setInterval(() => { if (automatic && !document.hidden) void refresh(); }, 5_000);
document.addEventListener('visibilitychange', () => { if (automatic && !document.hidden) void refresh(); });
window.addEventListener('workflow-code:kanban-theme-change', () => renderContent());
