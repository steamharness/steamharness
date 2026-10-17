const api = window.steamHarnessKanban;
const zh = (await api.getRuntimeLocale()).toLowerCase().startsWith('zh');
const words = zh ? { todo: '\u5f85\u529e', doing: '\u8fdb\u884c\u4e2d', done: '\u5df2\u5b8c\u6210', add: '\u6dfb\u52a0\u4efb\u52a1', move: '\u79fb\u5230\u4e0b\u4e00\u5217', remove: '\u5220\u9664', saved: '\u5df2\u4fdd\u5b58', task: '\u4efb\u52a1' }
  : { todo: 'To Do', doing: 'In Progress', done: 'Done', add: 'Add Task', move: 'Move to Next Column', remove: 'Delete', saved: 'Saved', task: 'Task' };
const stages = ['todo', 'doing', 'done'];
const key = 'task-board:tasks';
let tasks = [], busy = true;
const status = document.querySelector('#status');
const titleInput = document.querySelector('#task-title');
titleInput.setAttribute('aria-label', words.task);
document.querySelector('#add-task').textContent = words.add;

function render() {
  const { params } = api.getConfiguration();
  if (params.title) document.querySelector('#title').textContent = params.title;
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
  const previous = structuredClone(tasks); busy = true;
  try { update(); render(); await api.kv.setValue(key, tasks); status.textContent = words.saved; }
  catch (error) { tasks = previous; status.textContent = error.message ?? String(error); }
  finally { busy = false; render(); }
}
document.querySelector('#new-task').onsubmit = event => {
  event.preventDefault(); const title = titleInput.value.trim();
  if (title && !busy) void mutate(() => { tasks.unshift({ id: crypto.randomUUID(), title, stage: 'todo' }); titleInput.value = ''; });
};
window.addEventListener('steamharness:kanban-configuration-change', render);
try {
  const saved = await api.kv.getValue(key);
  tasks = Array.isArray(saved) ? saved : [{ id: crypto.randomUUID(), title: zh ? '\u7b2c\u4e00\u4e2a\u4efb\u52a1' : 'First Task', stage: 'todo' }];
  if (!saved) await api.kv.setValue(key, tasks);
} catch (error) { status.textContent = error.message ?? String(error); }
busy = false; render();
