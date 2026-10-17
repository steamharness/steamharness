import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  createKnowledgeDocument,
  createLocalWorkflowKVStore,
  createLocalWorkflowPersistentValueContext,
  createWorkflowPersistentValueContext,
  getKnowledgeDocument,
  getLocalWorkflowKVEntry,
  listKnowledgeDocumentPage,
  listLocalWorkflowKVEntries,
} from "../index";

test("local KV inspection returns paged summaries without embedding values", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-kv-inspection-"));
  const store = createLocalWorkflowKVStore({ rootDir });
  const largeValue = "x".repeat(2_048);

  try {
    await store.setValue({
      storageKind: "kv", scope: "project",
      projectId: "demo",
      key: "large",
      value: largeValue,
      source: { projectId: "demo", runId: "run-large", conversationId: "conversation-1" },
    });
    await store.setValue({
      storageKind: "kv", scope: "project",
      projectId: "demo",
      key: "settings",
      value: { enabled: true },
      source: { projectId: "demo", runId: "run-settings" },
    });
    await store.setValue({
      storageKind: "kv", scope: "project",
      projectId: "demo",
      key: "count",
      value: 3,
    });
    await store.setValue({
      storageKind: "kv", scope: "project",
      projectId: "other-project",
      key: "other",
      value: "ignored by workflow filter",
    });

    const firstPage = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      pageSize: 1,
    });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);
    assert.equal("value" in firstPage.items[0]!, false);

    const secondPage = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      pageSize: 2,
      cursor: firstPage.nextCursor,
    });
    assert.equal(secondPage.total, 3);
    assert.equal(secondPage.items.length, 2);
    assert.equal(secondPage.hasMore, false);
    assert.deepEqual(
      new Set([...firstPage.items, ...secondPage.items].map((entry) => entry.key)),
      new Set(["large", "settings", "count"]),
    );

    const allEntries = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      pageSize: 3,
    });
    const largeSummary = allEntries.items.find((entry) => entry.key === "large");
    assert.deepEqual(largeSummary?.source, {
      projectId: "demo",
      runId: "run-large",
      conversationId: "conversation-1",
    });
    assert.equal(largeSummary?.valueType, "string");
    assert.equal(largeSummary?.valueSizeBytes, Buffer.byteLength(JSON.stringify(largeValue), "utf8"));
    assert.equal(largeSummary?.valuePreview.endsWith("..."), true);
    assert.equal("value" in (largeSummary ?? {}), false);

    const sourceFiltered = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      query: "RUN-LARGE",
    });
    assert.deepEqual(sourceFiltered.items.map((entry) => entry.key), ["large"]);
    const summaryFiltered = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      query: "enabled",
    });
    assert.deepEqual(summaryFiltered.items.map((entry) => entry.key), ["settings"]);
    const objectFiltered = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      valueType: "object",
    });
    assert.deepEqual(objectFiltered.items.map((entry) => entry.key), ["settings"]);

    const detail = await getLocalWorkflowKVEntry({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      key: "large",
    });
    assert.equal(detail?.value, largeValue);
    assert.equal(detail?.valueSizeBytes, Buffer.byteLength(JSON.stringify(largeValue), "utf8"));

    const metadataPath = path.join(
      rootDir,
      "project",
      Buffer.from("demo").toString("base64url"),
      `${Buffer.from("large").toString("base64url")}.meta.json`,
    );
    const metadata = await readFile(metadataPath, "utf8");
    assert.equal(metadata.includes(largeValue), false);
    const inspectionIndex = await readFile(
      path.join(rootDir, ".inspection", "local-kv-index.v1.json"),
      "utf8",
    );
    assert.equal(inspectionIndex.includes(largeValue), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local PersistentValue contexts and inspection keep encoded path segments inside their root", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-persistent-context-"));

  try {
    const persistentValue = createLocalWorkflowPersistentValueContext({
      rootDir,
      projectId: "../project",
      conversationId: "../conversation",
      source: { projectId: "../project", runId: "run-1" },
    });
    await persistentValue.setValue("../workflow-key", { local: true });
    await persistentValue.conversation.setValue("../conversation-key", "conversation value");

    const workflowEntry = await getLocalWorkflowKVEntry({
      rootDir,
      storageKind: "persistent_value", scope: "project",
      projectId: "../project",
      key: "../workflow-key",
    });
    assert.deepEqual(workflowEntry?.value, { local: true });
    const conversationEntry = await getLocalWorkflowKVEntry({
      rootDir,
      storageKind: "persistent_value", scope: "conversation",
      projectId: "../project",
      conversationId: "../conversation",
      key: "../conversation-key",
    });
    assert.equal(conversationEntry?.value, "conversation value");

    await assert.rejects(
      () => listLocalWorkflowKVEntries({
        rootDir,
        storageKind: "persistent_value", scope: "conversation",
        conversationId: "conversation-only",
      }),
      /conversation filters require a project id/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local KV initializes the new format by clearing only known legacy data", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-kv-index-"));
  const legacyEntries = ["global", "workflow", "project", "conversation", ".inspection", ".transactions", ".locks"];
  const retainedPath = path.join(rootDir, "keep.txt");

  try {
    await Promise.all(legacyEntries.map(async (entry) => {
      const directory = path.join(rootDir, entry);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "legacy.json"), "legacy\n", "utf8");
    }));
    await writeFile(retainedPath, "keep\n", "utf8");

    const firstPage = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "11111111-1111-4111-8111-111111111111",
      pageSize: 10,
    });
    assert.deepEqual(firstPage, { items: [], hasMore: false, total: 0 });
    assert.equal(await readFile(retainedPath, "utf8"), "keep\n");
    for (const entry of legacyEntries) {
      await assert.rejects(readFile(path.join(rootDir, entry, "legacy.json"), "utf8"), /ENOENT/);
    }
    assert.deepEqual(
      JSON.parse(await readFile(path.join(rootDir, ".workflow-storage-format.json"), "utf8")),
      { version: 2, storageKind: "kv" },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local KV serializes updates from concurrent processes and leaves matching summary metadata", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-kv-lock-"));
  const store = createLocalWorkflowKVStore({ rootDir });

  try {
    await Promise.all(Array.from({ length: 6 }, () => runConcurrentKVUpdateWorker(rootDir)));

    assert.equal(await store.getValue({
      storageKind: "kv", scope: "project",
      projectId: "demo",
      key: "counter",
    }), 6);
    const page = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
    });
    assert.deepEqual(page.items.map((entry) => ({
      key: entry.key,
      valuePreview: entry.valuePreview,
      valueSizeBytes: entry.valueSizeBytes,
    })), [{
      key: "counter",
      valuePreview: "6",
      valueSizeBytes: Buffer.byteLength("6", "utf8"),
    }]);

    const entryDirectory = path.join(rootDir, "project", Buffer.from("demo").toString("base64url"));
    const entryNames = await readdir(entryDirectory);
    assert.equal(entryNames.some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local KV summary index retains distinct concurrent process writes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-kv-index-lock-"));
  const keys = Array.from({ length: 8 }, (_, index) => `entry-${index}`);

  try {
    await Promise.all(keys.map((key) => runConcurrentKVSetWorker(rootDir, key)));
    const page = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "kv", scope: "project",
      projectId: "demo",
      pageSize: keys.length,
    });
    assert.equal(page.total, keys.length);
    assert.deepEqual(new Set(page.items.map((entry) => entry.key)), new Set(keys));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local KV getValue replays its matching namespace journal before reading", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-kv-read-recovery-"));
  const store = createLocalWorkflowKVStore({ rootDir });
  const input = { storageKind: "kv" as const, scope: "project" as const, projectId: "demo", key: "recovered" };
  const journalPath = path.join(rootDir, ".transactions", "crashed-read.json");

  try {
    assert.equal(await store.getValue(input), undefined);
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      namespace: { storageKind: "kv", scope: "project", projectId: "demo" },
      writes: [{ input, value: "recovered value" }],
    })}\n`, "utf8");

    assert.equal(await store.getValue(input), "recovered value");
    assert.equal((await readdir(path.dirname(journalPath))).includes(path.basename(journalPath)), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local PersistentValue replays a complete namespace transaction journal before a first knowledge mutation", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-kv-transaction-recovery-"));
  const store = createLocalWorkflowKVStore({ rootDir, storageKind: "persistent_value" });
  const projectId = "demo";
  const source = { projectId, runId: "recovered-run" };
  const document = {
    id: "guide",
    title: "Recovered guide",
    markdown: "Recovered body",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  };
  const documentSummary = {
    id: document.id,
    title: document.title,
    markdownPreview: document.markdown,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  const documentIndex = {
    version: 2,
    total: 1,
    nextSequence: 1,
    headPageId: "page-1",
  };
  const documentPage = {
    version: 2,
    entries: [{ summary: documentSummary, sequence: 1 }],
  };
  const documentLocator = {
    version: 2,
    pageId: "page-1",
    sequence: 1,
  };
  const tombstone = {
    deleted: true,
    id: "removed",
    deletedAt: "2025-01-03T00:00:00.000Z",
  };
  const bodyInput = { storageKind: "persistent_value" as const, scope: "project" as const, projectId, key: "knowledge.document.guide" };
  const indexInput = { storageKind: "persistent_value" as const, scope: "project" as const, projectId, key: "knowledge.documents" };
  const pageInput = { storageKind: "persistent_value" as const, scope: "project" as const, projectId, key: "knowledge.documents.page.page-1" };
  const locatorInput = { storageKind: "persistent_value" as const, scope: "project" as const, projectId, key: "knowledge.documents.locator.guide" };
  const tombstoneInput = {
    storageKind: "persistent_value" as const, scope: "project" as const,
    projectId,
    key: "knowledge.document.removed",
  };
  const tombstoneLocatorInput = {
    storageKind: "persistent_value" as const, scope: "project" as const,
    projectId,
    key: "knowledge.documents.locator.removed",
  };
  const journalName = "crashed-knowledge-mutation.json";
  const journalPath = path.join(rootDir, ".transactions", journalName);

  try {
    await store.setValue({
      ...bodyInput,
      value: { ...document, markdown: "Stale body" },
      source: { projectId, runId: "before-crash" },
    });
    await store.setValue({
      ...indexInput,
      value: { documents: [] },
      source: { projectId, runId: "before-crash" },
    });

    // A commit persists its journal before writing individual KV files. Model a
    // process exit after the body rename but before its metadata/index updates.
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      namespace: { storageKind: "persistent_value", scope: "project", projectId },
      writes: [
        { input: pageInput, value: documentPage, source },
        { input: indexInput, value: documentIndex, source },
        { input: locatorInput, value: documentLocator, source },
        { input: bodyInput, value: document, source },
        { input: tombstoneLocatorInput, value: { version: 2, deleted: true, deletedAt: tombstone.deletedAt }, source },
        { input: tombstoneInput, value: tombstone, source },
      ],
    })}\n`, "utf8");
    const bodyPath = path.join(
      rootDir,
      "project",
      Buffer.from(projectId).toString("base64url"),
      `${Buffer.from(bodyInput.key).toString("base64url")}.json`,
    );
    await writeFile(bodyPath, `${JSON.stringify({
      ...bodyInput,
      value: document,
      source,
      updatedAt: "2025-01-04T00:00:00.000Z",
    })}\n`, "utf8");

    // A knowledge mutation is the first operation after the simulated crash.
    // It must replay every journal write before reserving the next index
    // sequence, otherwise a later recovery can overwrite this new document.
    const knowledge = {
      persistentValue: createLocalWorkflowPersistentValueContext({ rootDir, projectId }),
    };
    const createdAfterRecovery = await createKnowledgeDocument(knowledge, {
      id: "new-guide",
      title: "Created after recovery",
      markdown: "New body",
    });
    assert.equal(createdAfterRecovery.id, "new-guide");

    const createdSummary = {
      id: createdAfterRecovery.id,
      title: createdAfterRecovery.title,
      markdownPreview: createdAfterRecovery.markdown,
      createdAt: createdAfterRecovery.createdAt,
      updatedAt: createdAfterRecovery.updatedAt,
    };
    assert.deepEqual(await store.getValue(bodyInput), document);
    assert.deepEqual(await store.getValue(indexInput), {
      ...documentIndex,
      total: 2,
      nextSequence: 2,
    });
    assert.deepEqual(await store.getValue(pageInput), {
      ...documentPage,
      entries: [{ summary: createdSummary, sequence: 2 }, ...documentPage.entries],
    });
    assert.deepEqual(await store.getValue(locatorInput), documentLocator);
    assert.deepEqual(await store.getValue(tombstoneInput), tombstone);
    assert.deepEqual(await store.getValue(tombstoneLocatorInput), {
      version: 2,
      deleted: true,
      deletedAt: tombstone.deletedAt,
    });
    assert.equal((await readdir(path.dirname(journalPath))).includes(journalName), false);

    const bodyMetadata = JSON.parse(await readFile(
      bodyPath.replace(/\.json$/, ".meta.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(bodyMetadata.version, 1);
    assert.equal(bodyMetadata.key, bodyInput.key);
    assert.equal(bodyMetadata.valueType, "object");
    assert.deepEqual(bodyMetadata.source, source);

    const inspectionIndex = JSON.parse(await readFile(
      path.join(rootDir, ".inspection", "local-kv-index.v1.json"),
      "utf8",
    )) as { entries: Array<{ key: string; source?: unknown }> };
    assert.deepEqual(
      new Set(inspectionIndex.entries.map((entry) => entry.key)),
      new Set([
        bodyInput.key,
        indexInput.key,
        pageInput.key,
        locatorInput.key,
        tombstoneInput.key,
        tombstoneLocatorInput.key,
        "knowledge.document.new-guide",
        "knowledge.documents.locator.new-guide",
      ]),
    );
    assert.deepEqual(
      inspectionIndex.entries.find((entry) => entry.key === tombstoneInput.key)?.source,
      source,
    );

    const kvPage = await listLocalWorkflowKVEntries({
      rootDir,
      storageKind: "persistent_value", scope: "project",
      projectId,
      pageSize: 10,
    });
    assert.equal(kvPage.total, 8);
    assert.deepEqual(new Set(kvPage.items.map((entry) => entry.key)), new Set([
      bodyInput.key,
      indexInput.key,
      pageInput.key,
      locatorInput.key,
      tombstoneInput.key,
      tombstoneLocatorInput.key,
      "knowledge.document.new-guide",
      "knowledge.documents.locator.new-guide",
    ]));
    assert.deepEqual(
      (await getLocalWorkflowKVEntry({ rootDir, ...tombstoneInput }))?.value,
      tombstone,
    );

    const knowledgePage = await listKnowledgeDocumentPage(knowledge, { pageSize: 20 });
    assert.deepEqual(knowledgePage.items.map((item) => item.id), ["new-guide", document.id]);
    assert.deepEqual(await getKnowledgeDocument(knowledge, document.id), document);
    assert.deepEqual(await getKnowledgeDocument(knowledge, createdAfterRecovery.id), createdAfterRecovery);
    assert.equal(await getKnowledgeDocument(knowledge, "removed"), undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local PersistentValue namespace mutations recover their journal before writing", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-local-kv-nested-recovery-"));
  const store = createLocalWorkflowKVStore({ rootDir, storageKind: "persistent_value" });
  const targetProjectId = "target";
  const recoveredDocument = {
    id: "recovered",
    title: "Recovered",
    markdown: "Recovered body",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
  const recoveredSummary = {
    id: recoveredDocument.id,
    title: recoveredDocument.title,
    markdownPreview: recoveredDocument.markdown,
    createdAt: recoveredDocument.createdAt,
    updatedAt: recoveredDocument.updatedAt,
  };
  const journalPath = path.join(rootDir, ".transactions", "crashed-target-mutation.json");
  const targetPersistentValue = createWorkflowPersistentValueContext({
    store,
    projectId: targetProjectId,
  });

  try {
    assert.equal(await store.getValue({
      storageKind: "persistent_value",
      scope: "project",
      projectId: targetProjectId,
      key: "initialization-marker",
    }), undefined);
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      namespace: { storageKind: "persistent_value", scope: "project", projectId: targetProjectId },
      writes: [
        {
          input: {
            storageKind: "persistent_value", scope: "project",
            projectId: targetProjectId,
            key: "knowledge.documents.page.page-1",
          },
          value: {
            version: 2,
            entries: [{ summary: recoveredSummary, sequence: 1 }],
          },
        },
        {
          input: {
            storageKind: "persistent_value", scope: "project",
            projectId: targetProjectId,
            key: "knowledge.documents",
          },
          value: { version: 2, total: 1, nextSequence: 1, headPageId: "page-1" },
        },
        {
          input: {
            storageKind: "persistent_value", scope: "project",
            projectId: targetProjectId,
            key: "knowledge.documents.locator.recovered",
          },
          value: { version: 2, pageId: "page-1", sequence: 1 },
        },
        {
          input: {
            storageKind: "persistent_value", scope: "project",
            projectId: targetProjectId,
            key: "knowledge.document.recovered",
          },
          value: recoveredDocument,
        },
      ],
    })}\n`, "utf8");

    await createKnowledgeDocument({ persistentValue: targetPersistentValue }, {
      id: "new-document",
      title: "New document",
      markdown: "New body",
    });

    const page = await listKnowledgeDocumentPage({ persistentValue: targetPersistentValue }, { pageSize: 20 });
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map((item) => item.id), ["new-document", "recovered"]);
    assert.equal((await readdir(path.dirname(journalPath))).includes(path.basename(journalPath)), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

function runConcurrentKVUpdateWorker(rootDir: string): Promise<void> {
  const coreEntryUrl = pathToFileURL(path.resolve(import.meta.dirname, "../index.ts")).href;
  const script = [
    "const { createLocalWorkflowKVStore } = await import(process.env.WORKFLOW_CODE_CORE_ENTRY_URL);",
    "const store = createLocalWorkflowKVStore({ rootDir: process.env.WORKFLOW_CODE_KV_ROOT });",
    "await store.updateValue({ storageKind: 'kv', scope: 'project', projectId: 'demo', key: 'counter' }, (current) => {",
    "  const until = Date.now() + 25;",
    "  while (Date.now() < until) {}",
    "  return (typeof current === 'number' ? current : 0) + 1;",
    "});",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx/esm",
      "--conditions=development",
      "--input-type=module",
      "--eval",
      script,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKFLOW_CODE_CORE_ENTRY_URL: coreEntryUrl,
        WORKFLOW_CODE_KV_ROOT: rootDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Concurrent local KV worker exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

function runConcurrentKVSetWorker(rootDir: string, key: string): Promise<void> {
  const coreEntryUrl = pathToFileURL(path.resolve(import.meta.dirname, "../index.ts")).href;
  const script = [
    "const { createLocalWorkflowKVStore } = await import(process.env.WORKFLOW_CODE_CORE_ENTRY_URL);",
    "const store = createLocalWorkflowKVStore({ rootDir: process.env.WORKFLOW_CODE_KV_ROOT });",
    "await store.setValue({",
    "  storageKind: 'kv', scope: 'project',",
    "  projectId: 'demo',",
    "  key: process.env.WORKFLOW_CODE_KV_KEY,",
    "  value: { key: process.env.WORKFLOW_CODE_KV_KEY },",
    "});",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx/esm",
      "--conditions=development",
      "--input-type=module",
      "--eval",
      script,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKFLOW_CODE_CORE_ENTRY_URL: coreEntryUrl,
        WORKFLOW_CODE_KV_ROOT: rootDir,
        WORKFLOW_CODE_KV_KEY: key,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Concurrent local KV worker exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}
