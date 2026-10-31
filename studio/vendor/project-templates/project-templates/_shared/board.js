const api = window.steamHarnessKanban;
const zh = (await api.getRuntimeLocale()).toLowerCase().startsWith('zh');
const words = zh ? { todo: '\u5f85\u529e', doing: '\u8fdb\u884c\u4e2d', done: '\u5df2\u5b8c\u6210', add: '\u6dfb\u52a0\u4efb\u52a1', move: '\u79fb\u5230\u4e0b\u4e00\u5217', remove: '\u5220\u9664', saved: '\u5df2\u4fdd\u5b58', task: '\u4efb\u52a1',
  temporary: '临时模式：绑定数据库后可保存任务，刷新页面会丢失当前修改。', invalid: '保存的任务格式无效，未覆盖已有数据。' }
  : { todo: 'To Do', doing: 'In Progress', done: 'Done', add: 'Add Task', move: 'Move to Next Column', remove: 'Delete', saved: 'Saved', task: 'Task',
    temporary: 'Temporary mode: bind a database to save tasks. Reloading loses current changes.', invalid: 'Stored tasks are invalid. Existing data was not overwritten.' };
const stages = ['todo', 'doing', 'done'];
const kv = api.databases.get('data').kv;
const temporaryBoards = new Map();
let tasks = [], busy = true, temporary = false, generation = 0, key = '';
const status = document.querySelector('#status');
const titleInput = document.querySelector('#task-title');
const defaultTitle = document.querySelector('#title').textContent;
titleInput.setAttribute('aria-label', words.task);
document.querySelector('#add-task').textContent = words.add;

function render() {
  const { params } = api.getConfiguration();
  document.querySelector('#title').textContent = params.title || defaultTitle;
  document.querySelector('#add-task').disabled = busy;
  const board = document.querySelector('#board');
  board.replaceChildren();
  for (const stage of stages) {
    if (stage === 'done' && params.showDone === false) continue;
    const column = document.createElement('section'); column.className = `column ${stage}`;
    const heading = document.createElement('h2'); heading.textContent = words[stage]; column.append(heading);
    for (const task of tasks.filter(task => task.stage === stage)) {
      const row = document.createElement('article'), title = document.createElement('span'); title.textContent = task.title;
      row.append(title);
      for (const [symbol, label, update] of [
        ['\u2192', words.move, () => { task.stage = stages[(stages.indexOf(stage) + 1) % stages.length]; }],
        ['\u00d7', words.remove, () => { tasks = tasks.filter(entry => entry.id !== task.id); }],
      ]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = symbol;
        button.title = label; button.setAttribute('aria-label', label); button.disabled = busy;
        button.onclick = () => void mutate(update); row.append(button);
      }
      column.append(row);
    }
    board.append(column);
  }
}
async function mutate(update) {
  if (busy) return;
  const previous = structuredClone(tasks), current = generation, storageKey = key; busy = true;
  try {
    update(); render();
    if (temporary) temporaryBoards.set(storageKey, structuredClone(tasks));
    else await kv.setValue(storageKey, structuredClone(tasks));
    if (current === generation) status.textContent = temporary ? words.temporary : words.saved;
  }
  catch (error) { if (current === generation) { tasks = previous; status.textContent = error.message ?? String(error); } }
  finally { if (current === generation) { busy = false; render(); } }
}
document.querySelector('#new-task').onsubmit = event => {
  event.preventDefault(); const title = titleInput.value.trim();
  if (title && !busy) void mutate(() => { tasks.unshift({ id: crypto.randomUUID(), title, stage: 'todo' }); titleInput.value = ''; });
};
const storageKey = () => `task-board:tasks:${api.getConfiguration().id || 'default'}`;
async function load() {
  const current = ++generation; key = storageKey(); busy = true; temporary = false; tasks = []; status.textContent = ''; render();
  const initial = () => [{ id: crypto.randomUUID(), title: zh ? '\u7b2c\u4e00\u4e2a\u4efb\u52a1' : 'First Task', stage: 'todo' }];
  try {
    const saved = await kv.getValue(key);
    if (current !== generation) return;
    if (saved != null && (!Array.isArray(saved) || !saved.every(task => task && typeof task.id === 'string' && typeof task.title === 'string' && stages.includes(task.stage)))) {
      throw new Error(words.invalid);
    }
    tasks = saved ?? initial();
    busy = false;
  } catch (error) {
    if (current !== generation) return;
    if (error.code === 'DATABASE_UNBOUND') {
      temporary = true; tasks = temporaryBoards.get(key) ?? initial(); busy = false; status.textContent = words.temporary;
    } else status.textContent = error.message ?? String(error);
  }
  if (current === generation) render();
}
window.addEventListener('steamharness:kanban-configuration-change', () => {
  if (storageKey() === key) render(); else void load();
});
await load();
