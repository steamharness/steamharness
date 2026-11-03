import assert from "node:assert/strict";
import test from "node:test";
import { createTaskRepository } from "../task-repository.js";

test("retains the original binding and optimistic version after a resource rebind", async () => {
  let bound = "first", version = "1", writes = 0;
  const repository = createTaskRepository(async () => {
    const opened = bound;
    return { task: {
      async rows() { return { items: [{ rowVersion: version, values: { id: "task", configurationId: "board", title: "Before", description: "", status: "todo", position: 0 } }], total: 1 }; },
      async update(input) {
        assert.equal(input.rowVersion, "1");
        if (opened !== bound) throw new Error("DATABASE_BINDING_CHANGED");
        if (input.rowVersion !== version) throw new Error("DATABASE_ROW_CONFLICT");
        writes++; version = "2"; return { values: { id: "task", ...input.data }, rowVersion: version };
      },
    } };
  });
  const value = await repository.load("board"); value.tasks[0].title = "Draft";
  bound = "second";
  await assert.rejects(repository.save("board", value), /DATABASE_BINDING_CHANGED/);
  await assert.rejects(repository.save("board", value), /DATABASE_BINDING_CHANGED/);
  assert.equal(writes, 0);
  bound = "first"; version = "2";
  await assert.rejects(repository.save("board", value), /DATABASE_ROW_CONFLICT/);
  assert.equal(writes, 0);
});

test("an explicit load can retry an initial failure before any binding is established", async () => {
  let attempts = 0;
  const repository = createTaskRepository(async () => {
    if (++attempts === 1) throw new Error("DATABASE_UNBOUND");
    return { task: { async rows() { return { items: [], total: 0 }; } } };
  });
  await assert.rejects(repository.load("board"), /DATABASE_UNBOUND/);
  assert.deepEqual(await repository.load("board"), { version: 1, tasks: [] });
  assert.equal(attempts, 2);
});
