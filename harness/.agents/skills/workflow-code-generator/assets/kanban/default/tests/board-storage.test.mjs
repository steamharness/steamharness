import assert from "node:assert/strict";
import test from "node:test";

import {
  createBoardStorageController,
  createBoardStorageKey,
  restoreBoardState,
  serializeBoardState,
} from "../board-storage.js";

const FALLBACK = {
  title: "Fallback",
  tasks: [{ id: "fallback", title: "Default", description: "", status: "todo" }],
};

test("serializes versioned tasks and falls back from damaged data", () => {
  assert.equal(createBoardStorageKey("review"), "kanban.board-state.v1:review");
  assert.equal(createBoardStorageKey(""), "kanban.board-state.v1:default");
  assert.deepEqual(serializeBoardState(FALLBACK), {
    version: 1,
    tasks: [{ id: "fallback", title: "Default", description: "", status: "todo" }],
  });
  assert.equal(restoreBoardState({ version: 2, tasks: [] }, FALLBACK), FALLBACK);
  assert.equal(restoreBoardState({ version: 1, tasks: [{ id: "bad", title: "", description: "", status: "todo" }] }, FALLBACK), FALLBACK);
  assert.deepEqual(restoreBoardState({
    version: 1,
    tasks: [{ id: "stored", title: "Saved", description: "Restored", status: "done" }],
  }, FALLBACK), {
    title: "Fallback",
    tasks: [{ id: "stored", title: "Saved", description: "Restored", status: "done" }],
  });
});

test("isolates configuration keys and ignores stale configuration reads", async () => {
  const reads = new Map();
  const kv = {
    getValue(key) {
      const request = deferred();
      reads.set(key, request);
      return request.promise;
    },
    async setValue() {},
  };
  const controller = createBoardStorageController({ kv });
  const first = controller.load("first", FALLBACK);
  await new Promise((resolve) => setImmediate(resolve));
  const second = controller.load("second", FALLBACK);
  await new Promise((resolve) => setImmediate(resolve));

  reads.get(createBoardStorageKey("second")).resolve({
    version: 1,
    tasks: [{ id: "second", title: "Second", description: "", status: "doing" }],
  });
  assert.deepEqual(await second, {
    applied: true,
    stored: true,
    state: {
      title: "Fallback",
      tasks: [{ id: "second", title: "Second", description: "", status: "doing" }],
    },
  });
  reads.get(createBoardStorageKey("first")).resolve({ version: 1, tasks: [] });
  assert.deepEqual(await first, { applied: false });
});

test("serializes saves in call order", async () => {
  const firstWrite = deferred();
  const writes = [];
  const kv = {
    async getValue() { return undefined; },
    setValue(key, value) {
      writes.push({ key, value });
      return writes.length === 1 ? firstWrite.promise : Promise.resolve();
    },
  };
  const controller = createBoardStorageController({ kv });
  await controller.load("default", FALLBACK);
  const first = controller.save({ ...FALLBACK, tasks: [] });
  const second = controller.save(FALLBACK);

  await Promise.resolve();
  assert.equal(writes.length, 1);
  firstWrite.resolve();
  await first;
  await second;
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((write) => write.value.tasks.length), [0, 1]);
});

test("does not report saved while a newer debounced state is still pending", async () => {
  const firstWrite = deferred();
  const statuses = [];
  let scheduled;
  let writes = 0;
  const controller = createBoardStorageController({
    kv: {
      async getValue() { return undefined; },
      setValue() {
        writes += 1;
        return writes === 1 ? firstWrite.promise : Promise.resolve();
      },
    },
    onStatus: (status) => statuses.push(status.state),
    schedule: (callback) => {
      scheduled = callback;
      return 1;
    },
    cancel: () => undefined,
  });
  await controller.load("default", FALLBACK);

  const first = controller.save({ ...FALLBACK, tasks: [] });
  controller.scheduleSave(FALLBACK);
  firstWrite.resolve();
  await first;
  assert.equal(statuses.at(-1), "saving");

  scheduled();
  await controller.flush();
  assert.equal(statuses.at(-1), "saved");
});

test("retains failed data and retries the same save", async () => {
  const statuses = [];
  let attempts = 0;
  const kv = {
    async getValue() { return undefined; },
    async setValue() {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    },
  };
  const controller = createBoardStorageController({
    kv,
    onStatus: (status) => statuses.push(status.state),
  });
  await controller.load("default", FALLBACK);

  await assert.rejects(controller.save(FALLBACK), /看板保存失败/);
  assert.equal(statuses.at(-1), "error");
  await controller.retrySave();
  assert.equal(attempts, 2);
  assert.equal(statuses.at(-1), "saved");
});

test("retains a failed save across configuration switches and retries it after returning", async () => {
  const writes = [];
  let failFirstWrite = true;
  const controller = createBoardStorageController({
    kv: {
      async getValue() { return undefined; },
      async setValue(key, value) {
        writes.push({ key, value });
        if (failFirstWrite) {
          failFirstWrite = false;
          throw new Error("offline");
        }
      },
    },
  });
  const edited = {
    ...FALLBACK,
    tasks: [{ id: "edited", title: "Unsaved edit", description: "kept", status: "doing" }],
  };

  await controller.load("first", FALLBACK);
  await assert.rejects(controller.save(edited), /看板保存失败/);
  await controller.load("second", FALLBACK);
  const restored = await controller.load("first", FALLBACK);

  assert.equal(restored.saveFailed, true);
  assert.deepEqual(restored.state, edited);
  await controller.retrySave();
  assert.deepEqual(writes.map((write) => write.key), [
    createBoardStorageKey("first"),
    createBoardStorageKey("first"),
  ]);
  assert.deepEqual(writes.at(-1).value, serializeBoardState(edited));
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
