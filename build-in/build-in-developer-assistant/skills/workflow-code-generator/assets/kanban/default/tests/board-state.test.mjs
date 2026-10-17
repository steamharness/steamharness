import assert from "node:assert/strict";
import test from "node:test";

import {
  addTask,
  createInitialState,
  moveTask,
  removeTask,
  tasksForStatus,
  updateTask,
} from "../board-state.js";

test("uses fixed starter tasks instead of configuration text fields", () => {
  const state = createInitialState("交付看板");

  assert.equal(state.title, "交付看板");
  assert.deepEqual(tasksForStatus(state, "todo").map((task) => task.title), ["确认需求"]);
  assert.equal(state.tasks.length, 3);
});

test("adds, edits, moves and removes a task without mutating state", () => {
  const initial = createInitialState();
  const added = addTask(initial, { title: "编写测试", description: "覆盖拖拽", status: "todo" }, () => "task-1");
  const edited = updateTask(added, "task-1", { title: "验证拖拽", description: "", status: "doing" });
  const moved = moveTask(edited, "task-1", "done");
  const removed = removeTask(moved, "task-1");

  assert.equal(initial.tasks.length, 3);
  assert.deepEqual(edited.tasks.at(-1), { id: "task-1", title: "验证拖拽", description: "", status: "doing" });
  assert.equal(tasksForStatus(moved, "done").length, 2);
  assert.equal(removed.tasks.length, 3);
});

test("rejects missing titles and invalid target statuses", () => {
  const state = createInitialState();

  assert.throws(() => addTask(state, { title: " ", status: "todo" }, () => "task-1"), /任务名称不能为空/);
  assert.throws(() => addTask(state, { title: "任务", status: "blocked" }, () => "task-1"), /未知任务状态：blocked/);
});
