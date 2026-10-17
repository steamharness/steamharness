import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLocalWorkflowKVStore,
  createWorkflowKVContext,
  getLocalWorkflowKVEntry,
  listLocalWorkflowKVEntries,
} from "../index";

const PROJECT_ID = "demo";

function projectInput(key: string) {
  return { storageKind: "kv" as const, scope: "project" as const, projectId: PROJECT_ID, key };
}

async function createRootDir(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `workflow-code-kv-delete-${label}-`));
}

test("local KV delete removes the entry, its metadata and its inspection index row", async () => {
  const rootDir = await createRootDir("index");

  try {
    const store = createLocalWorkflowKVStore({ rootDir });
    await store.setValue({ ...projectInput("keep"), value: { keep: true } });
    await store.setValue({ ...projectInput("drop"), value: { drop: true } });

    assert.equal(await store.deleteValue(projectInput("drop")), true);
    assert.equal(await store.getValue(projectInput("drop")), undefined);
    // The detail path reads the entry file and the metadata file, so both must go.
    assert.equal(await getLocalWorkflowKVEntry({
      rootDir,
      storageKind: "kv",
      scope: "project",
      projectId: PROJECT_ID,
      key: "drop",
    }), undefined);

    const page = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv",
      scope: "project",
      projectId: PROJECT_ID,
    });
    assert.deepEqual(page.items.map((entry) => entry.key), ["keep"]);

    // Deleting again is a no-op that reports the key as already gone.
    assert.equal(await store.deleteValue(projectInput("drop")), false);
    assert.equal(await store.getValue(projectInput("keep")) instanceof Object, true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local KV delete keeps a stored null distinct from a missing entry", async () => {
  const rootDir = await createRootDir("null");

  try {
    const store = createLocalWorkflowKVStore({ rootDir });
    await store.setValue({ ...projectInput("explicit-null"), value: null });

    // A stored null is a real entry: it reads back, and delete reports a removal.
    assert.equal(await store.getValue(projectInput("explicit-null")), null);
    assert.equal(await store.deleteValue(projectInput("explicit-null")), true);
    assert.equal(await store.getValue(projectInput("explicit-null")), undefined);
    assert.equal(await store.deleteValue(projectInput("explicit-null")), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("KV context exposes deleteValue on both the project and conversation namespaces", async () => {
  const rootDir = await createRootDir("context");

  try {
    const store = createLocalWorkflowKVStore({ rootDir });
    const kv = createWorkflowKVContext({
      store,
      projectId: PROJECT_ID,
      conversationId: "conversation-1",
    });

    await kv.setValue("shared", "project value");
    await kv.conversation.setValue("shared", "conversation value");
    assert.equal(await kv.deleteValue("shared"), true);
    assert.equal(await kv.getValue("shared"), undefined);
    // Same key in the conversation scope is a different entry and must survive.
    assert.equal(await kv.conversation.getValue("shared"), "conversation value");

    assert.equal(await kv.conversation.deleteValue("shared"), true);
    assert.equal(await kv.conversation.getValue("shared"), undefined);
    assert.equal(await kv.deleteValue("shared"), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("a delete staged inside one namespace lock commits as a delete", async () => {
  const rootDir = await createRootDir("transaction");

  try {
    const store = createLocalWorkflowKVStore({ rootDir });
    await store.setValue({ ...projectInput("set-then-delete"), value: "first" });
    await store.setValue({ ...projectInput("delete-then-set"), value: "first" });

    const kv = createWorkflowKVContext({ store, projectId: PROJECT_ID });
    await kv.withLock!(async () => {
      // Staging replaces any earlier write for the same key, so the last
      // operation in the lock is the one that commits.
      await kv.setValue("set-then-delete", "second");
      assert.equal(await kv.deleteValue("set-then-delete"), true);
      assert.equal(await kv.deleteValue("delete-then-set"), true);
      await kv.setValue("delete-then-set", "second");
      // Inside the lock the staged delete already reads as absent.
      assert.equal(await kv.getValue("set-then-delete"), undefined);
    });

    assert.equal(await store.getValue(projectInput("set-then-delete")), undefined);
    assert.equal(await store.getValue(projectInput("delete-then-set")), "second");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("a crashed commit replays a staged delete from its journal", async () => {
  const rootDir = await createRootDir("recovery");

  try {
    const store = createLocalWorkflowKVStore({ rootDir });
    const input = projectInput("recovered");
    const journalPath = path.join(rootDir, ".transactions", "crashed-delete.json");
    await store.setValue({ ...input, value: "stale" });

    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      namespace: { storageKind: "kv", scope: "project", projectId: PROJECT_ID },
      writes: [{ input, deleted: true }],
    })}\n`, "utf8");

    // The journal is replayed before the read, so the delete lands and the
    // journal is retired.
    assert.equal(await store.getValue(input), undefined);
    assert.equal((await readdir(path.dirname(journalPath))).includes(path.basename(journalPath)), false);

    const page = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv",
      scope: "project",
      projectId: PROJECT_ID,
    });
    assert.deepEqual(page.items, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("a journal carrying an ambiguous delete record fails recovery loudly", async () => {
  const rootDir = await createRootDir("invalid-journal");

  try {
    const store = createLocalWorkflowKVStore({ rootDir });
    // The first operation stamps the root's storage-format marker, and an
    // unstamped root has its legacy data directories cleared. Use the store
    // once so the journal written below is the one recovery actually reads.
    assert.equal(await store.getValue(projectInput("ambiguous")), undefined);

    const journalPath = path.join(rootDir, ".transactions", "invalid-delete.json");
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      namespace: { storageKind: "kv", scope: "project", projectId: PROJECT_ID },
      // A record is a value write or a delete, never both. Recovery must refuse
      // to guess instead of silently applying one half of a corrupt record.
      writes: [{ input: projectInput("ambiguous"), deleted: true, value: "value" }],
    })}\n`, "utf8");

    await assert.rejects(
      store.getValue(projectInput("ambiguous")),
      /transaction journal is invalid/,
    );
    // The corrupt journal is left in place so the failure keeps surfacing
    // rather than being swallowed by a silent cleanup.
    assert.equal(
      (await readdir(path.dirname(journalPath))).includes(path.basename(journalPath)),
      true,
    );
    assert.equal((await readFile(journalPath, "utf8")).includes("ambiguous"), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
