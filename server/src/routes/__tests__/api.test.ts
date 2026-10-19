import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { type AuthenticatedPrincipal } from "../../auth";
import { configureProjectAuthContext } from "../../auth";
import { HttpError } from "../../protocol";
import { listBuiltinProjectRoles, listProjectPermissions } from "../../permissions";
import { createApiRouter } from "../api";
import type { AuditEventPage, UserProfileRecord } from "../../account-db";
import { PROJECT_CARD_IMAGE_MAX_BYTES, Storage } from "../../storage";
import type { KVEntryDetail, KVEntryPage, KnowledgeDocumentLinesRecord, KnowledgeDocumentListItem, KnowledgeDocumentPageRecord, KnowledgeDocumentRecord, KnowledgeDocumentSearchResult, TokenUsageDetail, TokenUsagePage } from "../../storage";
import { STEAMHARNESS_PROJECT_TYPES } from "@steamharness/project-types";
import type { RelatedProject, RelatedProjectKVGrant } from "@steamharness/project-info";

test("source download permission is exposed and granted to the developer role", () => {
  assert.equal(
    listProjectPermissions().some((permission) => permission.key === "projects.download_source"),
    true,
  );
  assert.equal(
    listBuiltinProjectRoles()
      .find((role) => role.id === "builtin_developer")
      ?.permissions.includes("projects.download_source"),
    true,
  );
});

test("Kanban file upload accepts images above the ordinary JSON limit without requiring preview artifacts", async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0xff);
  let uploaded = false;
  const storage = createStorageStub({
    getKanbanWorkspace: async () => { throw new Error("Preview source has not been uploaded."); },
    saveManagedFiles: async (options) => {
      assert.equal(options.projectName, "demo");
      assert.deepEqual(options.files[0]!.buffer, bytes);
      uploaded = true;
      return [{ id: "wf_abc123", name: "map.png", mimeType: "image/png", size: bytes.length, kind: "image", storage: "server", projectId: "demo", createdAt: "2026-10-08T00:00:00Z" }];
    },
  });
  const server = await listen(storage, createApiKeyPrincipal("desktop"));
  try {
    const response = await fetchJson(server.url("/api/projects/demo/kanban/bridge"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call: { requestId: "map", operation: "files.createFile", input: { name: "map.png", mimeType: "image/png", base64: bytes.toString("base64") } } }),
    });
    assert.equal(response.errCode, 0);
    assert.equal(uploaded, true);
    assert.equal((response.data as { storage: string }).storage, "server");
  } finally {
    await server.close();
  }
});

test("Kanban workspace issues a short-lived preview capability for Bearer-authenticated App users", async () => {
  const storage = createStorageStub({
    getKanbanWorkspace: async (options) => {
      assert.deepEqual(options, {
        projectName: "demo",
        target: "draft",
        actorId: "user-1",
      });
      return {
        projectId: "demo",
        projectName: "Kanban Demo",
        target: "draft",
        resolvedTarget: "draft",
        artifactDir: "dist",
        entry: "pages/board view.htm",
        relatedProjects: [],
        configurations: [],
      };
    },
    issueKanbanPreviewCapability: async (options) => {
      assert.deepEqual(options, {
        projectName: "demo",
        target: "draft",
        actorId: "user-1",
      });
      return {
        token: "preview-capability",
        resolvedTarget: "draft",
        expiresAt: "2026-07-27T00:15:00.000Z",
      };
    },
  });
  const server = await listen(storage, createApiKeyPrincipal("desktop"));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/kanban?target=draft"));

    assert.equal(response.errCode, 0);
    const preview = (response.data as { preview?: { url?: string; expiresAt?: string } }).preview;
    assert.equal(preview?.expiresAt, "2026-07-27T00:15:00.000Z");
    assert.match(
      preview?.url ?? "",
      /^\/api\/projects\/demo\/kanban\/previews\/preview-capability\/[A-Za-z0-9_-]+\/draft\/pages\/board%20view\.htm$/,
    );
  } finally {
    await server.close();
  }
});

test("Kanban Studio bridge fixes KV access to the authenticated project scope", async () => {
  const storage = createStorageStub({
    getKanbanWorkspace: async (options) => {
      assert.deepEqual(options, {
        projectName: "demo",
        target: "draft",
        actorId: "user-1",
      });
      return {
        projectId: "demo",
        projectName: "Demo",
        target: "draft",
        resolvedTarget: "draft",
        artifactDir: ".",
        entry: "index.html",
        relatedProjects: [],
        configurations: [],
      };
    },
    getProjectStorageValue: async (options) => {
      assert.deepEqual(options, {
        storageKind: "kv",
        scope: "project",
        projectId: "demo",
        key: "board",
      });
      return { exists: true, value: { version: 1 }, revision: "2" };
    },
  });
  const server = await listen(storage, createApiKeyPrincipal("desktop"));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/kanban/bridge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "draft",
        call: { requestId: "request-1", operation: "kv.getValue", input: { key: "board" } },
      }),
    });

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, { version: 1 });
  } finally {
    await server.close();
  }
});

test("Kanban Studio bridge reads a confirmed related project's KV through its alias", async () => {
  const sourceProjectId = "f4ee23d7-abbb-4ba3-8baf-75b7c6c0b964";
  const accessChecks: string[] = [];
  const storage = createStorageStub({
    getKanbanWorkspace: async () => ({
      projectId: "demo",
      projectName: "Demo",
      target: "draft",
      resolvedTarget: "draft",
      artifactDir: ".",
      entry: "index.html",
      relatedProjects: [createRelatedProject(sourceProjectId)],
      configurations: [],
    }),
    resolveKanbanRelatedProject: async (options) => {
      assert.equal(options.target, "draft");
      assert.equal(options.alias, "stocks");
      return createRelatedProject(sourceProjectId);
    },
    resolveRelatedProjectKVAccess: async (options) => {
      assert.deepEqual(options, {
        consumerProjectId: "demo",
        alias: "stocks",
        key: "stock-database.v3:catalog",
        operation: "read",
      });
      return { targetProjectId: sourceProjectId };
    },
    getProjectAccessSummary: async (projectId, userId) => {
      accessChecks.push(projectId);
      return {
        projectId,
        projectName: projectId,
        visibility: "private",
        ownerUserId: userId,
        member: userId ? {
          projectId,
          userId,
          role: "owner",
          createdAt: "2026-08-03T00:00:00.000Z",
        } : undefined,
      };
    },
    getProjectStorageValue: async (options) => {
      assert.deepEqual(options, {
        storageKind: "kv",
        scope: "project",
        projectId: sourceProjectId,
        key: "stock-database.v3:catalog",
      });
      return { exists: true, value: { schemaVersion: 3 } };
    },
  });
  const server = await listen(storage, createApiKeyPrincipal("desktop"));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/kanban/bridge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "draft",
        call: {
          requestId: "source-read",
          operation: "relatedProject.kv.getValue",
          input: { alias: "stocks", key: "stock-database.v3:catalog" },
        },
      }),
    });
    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, { schemaVersion: 3 });
    assert.deepEqual(accessChecks, ["demo"]);
  } finally {
    await server.close();
  }
});

test("Kanban Studio bridge applies related-project grant revocation immediately", async () => {
  const sourceProjectId = "00000000-0000-4000-8000-000000000302";
  let grantActive = true;
  const storage = createStorageStub({
    getKanbanWorkspace: async () => ({
      projectId: "demo",
      projectName: "Demo",
      target: "1.0.0",
      resolvedTarget: "1.0.0",
      artifactDir: ".",
      entry: "index.html",
      relatedProjects: [createRelatedProject(sourceProjectId)],
      configurations: [],
    }),
    resolveKanbanRelatedProject: async () => createRelatedProject(sourceProjectId),
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: projectId === "demo" ? "public" : "private",
      ownerUserId: "owner-1",
    }),
    resolveRelatedProjectKVAccess: async (options) => {
      assert.deepEqual(options, {
        consumerProjectId: "demo",
        alias: "stocks",
        key: "stock-database.v3:catalog",
        operation: "read",
      });
      if (!grantActive) throw new HttpError(403, 403, "Related project KV access is not granted for this key.");
      return { targetProjectId: sourceProjectId };
    },
    getProjectStorageValue: async () => ({ exists: true, value: { schemaVersion: 3 } }),
  });
  const server = await listen(
    storage,
    createPrincipal(["projects.read_public"], { userId: "viewer-1" }),
  );
  const request = () => fetch(server.url("/api/projects/demo/kanban/bridge"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: "1.0.0",
      call: {
        requestId: "source-read",
        operation: "relatedProject.kv.getValue",
        input: { alias: "stocks", key: "stock-database.v3:catalog" },
      },
    }),
  });

  try {
    const allowed = await request();
    assert.equal(allowed.status, 200);
    assert.deepEqual(((await allowed.json()) as { data: unknown }).data, { schemaVersion: 3 });

    grantActive = false;
    const revoked = await request();
    const payload = await revoked.json() as { errMessage: string };
    assert.equal(revoked.status, 404);
    assert.equal(payload.errMessage, "Kanban related project is unavailable.");
  } finally {
    await server.close();
  }
});

test("Kanban Studio bridge rejects operations outside the public whitelist", async () => {
  let storageRead = false;
  const storage = createStorageStub({
    getKanbanWorkspace: async () => ({
      projectId: "demo",
      projectName: "Demo",
      target: "draft",
      resolvedTarget: "draft",
      artifactDir: ".",
      entry: "index.html",
      relatedProjects: [],
      configurations: [],
    }),
    getProjectStorageValue: async () => {
      storageRead = true;
      return { exists: false };
    },
  });
  const server = await listen(storage, createApiKeyPrincipal("desktop"));

  try {
    const response = await fetch(server.url("/api/projects/demo/kanban/bridge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "draft",
        call: { requestId: "request-1", operation: "kv.deleteValue", input: { key: "board" } },
      }),
    });
    const payload = await response.json() as { errCode: number; errMessage: string };

    assert.equal(response.status, 400);
    assert.equal(payload.errCode, 400);
    assert.match(payload.errMessage, /invalid/i);
    assert.equal(storageRead, false);
  } finally {
    await server.close();
  }
});

test("Kanban Studio bridge allows project readers to perform read-only operations", async () => {
  let workspaceRead = false;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: "public",
      ownerUserId: "owner-1",
    }),
    getKanbanWorkspace: async () => {
      workspaceRead = true;
      return {
        projectId: "demo",
        projectName: "Demo",
        target: "draft",
        resolvedTarget: "draft",
        artifactDir: ".",
        entry: "index.html",
        relatedProjects: [],
        configurations: [],
      };
    },
  });
  const server = await listen(storage, createPrincipal(["projects.read_public"], { userId: "viewer-1" }));

  try {
    const response = await fetch(server.url("/api/projects/demo/kanban/bridge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "draft",
        call: { requestId: "request-1", operation: "kv.getValue", input: { key: "board" } },
      }),
    });
    const payload = await response.json() as { errCode: number };

    assert.equal(response.status, 200);
    assert.equal(payload.errCode, 0);
    assert.equal(workspaceRead, true);
  } finally {
    await server.close();
  }
});

test("Kanban file mutations are denied to a project reader before accessing file storage", async () => {
  let touched = false;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({ projectId, projectName: projectId, visibility: "public", ownerUserId: "owner-1" }),
    saveManagedFiles: async () => { touched = true; return []; },
    deleteManagedFile: async (id) => { touched = true; return { id }; },
    getManagedFile: async () => { touched = true; throw new Error("Unexpected file access."); },
  });
  const server = await listen(storage, createPrincipal(["projects.read_public"], { userId: "viewer-1" }));
  try {
    for (const [operation, input] of [
      ["files.createFile", { name: "map.png", base64: "AP8=" }],
      ["files.deleteFile", { fileId: "wf_abc123" }],
    ]) {
      const response = await fetch(server.url("/api/projects/demo/kanban/bridge"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call: { requestId: "write", operation, input } }),
      });
      assert.equal(response.status, 403);
    }
    assert.equal(touched, false);
  } finally {
    await server.close();
  }
});

test("Kanban revision stream releases a subscription when the client disconnects during setup", { timeout: 10_000 }, async () => {
  const subscriptionStarted = createDeferred<void>();
  const subscriptionReady = createDeferred<() => Promise<void>>();
  const subscriptionReleased = createDeferred<void>();
  const sourceProjectId = "00000000-0000-4000-8000-000000000301";
  const storage = createStorageStub({
    getKanbanRelatedProjectBindings: async () => ({
      resolvedTarget: "1.0.0",
      relatedProjects: [createRelatedProject(sourceProjectId)],
    }),
    resolveConfirmedRelatedProject: async () => createRelatedProjectAccess(sourceProjectId),
    subscribeProjectStorageRevisions: async () => {
      subscriptionStarted.resolve(undefined);
      return subscriptionReady.promise;
    },
    getProjectStorageRevision: async () => "1",
  });
  const server = await listen(storage);
  const controller = new AbortController();

  try {
    const response = await fetch(server.url("/api/projects/demo/kanban/related-project-revisions?target=1.0.0"), {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    await subscriptionStarted.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    subscriptionReady.resolve(async () => {
      subscriptionReleased.resolve(undefined);
    });
    await subscriptionReleased.promise;
  } finally {
    controller.abort();
    await server.close();
  }
});

test("Kanban revision stream reports a safe unavailable event when subscription setup fails", async () => {
  const sourceProjectId = "00000000-0000-4000-8000-000000000301";
  const storage = createStorageStub({
    getKanbanRelatedProjectBindings: async () => ({
      resolvedTarget: "1.0.0",
      relatedProjects: [createRelatedProject(sourceProjectId)],
    }),
    resolveConfirmedRelatedProject: async () => createRelatedProjectAccess(sourceProjectId),
    subscribeProjectStorageRevisions: async () => {
      throw new Error("database connection details must stay private");
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetch(server.url(
      "/api/projects/demo/kanban/related-project-revisions?target=1.0.0",
    ));
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: unavailable/);
    assert.match(body, /Kanban related project is unavailable/);
    assert.doesNotMatch(body, /database connection details/);
  } finally {
    await server.close();
  }
});

test("Kanban revision stream does not repeat a revision already included in its snapshot", async () => {
  const sourceProjectId = "00000000-0000-4000-8000-000000000301";
  let bindingsAvailable = true;
  const storage = createStorageStub({
    getKanbanRelatedProjectBindings: async () => {
      if (!bindingsAvailable) throw new Error("binding revoked");
      return {
        resolvedTarget: "1.0.0",
        relatedProjects: [createRelatedProject(sourceProjectId)],
      };
    },
    resolveConfirmedRelatedProject: async () => createRelatedProjectAccess(sourceProjectId),
    subscribeProjectStorageRevisions: async (listener) => {
      listener({ projectId: sourceProjectId, revision: "2" });
      setImmediate(() => {
        bindingsAvailable = false;
        listener({ projectId: sourceProjectId, revision: "3" });
      });
      return async () => undefined;
    },
    getProjectStorageRevision: async () => "1",
  });
  const server = await listen(storage);

  try {
    const response = await fetch(server.url(
      "/api/projects/demo/kanban/related-project-revisions?target=1.0.0",
    ));
    const body = await response.text();
    assert.match(body, /event: snapshot/);
    assert.match(body, /"alias":"stocks","revision":"2"/);
    assert.doesNotMatch(body, /event: revision\ndata: \{"alias":"stocks","revision":"2"\}/);
    assert.match(body, /event: unavailable/);
  } finally {
    await server.close();
  }
});

test("Kanban revision stream closes before publishing after project access is revoked", { timeout: 10_000 }, async () => {
  const sourceProjectId = "00000000-0000-4000-8000-000000000301";
  const subscriptionReady = createDeferred<void>();
  let revisionListener: ((event: { projectId: string; revision: string }) => void) | undefined;
  let kanbanReadable = true;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId, userId) => ({
      projectId,
      projectName: projectId,
      visibility: "private",
      ownerUserId: "owner-1",
      member: projectId === "demo" && !kanbanReadable
        ? undefined
        : {
            projectId,
            userId: userId ?? "viewer-1",
            role: "viewer",
            createdAt: "2026-06-18T00:00:00.000Z",
          },
    }),
    getKanbanRelatedProjectBindings: async () => ({
      resolvedTarget: "1.0.0",
      relatedProjects: [createRelatedProject(sourceProjectId)],
    }),
    resolveConfirmedRelatedProject: async () => createRelatedProjectAccess(sourceProjectId),
    subscribeProjectStorageRevisions: async (listener) => {
      revisionListener = listener;
      subscriptionReady.resolve(undefined);
      return async () => undefined;
    },
    getProjectStorageRevision: async () => "1",
  });
  const server = await listen(
    storage,
    createPrincipal([], { userId: "viewer-1" }),
  );
  const controller = new AbortController();

  try {
    const response = await fetch(server.url(
      "/api/projects/demo/kanban/related-project-revisions?target=1.0.0",
    ), { signal: controller.signal });
    assert.equal(response.status, 200);
    await subscriptionReady.promise;
    kanbanReadable = false;
    revisionListener?.({ projectId: sourceProjectId, revision: "2" });
    const body = await response.text();
    assert.match(body, /event: snapshot/);
    assert.match(body, /event: unavailable/);
    assert.doesNotMatch(body, /event: revision/);
  } finally {
    controller.abort();
    await server.close();
  }
});

test("Kanban revision stream closes before publishing after related-project access is revoked", { timeout: 2_000 }, async () => {
  const sourceProjectId = "00000000-0000-4000-8000-000000000303";
  const subscriptionReady = createDeferred<void>();
  let revisionListener: ((event: { projectId: string; revision: string }) => void) | undefined;
  let grantActive = true;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: projectId === "demo" ? "public" : "private",
      ownerUserId: "owner-1",
    }),
    getKanbanRelatedProjectBindings: async () => ({
      resolvedTarget: "1.0.0",
      relatedProjects: [createRelatedProject(sourceProjectId)],
    }),
    resolveConfirmedRelatedProject: async () => {
      if (!grantActive) throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
      return createRelatedProjectAccess(sourceProjectId);
    },
    subscribeProjectStorageRevisions: async (listener) => {
      revisionListener = listener;
      subscriptionReady.resolve(undefined);
      return async () => undefined;
    },
    getProjectStorageRevision: async () => "1",
  });
  const server = await listen(
    storage,
    createPrincipal(["projects.read_public"], { userId: "viewer-1" }),
  );
  const controller = new AbortController();

  try {
    const response = await fetch(server.url(
      "/api/projects/demo/kanban/related-project-revisions?target=1.0.0",
    ), { signal: controller.signal });
    assert.equal(response.status, 200);
    await subscriptionReady.promise;
    grantActive = false;
    revisionListener?.({ projectId: sourceProjectId, revision: "2" });
    const body = await response.text();
    assert.match(body, /event: snapshot/);
    assert.match(body, /event: unavailable/);
    assert.doesNotMatch(body, /event: revision/);
  } finally {
    controller.abort();
    await server.close();
  }
});

test("Kanban revision stream omits unconfirmed related projects from its snapshot", async () => {
  const sourceProjectId = "00000000-0000-4000-8000-000000000301";
  let subscribed = false;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: projectId === "demo" ? "public" : "private",
      ownerUserId: "owner-1",
    }),
    getKanbanRelatedProjectBindings: async () => ({
      resolvedTarget: "1.0.0",
      relatedProjects: [createRelatedProject(sourceProjectId)],
    }),
    resolveConfirmedRelatedProject: async () => {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    },
    subscribeProjectStorageRevisions: async () => {
      subscribed = true;
      return async () => undefined;
    },
  });
  const server = await listen(
    storage,
    createPrincipal(["projects.read_public"], { userId: "viewer-1" }),
  );
  const controller = new AbortController();

  try {
    const response = await fetch(server.url(
      "/api/projects/demo/kanban/related-project-revisions?target=1.0.0",
    ), { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    const body = new TextDecoder().decode(first.value);
    assert.match(body, /event: snapshot/);
    assert.match(body, /"revisions":\[\]/);
    assert.equal(subscribed, true);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    controller.abort();
    await server.close();
  }
});

test("Kanban draft file saves preserve declared base64 encoding", async () => {
  let received: unknown;
  const storage = createStorageStub({
    saveDraftFiles: async (options) => {
      received = options;
      return {
        projectId: "demo",
        projectName: "Kanban Demo",
        updatedFiles: ["assets/board.png"],
        removedFiles: [],
        nextVersion: "0.1.0",
      };
    },
  });
  const server = await listen(storage, {
    kind: "admin_key",
    tokenSource: "bearer",
    permissions: ["system.admin"],
    isSystemAdmin: true,
  });

  try {
    const response = await fetchJson(server.url("/api/projects/demo/draft/files"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "assets/board.png", content: "/wAQIEA=", encoding: "base64" }],
      }),
    });

    assert.equal(response.errCode, 0);
    assert.deepEqual(received, {
      projectName: "demo",
      files: [{ path: "assets/board.png", content: "/wAQIEA=", encoding: "base64" }],
      removePaths: undefined,
    });
  } finally {
    await server.close();
  }
});

test("draft file saves reject malformed file collections as client errors", async () => {
  const server = await listen(createStorageStub({
    saveDraftFiles: async () => {
      throw new Error("storage must not be called");
    },
  }), {
    kind: "admin_key",
    tokenSource: "bearer",
    permissions: ["system.admin"],
    isSystemAdmin: true,
  });

  try {
    for (const files of [{ path: "index.html", content: "html" }, [null], [
      { path: "assets/board.png", content: "AAAA", encoding: "hex" },
    ]]) {
      const response = await fetch(server.url("/api/projects/demo/draft/files"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    await server.close();
  }
});

test("project card image upload accepts cropped WebP data and returns the server URL", async () => {
  const webp = createWebpFixture("project-card");
  const storage = createStorageStub({
    saveProjectCardImage: async (options) => {
      assert.equal(options.projectName, "demo");
      assert.deepEqual(options.buffer, webp);
      assert.equal(options.origin.startsWith("http://127.0.0.1:"), true);
      return {
        projectId: "demo",
        url: `${options.origin}/project-card-images/demo/${"a".repeat(64)}.webp`,
        mimeType: "image/webp",
        size: options.buffer.byteLength,
        hash: "a".repeat(64),
      };
    },
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"]));

  try {
    const response = await fetch(server.url("/api/projects/demo/project-card-image"), {
      method: "POST",
      headers: { "Content-Type": "image/webp" },
      body: new Uint8Array(webp),
    });
    const payload = await response.json() as { errCode: number; data?: { url?: string; size?: number } };
    assert.equal(response.status, 201);
    assert.equal(payload.errCode, 0);
    assert.match(payload.data?.url ?? "", /\/project-card-images\/demo\/a{64}\.webp$/);
    assert.equal(payload.data?.size, webp.byteLength);
  } finally {
    await server.close();
  }
});

test("project card image upload rejects non-WebP content types", async () => {
  const storage = createStorageStub({
    saveProjectCardImage: async () => {
      throw new Error("saveProjectCardImage must not run for non-WebP uploads.");
    },
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"]));

  try {
    const response = await fetch(server.url("/api/projects/demo/project-card-image"), {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: "not-an-image",
    });
    const payload = await response.json() as { errCode: number };
    assert.equal(response.status, 415);
    assert.equal(payload.errCode, 415);
  } finally {
    await server.close();
  }
});

test("project card image upload reports oversized WebP bodies as 413", async () => {
  const storage = createStorageStub({
    saveProjectCardImage: async () => {
      throw new Error("saveProjectCardImage must not run for oversized uploads.");
    },
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"]));
  const oversizedWebp = Buffer.alloc(PROJECT_CARD_IMAGE_MAX_BYTES + 1);
  oversizedWebp.write("RIFF", 0, "ascii");
  oversizedWebp.write("WEBP", 8, "ascii");

  try {
    const response = await fetch(server.url("/api/projects/demo/project-card-image"), {
      method: "POST",
      headers: { "Content-Type": "image/webp" },
      body: new Uint8Array(oversizedWebp),
    });
    const payload = await response.json() as { errCode: number; errMessage: string };
    assert.equal(response.status, 413);
    assert.equal(payload.errCode, 413);
    assert.match(payload.errMessage, /too large/i);
  } finally {
    await server.close();
  }
});

test("project card metadata endpoint validates and persists server-issued image URLs", async () => {
  const projectCard = {
    icon: "bot" as const,
    iconUrl: `https://server.example/project-card-images/demo/${"b".repeat(64)}.webp`,
    iconColor: "#ffffff",
    iconBackgroundColor: "#2563eb",
  };
  const storage = createStorageStub({
    updateProjectCardMetadata: async (options) => {
      assert.equal(options.projectName, "demo");
      assert.deepEqual(options.projectCard, projectCard);
      return options.projectCard;
    },
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"]));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/project-card"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectCard }),
    });
    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, projectCard);
  } finally {
    await server.close();
  }
});

test("project info endpoint preserves localized names and future declaration ids", async () => {
  const projectInfo = {
    localizedNames: { "zh-CN": "中文名称", en: "English Name", ja: "日本語" },
    declarations: ["multilingual", "future-capability"],
    platformSupport: { mode: "specific" as const, platforms: ["macos", "future-os"] },
    dataStorage: { mode: "both" as const },
    relatedProjects: [],
  };
  const storage = createStorageStub({
    updateProjectInfoMetadata: async (options) => {
      assert.equal(options.projectName, "demo");
      assert.equal(options.name, "Default Name");
      assert.deepEqual(options.projectInfo, projectInfo);
      return { name: options.name, projectInfo: options.projectInfo };
    },
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"]));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/project-info"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Default Name", projectInfo }),
    });
    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, { name: "Default Name", projectInfo });
  } finally {
    await server.close();
  }
});

test("source files endpoint does not let a global source permission bypass project read access", async () => {
  let sourceRead = false;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: "private",
      ownerUserId: "owner-1",
    }),
    hasProjectSourceCapability: async () => false,
    getDownloadableSourceFiles: async () => {
      sourceRead = true;
      throw new Error("Source must not be read without project access.");
    },
  });
  const server = await listen(
    storage,
    createPrincipal(["projects.download_source"], { userId: "developer-1" }),
  );

  try {
    const response = await fetch(server.url("/api/projects/demo/source-files"));
    assert.equal(response.status, 403);
    assert.equal(sourceRead, false);
  } finally {
    await server.close();
  }
});

test("project deployment details authorize every manifest project when a dependency item is missing", async () => {
  const rootProjectId = "00000000-0000-4000-8000-000000000404";
  const sourceProjectId = "00000000-0000-4000-8000-000000000405";
  const deploymentId = "00000000-0000-4000-8000-000000000406";
  const checkedProjects: string[] = [];
  const storage = createStorageStub({
    getProjectGroupDeployment: async () => ({
      id: deploymentId,
      rootProjectId,
      status: "failed",
      manifest: {
        version: 1,
        rootProjectId,
        projects: [
          { projectId: rootProjectId, role: "root", archivePath: "projects/board.tgz" },
          {
            projectId: sourceProjectId,
            role: "dependency",
            alias: "stocks",
            archivePath: "projects/stocks.tgz",
          },
        ],
        dependencies: [{
          alias: "stocks",
          projectId: sourceProjectId,
          delivery: "included",
        }],
      },
      releaseLog: "",
      createdByUserId: "owner-1",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:01:00.000Z",
      failedStage: "dependency-publish",
      errorMessage: "Dependency publication failed.",
      items: [{
        deploymentId,
        projectId: rootProjectId,
        role: "root",
        delivery: "included",
        status: "prepared",
        plannedVersion: "0.3.0",
        updatedAt: "2026-08-05T00:01:00.000Z",
      }],
    }),
    getProjectAccessSummary: async (projectId, userId) => {
      checkedProjects.push(projectId);
      return {
        projectId: projectId,
        projectName: projectId,
        visibility: projectId === rootProjectId ? "public" : "private",
        ownerUserId: "owner-1",
        member: userId === "viewer-1" && projectId === rootProjectId
          ? {
              projectId: projectId,
              userId,
              role: "manager",
              createdAt: "2026-08-05T00:00:00.000Z",
            }
          : undefined,
      };
    },
  });
  const server = await listen(
    storage,
    createPrincipal(["projects.read_public"], { userId: "viewer-1" }),
  );

  try {
    const response = await fetch(server.url(`/api/deployments/${deploymentId}`));
    assert.equal(response.status, 403);
    assert.deepEqual(checkedProjects, [rootProjectId, sourceProjectId]);
  } finally {
    await server.close();
  }
});

test("dependency status and project-group download APIs retain exact targets and skipped dependencies", async () => {
  const dependency = {
    alias: "stocks",
    projectId: "00000000-0000-4000-8000-000000000412",
    delivery: "included" as const,
    version: "0.5.0",
    sourceHash: "a".repeat(64),
  };
  const statusResult = {
    rootProjectId: "demo",
    rootVersion: "0.3.0",
    dependencies: [{
      dependency,
      projectAvailable: true,
      sourceAvailable: true,
      sourceDownloadAllowed: false,
      relationshipConfirmed: true,
      dataInitialized: false,
      requestUrl: "http://example.test/access-requests/token",
    }],
    publishable: false,
  };
  const downloadResult = {
    rootProjectId: "demo",
    rootVersion: "0.3.0",
    dependencies: [dependency],
    downloads: [{
      projectId: "demo",
      version: "0.3.0",
      sourceHash: "b".repeat(64),
      role: "root" as const,
    }],
    projects: [],
    skippedDependencies: [{
      dependency,
      reason: "permission_required" as const,
      requestUrl: "http://example.test/access-requests/token",
    }],
    complete: false,
    copyAllowed: false,
  };
  const storage = createStorageStub({
    getProjectDependencyStatus: async (options) => {
      assert.equal(options.projectName, "demo");
      assert.equal(options.target, "0.3.0");
      return statusResult;
    },
    getProjectGroupDownload: async (options) => {
      assert.equal(options.projectName, "demo");
      assert.equal(options.target, "0.3.0");
      return downloadResult;
    },
  });
  const server = await listen(storage, createPrincipal([]));

  try {
    const status = await fetchJson(server.url("/api/projects/demo/dependencies?target=0.3.0"));
    assert.deepEqual(status.data, statusResult);
    const download = await fetchJson(server.url("/api/projects/demo/project-group-download?target=0.3.0"));
    assert.deepEqual(download.data, downloadResult);
  } finally {
    await server.close();
  }
});

test("related-project API lists, updates, and removes a confirmed relationship", async () => {
  const rootProjectId = "00000000-0000-4000-8000-000000000421";
  const targetProjectId = "00000000-0000-4000-8000-000000000422";
  const relation = createRelatedProject(targetProjectId, "inventory");
  const result = {
    projectId: rootProjectId,
    relatedProjects: [{
      relation,
      projectName: "Inventory",
      reciprocalAlias: "board",
      grantFromRelatedProject: relation.grantToRelatedProject,
      confirmed: true,
    }],
  };
  const storage = createStorageStub({
    listRelatedProjects: async (projectId) => {
      assert.equal(projectId, rootProjectId);
      return result;
    },
    setRelatedProject: async (options) => {
      assert.deepEqual(options, {
        projectId: rootProjectId,
        alias: "inventory",
        targetProjectId,
        grantToRelatedProject: relation.grantToRelatedProject,
        updateTarget: true,
        targetAlias: "board",
        targetGrantToRelatedProject: relation.grantToRelatedProject,
      });
      return result;
    },
    removeRelatedProject: async (options) => {
      assert.deepEqual(options, { projectId: rootProjectId, alias: "inventory", updateTarget: true });
      return { removed: true, relatedProjects: [] };
    },
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"]));

  try {
    const list = await fetchJson(server.url(`/api/projects/${rootProjectId}/related-projects`));
    assert.deepEqual(list.data, result);
    const saved = await fetchJson(server.url(`/api/projects/${rootProjectId}/related-projects/inventory`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetProjectId,
        targetAlias: "board",
        grantToRelatedProject: relation.grantToRelatedProject,
        targetGrantToRelatedProject: relation.grantToRelatedProject,
      }),
    });
    assert.deepEqual(saved.data, result);
    const removed = await fetchJson(server.url(`/api/projects/${rootProjectId}/related-projects/inventory`), {
      method: "DELETE",
    });
    assert.deepEqual(removed.data, { removed: true, relatedProjects: [] });
  } finally {
    await server.close();
  }
});

test("source access request API submits, approves, rejects, and revokes download capability", async () => {
  const projectId = "00000000-0000-4000-8000-000000000432";
  const requestId = "00000000-0000-4000-8000-000000000433";
  const request = {
    id: requestId,
    projectId,
    requesterUserId: "user-1",
    capability: "download_source" as const,
    reason: "Need the source to run this Kanban locally.",
    status: "pending" as const,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
  const storage = createStorageStub({
    readProjectAccessRequestToken: () => ({ projectId }),
    createProjectAccessRequest: async (options) => {
      assert.deepEqual(options, {
        projectId,
        requesterUserId: "user-1",
        reason: request.reason,
      });
      return request;
    },
    listProjectAccessRequests: async () => [request],
    listProjectSourceCapabilities: async () => [],
    resolveProjectAccessRequest: async (options) => ({
      ...request,
      status: options.status,
      resolvedByUserId: options.resolvedByUserId,
      resolvedAt: "2026-08-05T00:01:00.000Z",
    }),
    revokeProjectSourceCapability: async (options) => {
      assert.deepEqual(options, {
        projectId,
        userId: "user-1",
        revokedByUserId: "user-1",
      });
      return { revoked: true };
    },
  });
  const requester = await listen(storage, createPrincipal([], { userId: "user-1" }));
  try {
    const details = await fetchJson(requester.url("/api/project-source-access/signed-token"));
    assert.equal((details.data as { projectId: string }).projectId, projectId);
    const submitted = await fetch(requester.url("/api/project-source-access/signed-token/requests"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: request.reason }),
    });
    assert.equal(submitted.status, 201);
  } finally {
    await requester.close();
  }

  const manager = await listen(storage, createPrincipal(["projects.manage_own"], { userId: "user-1" }));
  try {
    const listed = await fetchJson(manager.url(`/api/projects/${projectId}/source-access-requests`));
    assert.deepEqual((listed.data as { requests: unknown }).requests, [request]);
    for (const status of ["approved", "rejected"] as const) {
      const resolved = await fetchJson(manager.url(
        `/api/projects/${projectId}/source-access-requests/${requestId}`,
      ), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      assert.equal((resolved.data as { status: string }).status, status);
    }
    const revoked = await fetchJson(manager.url(
      `/api/projects/${projectId}/source-capabilities/user-1`,
    ), { method: "DELETE" });
    assert.deepEqual(revoked.data, { revoked: true });
  } finally {
    await manager.close();
  }

  const noUser = await listen(storage, {
    kind: "admin_key",
    tokenSource: "bearer",
    permissions: ["system.admin"],
    isSystemAdmin: true,
  });
  try {
    const response = await fetch(noUser.url("/api/project-source-access/signed-token"));
    assert.equal(response.status, 400);
  } finally {
    await noUser.close();
  }
});

test("workflows endpoint hides legacy non-UUID ids from admins after cleanup", async () => {
  const storage = createStorageStub({
    listProjects: async () => ([
      {
        id: "claude-agent",
        name: "@steamharness/claude-agent-workflow",
        projectType: "workflow",
        projectCard: { icon: "bot", iconBackgroundColor: "#2563eb" },
        visibility: "private",
        hasDraft: false,
        latest: "0.0.1",
        versions: ["0.0.1"],
        onlineVersions: ["0.0.1"],
        nextVersion: "0.0.2",
        webhookEnabled: false,
      },
      {
        id: "7a9627b8-405f-4302-adc3-f2789b96095a",
        name: "Viewer Project",
        projectType: "workflow",
        projectCard: { icon: "bot", iconBackgroundColor: "#2563eb" },
        visibility: "public",
        hasDraft: false,
        latest: "1.0.0",
        versions: ["1.0.0"],
        onlineVersions: ["1.0.0"],
        nextVersion: "1.0.1",
        webhookEnabled: false,
      },
    ]) as any,
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: "public",
    }) as any,
  });
  const server = await listen(storage, createPrincipal(["projects.read_all"]));

  try {
    const response = await fetchJson(server.url("/api/projects"));

    // 旧版 non-UUID 项目不再兼容展示，管理员也只应看到 UUID 项目。
    assert.equal(response.errCode, 0);
    assert.deepEqual((response.data as Array<{ id: string }>).map((item) => item.id), [
      "7a9627b8-405f-4302-adc3-f2789b96095a",
    ]);
  } finally {
    await server.close();
  }
});

test("workflows endpoint hides legacy non-UUID ids from ordinary public readers", async () => {
  const storage = createStorageStub({
    listProjects: async () => ([
      {
        id: "legacy-name",
        name: "Legacy",
        projectType: "workflow",
        projectCard: { icon: "bot", iconBackgroundColor: "#2563eb" },
        visibility: "public",
        hasDraft: false,
        latest: "0.0.1",
        versions: ["0.0.1"],
        onlineVersions: ["0.0.1"],
        nextVersion: "0.0.2",
        webhookEnabled: false,
      },
      {
        id: "7a9627b8-405f-4302-adc3-f2789b96095a",
        name: "Viewer Project",
        projectType: "workflow",
        projectCard: { icon: "bot", iconBackgroundColor: "#2563eb" },
        visibility: "public",
        hasDraft: false,
        latest: "1.0.0",
        versions: ["1.0.0"],
        onlineVersions: ["1.0.0"],
        nextVersion: "1.0.1",
        webhookEnabled: false,
      },
    ]) as any,
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: "public",
    }) as any,
  });
  const server = await listen(storage, createPrincipal(["projects.read_public"]));

  try {
    const response = await fetchJson(server.url("/api/projects"));

    assert.equal(response.errCode, 0);
    assert.deepEqual((response.data as Array<{ id: string }>).map((item) => item.id), [
      "7a9627b8-405f-4302-adc3-f2789b96095a",
    ]);
  } finally {
    await server.close();
  }
});

test("create workflow endpoint atomically forwards package UUID and project info", async () => {
  const projectInfo = {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" as const },
    dataStorage: { mode: "both" as const },
    relatedProjects: [],
  };
  const storage = createStorageStub({
    createProject: async (options) => {
      assert.deepEqual(options, {
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        projectName: "Hello Workflow",
        projectType: "workflow",
        projectInfo,
        ownerUserId: "creator-1",
        createdByUserId: "creator-1",
        visibility: "private",
      });
      return {
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        projectName: "Hello Workflow",
        projectType: "workflow",
        projectInfo,
        visibility: "private",
      };
    },
  });
  const server = await listen(storage, createPrincipal(["projects.create"], { userId: "creator-1" }));

  try {
    const response = await fetchJson(server.url("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        name: "Hello Workflow",
        projectType: "workflow",
        projectInfo,
      }),
    });

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, {
      projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      projectName: "Hello Workflow",
      projectType: "workflow",
      projectInfo,
      visibility: "private",
    });
  } finally {
    await server.close();
  }
});

test("create workflow endpoint rejects missing and unknown project types", async () => {
  let createCalls = 0;
  const storage = createStorageStub({
    createProject: async () => {
      createCalls += 1;
      throw new Error("must not be called");
    },
  });
  const server = await listen(storage, createPrincipal(["projects.create"]));

  try {
    for (const body of [
      {
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        name: "Missing Type",
        projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" }, dataStorage: { mode: "both" } },
      },
      {
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        name: "Unknown Type",
        projectType: "agent",
        projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" }, dataStorage: { mode: "both" } },
      },
    ]) {
      const response = await fetchJson(server.url("/api/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      assert.equal(response.errCode, 400);
      const errorMessage = (response as { errMessage?: string }).errMessage ?? "";
      assert.match(errorMessage, /projectType is required/i);
      assert.equal(
        STEAMHARNESS_PROJECT_TYPES.every((projectType) => errorMessage.includes(JSON.stringify(projectType))),
        true,
      );
    }
    assert.equal(createCalls, 0);
  } finally {
    await server.close();
  }
});

test("create workflow endpoint requires a package UUID and declared data storage mode", async () => {
  let createCalls = 0;
  const storage = createStorageStub({
    createProject: async () => {
      createCalls += 1;
      throw new Error("must not be called");
    },
  });
  const server = await listen(storage, createPrincipal(["projects.create"]));
  const validProjectInfo = {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" },
    dataStorage: { mode: "both" },
  };

  try {
    const cases = [
      {
        body: { name: "Missing UUID", projectType: "workflow", projectInfo: validProjectInfo },
        message: /projectId must be a string/i,
      },
      {
        body: {
          projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
          name: "Missing declaration",
          projectType: "workflow",
        },
        message: /projectInfo must be an object/i,
      },
      {
        body: {
          projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
          name: "Invalid declaration",
          projectType: "workflow",
          projectInfo: { ...validProjectInfo, dataStorage: { mode: "archive" } },
        },
        message: /dataStorage\.mode must be "local", "server", or "both"/i,
      },
    ];

    for (const entry of cases) {
      const response = await fetchJson(server.url("/api/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.body),
      });
      assert.equal(response.errCode, 400);
      assert.match((response as { errMessage: string }).errMessage, entry.message);
    }
    assert.equal(createCalls, 0);
  } finally {
    await server.close();
  }
});

test("create workflow endpoint validates and forwards optional project card metadata", async () => {
  const projectCard = {
    icon: "message-circle" as const,
    iconColor: "#f8fafc",
    iconBackgroundColor: "#0f766e",
  };
  const projectInfo = {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" as const },
    dataStorage: { mode: "server" as const },
    relatedProjects: [],
  };
  let receivedOptions: unknown;
  const storage = createStorageStub({
    createProject: async (options) => {
      receivedOptions = options;
      return {
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        projectName: "Round Conversation",
        projectType: "conversation",
        projectInfo,
        visibility: "private",
      };
    },
  });
  const server = await listen(storage, createPrincipal(["projects.create"], { userId: "creator-1" }));

  try {
    const response = await fetchJson(server.url("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        name: "Round Conversation",
        projectType: "conversation",
        projectInfo,
        projectCard,
      }),
    });

    assert.equal(response.errCode, 0);
    assert.deepEqual(receivedOptions, {
      projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      projectName: "Round Conversation",
      projectType: "conversation",
      projectInfo,
      ownerUserId: "creator-1",
      createdByUserId: "creator-1",
      visibility: "private",
      projectCard: { ...projectCard, iconUrl: undefined },
    });
  } finally {
    await server.close();
  }
});

test("create workflow endpoint rejects invalid project card metadata", async () => {
  let createCalls = 0;
  const storage = createStorageStub({
    createProject: async () => {
      createCalls += 1;
      throw new Error("must not be called");
    },
  });
  const server = await listen(storage, createPrincipal(["projects.create"]));

  try {
    const response = await fetchJson(server.url("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        name: "Invalid Card",
        projectType: "workflow",
        projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" }, dataStorage: { mode: "both" } },
        projectCard: { icon: "unknown", iconBackgroundColor: "teal" },
      }),
    });

    assert.equal(response.errCode, 400);
    assert.equal(createCalls, 0);
  } finally {
    await server.close();
  }
});

test("audit events endpoint requires audit.read permission", async () => {
  configureProjectAuthContext({ accountDb: createAccountDbStub() as any });
  const server = await listen(createStorageStub({}), createPrincipal(["projects.read_all"]));

  try {
    const response = await fetchJson(server.url("/api/audit-events"));

    assert.equal(response.errCode, 403);
    assert.equal((response as { errMessage?: string }).errMessage, "Permission denied.");
  } finally {
    configureProjectAuthContext({});
    await server.close();
  }
});

test("audit events endpoint forwards filters and returns paged audit data", async () => {
  const accountDb = createAccountDbStub();
  const expectedPage: AuditEventPage = {
    items: [
      {
        id: "audit-1",
        principalKind: "user_session",
        actorUserId: "user-1",
        actorProfileId: "user-1",
        actorDisplayName: "User One",
        eventType: "project.publish",
        resourceType: "project_version",
        resourceId: "demo:1.0.0",
        outcome: "success",
        requestIp: "127.0.0.1",
        userAgent: "test-agent",
        context: { projectName: "demo", token: "abcd...wxyz" },
        createdAt: "2026-06-18T08:00:00.000Z",
      },
    ],
    hasMore: true,
    nextCursor: "cursor-next",
    total: 42,
  };
  accountDb.getUserProfilesByIds = async (userIds: string[]) => {
    assert.deepEqual(userIds, ["user-1"]);
    return new Map([["user-1", createProfile("user-1", "user-1@example.com", "User One", "https://example.test/user-1.png")]]);
  };
  let capturedOptions: Record<string, unknown> | undefined;
  accountDb.listAuditEvents = async (options?: Record<string, unknown>) => {
    capturedOptions = options;
    return expectedPage;
  };
  configureProjectAuthContext({ accountDb: accountDb as any });
  const server = await listen(createStorageStub({}), createPrincipal(["audit.read"]));

  try {
    const response = await fetchJson(server.url("/api/audit-events?pageSize=10&cursor=cursor-1&from=2026-06-01T00:00:00.000Z&to=2026-06-18T00:00:00.000Z&userId=user-1&principalKind=user_session&eventType=project.publish&resourceType=project_version&resourceId=demo%3A1.0.0&outcome=success"));

    assert.equal(response.errCode, 0);
    assert.deepEqual(capturedOptions, {
      pageSize: 10,
      cursor: "cursor-1",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-18T00:00:00.000Z",
      actorUserId: "user-1",
      principalKind: "user_session",
      eventType: "project.publish",
      resourceType: "project_version",
      resourceId: "demo:1.0.0",
      outcome: "success",
    });
    assert.deepEqual(response.data, {
      ...expectedPage,
      items: [{
        ...expectedPage.items[0],
        actorProfile: {
          userId: "user-1",
          displayName: "User One",
          email: "user-1@example.com",
          avatarUrl: "https://example.test/user-1.png",
        },
      }],
    });
    const recordedEvent = accountDb.createdAuditEvents.at(-1);
    assert.equal(recordedEvent?.eventType, "audit.events.list");
    assert.equal(recordedEvent?.context?.eventType, "project.publish");
  } finally {
    configureProjectAuthContext({});
    await server.close();
  }
});

test("member endpoint rejects owner demotion", async () => {
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId, userId) => ({
      projectId,
      projectName: "demo",
      visibility: "private",
      ownerUserId: "owner-1",
      member: userId === "owner-1"
        ? {
            projectId,
            userId,
            role: "owner",
            createdAt: "2026-06-18T00:00:00.000Z",
          }
        : undefined,
    }),
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"], { userId: "owner-1" }));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/members/owner-1"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    });
    assert.equal(response.errCode, 409);
    assert.match(String((response as { errMessage?: string }).errMessage), /owner role cannot be changed/i);
  } finally {
    await server.close();
  }
});

test("manager cannot transfer ownership", async () => {
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId, userId) => ({
      projectId,
      projectName: "demo",
      visibility: "private",
      ownerUserId: "owner-1",
      member: userId === "manager-1"
        ? {
            projectId,
            userId,
            role: "manager",
            createdAt: "2026-06-18T00:00:00.000Z",
          }
        : undefined,
    }),
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"], { userId: "manager-1" }));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/members/viewer-2"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    });
    assert.equal(response.errCode, 403);
    assert.match(String((response as { errMessage?: string }).errMessage), /cannot transfer project ownership/i);
  } finally {
    await server.close();
  }
});

test("project creator can manage members without owner membership", async () => {
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: "demo",
      visibility: "private",
      ownerUserId: "owner-1",
      createdByUserId: "creator-1",
      member: undefined,
    }),
    setProjectMember: async (options) => ({
      projectId: options.projectId,
      userId: options.userId,
      role: options.role,
      createdBy: options.createdBy,
      createdAt: "2026-06-18T00:00:00.000Z",
    }),
    createProjectInvitation: async (options) => ({
      invitation: {
        id: "inv-creator",
        projectId: options.projectId,
        token: "tok-creator",
        role: options.role,
        createdAt: "2026-06-18T00:00:00.000Z",
        expiresAt: "2026-06-25T00:00:00.000Z",
        createdBy: options.createdBy,
      },
      token: "tok-creator",
    }),
  });
  const server = await listen(storage, createPrincipal(["projects.create"], { userId: "creator-1" }));

  try {
    const memberResponse = await fetchJson(server.url("/api/projects/demo/members/viewer-2"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    });
    assert.equal(memberResponse.errCode, 0);
    assert.deepEqual(memberResponse.data, {
      projectId: "demo",
      userId: "viewer-2",
      role: "viewer",
      createdBy: "creator-1",
      createdAt: "2026-06-18T00:00:00.000Z",
    });

    const invitationResponse = await fetchJson(server.url("/api/projects/demo/invitations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer" }),
    });
    assert.equal(invitationResponse.errCode, 0);
    const data = invitationResponse.data as { invitation: { id: string; role: string; createdBy?: string }; token: string };
    assert.equal(data.invitation.id, "inv-creator");
    assert.equal(data.invitation.role, "writer");
    assert.equal(data.invitation.createdBy, "creator-1");
    assert.equal(data.token, "tok-creator");
  } finally {
    await server.close();
  }
});

// project invitation lifecycle
test("invitation endpoint creates a manager invitation with a token", async () => {
  const storage = createStorageStub({
    createProjectInvitation: async (options) => ({
      invitation: {
        id: "inv-1",
        projectId: options.projectId,
        token: "tok-abc",
        role: options.role,
        createdAt: "2026-06-18T00:00:00.000Z",
        expiresAt: "2026-06-25T00:00:00.000Z",
        createdBy: options.createdBy,
      },
      token: "tok-abc",
    }),
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"], { userId: "owner-1" }));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/invitations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "manager" }),
    });
    assert.equal(response.errCode, 0);
    const data = response.data as { invitation: { id: string; role: string }; token: string };
    assert.equal(data.invitation.role, "manager");
    assert.equal(data.invitation.id, "inv-1");
    assert.equal(data.token, "tok-abc");
  } finally {
    await server.close();
  }
});

test("invitation endpoint rejects owner role and unknown roles", async () => {
  const server = await listen(createStorageStub({}), createPrincipal(["projects.manage_own"], { userId: "owner-1" }));

  try {
    const ownerResponse = await fetchJson(server.url("/api/projects/demo/invitations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    });
    assert.equal(ownerResponse.errCode, 400);

    const badResponse = await fetchJson(server.url("/api/projects/demo/invitations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "superuser" }),
    });
    assert.equal(badResponse.errCode, 400);
  } finally {
    await server.close();
  }
});

test("invitation revoke endpoint requires a still-pending invitation", async () => {
  const storage = createStorageStub({
    revokeProjectInvitation: async () => ({ revoked: true }),
  });
  const server = await listen(storage, createPrincipal(["projects.manage_own"], { userId: "owner-1" }));

  try {
    const response = await fetchJson(server.url("/api/projects/demo/invitations/inv-1"), {
      method: "DELETE",
    });
    assert.equal(response.errCode, 0);
    assert.equal((response.data as { revoked: boolean }).revoked, true);
  } finally {
    await server.close();
  }

  const blockedServer = await listen(
    createStorageStub({ revokeProjectInvitation: async () => ({ revoked: false }) }),
    createPrincipal(["projects.manage_own"], { userId: "owner-1" }),
  );
  try {
    const response = await fetchJson(blockedServer.url("/api/projects/demo/invitations/inv-1"), {
      method: "DELETE",
    });
    assert.equal(response.errCode, 409);
  } finally {
    await blockedServer.close();
  }
});

test("publish endpoint forwards exact version and source preconditions", async () => {
  const sourceHash = "a".repeat(64);
  const published: unknown[] = [];
  const storage = createStorageStub({
    publish: async (options) => {
      published.push(options);
      return { projectId: "demo", projectName: "demo", version: "1.2.3", latest: "1.2.3", nextVersion: "1.2.4", releaseLog: "Version notes", dependencies: [] };
    },
  });
  const server = await listen(storage, createPrincipal(["projects.manage_all"]));
  try {
    const response = await fetchJson(server.url("/api/projects/demo/publish"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseLog: "Version notes", expectedVersion: "1.2.3", expectedSourceHash: sourceHash }),
    });
    assert.equal(response.errCode, 0);
    assert.deepEqual(published, [{ projectName: "demo", releaseLog: "Version notes", expectedVersion: "1.2.3", expectedSourceHash: sourceHash, createdByUserId: "user-1" }]);
    const invalid = await fetchJson(server.url("/api/projects/demo/publish"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedSourceHash: 123 }),
    });
    assert.equal(invalid.errCode, 400);
    assert.equal(published.length, 1);
  } finally { await server.close(); }
});

test("publish endpoint rejects callers without project management permission", async () => {
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: "demo",
      visibility: "private",
      ownerUserId: "owner-2",
    }),
    publish: async () => {
      throw new Error("publish should not run without permission.");
    },
  });
  const server = await listen(storage, createPrincipal(["projects.read_all"]));

  try {
    const response = await fetch(server.url("/api/projects/demo/publish"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseLog: "test" }),
    });
    const payload = await response.json() as { errCode: number };
    assert.equal(response.status, 403);
    assert.equal(payload.errCode, 403);
  } finally {
    await server.close();
  }
});

test("workflow KV endpoint forwards project filters", async () => {
  const storage = createStorageStub({
    listProjectKVEntries: async (options) => {
      assert.deepEqual(options, {
        projectId: "demo",
        pageSize: 25,
        cursor: undefined,
        scope: "conversation",
        query: "memory",
        valueType: "object",
        conversationId: "Thread-1",
        runId: "RUN-1",
      });
      return { items: [], hasMore: false, total: 0 };
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/projects/demo/kv?pageSize=25&scope=conversation&q=memory&valueType=object&linkState=unlinked&conversationId=Thread-1&runId=RUN-1"));

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, { items: [], hasMore: false, total: 0 });
  } finally {
    await server.close();
  }
});

test("workflow KV detail endpoint forwards exact entry identity", async () => {
  const detail = createKVDetail({ scope: "conversation", key: "conversation.state", conversationId: "Thread-1" });
  const storage = createStorageStub({
    getProjectKVEntry: async (options) => {
      assert.deepEqual(options, {
        projectId: "demo",
        scope: "conversation",
        key: "conversation.state",
        conversationId: "Thread-1",
      });
      return detail;
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/projects/demo/kv/entry?scope=conversation&key=conversation.state&conversationId=Thread-1"));

    // loads full KV values only after a row is expanded.
    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, detail);
  } finally {
    await server.close();
  }
});

test("project storage endpoint forwards PersistentValue get and set payloads", async () => {
  const calls: string[] = [];
  const storage = createStorageStub({
    getProjectStorageValue: async (options) => {
      calls.push(`get:${options.storageKind}:${options.scope}:${options.projectId}:${options.conversationId}:${options.key}`);
      return { exists: true, value: "stored", revision: "42" };
    },
    setProjectStorageValue: async (options) => {
      calls.push(`set:${options.storageKind}:${options.scope}:${options.projectId}:${options.conversationId}:${options.key}:${JSON.stringify(options.value)}:${options.source?.runId}`);
      return { ok: true };
    },
  });
  const server = await listen(storage);

  try {
    const get = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "demo",
        storageKind: "persistent_value",
        operation: "get",
        entry: {
          scope: "project",
          projectId: "demo",
          key: "settings",
        },
      }),
    });
    const set = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "demo",
        storageKind: "persistent_value",
        operation: "set",
        entry: {
          scope: "conversation",
          projectId: "demo",
          conversationId: "Thread-1",
          key: "memory",
        },
        value: { saved: true },
        source: {
          projectId: "demo",
          runId: "run-1",
          conversationId: "Thread-1",
        },
      }),
    });

    // Server-backed PersistentValue requests retain their PostgreSQL write and
    // source metadata behavior.
    assert.equal(get.errCode, 0);
    assert.deepEqual(get.data, { exists: true, value: "stored", revision: "42" });
    assert.equal(set.errCode, 0);
    assert.deepEqual(calls, [
      "get:persistent_value:project:demo:undefined:settings",
      "set:persistent_value:conversation:demo:Thread-1:memory:{\"saved\":true}:run-1",
    ]);
  } finally {
    await server.close();
  }
});

test("project storage endpoint requires a bound current-project address", async () => {
  let storageCalls = 0;
  const storage = createStorageStub({
    getProjectStorageValue: async () => {
      storageCalls += 1;
      return { exists: false };
    },
    setProjectStorageValue: async () => {
      storageCalls += 1;
      return { ok: true };
    },
    mutateProjectStorageKnowledgeDocument: async () => {
      storageCalls += 1;
      return createKnowledgeDocument("unexpected");
    },
  });
  const server = await listen(storage);

  try {
    const bodies = [
      {
        operation: "get",
        storageKind: "persistent_value",
        entry: { scope: "project", projectId: "project-a", key: "settings" },
      },
      {
        projectId: "project-a",
        storageKind: "persistent_value",
        operation: "get",
        entry: { scope: "project", projectId: "project-b", key: "settings" },
      },
      {
        projectId: "project-a",
        storageKind: "persistent_value",
        operation: "set",
        entry: { scope: "project", projectId: "project-a", key: "settings" },
        value: true,
        source: { projectId: "project-b" },
      },
      {
        projectId: "project-a",
        storageKind: "persistent_value",
        operation: "knowledge-mutation",
        namespace: { scope: "project", projectId: "project-b" },
        mutation: {
          type: "create",
          input: { id: "guide", title: "Guide", markdown: "# Guide" },
        },
      },
    ];

    for (const body of bodies) {
      const response = await fetchJson(server.url("/api/project-storage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.errCode, 400);
    }
    assert.equal(storageCalls, 0);
  } finally {
    await server.close();
  }
});

test("project storage endpoint forwards compare-and-set revisions", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const storage = createStorageStub({
    compareAndSetProjectStorageValue: async (options) => {
      calls.push(options);
      return { applied: true, revision: "43" };
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "demo",
        storageKind: "persistent_value",
        operation: "compare-and-set",
        entry: { scope: "project", projectId: "demo", key: "counter" },
        expectedRevision: "42",
        value: 2,
        source: { projectId: "demo", runId: "run-2" },
      }),
    });
    const create = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "demo",
        storageKind: "persistent_value",
        operation: "compare-and-set",
        entry: { scope: "project", projectId: "demo", key: "new-counter" },
        expectedRevision: null,
        value: 1,
      }),
    });
    const invalid = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "demo",
        storageKind: "persistent_value",
        operation: "compare-and-set",
        entry: { scope: "project", projectId: "demo", key: "counter" },
        expectedRevision: "not-a-row-version",
        value: 3,
      }),
    });

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, { applied: true, revision: "43" });
    assert.equal(create.errCode, 0);
    assert.equal(invalid.errCode, 400);
    assert.deepEqual(calls, [{
      storageKind: "persistent_value",
      scope: "project",
      projectId: "demo",
      key: "counter",
      expectedRevision: "42",
      value: 2,
      source: { projectId: "demo", runId: "run-2", conversationId: undefined },
    }, {
      storageKind: "persistent_value",
      scope: "project",
      projectId: "demo",
      key: "new-counter",
      expectedRevision: null,
      value: 1,
      source: { projectId: "demo" },
    }]);
  } finally {
    await server.close();
  }
});

test("project storage endpoint forwards atomic PersistentValue knowledge mutations", async () => {
  const calls: string[] = [];
  const document = createKnowledgeDocument("remote-guide");
  const storage = createStorageStub({
    mutateProjectStorageKnowledgeDocument: async (options) => {
      calls.push(`${options.projectId}:${options.mutation.type}:${JSON.stringify(options.mutation.input)}`);
      return options.mutation.type === "delete"
        ? { id: options.mutation.input.documentId, deleted: true }
        : document;
    },
  });
  const server = await listen(storage);

  try {
    const create = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "remote-project",
        storageKind: "persistent_value",
        operation: "knowledge-mutation",
        namespace: { scope: "project", projectId: "remote-project" },
        mutation: {
          type: "create",
          input: { id: "remote-guide", title: "Remote guide", markdown: "# Remote" },
        },
      }),
    });
    const edit = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "remote-project",
        storageKind: "persistent_value",
        operation: "knowledge-mutation",
        namespace: { scope: "project", projectId: "remote-project" },
        mutation: {
          type: "edit",
          input: { documentId: "remote-guide", markdown: "# Edited" },
        },
      }),
    });
    const deleted = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "remote-project",
        storageKind: "persistent_value",
        operation: "knowledge-mutation",
        namespace: { scope: "project", projectId: "remote-project" },
        mutation: {
          type: "delete",
          input: { documentId: "remote-guide" },
        },
      }),
    });

    assert.equal(create.errCode, 0);
    assert.equal(edit.errCode, 0);
    assert.equal(deleted.errCode, 0);
    assert.deepEqual(deleted.data, { id: "remote-guide", deleted: true });
    assert.deepEqual(calls, [
      "remote-project:create:{\"id\":\"remote-guide\",\"title\":\"Remote guide\",\"markdown\":\"# Remote\"}",
      "remote-project:edit:{\"documentId\":\"remote-guide\",\"markdown\":\"# Edited\"}",
      "remote-project:delete:{\"documentId\":\"remote-guide\"}",
    ]);
  } finally {
    await server.close();
  }
});

test("PersistentValue knowledge mutations require data write access to the current project", async () => {
  let mutationCalled = false;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: "private",
      ownerUserId: "owner-1",
    }),
    mutateProjectStorageKnowledgeDocument: async () => {
      mutationCalled = true;
      return createKnowledgeDocument("should-not-write");
    },
  });
  const server = await listen(
    storage,
    createPrincipal(["knowledge.manage", "projects.manage_own"], { userId: "other-user" }),
  );

  try {
    const response = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "private-project",
        storageKind: "persistent_value",
        operation: "knowledge-mutation",
        namespace: { scope: "project", projectId: "private-project" },
        mutation: {
          type: "create",
          input: { id: "private-guide", title: "Private guide", markdown: "# Private" },
        },
      }),
    });

    assert.equal(response.errCode, 403);
    assert.equal(mutationCalled, false);
  } finally {
    await server.close();
  }
});

test("current project and conversation writes require project data write access", async () => {
  let readCalled = false;
  let writeCalled = false;
  const storage = createStorageStub({
    getProjectAccessSummary: async (projectId) => ({
      projectId,
      projectName: projectId,
      visibility: "private",
      ownerUserId: "owner-1",
    }),
    getProjectStorageValue: async () => {
      readCalled = true;
      return { exists: true, value: "should-not-read" };
    },
    setProjectStorageValue: async () => {
      writeCalled = true;
      return { ok: true };
    },
  });
  const server = await listen(
    storage,
    createPrincipal(["knowledge.manage", "projects.manage_own"], { userId: "other-user" }),
  );

  try {
    const read = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "private-project",
        storageKind: "persistent_value",
        operation: "get",
        entry: {
          scope: "project",
          projectId: "private-project",
          key: "private-key",
        },
      }),
    });
    const write = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "private-project",
        storageKind: "persistent_value",
        operation: "set",
        entry: {
          scope: "conversation",
          projectId: "private-project",
          conversationId: "thread-1",
          key: "private-key",
        },
        value: "should-not-write",
      }),
    });

    assert.equal(read.errCode, 403);
    assert.equal(write.errCode, 403);
    assert.equal(readCalled, false);
    assert.equal(writeCalled, false);
  } finally {
    await server.close();
  }
});

test("project storage endpoint rejects the removed global scope", async () => {
  let readCalled = false;
  const storage = createStorageStub({
    getProjectStorageValue: async () => {
      readCalled = true;
      return { exists: true, value: "global-value" };
    },
  });
  const server = await listen(storage, createPrincipal(["knowledge.manage"], { userId: "other-user" }));

  try {
    const response = await fetchJson(server.url("/api/project-storage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "global-owner-project",
        storageKind: "persistent_value",
        operation: "get",
        entry: { scope: "global", key: "global-key" },
      }),
    });

    assert.equal(response.errCode, 400);
    assert.equal(readCalled, false);
  } finally {
    await server.close();
  }
});

test("knowledge document endpoints forward CRUD payloads", async () => {
  const calls: string[] = [];
  const document = createKnowledgeDocument("guide");
  const storage = createStorageStub({
    listKnowledgeDocuments: async (projectName, options) => {
      calls.push(`list:${projectName}:${options?.pageSize}:${options?.cursor}`);
      return { items: [createKnowledgeListItem("guide")], hasMore: false, total: 1 };
    },
    createKnowledgeDocument: async (options) => {
      calls.push(`create:${options.projectName}:${options.id}:${options.title}:${options.markdown}`);
      return document;
    },
    getKnowledgeDocument: async (options) => {
      calls.push(`get:${options.projectName}:${options.documentId}`);
      return document;
    },
    editKnowledgeDocument: async (options) => {
      calls.push(`edit:${options.projectName}:${options.documentId}:${options.title}:${options.markdown}`);
      return { ...document, title: options.title ?? document.title, markdown: options.markdown ?? document.markdown };
    },
    deleteKnowledgeDocument: async (options) => {
      calls.push(`delete:${options.projectName}:${options.documentId}`);
      return { id: options.documentId, deleted: true };
    },
  });
  const server = await listen(storage);

  try {
    const list = await fetchJson(server.url("/api/projects/demo/knowledge-documents?pageSize=10&cursor=20"));
    const create = await fetchJson(server.url("/api/projects/demo/knowledge-documents?response=summary"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "guide", title: "Guide", markdown: "# Guide" }),
    });
    const get = await fetchJson(server.url("/api/projects/demo/knowledge-documents/guide"));
    const edit = await fetchJson(server.url("/api/projects/demo/knowledge-documents/guide?response=summary"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Guide v2", markdown: "# Guide v2" }),
    });
    const deleted = await fetchJson(server.url("/api/projects/demo/knowledge-documents/guide"), {
      method: "DELETE",
    });

    // Knowledge document REST APIs manage project PersistentValue markdown
    // documents without exposing raw KV rows.
    assert.equal(list.errCode, 0);
    assert.equal(create.errCode, 0);
    assert.equal(get.errCode, 0);
    assert.equal(edit.errCode, 0);
    assert.equal(deleted.errCode, 0);
    assert.deepEqual((list.data as KnowledgeDocumentPageRecord).items.map((item) => item.id), ["guide"]);
    assert.equal((create.data as KnowledgeDocumentListItem).markdownPreview, "Guide");
    assert.equal("markdown" in (create.data as Record<string, unknown>), false);
    assert.equal((edit.data as KnowledgeDocumentListItem).markdownPreview, "Guide v2");
    assert.equal("markdown" in (edit.data as Record<string, unknown>), false);
    assert.deepEqual(deleted.data, { id: "guide", deleted: true });
    assert.deepEqual(calls, [
      "list:demo:10:20",
      "create:demo:guide:Guide:# Guide",
      "get:demo:guide",
      "edit:demo:guide:Guide v2:# Guide v2",
      "delete:demo:guide",
    ]);
  } finally {
    await server.close();
  }
});

test("knowledge summary responses use the bounded shared markdown preview", async () => {
  const document: KnowledgeDocumentRecord = {
    ...createKnowledgeDocument("large-guide"),
    markdown: `${"#".repeat(20_000)}late markdown`,
  };
  const storage = createStorageStub({
    createKnowledgeDocument: async () => document,
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/projects/demo/knowledge-documents?response=summary"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "large-guide", title: "Large guide", markdown: document.markdown }),
    });

    assert.equal(response.errCode, 0);
    assert.equal((response.data as KnowledgeDocumentListItem).markdownPreview, "");
    assert.equal("markdown" in (response.data as Record<string, unknown>), false);
  } finally {
    await server.close();
  }
});

test("knowledge search endpoint forwards line context query parameters", async () => {
  const result: KnowledgeDocumentSearchResult = {
    query: "markdown",
    documentsSearched: 1,
    totalMatches: 1,
    matchesTruncated: false,
    maxMatches: 50,
    pageSize: 25,
    cursor: "75",
    nextCursor: "100",
    hasMore: true,
    matches: [{
      documentId: "guide",
      title: "Guide",
      lineNumber: 2,
      line: "markdown line",
      before: [{ lineNumber: 1, content: "# Guide" }],
      after: [{ lineNumber: 3, content: "next" }],
    }],
  };
  const storage = createStorageStub({
    searchKnowledgeDocuments: async (options) => {
      assert.deepEqual(options, {
        projectName: "demo",
        query: "markdown",
        documentId: "guide",
        beforeLines: 1,
        afterLines: 1,
        maxMatches: 50,
        pageSize: 25,
        cursor: "75",
      });
      return result;
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/projects/demo/knowledge-documents/search?q=markdown&documentId=guide&beforeLines=1&afterLines=1&maxMatches=50&pageSize=25&cursor=75"));

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, result);
  } finally {
    await server.close();
  }
});

test("knowledge document line endpoint forwards document id and range query parameters", async () => {
  const result: KnowledgeDocumentLinesRecord = {
    documentId: "guide",
    title: "Guide",
    startLine: 2,
    endLine: 4,
    totalLines: 6,
    lines: [
      { lineNumber: 2, content: "two" },
      { lineNumber: 3, content: "three" },
      { lineNumber: 4, content: "four" },
    ],
  };
  const storage = createStorageStub({
    readKnowledgeDocumentLines: async (options) => {
      assert.deepEqual(options, {
        projectName: "demo",
        documentId: "guide",
        startLine: 2,
        endLine: 4,
      });
      return result;
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/projects/demo/knowledge-documents/guide/lines?startLine=2&endLine=4"));

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, result);
  } finally {
    await server.close();
  }
});

test("system token usage endpoint forwards pagination filters", async () => {
  const usagePage: TokenUsagePage = {
    systemTotal: createTokenUsageAggregate(120),
    projects: [
      { projectId: "demo", total: createTokenUsageAggregate(80), updatedAt: "2026-05-22T00:00:00.000Z" },
    ],
    hasMore: false,
    total: 1,
  };
  const storage = createStorageStub({
    getSystemTokenUsage: async (options) => {
      assert.deepEqual(options, {
        pageSize: 10,
        cursor: "cursor-1",
      });
      return usagePage;
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/token-usage?pageSize=10&cursor=cursor-1"));

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, usagePage);
  } finally {
    await server.close();
  }
});

test("project token usage endpoint forwards conversation detail filters", async () => {
  const detail: TokenUsageDetail = {
    projectId: "demo",
    projectTotal: createTokenUsageAggregate(120),
    conversationId: "Thread-1",
    conversationTotal: createTokenUsageAggregate(60),
    entries: [],
  };
  const storage = createStorageStub({
    getProjectTokenUsage: async (options) => {
      assert.deepEqual(options, {
        projectId: "demo",
        conversationId: "Thread-1",
        includeEntries: true,
      });
      return detail;
    },
  });
  const server = await listen(storage);

  try {
    const response = await fetchJson(server.url("/api/projects/demo/token-usage?conversationId=Thread-1&includeEntries=true"));

    assert.equal(response.errCode, 0);
    assert.deepEqual(response.data, detail);
  } finally {
    await server.close();
  }
});

test("all member roles can read data while only writers and managers can mutate it", async () => {
  for (const role of ["owner", "manager", "writer", "viewer"] as const) {
    const storage = createStorageStub({
      getProjectAccessSummary: async projectId => ({ projectId, projectName: projectId, visibility: "private",
        member: { projectId, userId: "member", role, createdAt: "2026-10-16T00:00:00.000Z" } }),
      canDownloadProjectSource: Storage.prototype.canDownloadProjectSource,
      getFiles: async () => ({ projectId: "demo", projectName: "demo", target: "draft", resolvedTarget: "draft", files: [] }),
      getSourceArchive: async () => ({ version: "1.0.0", archive: Buffer.from("archive") }),
      cloneProject: async () => ({ projectId: "copy", projectName: "copy", sourceTarget: "latest", resolvedSourceTarget: "1.0.0", nextVersion: "1.0.1" }),
      getKanbanWorkspace: async () => ({ projectId: "demo", projectName: "demo", target: "latest",
        resolvedTarget: "1.0.0", artifactDir: ".", entry: "index.html", relatedProjects: [], configurations: [] }),
    });
    const server = await listen(storage, createPrincipal(["projects.create"], { userId: "member" }));
    try {
      const request = (operation: string) => fetch(server.url("/api/project-storage"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "demo", storageKind: "kv", operation,
          entry: { scope: "project", projectId: "demo", key: "settings" }, value: true }),
      });
      assert.equal((await request("get")).status, 200, role);
      assert.equal((await request("set")).status, role === "viewer" ? 403 : 200, role);
      assert.equal((await fetch(server.url("/api/projects/demo/knowledge-documents"))).status, 200, role);
      assert.equal((await fetch(server.url("/api/projects/demo/knowledge-documents"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Guide", markdown: "# Guide" }),
      })).status, role === "viewer" ? 403 : 201, role);
      const bridge = await fetch(server.url("/api/projects/demo/kanban/bridge"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call: { requestId: "write", operation: "kv.setValue", input: { key: "settings", value: true } } }),
      });
      assert.equal(bridge.status, role === "viewer" ? 403 : 200, role);
      const downloadStatus = role === "owner" || role === "manager" ? 200 : 403;
      assert.equal((await fetch(server.url("/api/projects/demo/files?target=draft"))).status, downloadStatus, role);
      assert.equal((await fetch(server.url("/api/projects/demo/source-archive?target=1.0.0"))).status, downloadStatus, role);
      assert.equal((await fetch(server.url("/api/projects/demo/clone"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetProjectName: "copy" }),
      })).status, downloadStatus, role);
    } finally { await server.close(); }
  }
});

test("removed execution APIs return JSON 404 before authentication", async () => {
  const app = express();
  app.use("/api", createApiRouter(createStorageStub({})));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [method, endpoint] of [
      ["POST", "/projects/demo/run"], ["POST", "/projects/demo/run-stream"],
      ["GET", "/projects/demo/runs"], ["GET", "/projects/demo/run-stats"],
      ["GET", "/projects/demo/structure"], ["POST", "/projects/demo/resolve-params"],
      ["GET", "/projects/demo/env"], ["GET", "/projects/demo/webhook"],
      ["GET", "/projects/demo/schedules"], ["POST", "/projects/demo/mcp"],
      ["POST", "/projects/demo/versions/1.0.0/online"], ["GET", "/admin/runners"],
      ["POST", "/runner/heartbeat"], ["POST", "/runtime/storage"],
    ]) {
      const response = await fetch(`${origin}/api${endpoint}`, { method });
      assert.equal(response.status, 404, `${method} ${endpoint}`);
      assert.equal((await response.json() as { errCode: number }).errCode, 404);
    }
    assert.equal((await fetch(`${origin}/api/projects`)).status, 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

function createStorageStub(overrides: Partial<Storage>): Storage {
  const stub: Partial<Storage> = {
    canWriteProjectData: Storage.prototype.canWriteProjectData,
    assertDataWritableProject: Storage.prototype.assertDataWritableProject,
    hasProjectSourceCapability: async () => false,
    assertServerProjectDataAccess: async () => ({
      localizedNames: {},
      declarations: [],
      platformSupport: { mode: "agnostic" },
      dataStorage: { mode: "both" },
      relatedProjects: [],
    }),
    getProjectAccessSummary: async (projectId, userId) => ({
      projectId,
      projectName: projectId,
      visibility: "private",
      ownerUserId: userId ?? "user-1",
      member: userId === undefined
        ? undefined
        : {
            projectId,
            userId,
            role: "owner",
            createdAt: "2026-06-18T00:00:00.000Z",
          },
    }),
    canReadProject: (options) => {
      if (options.canReadAll) return true;
      if (options.userId && options.access.member !== undefined) return true;
      return options.canReadPublic === true && options.access.visibility === "public";
    },
    canManageProject: (options) => {
      if (options.canManageAll) return true;
      if (!options.userId) return false;
      if (options.access.member?.role === "owner" || options.access.member?.role === "manager") {
        return true;
      }
      const isOwnerOrCreator = options.access.ownerUserId === options.userId || options.access.createdByUserId === options.userId;
      if (options.canManageOwn && isOwnerOrCreator) {
        return true;
      }
      return Boolean(
        options.canUpload ||
        options.canPublish,
      ) && isOwnerOrCreator;
    },
    canDownloadProjectSource: Storage.prototype.canDownloadProjectSource,
    getSourceDownloadAvailability: async () => ({
      available: true,
      target: "1.0.0",
    }),
    assertReadableProject: (options) => {
      const canRead = options.canReadAll ||
        (options.userId && options.access.member !== undefined) ||
        (options.canReadPublic === true && options.access.visibility === "public");
      if (!canRead) {
        throw new HttpError(403, 403, "Permission denied.");
      }
    },
    assertManageableProject: (options) => {
      const canManage = options.canManageAll ||
        (
          !!options.userId &&
          (
            options.access.member?.role === "owner" ||
            options.access.member?.role === "manager" ||
            (options.canManageOwn && (
              options.access.ownerUserId === options.userId ||
              options.access.createdByUserId === options.userId
            )) ||
            (
              Boolean(
                options.canUpload ||
                options.canPublish,
              ) &&
              (
                options.access.ownerUserId === options.userId ||
                options.access.createdByUserId === options.userId
              )
            )
          )
        );
      if (!canManage) {
        throw new HttpError(403, 403, "Permission denied.");
      }
    },
    listProjectKVEntries: async (): Promise<KVEntryPage> => ({ items: [], hasMore: false, total: 0 }),
    getProjectKVEntry: async (): Promise<KVEntryDetail> => createKVDetail({ scope: "project", key: "settings" }),
    getProjectStorageValue: async () => ({ exists: false }),
    setProjectStorageValue: async () => ({ ok: true }),
    compareAndSetProjectStorageValue: async () => ({ applied: true, revision: "1" }),
    listKnowledgeDocuments: async (): Promise<KnowledgeDocumentPageRecord> => ({ items: [], hasMore: false, total: 0 }),
    getKnowledgeDocument: async (): Promise<KnowledgeDocumentRecord> => createKnowledgeDocument("guide"),
    createKnowledgeDocument: async (): Promise<KnowledgeDocumentRecord> => createKnowledgeDocument("guide"),
    editKnowledgeDocument: async (): Promise<KnowledgeDocumentRecord> => createKnowledgeDocument("guide"),
    deleteKnowledgeDocument: async (): Promise<{ id: string; deleted: boolean }> => ({ id: "guide", deleted: true }),
    searchKnowledgeDocuments: async (): Promise<KnowledgeDocumentSearchResult> => ({
      query: "",
      documentsSearched: 0,
      totalMatches: 0,
      matchesTruncated: false,
      maxMatches: 200,
      pageSize: 200,
      hasMore: false,
      matches: [],
    }),
    readKnowledgeDocumentLines: async (): Promise<KnowledgeDocumentLinesRecord> => ({
      documentId: "guide",
      title: "Guide",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      lines: [{ lineNumber: 1, content: "# Guide" }],
    }),
    getSystemTokenUsage: async (): Promise<TokenUsagePage> => ({
      systemTotal: createTokenUsageAggregate(0),
      projects: [],
      hasMore: false,
      total: 0,
    }),
    getProjectTokenUsage: async (options): Promise<TokenUsageDetail> => ({
      projectId: options.projectId,
      projectTotal: createTokenUsageAggregate(0),
    }),
    createProjectInvitation: async (options) => ({
      invitation: {
        id: "inv-stub",
        projectId: options.projectId,
        token: "stub-token",
        role: options.role,
        createdAt: "2026-05-26T00:00:00.000Z",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        createdBy: options.createdBy,
      },
      token: "stub-token",
    }),
    listProjectInvitations: async (): Promise<never[]> => [],
    getInvitationByToken: async () => undefined,
    revokeProjectInvitation: async () => ({ revoked: false }),
    acceptInvitation: async () => {
      throw new HttpError(404, 404, "Invitation not found.");
    },
    ...overrides,
  };
  return stub as Storage;
}

function createWebpFixture(payload: string): Buffer {
  const content = Buffer.from(payload, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(content.byteLength + 4);
  return Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), content]);
}

function createAccountDbStub() {
  return {
    createdAuditEvents: [] as Array<{
      eventType: string;
      outcome: string;
      context?: Record<string, unknown>;
    }>,
    async getUserProfilesByIds(_userIds: string[]): Promise<Map<string, UserProfileRecord>> {
      return new Map();
    },
    async createAuditEvent(event: {
      eventType: string;
      outcome: string;
      context?: Record<string, unknown>;
    }) {
      this.createdAuditEvents.push(event);
    },
    async listAuditEvents(): Promise<AuditEventPage> {
      return {
        items: [],
        hasMore: false,
        total: 0,
      };
    },
  };
}

async function listen(
  storage: Storage,
  principal?: AuthenticatedPrincipal,
): Promise<{
  close: () => Promise<void>;
  url: (path: string) => string;
}> {
  const app = express();
  app.use((req, res, next) => {
    res.locals.principal = principal ?? createPrincipal(["system.admin"]);
    next();
  });
  app.use("/api", createApiRouter(storage));
  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
  };
}


function createProfile(
  userId: string,
  email: string,
  displayName: string,
  avatarUrl?: string,
): UserProfileRecord {
  return {
    userId,
    email,
    displayName,
    avatarUrl,
    status: "active",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    roleIds: [],
    roleNames: [],
    permissions: [],
  };
}

function createPrincipal(
  permissions: string[],
  overrides: Partial<Extract<AuthenticatedPrincipal, { kind: "user_session" }>> = {},
): AuthenticatedPrincipal {
  return {
    kind: "user_session",
    tokenSource: "cookie",
    userId: overrides.userId ?? "user-1",
    profile: overrides.profile ?? {
      userId: overrides.userId ?? "user-1",
      email: "user-1@example.com",
      displayName: "User One",
      status: "active",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
      roleIds: [],
      roleNames: [],
      permissions: permissions as any,
    },
    permissions: permissions as any,
    isSystemAdmin: permissions.includes("system.admin"),
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function createApiKeyPrincipal(source: "desktop" | "cli"): AuthenticatedPrincipal {
  const sessionPrincipal = createPrincipal(["runs.create"]);
  assert.equal(sessionPrincipal.kind, "user_session");
  return {
    kind: "api_key",
    tokenSource: "bearer",
    userId: sessionPrincipal.userId,
    profile: sessionPrincipal.profile,
    permissions: sessionPrincipal.permissions,
    isSystemAdmin: false,
    apiKey: {
      id: `api-key-${source}`,
      userId: sessionPrincipal.userId,
      name: source === "desktop" ? "SteamHarness Desktop login" : "SteamHarness CLI login",
      prefix: `wfk_${source}`,
      source,
      scopes: [],
      createdAt: "2026-07-22T00:00:00.000Z",
      secretHash: "secret-hash",
      user: sessionPrincipal.profile,
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown & { errCode?: number; data?: unknown }> {
  const response = await fetch(url, init);
  return await response.json() as unknown & { errCode?: number; data?: unknown };
}

function createKVDetail(overrides: Partial<KVEntryDetail>): KVEntryDetail {
  const detail: KVEntryDetail = {
    storageKind: "kv",
    scope: "project",
    key: "settings",
    value: { ok: true },
    valueType: "object",
    valueSizeBytes: 11,
    valuePreview: "{\"ok\":true}",
    projectId: "demo",
    conversationId: overrides.scope === "conversation" ? "Thread-1" : undefined,
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
  if (detail.scope !== "conversation") {
    delete detail.conversationId;
  }
  return detail;
}

function createRelatedProject(
  projectId: string,
  alias = "stocks",
): RelatedProject {
  return {
    alias,
    projectId,
    grantToRelatedProject: {
      read: { mode: "all" },
      write: { mode: "none" },
    },
  };
}

function createRelatedProjectAccess(
  targetProjectId: string,
  grant: RelatedProjectKVGrant = createRelatedProject(targetProjectId).grantToRelatedProject,
): { targetProjectId: string; grant: RelatedProjectKVGrant } {
  return { targetProjectId, grant };
}

function createKnowledgeDocument(id: string): KnowledgeDocumentRecord {
  return {
    id,
    title: "Guide",
    markdown: "# Guide",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

function createKnowledgeListItem(id: string): KnowledgeDocumentListItem {
  return {
    id,
    title: "Guide",
    markdownPreview: "Guide",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

function createTokenUsageAggregate(totalTokens: number) {
  return {
    inputTokens: Math.floor(totalTokens / 2),
    outputTokens: Math.ceil(totalTokens / 2),
    totalTokens,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    calls: totalTokens > 0 ? 1 : 0,
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
}
