export const runStatuses = ['running', 'waiting_for_input', 'success', 'failed', 'aborted', 'timed_out', 'interrupted', 'unknown'];
export const projectTypes = ['workflow', 'conversation', 'kanban', 'unknown'];

export function status(value) { return runStatuses.includes(value) ? value : 'unknown'; }

export function formatTimestamp(value) {
  if (typeof value !== 'number') return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = number => String(number).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function analyze(snapshot, filters = {}) {
  const since = filters.days ? snapshot.generatedAt - filters.days * 86_400_000 : 0;
  const search = (filters.search ?? '').trim().toLocaleLowerCase();
  const projects = snapshot.projects.filter(project => (!filters.type || project.projectType === filters.type)
    && (!filters.project || project.uri === filters.project)
    && (!search || [project.name, project.folderPath, project.id].some(value => value.toLocaleLowerCase().includes(search))));
  const runs = projects.flatMap(project => project.runs.map(run => ({ ...run, status: status(run.status), project })))
    .filter(run => (!since || run.createdAt >= since) && (!filters.status || run.status === filters.status))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const statuses = Object.fromEntries(runStatuses.map(value => [value, runs.filter(run => run.status === value).length]));
  const types = Object.fromEntries(projectTypes.map(value => [value, projects.filter(project => (projectTypes.includes(project.projectType) ? project.projectType : 'unknown') === value).length]));
  const completed = runs.filter(run => !['running', 'waiting_for_input', 'unknown'].includes(run.status));
  const durations = completed.map(run => run.durationMs).filter(value => typeof value === 'number' && Number.isFinite(value));
  const active = snapshot.projects.flatMap(project => project.runs.filter(run => ['running', 'waiting_for_input'].includes(run.status)).map(run => ({ ...run, project })));
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(snapshot.generatedAt); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 13 + index);
    const start = date.getTime(), next = new Date(date); next.setDate(date.getDate() + 1);
    return { start, count: runs.filter(run => run.createdAt >= start && run.createdAt < next.getTime()).length };
  });
  return { projects, runs, statuses, types, active, days, completed: completed.length,
    successRate: completed.length ? statuses.success / completed.length : null,
    averageDuration: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    queued: snapshot.projects.reduce((total, project) => total + project.queued, 0),
    unavailable: snapshot.projects.filter(project => project.availability !== 'available').length };
}

export function csv(rows) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    const text = String(value ?? '');
    // Spreadsheet applications interpret these prefixes as formulas.
    return '"' + (/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}
