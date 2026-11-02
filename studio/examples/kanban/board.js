import { data } from './.steamharness/generated/database/browser/index.js';
const api = window.steamHarnessKanban;
let generation = 0, configurationId = '';
let connection;
const database = () => connection ??= api.databases.connect(data).catch(error => { connection = undefined; throw error; });
const columns = [['todo', '\u5f85\u529e'], ['doing', '\u8fdb\u884c\u4e2d'], ['done', '\u5df2\u5b8c\u6210']];
const labels = { design: '\u8bbe\u8ba1', development: '\u5f00\u53d1', test: '\u6d4b\u8bd5' };
let tasks = [], busy = true;
const error = reason => { const element = document.querySelector('#board-error'); element.textContent = reason.message ?? String(reason); element.hidden = false; };
function render() {
  const { params } = api.getConfiguration(); document.body.dataset.density = params.density ?? 'comfortable';
  document.querySelector('#board-title').textContent = params.title || '\u9879\u76ee\u8ba1\u5212'; document.querySelector('#board-description').textContent = params.description || '';
  document.body.dataset.presentation = api.getPresentation().mode;
  const root = document.querySelector('#board'); root.replaceChildren();
  for (const [status, title] of columns) {
    if (status === 'done' && params.showCompleted === false) continue;
    const column = document.createElement('section'); column.className = 'column'; column.dataset.status = status;
    const matches = tasks.filter(task => task.status === status && (params.priority === 'all' || !params.priority || task.priority === params.priority) && (!Array.isArray(params.labels) || params.labels.includes(task.label))).slice(0, Number(params.limit) || 20);
    const heading = document.createElement('h2'), count = document.createElement('span'); heading.textContent = title; count.className = 'column-count'; count.textContent = String(matches.length); heading.append(count); column.append(heading);
    for (const task of matches) {
      const card = document.createElement('article'); card.className = 'task'; card.dataset.id = task.id; card.dataset.priority = task.priority;
      const top = document.createElement('div'); top.className = 'task-top'; const label = document.createElement('span'), priority = document.createElement('span'); label.textContent = labels[task.label]; priority.className = 'task-priority'; priority.textContent = task.priority === 'high' ? '\u9ad8\u4f18\u5148\u7ea7' : '\u666e\u901a'; top.append(label, priority);
      const heading = document.createElement('h3'); heading.textContent = task.title; const detail = document.createElement('p'); detail.textContent = task.description;
      const actions = document.createElement('div'); actions.className = 'task-actions';
      for (const [text, title, operation] of [['\u2192', '\u79fb\u5230\u4e0b\u4e00\u5217', db => db.task.update({ key: { id: task.id }, rowVersion: task.rowVersion, data: { status: columns[(columns.findIndex(([value]) => value === status) + 1) % columns.length][0] } })], ['\u00d7', '\u5220\u9664\u4efb\u52a1', db => db.task.delete({ key: { id: task.id }, rowVersion: task.rowVersion })]]) {
        const button = document.createElement('button'); button.textContent = text; button.title = title; button.setAttribute('aria-label', title); button.disabled = busy; button.onclick = () => void mutate(operation).catch(error); actions.append(button);
      }
      card.append(top, heading, detail, actions); column.append(card);
    } root.append(column);
  }
  document.querySelector('#board-summary').textContent = `${tasks.length} \u4e2a\u4efb\u52a1`; document.querySelector('#new-task').disabled = busy;
}
async function mutate(operation) {
  if (busy) throw new Error('Kanban is busy.');
  const current = generation; busy = true; render();
  try { await operation(await database()); if (current === generation) await load(); }
  catch (reason) { if (current === generation) { busy = false; render(); } throw reason; }
}
async function load() {
  const current = ++generation, selected = api.getConfiguration().id || 'default';
  if (configurationId !== selected) tasks = [];
  configurationId = selected; busy = true; render();
  try {
    const db = await database(), rows = [];
    for (let page = 1; ; page++) {
      const result = await db.task.rows({ where: { configurationId: selected }, orderBy: { createdAt: 'desc', id: 'asc' }, page, pageSize: 100 });
      if (current !== generation) return;
      rows.push(...result.items); if (rows.length >= result.total || !result.items.length) break;
    }
    tasks = rows.map(row => ({ ...row.values, rowVersion: row.rowVersion })); busy = false;
    document.querySelector('#board-error').hidden = true;
  } catch (reason) { if (current === generation) error(reason); throw reason; }
  finally { if (current === generation) render(); }
}
document.querySelector('#new-task').onclick = () => document.querySelector('#task-dialog').showModal();
document.querySelector('#cancel-task').onclick = () => document.querySelector('#task-dialog').close();
document.querySelector('#task-form').onsubmit = async event => { event.preventDefault(); const title = document.querySelector('#task-title').value.trim(); if (!title) return;
  try { await mutate(db => db.task.insert({ configurationId, id: crypto.randomUUID(), title, description: document.querySelector('#task-description').value, status: 'todo', priority: document.querySelector('#task-priority').value, label: document.querySelector('#task-label').value })); document.querySelector('#task-dialog').close(); document.querySelector('#task-form').reset(); } catch (reason) { error(reason); }
};
document.querySelector('#export-board').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'kanban.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000); };
window.addEventListener('steamharness:kanban-configuration-change', () => { if ((api.getConfiguration().id || 'default') === configurationId) render(); else void load().catch(error); }); window.addEventListener('steamharness:kanban-presentation-change', render);
const loaded = load();
api.methods.register({ name: 'tasks.list', description: '\u8bfb\u53d6\u5f53\u524d\u770b\u677f\u4efb\u52a1', inputSchema: { type: 'object', properties: {} }, readOnly: true }, async () => { await loaded; return { configuration: api.getConfiguration(), tasks: structuredClone(tasks) }; });
api.methods.register({ name: 'tasks.create', description: '\u521b\u5efa\u4e00\u4e2a\u5f85\u529e\u4efb\u52a1', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, async input => { await loaded; if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title is required.'); await mutate(db => db.task.insert({ configurationId, id: crypto.randomUUID(), title: input.title.trim(), description: '', status: 'todo', priority: 'normal', label: 'development' })); return { count: tasks.length }; });
void loaded.catch(error);
