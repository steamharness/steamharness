const api = window.steamHarnessKanban;
const key = 'studio-kanban:tasks';
const columns = [['todo', '\u5f85\u529e'], ['doing', '\u8fdb\u884c\u4e2d'], ['done', '\u5df2\u5b8c\u6210']];
const labels = { design: '\u8bbe\u8ba1', development: '\u5f00\u53d1', test: '\u6d4b\u8bd5' };
let tasks = [], busy = true;
const error = reason => { const element = document.querySelector('#board-error'); element.textContent = reason.message ?? String(reason); element.hidden = false; };
const seed = () => [
  { id: crypto.randomUUID(), title: '\u68b3\u7406\u9879\u76ee\u5165\u53e3', description: '\u786e\u8ba4\u5de5\u4f5c\u533a\u7684\u4e3b\u8981\u4f7f\u7528\u6d41\u7a0b', status: 'todo', priority: 'high', label: 'design' },
  { id: crypto.randomUUID(), title: '\u63a5\u5165\u9879\u76ee\u81ea\u5b9a\u4e49\u53c2\u6570', description: '\u7edf\u4e00\u914d\u7f6e\u6ce8\u5165\u548c\u9884\u89c8\u66f4\u65b0', status: 'doing', priority: 'high', label: 'development' },
  { id: crypto.randomUUID(), title: '\u9a8c\u8bc1\u6d45\u8272\u4e0e\u6df1\u8272\u4e3b\u9898', description: '\u6d4f\u89c8\u5668\u548c VS Code \u5171\u7528\u9875\u9762', status: 'done', priority: 'normal', label: 'test' },
];
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
      for (const [text, title, operation] of [['\u2192', '\u79fb\u5230\u4e0b\u4e00\u5217', () => { task.status = columns[(columns.findIndex(([value]) => value === status) + 1) % columns.length][0]; }], ['\u00d7', '\u5220\u9664\u4efb\u52a1', () => { tasks = tasks.filter(item => item !== task); }]]) {
        const button = document.createElement('button'); button.textContent = text; button.title = title; button.setAttribute('aria-label', title); button.disabled = busy; button.onclick = () => void mutate(operation).catch(error); actions.append(button);
      }
      card.append(top, heading, detail, actions); column.append(card);
    } root.append(column);
  }
  document.querySelector('#board-summary').textContent = `${tasks.length} \u4e2a\u4efb\u52a1`; document.querySelector('#new-task').disabled = busy;
}
async function mutate(operation) {
  if (busy) throw new Error('Kanban is busy.'); const previous = structuredClone(tasks); busy = true;
  try { operation(); render(); await api.databases.get('data').kv.setValue(key, tasks); document.querySelector('#board-error').hidden = true; }
  catch (reason) { tasks = previous; throw reason; } finally { busy = false; render(); }
}
async function load() { render(); const saved = await api.databases.get('data').kv.getValue(key); tasks = Array.isArray(saved) ? saved : seed(); if (!saved) await api.databases.get('data').kv.setValue(key, tasks); busy = false; render(); }
document.querySelector('#new-task').onclick = () => document.querySelector('#task-dialog').showModal();
document.querySelector('#cancel-task').onclick = () => document.querySelector('#task-dialog').close();
document.querySelector('#task-form').onsubmit = async event => { event.preventDefault(); const title = document.querySelector('#task-title').value.trim(); if (!title) return;
  try { await mutate(() => tasks.unshift({ id: crypto.randomUUID(), title, description: document.querySelector('#task-description').value, status: 'todo', priority: document.querySelector('#task-priority').value, label: document.querySelector('#task-label').value })); document.querySelector('#task-dialog').close(); document.querySelector('#task-form').reset(); } catch (reason) { error(reason); }
};
document.querySelector('#export-board').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'kanban.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000); };
window.addEventListener('steamharness:kanban-configuration-change', render); window.addEventListener('steamharness:kanban-presentation-change', render);
const loaded = load();
api.methods.register({ name: 'tasks.list', description: '\u8bfb\u53d6\u5f53\u524d\u770b\u677f\u4efb\u52a1', inputSchema: { type: 'object', properties: {} }, readOnly: true }, async () => { await loaded; return { configuration: api.getConfiguration(), tasks: structuredClone(tasks) }; });
api.methods.register({ name: 'tasks.create', description: '\u521b\u5efa\u4e00\u4e2a\u5f85\u529e\u4efb\u52a1', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, async input => { await loaded; if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title is required.'); await mutate(() => tasks.unshift({ id: crypto.randomUUID(), title: input.title.trim(), description: '', status: 'todo', priority: 'normal', label: 'development' })); return { count: tasks.length }; });
void loaded.catch(error);
