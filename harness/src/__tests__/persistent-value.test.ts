import { mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { serializeProjectError } from '../workflow/errors';
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createLocalProjectKVStore,
  createKnowledgeDocument,
  createProjectKVContext,
  createProjectPersistentValueContext,
  deleteKnowledgeDocument,
  editKnowledgeDocument,
  runLocalProjectWithReport,
  HarnessError,
  type KVStore,
} from "../index";

const PERSISTENT_TEST_PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("persistentValue writes current-project and conversation scopes through the injected store", async () => {
  const store = createMemoryKVStore();
  const persistentValue = createProjectPersistentValueContext({
    store,
    projectId: "demo",
    conversationId: "conv-1",
    source: { projectId: "demo", runId: "run-1", conversationId: "conv-1" },
  });

  await persistentValue.setValue("project-key", { count: 1 });
  await persistentValue.conversation.setValue("conversation-key", true);

  assert.deepEqual(await persistentValue.getValue("project-key"), { count: 1 });
  assert.equal(await persistentValue.conversation.getValue("conversation-key"), true);
  assert.deepEqual(store.sources.get("persistent_value:conversation:demo:conv-1:conversation-key"), {
    projectId: "demo",
    runId: "run-1",
    conversationId: "conv-1",
  });
});

test("persistentValue updateValue uses the injected store", async () => {
  const persistentValue = createProjectPersistentValueContext({
    store: createMemoryKVStore(),
    projectId: "demo",
  });

  const first = await persistentValue.updateValue("count", (current) => Number(current ?? 0) + 1);
  const second = await persistentValue.updateValue("count", (current) => Number(current ?? 0) + 1);

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(await persistentValue.getValue("count"), 2);
});

test("persistentValue without a server store fails on get set and update calls", async () => {
  const persistentValue = createProjectPersistentValueContext({
    projectId: "demo",
    conversationId: "conv-1",
  });

  await assertPersistentValueUnavailable(() => persistentValue.getValue("project-key"));
  await assertPersistentValueUnavailable(() => persistentValue.setValue("project-key", "value"));
  await assertPersistentValueUnavailable(() => persistentValue.conversation.updateValue("conversation-key", () => "value"));
});

test("local kv fallback remains usable when persistentValue is unavailable", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-persistent-value-test-"));
  const kv = createProjectKVContext({
    store: createLocalProjectKVStore({ rootDir }),
    projectId: "demo",
  });
  const persistentValue = createProjectPersistentValueContext({
    projectId: "demo",
  });

  await kv.setValue("local-key", "local-value");

  assert.equal(await kv.getValue("local-key"), "local-value");
  await assertPersistentValueUnavailable(() => persistentValue.getValue("local-key"));
});

test("local KV immediately recovers a fresh lock left by a dead process", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-kv-dead-owner-"));
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(exited.status, 0);
  assert.ok(exited.pid > 0);
  try {
    await writeFile(path.join(rootDir, ".workflow-storage-format.json.lock"), JSON.stringify({
      token: "crashed-owner", pid: exited.pid, createdAt: new Date().toISOString(),
    }));
    const kv = createProjectKVContext({ store: createLocalProjectKVStore({ rootDir }), projectId: "demo" });
    await kv.setValue("recovered", true);
    assert.equal(await kv.getValue("recovered"), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("concurrent stale-lock recovery cannot remove another recovery's newly acquired lock", async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-kv-concurrent-recovery-"));
  const lockPath = path.join(rootDir, ".workflow-storage-format.json.lock");
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(exited.status, 0);
  await writeFile(lockPath, JSON.stringify({ token: "crashed-owner", pid: exited.pid, createdAt: new Date().toISOString() }));
  const originalRm = fs.promises.rm;
  let first = true, reclaiming = false, overlapping = false;
  let reached!: () => void, contested!: () => void;
  const firstReclaim = new Promise<void>(resolve => { reached = resolve; });
  const secondReclaim = new Promise<void>(resolve => { contested = resolve; });
  t.mock.method(fs.promises, "rm", async (...args: Parameters<typeof originalRm>) => {
    if (String(args[0]) === lockPath) {
      if (first) {
        first = false; reclaiming = true; reached();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([secondReclaim, new Promise<void>(resolve => { timer = setTimeout(resolve, 200); })]); }
        finally { clearTimeout(timer); reclaiming = false; }
      } else if (reclaiming) { overlapping = true; contested(); }
    }
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  try {
    const left = createProjectKVContext({ store: createLocalProjectKVStore({ rootDir }), projectId: "left" });
    const writing = left.setValue("value", 1);
    await firstReclaim;
    const right = createProjectKVContext({ store: createLocalProjectKVStore({ rootDir }), projectId: "right" });
    await Promise.all([writing, right.setValue("value", 2)]);
    assert.equal(overlapping, false, "stale deletions must be serialized until the owner is rechecked");
    assert.equal(await left.getValue("value"), 1); assert.equal(await right.getValue("value"), 2);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local KV reuses same-namespace locks and rejects cross-namespace access", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-persistent-value-nested-lock-"));
  const store = createLocalProjectKVStore({ rootDir });

  try {
    const withNamespaceLock = store.withNamespaceLock;
    if (withNamespaceLock === undefined) {
      throw new Error("Local KV store must expose namespace locks.");
    }
    const updateValue = store.updateValue;
    if (updateValue === undefined) {
      throw new Error("Local KV store must expose atomic updates.");
    }
    await withNamespaceLock(
      { storageKind: "kv", scope: "project", projectId: "outer" },
      async () => {
        await store.setValue({
          storageKind: "kv",
          scope: "project",
          projectId: "outer",
          key: "value",
          value: "outer",
        });
        await withNamespaceLock(
          { storageKind: "kv", scope: "project", projectId: "outer" },
          async () => {
            assert.equal(await store.getValue({
              storageKind: "kv",
              scope: "project",
              projectId: "outer",
              key: "value",
            }), "outer");
            await updateValue({
              storageKind: "kv",
              scope: "project",
              projectId: "outer",
              key: "value",
            }, (value) => `${value}-updated`);
          },
        );

        await assert.rejects(
          () => withNamespaceLock(
            { storageKind: "kv", scope: "project", projectId: "inner" },
            async () => undefined,
          ),
          /cannot access a different namespace while holding a lock/,
        );
        await assert.rejects(
          () => store.getValue({ storageKind: "kv", scope: "project", projectId: "inner", key: "value" }),
          /cannot access a different namespace while holding a lock/,
        );
        await assert.rejects(
          () => store.setValue({ storageKind: "kv", scope: "project", projectId: "inner", key: "value", value: "inner" }),
          /cannot access a different namespace while holding a lock/,
        );
        await assert.rejects(
          () => updateValue(
            { storageKind: "kv", scope: "project", projectId: "inner", key: "value" },
            () => "inner",
          ),
          /cannot access a different namespace while holding a lock/,
        );
      },
    );

    assert.equal(await store.getValue({ storageKind: "kv", scope: "project", projectId: "outer", key: "value" }), "outer-updated");
    assert.equal(await store.getValue({ storageKind: "kv", scope: "project", projectId: "inner", key: "value" }), undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("knowledge mutations reject PersistentValue stores without an atomic namespace capability", async () => {
  const store = createMemoryKVStore();
  const persistentValue = createProjectPersistentValueContext({
    store,
    projectId: "demo",
  });

  await assert.rejects(
    () => createKnowledgeDocument({ persistentValue }, {
      id: "guide",
      title: "Guide",
      markdown: "body",
    }),
    /require an atomic PersistentValue namespace lock or mutation executor/,
  );
  assert.equal(await persistentValue.getValue("knowledge.document.guide"), undefined);
});

test("persistentValue conversation scope still requires a conversation id", async () => {
  const persistentValue = createProjectPersistentValueContext({
    store: createMemoryKVStore(),
    projectId: "demo",
  });

  await assert.rejects(
    () => persistentValue.conversation.setValue("conversation-key", "value"),
    (error) =>
      error instanceof HarnessError &&
      error.message === "Workflow KV conversation scope requires a conversation id.",
  );
});

async function assertPersistentValueUnavailable(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    operation,
    (error) =>
      error instanceof HarnessError &&
      error.message.includes("Workflow PersistentValue requires"),
  );
}

function createMemoryKVStore(): KVStore & {
  values: Map<string, unknown>;
  sources: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  const sources = new Map<string, unknown>();

  function createKey(input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }): string {
    return [
      input.storageKind,
      input.scope,
      input.projectId,
      input.conversationId ?? "",
      input.key,
    ].join(":");
  }

  return {
    values,
    sources,
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      values.set(createKey(input), input.value);
      sources.set(createKey(input), input.source);
    },
    async deleteValue(input) {
      sources.delete(createKey(input));
      return values.delete(createKey(input));
    },
    async updateValue(input, updater) {
      const key = createKey(input);
      const next = updater(values.get(key));
      values.set(key, next);
      sources.set(key, input.source);
      return next;
    },
  };
}

async function listenPersistentValueServer(
  handle: (body: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<{
  url: string;
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}> {
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      authorizations.push(request.headers.authorization);
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const payload = await handle(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      })();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    authorizations,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
