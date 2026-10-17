import assert from "node:assert/strict";
import test from "node:test";
import { createKanbanRevisionBatcher } from "../kanban-revision-batcher";

test("Kanban revision batches keep only the latest revision per source", async () => {
  const validationStarted = deferred<void>();
  const allowValidation = deferred<void>();
  const published = deferred<void>();
  const events: Array<{ projectId: string; revision: string }> = [];
  let validations = 0;
  const batcher = createKanbanRevisionBatcher({
    isClosed: () => false,
    validate: async () => {
      validations += 1;
      validationStarted.resolve(undefined);
      await allowValidation.promise;
    },
    publish: (projectId, revision) => {
      events.push({ projectId, revision });
      published.resolve(undefined);
    },
    onUnavailable: async () => undefined,
  });

  batcher.remember("stocks", "1");
  batcher.enqueue("stocks", "1");
  batcher.enqueue("stocks", "2");
  batcher.enqueue("stocks", "3");
  await validationStarted.promise;

  assert.equal(validations, 1);
  batcher.enqueue("stocks", "4");
  allowValidation.resolve(undefined);
  await published.promise;
  assert.equal(validations, 1);
  assert.deepEqual(events, [{ projectId: "stocks", revision: "4" }]);
});

test("Kanban revision validation failures close the stream without publishing", async () => {
  const unavailable = deferred<void>();
  let published = false;
  let closed = false;
  const batcher = createKanbanRevisionBatcher({
    isClosed: () => closed,
    validate: async () => {
      throw new Error("permission revoked");
    },
    publish: () => {
      published = true;
    },
    onUnavailable: async () => {
      closed = true;
      unavailable.resolve(undefined);
    },
  });

  batcher.enqueue("stocks", "2");
  await unavailable.promise;
  assert.equal(published, false);
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
