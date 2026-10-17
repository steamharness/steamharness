import assert from "node:assert/strict";
import test from "node:test";
import { invokeServerKanbanBridge } from "../kanban-bridge";
import { HttpError } from "../protocol";
import type { WorkflowStorage } from "../storage";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Kanban files preserve binary bytes and reject other projects and conversation attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanban-files-"));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  const metadata = { id: "wf_abc123", name: "map.png", mimeType: "image/png", size: bytes.length, kind: "image", storage: "server", workflowId: "demo", createdAt: "2026-10-08T00:00:00Z" };
  let owner = "demo";
  let conversationId: string | undefined;
  let deleted = false;
  const storage = {
    async saveManagedFiles(input: { workflowName: string; files: Array<{ buffer: Buffer }> }) {
      assert.equal(input.workflowName, "demo");
      assert.deepEqual(input.files[0]!.buffer, bytes);
      return [metadata];
    },
    async getManagedFile() { return { metadata: { ...metadata, workflowId: owner, conversationId }, filePath: join(root, "content") }; },
    async deleteManagedFile() { deleted = true; },
  } as unknown as WorkflowStorage;
  const invoke = (operation: "files.createFile" | "files.readFile" | "files.deleteFile", input: Record<string, unknown>) => (
    invokeServerKanbanBridge(storage, "demo", { requestId: "file", operation, input })
  );
  try {
    await writeFile(join(root, "content"), bytes);
    assert.deepEqual(await invoke("files.createFile", { name: "map.png", mimeType: "image/png", base64: bytes.toString("base64") }), { ...metadata, url: "/api/workflows/files/wf_abc123" });
    assert.deepEqual((await invoke("files.readFile", { fileId: metadata.id }) as { base64: string }).base64, bytes.toString("base64"));
    owner = "another-project";
    await assert.rejects(invoke("files.readFile", { fileId: metadata.id }), /unavailable/);
    await assert.rejects(invoke("files.deleteFile", { fileId: metadata.id }), /unavailable/);
    assert.equal(deleted, false);
    owner = "demo";
    conversationId = "private-conversation";
    await assert.rejects(invoke("files.readFile", { fileId: metadata.id }), /unavailable/);
    conversationId = undefined;
    assert.equal(await invoke("files.deleteFile", { fileId: metadata.id }), true);
    assert.equal(deleted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server Kanban bridge dispatches the complete project data API", async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const storage = {
    getProjectStorageValue: async (input: unknown) => {
      calls.push({ operation: "kv.get", input });
      return { exists: true, value: { version: 1 }, revision: "1" };
    },
    setProjectStorageValue: async (input: unknown) => {
      calls.push({ operation: "kv.set", input });
      return { ok: true };
    },
    listKnowledgeDocuments: async (workflowName: string, input: unknown) => {
      calls.push({ operation: "knowledge.list", input: { workflowName, input } });
      return { items: [], hasMore: false, total: 0 };
    },
    getKnowledgeDocument: async (input: unknown) => {
      calls.push({ operation: "knowledge.get", input });
      return { id: "guide", title: "Guide", markdown: "# Guide" };
    },
    createKnowledgeDocument: async (input: unknown) => {
      calls.push({ operation: "knowledge.create", input });
      return { id: "guide", title: "Guide", markdown: "# Guide" };
    },
    editKnowledgeDocument: async (input: unknown) => {
      calls.push({ operation: "knowledge.edit", input });
      return { id: "guide", title: "Updated", markdown: "# Guide" };
    },
    deleteKnowledgeDocument: async (input: unknown) => {
      calls.push({ operation: "knowledge.delete", input });
      return { id: "guide", deleted: true };
    },
    searchKnowledgeDocuments: async (input: unknown) => {
      calls.push({ operation: "knowledge.search", input });
      return { query: "Guide", documentsSearched: 1, totalMatches: 1, matchesTruncated: false, matches: [] };
    },
    readKnowledgeDocumentLines: async (input: unknown) => {
      calls.push({ operation: "knowledge.lines", input });
      return { documentId: "guide", startLine: 1, endLine: 1, totalLines: 1, lines: [] };
    },
  } as unknown as WorkflowStorage;
  const invoke = (operation: Parameters<typeof invokeServerKanbanBridge>[2]["operation"], input: Record<string, unknown>) => (
    invokeServerKanbanBridge(storage, "demo", { requestId: operation, operation, input })
  );

  await assert.doesNotReject(invoke("kv.getValue", { key: "board" }));
  await assert.doesNotReject(invoke("kv.setValue", { key: "board", value: { version: 1 } }));
  await assert.doesNotReject(invoke("knowledge.listDocuments", { pageSize: 20 }));
  await assert.doesNotReject(invoke("knowledge.getDocument", { documentId: "guide" }));
  await assert.doesNotReject(invoke("knowledge.createDocument", { id: "guide", title: "Guide", markdown: "# Guide" }));
  await assert.doesNotReject(invoke("knowledge.editDocument", { documentId: "guide", title: "Updated" }));
  await assert.doesNotReject(invoke("knowledge.deleteDocument", { documentId: "guide" }));
  await assert.doesNotReject(invoke("knowledge.searchDocuments", { query: "Guide", pageSize: 20 }));
  await assert.doesNotReject(invoke("knowledge.readDocumentLines", { documentId: "guide", startLine: 1, endLine: 1 }));

  assert.deepEqual(calls, [
    { operation: "kv.get", input: { storageKind: "kv", scope: "project", projectId: "demo", key: "board" } },
    { operation: "kv.set", input: { storageKind: "kv", scope: "project", projectId: "demo", key: "board", value: { version: 1 }, source: { projectId: "demo" } } },
    { operation: "knowledge.list", input: { workflowName: "demo", input: { pageSize: 20 } } },
    { operation: "knowledge.get", input: { workflowName: "demo", documentId: "guide" } },
    { operation: "knowledge.create", input: { workflowName: "demo", id: "guide", title: "Guide", markdown: "# Guide" } },
    { operation: "knowledge.edit", input: { workflowName: "demo", documentId: "guide", title: "Updated" } },
    { operation: "knowledge.delete", input: { workflowName: "demo", documentId: "guide" } },
    { operation: "knowledge.search", input: { workflowName: "demo", query: "Guide", pageSize: 20 } },
    { operation: "knowledge.lines", input: { workflowName: "demo", documentId: "guide", startLine: 1, endLine: 1 } },
  ]);
});

test("server Kanban bridge returns the fixed host locale without reading project data", async () => {
  const storage = {} as WorkflowStorage;

  assert.equal(await invokeServerKanbanBridge(storage, "demo", {
    requestId: "runtime-locale",
    operation: "runtime.getLocale",
    input: {},
  }, { runtimeLocale: "zh-CN" }), "zh-CN");
  assert.equal(await invokeServerKanbanBridge(storage, "demo", {
    requestId: "runtime-locale-default",
    operation: "runtime.getLocale",
    input: {},
  }), "en");
});

test("server Kanban bridge turns unavailable storage failures into a safe error", async () => {
  const storage = {
    getProjectStorageValue: async () => {
      throw new Error("connect ECONNREFUSED postgres://private-host/workflow");
    },
  } as unknown as WorkflowStorage;

  await assert.rejects(
    invokeServerKanbanBridge(storage, "demo", {
      requestId: "request-1",
      operation: "kv.getValue",
      input: { key: "board" },
    }),
    (reason: unknown) => reason instanceof HttpError &&
      reason.statusCode === 500 &&
      reason.message === "Kanban project data operation failed.",
  );
});

test("server Kanban bridge reads a confirmed fixed-target related project", async () => {
  const calls: unknown[] = [];
  const storage = {
    resolveKanbanRelatedProject: async (input: unknown) => {
      calls.push({ resolve: input });
      return {
        alias: "stocks",
        projectId: "f4ee23d7-abbb-4ba3-8baf-75b7c6c0b964",
      };
    },
    resolveRelatedProjectKVAccess: async (input: unknown) => {
      calls.push({ authorize: input });
      return { targetProjectId: "f4ee23d7-abbb-4ba3-8baf-75b7c6c0b964" };
    },
    getProjectStorageValue: async (input: unknown) => {
      calls.push({ get: input });
      return { exists: true, value: { schemaVersion: 3 }, revision: "3" };
    },
  } as unknown as WorkflowStorage;
  assert.deepEqual(await invokeServerKanbanBridge(storage, "kanban-project", {
    requestId: "source-read",
    operation: "relatedProject.kv.getValue",
    input: { alias: "stocks", key: "stock-database.v3:catalog" },
  }, { target: "1.2.3" }), { schemaVersion: 3 });
  assert.deepEqual(calls, [
    { resolve: {
      workflowName: "kanban-project",
      target: "1.2.3",
      alias: "stocks",
    } },
    { authorize: {
      consumerProjectId: "kanban-project",
      alias: "stocks",
      key: "stock-database.v3:catalog",
      operation: "read",
    } },
    { get: {
      storageKind: "kv",
      scope: "project",
      projectId: "f4ee23d7-abbb-4ba3-8baf-75b7c6c0b964",
      key: "stock-database.v3:catalog",
    } },
  ]);
});

test("server Kanban bridge hides unavailable related-project failures", async () => {
  let dataRead = false;
  const storage = {
    resolveKanbanRelatedProject: async () => ({
      alias: "stocks",
      projectId: "f4ee23d7-abbb-4ba3-8baf-75b7c6c0b964",
    }),
    resolveRelatedProjectKVAccess: async () => {
      throw new HttpError(403, 403, "Related project KV access is not granted for this key.");
    },
    getProjectStorageValue: async () => {
      dataRead = true;
      return { exists: false };
    },
  } as unknown as WorkflowStorage;

  await assert.rejects(
    invokeServerKanbanBridge(storage, "demo", {
      requestId: "source-read",
      operation: "relatedProject.kv.getValue",
      input: { alias: "stocks", key: "stock-database.v3:catalog" },
    }),
    (reason: unknown) => reason instanceof HttpError &&
      reason.statusCode === 404 &&
      reason.message === "Kanban related project is unavailable.",
  );
  assert.equal(dataRead, false);
});

test("server Kanban bridge returns null for missing knowledge documents", async () => {
  const storage = {
    getKnowledgeDocument: async () => {
      throw new HttpError(404, 404, "Document does not exist.");
    },
  } as unknown as WorkflowStorage;

  await assert.doesNotReject(async () => {
    assert.equal(await invokeServerKanbanBridge(storage, "demo", {
      requestId: "request-1",
      operation: "knowledge.getDocument",
      input: { documentId: "missing" },
    }), null);
  });
});
