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
  createRemoteProjectRelatedProjectKVStoreFromEnv,
  createRemoteProjectStorageStoreFromEnv,
  RemoteProjectStorageStore,
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

test('remote storage failures retain the real project and relation through report serialization without credentials', async t => {
  const consumerProjectId = '22222222-2222-4222-8222-222222222222';
  for (const status of [401, 403, 404]) {
    const fetcher = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ errCode: status, errMessage: 'Project or group does not exist.' }), { status }));
    try {
      const store = new RemoteProjectStorageStore({ serverUrl: 'https://project.test/', token: 'private-token', projectId: PERSISTENT_TEST_PROJECT_ID,
        storageKind: 'kv', relatedProject: { consumerProjectId, alias: 'database' } });
      await assert.rejects(store.getValue({ storageKind: 'kv', scope: 'project', projectId: PERSISTENT_TEST_PROJECT_ID, key: '@index/knowledge.v1' }), error => {
        assert.ok(error instanceof HarnessError);
        const serialized = serializeProjectError(error);
        assert.deepEqual(serialized.metadata, { code: 'PROJECT_SERVER_ACCESS_FAILED', serverUrl: 'https://project.test', projectId: PERSISTENT_TEST_PROJECT_ID,
          consumerProjectId, relatedProjectAlias: 'database', storageKind: 'kv', operation: 'get', key: '@index/knowledge.v1', status, errCode: status, data: undefined });
        assert.ok(!JSON.stringify(serialized).includes('private-token')); return true;
      });
    } finally { fetcher.mock.restore(); }
  }
  const fetcher = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  try {
    const store = new RemoteProjectStorageStore({ serverUrl: 'https://project.test', token: 'private-token', projectId: PERSISTENT_TEST_PROJECT_ID, storageKind: 'kv' });
    await assert.rejects(store.getValue({ storageKind: 'kv', scope: 'project', projectId: PERSISTENT_TEST_PROJECT_ID, key: 'data' }), error => {
      assert.ok(error instanceof HarnessError); assert.equal(error.metadata?.code, 'PROJECT_SERVER_ACCESS_FAILED'); assert.equal(error.metadata?.projectId, PERSISTENT_TEST_PROJECT_ID); return true;
    });
  } finally { fetcher.mock.restore(); }
});

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

test("remote persistentValue store proxies get and set through server API", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = await listenPersistentValueServer(async (body) => {
    requests.push(body);
    if (body["operation"] === "get") {
      return {
        errCode: 0,
        errMessage: "",
        data: { exists: true, value: "remote-value" },
      };
    }
    return {
      errCode: 0,
      errMessage: "",
      data: { ok: true },
    };
  });
  const store = new RemoteProjectStorageStore({
    serverUrl: server.url,
    token: "server-token",
    projectId: PERSISTENT_TEST_PROJECT_ID,
    storageKind: "persistent_value",
  });

  try {
    await store.setValue({
      storageKind: "persistent_value",
      scope: "conversation",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      conversationId: "conv-1",
      key: "remote-key",
      value: { saved: true },
      source: { projectId: PERSISTENT_TEST_PROJECT_ID, runId: "run-1", conversationId: "conv-1" },
    });

    assert.equal(await store.getValue({
      storageKind: "persistent_value",
      scope: "project",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      key: "remote-key",
    }), "remote-value");
    assert.deepEqual(requests.map((request) => request["operation"]), ["set", "get"]);
    assert.equal(requests[0]?.["projectId"], PERSISTENT_TEST_PROJECT_ID);
    assert.deepEqual((requests[0]?.["entry"] as Record<string, unknown>), {
      storageKind: "persistent_value",
      scope: "conversation",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      conversationId: "conv-1",
      key: "remote-key",
    });
    assert.deepEqual(requests[0]?.["source"], {
      projectId: PERSISTENT_TEST_PROJECT_ID,
      runId: "run-1",
      conversationId: "conv-1",
    });
    assert.equal(server.authorizations[0], "Bearer server-token");
  } finally {
    await server.close();
  }
});

test("remote store proxies delete and reports whether the server removed an entry", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const removed = [true, false];
  const server = await listenPersistentValueServer(async (body) => {
    requests.push(body);
    assert.equal(body["operation"], "delete");
    return {
      errCode: 0,
      errMessage: "",
      data: { removed: removed.shift() ?? false },
    };
  });
  const store = new RemoteProjectStorageStore({
    serverUrl: server.url,
    token: "server-token",
    projectId: PERSISTENT_TEST_PROJECT_ID,
    storageKind: "kv",
  });
  const input = {
    storageKind: "kv" as const,
    scope: "conversation" as const,
    projectId: PERSISTENT_TEST_PROJECT_ID,
    conversationId: "conv-1",
    key: "remote-key",
  };

  try {
    assert.equal(await store.deleteValue(input), true);
    // An already-absent key is a successful no-op, not an error.
    assert.equal(await store.deleteValue(input), false);
    assert.deepEqual(requests[0]?.["entry"], {
      storageKind: "kv",
      scope: "conversation",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      conversationId: "conv-1",
      key: "remote-key",
    });
    assert.equal("value" in (requests[0] ?? {}), false);
  } finally {
    await server.close();
  }
});

test("remote store rejects a delete response without a removal flag", async () => {
  const server = await listenPersistentValueServer(async () => ({
    errCode: 0,
    errMessage: "",
    data: { ok: true },
  }));
  const store = new RemoteProjectStorageStore({
    serverUrl: server.url,
    token: "server-token",
    projectId: PERSISTENT_TEST_PROJECT_ID,
    storageKind: "kv",
  });

  try {
    await assert.rejects(
      () => store.deleteValue({
        storageKind: "kv",
        scope: "project",
        projectId: PERSISTENT_TEST_PROJECT_ID,
        key: "remote-key",
      }),
      /invalid delete result/,
    );
  } finally {
    await server.close();
  }
});

test("remote related-project KV addresses the consumer alias without sending the target UUID", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = await listenPersistentValueServer(async (body) => {
    requests.push(body);
    return body["operation"] === "get"
      ? { errCode: 0, errMessage: "", data: { exists: true, value: "related", revision: "1" } }
      : { errCode: 0, errMessage: "", data: { ok: true } };
  });
  const consumerProjectId = "99999999-9999-4999-8999-999999999999";
  const store = createRemoteProjectRelatedProjectKVStoreFromEnv({
    consumerProjectId,
    targetProjectId: PERSISTENT_TEST_PROJECT_ID,
    alias: "inventory",
    env: {
      STEAMHARNESS_SERVER_URL: server.url,
      STEAMHARNESS_SERVER_ADMIN_KEY: "server-token",
    } as NodeJS.ProcessEnv,
  });
  assert.ok(store);

  try {
    assert.equal(await store.getValue({
      storageKind: "kv",
      scope: "project",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      key: "catalog:item",
    }), "related");
    await store.setValue({
      storageKind: "kv",
      scope: "project",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      key: "catalog:item",
      value: { stock: 3 },
    });

    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request["consumerProjectId"], consumerProjectId);
      assert.equal(request["alias"], "inventory");
      assert.equal("projectId" in request, false);
      const entry = request["entry"] as Record<string, unknown>;
      assert.equal("projectId" in entry, false);
      assert.equal(entry["scope"], "project");
    }
  } finally {
    await server.close();
  }
});

test("remote persistentValue updateValue retries a compare-and-set conflict", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let value = 0;
  let revision = "100";
  let conflictOnce = true;
  const server = await listenPersistentValueServer(async (body) => {
    requests.push(body);
    if (body["operation"] === "get") {
      return { errCode: 0, errMessage: "", data: { exists: true, value, revision } };
    }
    if (body["operation"] === "compare-and-set") {
      if (conflictOnce) {
        conflictOnce = false;
        value = 1;
        revision = "101";
        return { errCode: 0, errMessage: "", data: { applied: false } };
      }
      if (body["expectedRevision"] !== revision) {
        return { errCode: 0, errMessage: "", data: { applied: false } };
      }
      value = body["value"] as number;
      revision = "102";
      return { errCode: 0, errMessage: "", data: { applied: true, revision } };
    }
    return { errCode: 400, errMessage: "Expected get or compare-and-set." };
  });
  const store = new RemoteProjectStorageStore({
    serverUrl: server.url,
    token: "server-token",
    projectId: PERSISTENT_TEST_PROJECT_ID,
    storageKind: "persistent_value",
  });

  try {
    const result = await store.updateValue({
      storageKind: "persistent_value",
      scope: "project",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      key: "counter",
      source: { projectId: PERSISTENT_TEST_PROJECT_ID, runId: "run-1" },
    }, (current) => Number(current ?? 0) + 1);

    assert.equal(result, 2);
    assert.equal(value, 2);
    assert.deepEqual(requests.map((request) => request["operation"]), [
      "get",
      "compare-and-set",
      "get",
      "compare-and-set",
    ]);
    assert.equal(requests[1]?.["expectedRevision"], "100");
    assert.equal(requests[3]?.["expectedRevision"], "101");
    assert.deepEqual(requests[3]?.["source"], {
      projectId: PERSISTENT_TEST_PROJECT_ID,
      runId: "run-1",
    });
  } finally {
    await server.close();
  }
});

test("remote persistentValue updateValue rejects an unversioned server response", async () => {
  const server = await listenPersistentValueServer(async (body) => {
    if (body["operation"] === "get") {
      return { errCode: 0, errMessage: "", data: { exists: true, value: 1 } };
    }
    return { errCode: 400, errMessage: "compare-and-set must not be called without a revision." };
  });
  const store = new RemoteProjectStorageStore({
    serverUrl: server.url,
    token: "server-token",
    projectId: PERSISTENT_TEST_PROJECT_ID,
    storageKind: "persistent_value",
  });

  try {
    await assert.rejects(
      () => store.updateValue({
        storageKind: "persistent_value",
        scope: "project",
        projectId: PERSISTENT_TEST_PROJECT_ID,
        key: "counter",
      }, (current) => current),
      /did not return a revision/,
    );
    assert.equal(server.authorizations.length, 1);
  } finally {
    await server.close();
  }
});

test("remote persistentValue sends each knowledge mutation as one atomic server request", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const documents = new Map<string, {
    id: string;
    title: string;
    markdown: string;
    createdAt: string;
    updatedAt: string;
  }>();
  let sequence = 0;
  const server = await listenPersistentValueServer(async (body) => {
    requests.push(body);
    if (body["operation"] !== "knowledge-mutation") {
      return { errCode: 400, errMessage: "Expected a knowledge mutation." };
    }

    const mutation = body["mutation"] as Record<string, unknown>;
    const input = mutation["input"] as Record<string, unknown>;
    const updatedAt = `2026-07-13T00:00:${String(sequence += 1).padStart(2, "0")}.000Z`;
    switch (mutation["type"]) {
      case "create": {
        const document = {
          id: input["id"] as string,
          title: input["title"] as string,
          markdown: input["markdown"] as string,
          createdAt: updatedAt,
          updatedAt,
        };
        documents.set(document.id, document);
        return { errCode: 0, errMessage: "", data: document };
      }
      case "edit": {
        const documentId = input["documentId"] as string;
        const current = documents.get(documentId);
        if (current === undefined) {
          return { errCode: 404, errMessage: "Knowledge document does not exist." };
        }
        const document = {
          ...current,
          ...(input["title"] === undefined ? {} : { title: input["title"] as string }),
          ...(input["markdown"] === undefined ? {} : { markdown: input["markdown"] as string }),
          updatedAt,
        };
        documents.set(document.id, document);
        return { errCode: 0, errMessage: "", data: document };
      }
      case "delete": {
        const documentId = input["documentId"] as string;
        const deleted = documents.delete(documentId);
        return { errCode: 0, errMessage: "", data: { id: documentId, deleted } };
      }
      default:
        return { errCode: 400, errMessage: "Unsupported knowledge mutation." };
    }
  });
  const persistentValue = createProjectPersistentValueContext({
    store: new RemoteProjectStorageStore({
      serverUrl: server.url,
      token: "server-token",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      storageKind: "persistent_value",
    }),
    projectId: PERSISTENT_TEST_PROJECT_ID,
  });
  const context = { persistentValue };

  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      createKnowledgeDocument(context, {
        id: `document-${index}`,
        title: `Document ${index}`,
        markdown: `body ${index}`,
      })
    ));
    const edited = await editKnowledgeDocument(context, {
      id: "document-0",
      title: "Document 0 edited",
    });
    const deleted = await deleteKnowledgeDocument(context, "document-1");

    assert.equal(documents.size, 7);
    assert.equal(documents.get("document-0")?.title, "Document 0 edited");
    assert.equal(edited.id, "document-0");
    assert.deepEqual(deleted, { id: "document-1", deleted: true });
    assert.equal(requests.length, 10);
    assert.deepEqual(
      requests.map((request) => request["operation"]),
      Array.from({ length: 10 }, () => "knowledge-mutation"),
    );
    assert.deepEqual(requests[0]?.["namespace"], {
      storageKind: "persistent_value",
      scope: "project",
      projectId: PERSISTENT_TEST_PROJECT_ID,
    });
    assert.deepEqual(
      requests.map((request) => (request["mutation"] as Record<string, unknown>)["type"]),
      [
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
        "edit",
        "delete",
      ],
    );
    assert.deepEqual((requests[8]?.["mutation"] as Record<string, unknown>)["input"], {
      documentId: "document-0",
      title: "Document 0 edited",
    });
  } finally {
    await server.close();
  }
});

test("remote persistentValue store from env reads server connection", () => {
  const store = createRemoteProjectStorageStoreFromEnv(PERSISTENT_TEST_PROJECT_ID, "persistent_value", {
    STEAMHARNESS_SERVER_URL: " http://127.0.0.1:8787/ ",
    STEAMHARNESS_SERVER_ADMIN_KEY: " token ",
  } as NodeJS.ProcessEnv);

  assert.ok(store instanceof RemoteProjectStorageStore);
});

test("remote persistentValue store from env falls back to saved CLI auth file", async () => {
  const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-persistent-auth-"));
  await writeFile(
    path.join(authDir, "workflow-auth.json"),
    JSON.stringify({
      serverUrl: "http://127.0.0.1:7125",
      apiKey: "saved-api-key",
      source: "device_flow",
    }),
    "utf8",
  );

  const store = createRemoteProjectStorageStoreFromEnv(PERSISTENT_TEST_PROJECT_ID, "persistent_value", {
    STEAMHARNESS_CLI_AUTH_DIR: authDir,
  } as NodeJS.ProcessEnv);

  assert.ok(store instanceof RemoteProjectStorageStore);
});

test("local workflow uses configured server PersistentValue store", async () => {
  const projectDir = await createPersistentValueProject("server");
  const requests: Array<Record<string, unknown>> = [];
  const values = new Map<string, unknown>();
  const server = await listenPersistentValueServer(async (body) => {
    requests.push(body);
    const entry = body["entry"] as Record<string, unknown>;
    const key = `${entry["storageKind"]}:${entry["scope"]}:${entry["projectId"] ?? ""}:${entry["conversationId"] ?? ""}:${entry["key"]}`;
    if (body["operation"] === "get") {
      return values.has(key)
        ? { errCode: 0, errMessage: "", data: { exists: true, value: values.get(key) } }
        : { errCode: 0, errMessage: "", data: { exists: false } };
    }
    values.set(key, body["value"]);
    return { errCode: 0, errMessage: "", data: { ok: true } };
  });

  try {
    const report = await runLocalProjectWithReport({
      projectDir,
      env: {
        STEAMHARNESS_SERVER_URL: server.url,
        STEAMHARNESS_SERVER_ADMIN_KEY: "server-token",
      } as NodeJS.ProcessEnv,
    });

    assert.equal(report.status, "success");
    assert.equal(values.get(`persistent_value:project:${PERSISTENT_TEST_PROJECT_ID}::local-key`), "from-local-run");
    assert.deepEqual(requests.map((request) => request["operation"]), ["set"]);
  } finally {
    await server.close();
  }
});

test("local workflow uses an explicit local PersistentValue directory before remote env", async () => {
  const projectDir = await createPersistentValueProject();
  const persistentValueStoreDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-local-persistent-value-"));

  try {
    const report = await runLocalProjectWithReport({
      projectDir,
      storage: {
        host: "local",
        local: { persistentValueStoreDir },
      },
      env: {
        STEAMHARNESS_SERVER_URL: "http://127.0.0.1:1",
        STEAMHARNESS_SERVER_ADMIN_KEY: "remote-token",
      } as NodeJS.ProcessEnv,
    });

    assert.equal(report.status, "success");
    const localStore = createLocalProjectKVStore({ rootDir: persistentValueStoreDir, storageKind: "persistent_value" });
    assert.equal(await localStore.getValue({
      storageKind: "persistent_value",
      scope: "project",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      key: "local-key",
    }), "from-local-run");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(persistentValueStoreDir, { recursive: true, force: true });
  }
});

test("injected PersistentValue store takes priority over an explicit local directory", async () => {
  const projectDir = await createPersistentValueProject();
  const persistentValueStoreDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-local-persistent-value-"));
  const persistentValueStore = createMemoryKVStore();

  try {
    const report = await runLocalProjectWithReport({
      projectDir,
      storage: {
        host: "local",
        local: { persistentValueStore, persistentValueStoreDir },
      },
      env: {
        STEAMHARNESS_SERVER_URL: "http://127.0.0.1:1",
        STEAMHARNESS_SERVER_ADMIN_KEY: "remote-token",
      } as NodeJS.ProcessEnv,
    });

    assert.equal(report.status, "success");
    assert.equal(
      persistentValueStore.values.get(`persistent_value:project:${PERSISTENT_TEST_PROJECT_ID}::local-key`),
      "from-local-run",
    );
    const localStore = createLocalProjectKVStore({ rootDir: persistentValueStoreDir, storageKind: "persistent_value" });
    assert.equal(await localStore.getValue({
      storageKind: "persistent_value",
      scope: "project",
      projectId: PERSISTENT_TEST_PROJECT_ID,
      key: "local-key",
    }), undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(persistentValueStoreDir, { recursive: true, force: true });
  }
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

async function createPersistentValueProject(
  storageLocation: "local" | "server" = "local",
): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-persistent-local-"));
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({
      id: PERSISTENT_TEST_PROJECT_ID,
      type: "module",
      steamHarness: {
        projectInfo: {
          dataStorage: { mode: storageLocation },
        },
      },
    }),
  );
  await writeFile(
    path.join(projectDir, "index.ts"),
    [
      "const outputNode = steamharness.createOutputNode({",
      "  name: \"output\",",
      "  format() {",
      "    return { errCode: 0, errMessage: \"\", items: [] };",
      "  },",
      "});",
      "",
      "export const persistentCliProject = steamharness.defineProject({",
      "  name: \"persistent-cli-test\",",
      "  async run(input, context) {",
      `    await context.storage.${storageLocation}.persistentValue.setValue("local-key", "from-local-run");`,
      "    return steamharness.runNode(outputNode, input, context);",
      "  },",
      "});",
      "",
      "export const executor = steamharness.defineExecutor({",
      "  projectType: \"workflow\",",
      "  defaultEntrypoint: \"main\",",
      "  entrypoints: [steamharness.defineEntrypoint({",
      "    id: \"main\", title: \"Main\", workflow: persistentCliProject,",
      "    createInput() { return {}; },",
      "  })],",
      "});",
      "",
      "export { persistentCliProject as workflow };",
      "export default persistentCliProject;",
      "",
    ].join("\n"),
  );

  return projectDir;
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
