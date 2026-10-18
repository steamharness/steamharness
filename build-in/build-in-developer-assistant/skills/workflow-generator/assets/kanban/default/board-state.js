export const STATUSES = ["todo", "doing", "done"];

export const STATUS_LABELS = {
  todo: "待处理",
  doing: "进行中",
  done: "已完成",
};

const DEFAULT_TASKS = [
  { id: "sample-requirements", title: "确认需求", description: "明确本轮交付范围和验收标准。", status: "todo" },
  { id: "sample-implementation", title: "实现看板交互", description: "在看板内完成任务的新建、编辑和删除。", status: "doing" },
  { id: "sample-project-type", title: "完成项目类型设计", description: "Kanban 已使用独立 HTML 入口。", status: "done" },
];

function normalizeText(value) {
  return String(value ?? "").trim();
}

function assertStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`未知任务状态：${status}`);
  }
}

function createTask({ id, title, description = "", status }) {
  assertStatus(status);
  const normalizedTitle = normalizeText(title);
  const normalizedId = normalizeText(id);

  if (!normalizedId) throw new Error("任务 ID 不能为空");
  if (!normalizedTitle) throw new Error("任务名称不能为空");

  return {
    id: normalizedId,
    title: normalizedTitle,
    description: normalizeText(description),
    status,
  };
}

export function createInitialState(title = "{{name}}") {
  return {
    title: normalizeText(title) || "{{name}}",
    tasks: DEFAULT_TASKS.map((task) => ({ ...task })),
  };
}

export function addTask(state, values, createId = () => crypto.randomUUID()) {
  const task = createTask({ ...values, id: createId() });
  return { ...state, tasks: [...state.tasks, task] };
}

export function updateTask(state, taskId, values) {
  const existingTask = state.tasks.find((task) => task.id === taskId);
  if (!existingTask) throw new Error("未找到任务");

  const updatedTask = createTask({ ...existingTask, ...values, id: existingTask.id });
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? updatedTask : task)),
  };
}

export function moveTask(state, taskId, status) {
  return updateTask(state, taskId, { status });
}

export function removeTask(state, taskId) {
  if (!state.tasks.some((task) => task.id === taskId)) throw new Error("未找到任务");
  return { ...state, tasks: state.tasks.filter((task) => task.id !== taskId) };
}

export function tasksForStatus(state, status) {
  assertStatus(status);
  return state.tasks.filter((task) => task.status === status);
}
