import { data } from './dist/steamharness/generated/database/browser/index.js';
const api = window.steamHarnessKanban;
const zh = (await api.getRuntimeLocale()).toLowerCase().startsWith('zh');
const words = zh ? { todo: '待办', doing: '进行中', done: '已完成', add: '添加任务', move: '移到下一列', remove: '删除', saved: '已保存', task: '任务' }
  : { todo: 'To Do', doing: 'In Progress', done: 'Done', add: 'Add Task', move: 'Move to Next Column', remove: 'Delete', saved: 'Saved', task: 'Task' };
const stages = ['todo', 'doing', 'done'];
let tasks = [], busy = true, generation = 0, configurationId = '';
const status = document.querySelector('#status'), titleInput = document.querySelector('#task-title');
const defaultTitle = document.querySelector('#title').textContent;
titleInput.setAttribute('aria-label', words.task);
document.querySelector('#add-task').textContent = words.add;
let connection;
const database = () => connection ??= api.databases.connect(data).catch(error => { connection = undefined; throw error; });
function render() {
  const { params } = api.getConfiguration();
  document.querySelector('#title').textContent = params.title || defaultTitle;
  document.querySelector('#add-task').disabled = busy;
  const board = document.querySelector('#board'); board.replaceChildren();
  for (const stage of stages) {
    if (stage === 'done' && params.showDone === false) continue;
    const column = document.createElement('section'); column.className = `column ${stage}`;
    const heading = document.createElement('h2'); heading.textContent = words[stage]; column.append(heading);
    for (const task of tasks.filter(task => task.values.status === stage)) {
      const row = document.createElement('article'), title = document.createElement('span'); title.textContent = task.values.title; row.append(title);
      for (const [symbol, label, action] of [
        ['→', words.move, db => db.task.update({ key: { id: task.values.id }, rowVersion: task.rowVersion, data: { status: stages[(stages.indexOf(stage) + 1) % stages.length] } })],
        ['×', words.remove, db => db.task.delete({ key: { id: task.values.id }, rowVersion: task.rowVersion })],
      ]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = symbol;
        button.title = label; button.setAttribute('aria-label', label); button.disabled = busy;
        button.onclick = () => void mutate(action); row.append(button);
      }
      column.append(row);
    }
    board.append(column);
  }
}
async function mutate(action) {
  if (busy) return;
  const current = generation; busy = true; render();
  try { await action(await database()); if (current === generation && await load()) status.textContent = words.saved; return true; }
  catch (error) { if (current === generation) { status.textContent = error.message ?? String(error); busy = false; render(); } return false; }
}
document.querySelector('#new-task').onsubmit = event => {
  event.preventDefault(); const title = titleInput.value.trim(), selected = configurationId;
  if (title && !busy) void mutate(db => db.task.insert({ id: crypto.randomUUID(), configurationId: selected, title, status: 'todo' })).then(saved => { if (saved && selected === configurationId && titleInput.value.trim() === title) titleInput.value = ''; });
};
async function load() {
  const current = ++generation, selected = api.getConfiguration().id || 'default';
  if (configurationId !== selected) tasks = [];
  configurationId = selected; busy = true; status.textContent = ''; render();
  try {
    const db = await database(), rows = [];
    for (let page = 1; ; page++) {
      const result = await db.task.rows({ where: { configurationId: selected }, orderBy: { createdAt: 'desc', id: 'asc' }, page, pageSize: 100 });
      if (current !== generation) return;
      rows.push(...result.items); if (rows.length >= result.total || result.items.length === 0) break;
    }
    tasks = rows; busy = false;
  } catch (error) { if (current !== generation) return; status.textContent = error.message ?? String(error); }
  if (current === generation) render();
  return current === generation && !busy;
}
window.addEventListener('steamharness:kanban-configuration-change', () => {
  if ((api.getConfiguration().id || 'default') === configurationId) render(); else void load();
});
await load();
