const api = window.steamHarnessKanban;
const columns = [['todo', '\u5f85\u529e'], ['doing', '\u8fdb\u884c\u4e2d'], ['done', '\u5df2\u5b8c\u6210']];
const labels = { design: '\u8bbe\u8ba1', development: '\u5f00\u53d1', test: '\u6d4b\u8bd5' };
const sampleTasks = [
  { id: 'plan', title: '\u89c4\u5212\u9879\u76ee', description: '', status: 'todo', priority: 'high', label: 'design' },
  { id: 'build', title: '\u5b9e\u73b0\u9875\u9762', description: '', status: 'doing', priority: 'normal', label: 'development' },
  { id: 'verify', title: '\u9a8c\u8bc1\u4ea4\u4e92', description: '', status: 'done', priority: 'normal', label: 'test' },
];
const tasksByConfiguration = new Map([['default', sampleTasks]]);
const configurationId = () => api.getConfiguration().id || 'default';
function currentTasks() {
  const id = configurationId();
  if (!tasksByConfiguration.has(id)) tasksByConfiguration.set(id, []);
  return tasksByConfiguration.get(id);
}
function render() {
  const { params } = api.getConfiguration();
  const tasks = currentTasks();
  document.body.dataset.density = params.density ?? 'comfortable';
  document.body.dataset.presentation = api.getPresentation().mode;
  document.querySelector('#board-title').textContent = params.title || '\u9879\u76ee\u8ba1\u5212';
  document.querySelector('#board-description').textContent = params.description || '';
  const root = document.querySelector('#board');
  root.replaceChildren();
  for (const [status, title] of columns) {
    if (status === 'done' && params.showCompleted === false) continue;
    const column = document.createElement('section');
    column.className = 'column'; column.dataset.status = status;
    const matches = tasks.filter(task => task.status === status && (params.priority === 'all' || !params.priority || task.priority === params.priority)
      && (!Array.isArray(params.labels) || params.labels.includes(task.label))).slice(0, Number(params.limit) || 20);
    const heading = document.createElement('h2'), count = document.createElement('span');
    heading.textContent = title; count.className = 'column-count'; count.textContent = String(matches.length);
    heading.append(count); column.append(heading);
    for (const task of matches) {
      const card = document.createElement('article');
      card.className = 'task'; card.dataset.id = task.id; card.dataset.priority = task.priority;
      const top = document.createElement('div'), label = document.createElement('span'), priority = document.createElement('span');
      top.className = 'task-top'; label.textContent = labels[task.label]; priority.className = 'task-priority';
      priority.textContent = task.priority === 'high' ? '\u9ad8\u4f18\u5148\u7ea7' : '\u666e\u901a';
      top.append(label, priority);
      const name = document.createElement('h3'), detail = document.createElement('p');
      name.textContent = task.title; detail.textContent = task.description;
      const actions = document.createElement('div'); actions.className = 'task-actions';
      const move = document.createElement('button');
      move.textContent = '\u2192'; move.title = '\u79fb\u5230\u4e0b\u4e00\u5217'; move.setAttribute('aria-label', move.title);
      move.onclick = () => { task.status = columns[(columns.findIndex(([value]) => value === status) + 1) % columns.length][0]; render(); };
      const remove = document.createElement('button');
      remove.textContent = '\u00d7'; remove.title = '\u5220\u9664\u4efb\u52a1'; remove.setAttribute('aria-label', remove.title);
      remove.onclick = () => { const index = tasks.indexOf(task); if (index >= 0) tasks.splice(index, 1); render(); };
      actions.append(move, remove); card.append(top, name, detail, actions); column.append(card);
    }
    root.append(column);
  }
  document.querySelector('#board-summary').textContent = `${tasks.length} \u4e2a\u4efb\u52a1`;
}
document.querySelector('#new-task').onclick = () => document.querySelector('#task-dialog').showModal();
document.querySelector('#cancel-task').onclick = () => document.querySelector('#task-dialog').close();
document.querySelector('#task-form').onsubmit = event => {
  event.preventDefault();
  const title = document.querySelector('#task-title').value.trim();
  if (!title) return;
  currentTasks().unshift({ id: crypto.randomUUID(), title, description: document.querySelector('#task-description').value,
    status: 'todo', priority: document.querySelector('#task-priority').value, label: document.querySelector('#task-label').value });
  document.querySelector('#task-dialog').close(); document.querySelector('#task-form').reset(); render();
};
document.querySelector('#export-board').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(currentTasks(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'kanban.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};
window.addEventListener('steamharness:kanban-configuration-change', render);
window.addEventListener('steamharness:kanban-presentation-change', render);
api.methods.register({ name: 'tasks.list', description: '\u8bfb\u53d6\u5f53\u524d\u770b\u677f\u4efb\u52a1',
  inputSchema: { type: 'object', properties: {} }, readOnly: true }, async () => ({ configuration: api.getConfiguration(), tasks: structuredClone(currentTasks()) }));
api.methods.register({ name: 'tasks.create', description: '\u521b\u5efa\u4e00\u4e2a\u5f85\u529e\u4efb\u52a1',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, async input => {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title is required.');
  currentTasks().unshift({ id: crypto.randomUUID(), title: input.title.trim(), description: '', status: 'todo', priority: 'normal', label: 'development' });
  render(); return { count: currentTasks().length };
});
render();
