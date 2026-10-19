import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLocalProjectPersistentValueContext,
  createProjectRelatedProjectsContext,
  createDisabledProjectTokenUsageContext,
  createKnowledgeDocument,
  createKnowledgeMarkdownPreview,
  createProjectConversationContext,
  createProjectKVContext,
  createProjectPersistentValueContext,
  deleteKnowledgeDocument,
  editKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocumentPage,
  listKnowledgeDocuments,
  readKnowledgeDocumentLines,
  searchKnowledgeDocuments,
  MAX_KNOWLEDGE_MARKDOWN_PREVIEW_SCAN_CODE_UNITS,
  type KVStore,
  type StorageLocationContext,
} from "../index";

test("knowledge markdown previews preserve compact output without scanning an entire large body", () => {
  assert.equal(
    createKnowledgeMarkdownPreview("  # Guide\n\nUse **PersistentValue** for [knowledge](./guide).  "),
    "Guide Use PersistentValue for knowledge ./guide .",
  );
  assert.equal(createKnowledgeMarkdownPreview("x".repeat(160)), "x".repeat(160));
  assert.equal(
    createKnowledgeMarkdownPreview("x".repeat(161)),
    `${"x".repeat(157)}...`,
  );

  // The preview is metadata, so an unusually large syntax/whitespace prefix
  // must not force create/edit summary responses to walk the entire document.
  assert.equal(
    createKnowledgeMarkdownPreview(`${"#".repeat(MAX_KNOWLEDGE_MARKDOWN_PREVIEW_SCAN_CODE_UNITS + 1)}late text`),
    "",
  );
});

test("knowledge documents write markdown documents through the PersistentValue project scope", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);

  const document = await createKnowledgeDocument(context, {
    id: "guide",
    title: "Guide",
    markdown: "# Guide\n\nUse PersistentValue for knowledge.",
  });

  assert.equal(document.id, "guide");
  assert.equal(document.markdown, "# Guide\n\nUse PersistentValue for knowledge.");
  assert.deepEqual(store.keys(), [
    "persistent_value:project:demo::knowledge.document.guide",
    "persistent_value:project:demo::knowledge.documents",
    "persistent_value:project:demo::knowledge.documents.locator.guide",
    "persistent_value:project:demo::knowledge.documents.page.page-1",
  ]);
  assert.deepEqual(store.values.get("persistent_value:project:demo::knowledge.documents"), {
    version: 2,
    total: 1,
    nextSequence: 1,
    headPageId: "page-1",
  });
  assert.deepEqual(store.values.get("persistent_value:project:demo::knowledge.documents.locator.guide"), {
    version: 2,
    pageId: "page-1",
    sequence: 1,
  });
  assert.deepEqual(await listKnowledgeDocuments(context), [{
    id: "guide",
    title: "Guide",
    markdownPreview: "Guide Use PersistentValue for knowledge.",
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }]);
});

test("knowledge document pages read only bounded persistent index pages", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  for (let index = 0; index < 130; index += 1) {
    await createKnowledgeDocument(context, {
      id: `document-${index}`,
      title: `Document ${index}`,
      markdown: `markdown ${index}`,
    });
  }

  const readKeys: string[] = [];
  const originalGetValue = store.getValue.bind(store);
  store.getValue = async (input) => {
    readKeys.push(input.key);
    return originalGetValue(input);
  };

  const first = await listKnowledgeDocumentPage(context, { pageSize: 20 });
  const second = await listKnowledgeDocumentPage(context, {
    pageSize: 20,
    cursor: first.nextCursor,
  });

  assert.equal(first.total, 130);
  assert.equal(first.items.length, 20);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(first.nextCursor ?? "", /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first.nextCursor, "2");
  assert.equal(second.total, 130);
  assert.equal(second.items.length, 20);
  assert.equal(second.hasMore, true);
  assert.deepEqual(first.items.slice(0, 3).map((document) => document.id), ["document-129", "document-128", "document-127"]);
  assert.equal(first.items.at(-1)?.id, "document-110");
  // The first page stops inside the 128-entry page. Its next cursor must be
  // reusable without treating the current page as a linked-list cycle.
  assert.equal(second.items[0]?.id, "document-109");
  assert.equal(second.items.at(-1)?.id, "document-90");
  assert.equal(readKeys.filter((key) => key === "knowledge.documents").length, 2);
  assert.ok(readKeys.filter((key) => key.startsWith("knowledge.documents.page.")).length <= 3);
  assert.equal(readKeys.some((key) => key.startsWith("knowledge.document.")), false);
  await assert.rejects(
    () => listKnowledgeDocumentPage(context, { pageSize: 0 }),
    /pageSize must be an integer/,
  );
  await assert.rejects(
    () => listKnowledgeDocumentPage(context, { cursor: "2" }),
    /valid knowledge document page cursor/,
  );
});

test("knowledge document page blocks preserve full list and locator correctness across edits and deletes", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  for (let index = 0; index < 256; index += 1) {
    await createKnowledgeDocument(context, {
      id: `document-${index}`,
      title: `Document ${index}`,
      markdown: `body ${index}`,
    });
  }

  await editKnowledgeDocument(context, {
    id: "document-0",
    title: "Document zero edited",
    markdown: "new body",
  });
  const afterEdit = await listKnowledgeDocumentPage(context, { pageSize: 20 });
  assert.equal(afterEdit.total, 256);
  assert.equal(afterEdit.items[0]?.id, "document-0");
  assert.equal((await listKnowledgeDocuments(context)).filter((item) => item.id === "document-0").length, 1);

  const deleted = await deleteKnowledgeDocument(context, "document-1");
  assert.deepEqual(deleted, { id: "document-1", deleted: true });
  const allDocuments = await listKnowledgeDocuments(context);
  assert.equal(allDocuments.length, 255);
  assert.equal(allDocuments.some((item) => item.id === "document-1"), false);
  assert.equal((await getKnowledgeDocument(context, "document-1")), undefined);
  const deletedLocator = store.values.get("persistent_value:project:demo::knowledge.documents.locator.document-1") as {
    version?: number;
    deleted?: boolean;
    deletedAt?: string;
  };
  assert.equal(deletedLocator.version, 2);
  assert.equal(deletedLocator.deleted, true);
  assert.match(deletedLocator.deletedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("knowledge document deletion prunes an empty head page before the next list read", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  for (let index = 0; index < 129; index += 1) {
    await createKnowledgeDocument(context, {
      id: `document-${index}`,
      title: `Document ${index}`,
      markdown: `body ${index}`,
    });
  }

  await deleteKnowledgeDocument(context, "document-128");
  assert.deepEqual(store.values.get("persistent_value:project:demo::knowledge.documents"), {
    version: 2,
    total: 128,
    nextSequence: 129,
    headPageId: "page-1",
  });

  const readKeys: string[] = [];
  const originalGetValue = store.getValue.bind(store);
  store.getValue = async (input) => {
    readKeys.push(input.key);
    return originalGetValue(input);
  };
  const page = await listKnowledgeDocumentPage(context, { pageSize: 20 });

  assert.equal(page.items[0]?.id, "document-127");
  assert.deepEqual(readKeys, ["knowledge.documents", "knowledge.documents.page.page-1"]);
});

test("knowledge document mutations unlink empty non-head index pages", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  for (let index = 0; index < 129; index += 1) {
    await createKnowledgeDocument(context, {
      id: `document-${index}`,
      title: `Document ${index}`,
      markdown: `body ${index}`,
    });
  }

  for (let index = 1; index < 128; index += 1) {
    await deleteKnowledgeDocument(context, `document-${index}`);
  }
  await editKnowledgeDocument(context, {
    id: "document-0",
    title: "Document zero edited",
  });

  const page = await listKnowledgeDocumentPage(context, { pageSize: 20 });
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.items.map((document) => document.id), ["document-0", "document-128"]);
  assert.deepEqual((await listKnowledgeDocuments(context)).map((document) => document.id), ["document-0", "document-128"]);
});

test("knowledge helpers accept a narrow local PersistentValue context", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-local-knowledge-"));
  const context = {
    persistentValue: createLocalProjectPersistentValueContext({
      rootDir,
      projectId: "local-project",
    }),
  };

  try {
    await createKnowledgeDocument(context, {
      id: "local-guide",
      title: "Local guide",
      markdown: "Stored outside the server database.",
    });

    const page = await listKnowledgeDocumentPage(context, { pageSize: 20 });
    assert.deepEqual(page.items.map((document) => document.id), ["local-guide"]);
    assert.equal((await getKnowledgeDocument(context, "local-guide"))?.markdown, "Stored outside the server database.");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("local knowledge mutations serialize one PersistentValue project namespace", async () => {
  const mutationCount = 32;
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-local-knowledge-lock-"));
  const firstContext = {
    persistentValue: createLocalProjectPersistentValueContext({
      rootDir,
      projectId: "local-project",
    }),
  };
  const secondContext = {
    persistentValue: createLocalProjectPersistentValueContext({
      rootDir,
      projectId: "local-project",
    }),
  };

  try {
    await Promise.all(Array.from({ length: mutationCount }, (_, index) =>
      createKnowledgeDocument(index % 2 === 0 ? firstContext : secondContext, {
        id: `document-${index}`,
        title: `Document ${index}`,
        markdown: `body ${index}`,
      })
    ));

    assert.deepEqual(
      new Set((await listKnowledgeDocuments(firstContext)).map((document) => document.id)),
      new Set(Array.from({ length: mutationCount }, (_, index) => `document-${index}`)),
    );

    const duplicateCreates = await Promise.allSettled([
      createKnowledgeDocument(firstContext, {
        id: "shared",
        title: "Shared first",
        markdown: "first",
      }),
      createKnowledgeDocument(secondContext, {
        id: "shared",
        title: "Shared second",
        markdown: "second",
      }),
    ]);
    assert.equal(duplicateCreates.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(duplicateCreates.filter((result) => result.status === "rejected").length, 1);

    const editAndDelete = await Promise.allSettled([
      editKnowledgeDocument(firstContext, {
        id: "shared",
        title: "Shared edited",
        markdown: "edited",
      }),
      deleteKnowledgeDocument(secondContext, "shared"),
    ]);
    assert.equal(editAndDelete.some((result) => result.status === "fulfilled"), true);

    const summaries = await listKnowledgeDocuments(firstContext);
    const sharedSummary = summaries.find((document) => document.id === "shared");
    const sharedDocument = await getKnowledgeDocument(firstContext, "shared");
    assert.equal(sharedSummary === undefined, sharedDocument === undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("knowledge document create conflict does not overwrite document content", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  await createKnowledgeDocument(context, {
    id: "guide",
    title: "Guide",
    markdown: "original",
  });

  await assert.rejects(
    () => createKnowledgeDocument(context, {
      id: "guide",
      title: "Guide",
      markdown: "replacement",
    }),
    /already exists/,
  );

  // Index reservation prevents a create conflict from replacing existing
  // PersistentValue-backed markdown.
  assert.equal((await getKnowledgeDocument(context, "guide"))?.markdown, "original");
});

test("knowledge document create rolls back index reservation when body write fails", async () => {
  const store = createMemoryKVStore({
    failSetKeys: new Set(["persistent_value:project:demo::knowledge.document.guide"]),
  });
  const context = createTestContext(store);

  await assert.rejects(
    () => createKnowledgeDocument(context, {
      id: "guide",
      title: "Guide",
      markdown: "body",
    }),
    /forced set failure/,
  );

  assert.deepEqual(await listKnowledgeDocuments(context), []);
  assert.equal(await getKnowledgeDocument(context, "guide"), undefined);
});

test("knowledge document edit restores body when index write fails", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  await createKnowledgeDocument(context, {
    id: "guide",
    title: "Guide",
    markdown: "original",
  });
  store.failSetKeys.add("persistent_value:project:demo::knowledge.documents");

  await assert.rejects(
    () => editKnowledgeDocument(context, {
      id: "guide",
      title: "Guide v2",
      markdown: "replacement",
    }),
    /forced set failure/,
  );

  const document = await getKnowledgeDocument(context, "guide");
  assert.equal(document?.title, "Guide");
  assert.equal(document?.markdown, "original");
  assert.deepEqual((await listKnowledgeDocuments(context)).map((item) => item.title), ["Guide"]);
});

test("knowledge document delete restores body when index write fails", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  await createKnowledgeDocument(context, {
    id: "guide",
    title: "Guide",
    markdown: "original",
  });
  store.failSetKeys.add("persistent_value:project:demo::knowledge.documents");

  await assert.rejects(
    () => deleteKnowledgeDocument(context, "guide"),
    /forced set failure/,
  );

  const document = await getKnowledgeDocument(context, "guide");
  assert.equal(document?.markdown, "original");
  assert.deepEqual((await listKnowledgeDocuments(context)).map((item) => item.id), ["guide"]);
});

test("knowledge documents edit and delete index entries without losing tombstone metadata", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  await createKnowledgeDocument(context, {
    id: "api",
    title: "API",
    markdown: "old",
  });

  const edited = await editKnowledgeDocument(context, {
    id: "api",
    title: "Core API",
    markdown: "new markdown",
  });
  const deleted = await deleteKnowledgeDocument(context, "api");

  assert.equal(edited.title, "Core API");
  assert.deepEqual(deleted, { id: "api", deleted: true });
  assert.deepEqual(await listKnowledgeDocuments(context), []);
  assert.equal(await getKnowledgeDocument(context, "api"), undefined);
  const tombstone = store.values.get("persistent_value:project:demo::knowledge.document.api");
  assert.equal(typeof tombstone, "object");
  assert.equal((tombstone as { deleted?: boolean }).deleted, true);
  assert.equal((tombstone as { id?: string }).id, "api");
  assert.match((tombstone as { deletedAt?: string }).deletedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("knowledge search returns line numbers and requested context lines", async () => {
  const context = createTestContext(createMemoryKVStore());
  await createKnowledgeDocument(context, {
    id: "docs",
    title: "Docs",
    markdown: [
      "# Docs",
      "Install the server.",
      "PersistentValue stores markdown.",
      "Search returns line numbers.",
    ].join("\n"),
  });

  const result = await searchKnowledgeDocuments(context, {
    query: "persistentvalue",
    beforeLines: 1,
    afterLines: 1,
  });

  assert.equal(result.documentsSearched, 1);
  assert.deepEqual(result.matches, [{
    documentId: "docs",
    title: "Docs",
    lineNumber: 3,
    line: "PersistentValue stores markdown.",
    before: [{ lineNumber: 2, content: "Install the server." }],
    after: [{ lineNumber: 4, content: "Search returns line numbers." }],
  }]);
});

test("knowledge search can target one document", async () => {
  const context = createTestContext(createMemoryKVStore());
  await createKnowledgeDocument(context, { id: "one", title: "One", markdown: "alpha" });
  await createKnowledgeDocument(context, { id: "two", title: "Two", markdown: "alpha" });

  const result = await searchKnowledgeDocuments(context, {
    query: "alpha",
    documentId: "two",
  });

  assert.equal(result.documentsSearched, 1);
  assert.deepEqual(result.matches.map((match) => match.documentId), ["two"]);
});

test("knowledge search caps large result payloads while counting all matches", async () => {
  const context = createTestContext(createMemoryKVStore());
  await createKnowledgeDocument(context, {
    id: "large",
    title: "Large",
    markdown: ["match one", "match two", "match three", "match four"].join("\n"),
  });

  const result = await searchKnowledgeDocuments(context, {
    query: "match",
    maxMatches: 2,
  });

  // Search against large knowledge documents reports the full count without
  // returning an unbounded result payload.
  assert.equal(result.totalMatches, 4);
  assert.equal(result.matchesTruncated, true);
  assert.equal(result.maxMatches, 2);
  assert.equal(result.pageSize, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, "2");
  assert.deepEqual(result.matches.map((match) => match.lineNumber), [1, 2]);
});

test("knowledge search paginates large result payloads with a cursor", async () => {
  const context = createTestContext(createMemoryKVStore());
  await createKnowledgeDocument(context, {
    id: "large",
    title: "Large",
    markdown: ["match one", "match two", "match three", "match four"].join("\n"),
  });

  const first = await searchKnowledgeDocuments(context, {
    query: "match",
    pageSize: 2,
  });
  const second = await searchKnowledgeDocuments(context, {
    query: "match",
    pageSize: 2,
    cursor: first.nextCursor,
  });

  // Search result pagination keeps broad knowledge queries usable without
  // forcing the UI to render every matching line at once.
  assert.deepEqual(first.matches.map((match) => match.lineNumber), [1, 2]);
  assert.equal(first.totalMatches, 4);
  assert.equal(first.nextCursor, "2");
  assert.equal(first.hasMore, true);
  assert.equal(second.cursor, "2");
  assert.deepEqual(second.matches.map((match) => match.lineNumber), [3, 4]);
  assert.equal(second.totalMatches, 4);
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.hasMore, false);
});

test("knowledge search bounds full-library markdown reads while keeping exact match counts", async () => {
  const store = createMemoryKVStore();
  const context = createTestContext(store);
  for (let index = 0; index < 9; index += 1) {
    await createKnowledgeDocument(context, {
      id: `document-${index}`,
      title: `Document ${index}`,
      markdown: `match ${index}`,
    });
  }

  const originalGetValue = store.getValue.bind(store);
  let inFlightDocumentReads = 0;
  let maxInFlightDocumentReads = 0;
  store.getValue = async (input) => {
    if (input.key.startsWith("knowledge.document.")) {
      inFlightDocumentReads += 1;
      maxInFlightDocumentReads = Math.max(maxInFlightDocumentReads, inFlightDocumentReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await originalGetValue(input);
      } finally {
        inFlightDocumentReads -= 1;
      }
    }
    return originalGetValue(input);
  };

  const result = await searchKnowledgeDocuments(context, { query: "match", pageSize: 2 });

  assert.equal(result.totalMatches, 9);
  assert.equal(result.matches.length, 2);
  assert.ok(maxInFlightDocumentReads <= 4);
});

test("knowledge search acquires one optional local namespace read lock", async () => {
  const store = createMemoryKVStore();
  let readLocks = 0;
  store.withNamespaceReadLock = async (input, operation) => {
    readLocks += 1;
    assert.deepEqual(input, { storageKind: "persistent_value", scope: "project", projectId: "demo" });
    return operation();
  };
  const context = createTestContext(store);
  for (let index = 0; index < 5; index += 1) {
    await createKnowledgeDocument(context, {
      id: `document-${index}`,
      title: `Document ${index}`,
      markdown: `match ${index}`,
    });
  }

  const result = await searchKnowledgeDocuments(context, { query: "match", pageSize: 2 });

  assert.equal(result.totalMatches, 5);
  assert.equal(readLocks, 1);
});

test("knowledge search does not use a store's general namespace lock", async () => {
  const store = createMemoryKVStore();
  let namespaceLocks = 0;
  const originalWithNamespaceLock = store.withNamespaceLock;
  store.withNamespaceLock = async (input, operation) => {
    namespaceLocks += 1;
    return originalWithNamespaceLock!(input, operation);
  };
  const context = createTestContext(store);
  for (let index = 0; index < 3; index += 1) {
    await createKnowledgeDocument(context, {
      id: `document-${index}`,
      title: `Document ${index}`,
      markdown: `match ${index}`,
    });
  }
  namespaceLocks = 0;

  const result = await searchKnowledgeDocuments(context, { query: "match" });

  assert.equal(result.totalMatches, 3);
  assert.equal(namespaceLocks, 0);
});

test("knowledge search validates pageSize", async () => {
  const context = createTestContext(createMemoryKVStore());

  await assert.rejects(
    () => searchKnowledgeDocuments(context, {
      query: "match",
      pageSize: 0,
    }),
    /pageSize must be an integer/,
  );
});

test("knowledge search preserves legacy maxMatches validation wording", async () => {
  const context = createTestContext(createMemoryKVStore());

  await assert.rejects(
    () => searchKnowledgeDocuments(context, {
      query: "match",
      maxMatches: 0,
    }),
    /maxMatches must be an integer/,
  );
});

test("knowledge document line range reads one document without loading all matches", async () => {
  const context = createTestContext(createMemoryKVStore());
  await createKnowledgeDocument(context, {
    id: "guide",
    title: "Guide",
    markdown: ["one", "two", "three", "four"].join("\n"),
  });

  const result = await readKnowledgeDocumentLines(context, {
    documentId: "guide",
    startLine: 2,
    endLine: 3,
  });

  assert.deepEqual(result, {
    documentId: "guide",
    title: "Guide",
    startLine: 2,
    endLine: 3,
    totalLines: 4,
    lines: [
      { lineNumber: 2, content: "two" },
      { lineNumber: 3, content: "three" },
    ],
  });
});

test("knowledge document line range validates range size", async () => {
  const context = createTestContext(createMemoryKVStore());
  await createKnowledgeDocument(context, {
    id: "guide",
    title: "Guide",
    markdown: "one",
  });

  await assert.rejects(
    () => readKnowledgeDocumentLines(context, {
      documentId: "guide",
      startLine: 1,
      endLine: 1001,
    }),
    /cannot exceed 1000 lines/,
  );
});

function createTestContext(store: KVStore): StorageLocationContext {
  const kv = createProjectKVContext({ store: createMemoryKVStore(), projectId: "demo" });
  const persistentValue = createProjectPersistentValueContext({ store, projectId: "demo" });
  return { kv, persistentValue, relatedProjects: createProjectRelatedProjectsContext() };
}

function createMemoryKVStore(options: {
  failSetKeys?: Set<string>;
  failUpdateKeys?: Set<string>;
} = {}): KVStore & {
  values: Map<string, unknown>;
  failSetKeys: Set<string>;
  failUpdateKeys: Set<string>;
  keys: () => string[];
} {
  const values = new Map<string, unknown>();
  const failSetKeys = options.failSetKeys ?? new Set<string>();
  const failUpdateKeys = options.failUpdateKeys ?? new Set<string>();
  const namespaceTails = new Map<string, Promise<void>>();
  function createKey(input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }): string {
    return [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");
  }

  return {
    values,
    failSetKeys,
    failUpdateKeys,
    keys: () => [...values.keys()].sort(),
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      const key = createKey(input);
      if (failSetKeys.has(key)) {
        throw new Error(`forced set failure for ${key}`);
      }
      values.set(key, input.value);
    },
    async deleteValue(input) {
      return values.delete(createKey(input));
    },
    async updateValue(input, updater) {
      const key = createKey(input);
      if (failUpdateKeys.has(key)) {
        throw new Error(`forced update failure for ${key}`);
      }
      const next = updater(values.get(key));
      values.set(key, next);
      return next;
    },
    async withNamespaceLock(input, operation) {
      const namespace = [input.storageKind, input.scope, input.projectId, input.conversationId ?? ""].join(":");
      const previous = namespaceTails.get(namespace) ?? Promise.resolve();
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      namespaceTails.set(namespace, previous.then(() => completion));
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}
