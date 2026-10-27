import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { type AuthenticatedPrincipal } from "../../auth";
import { configureProjectAuthContext } from "../../auth";
import { HttpError } from "../../protocol";
import { resolveResourceAccess, type AccessActor, type AccessCapability, type ProjectRole } from "@steamharness/project-access";
import { createApiRouter } from "../api";
import type { AuditEventPage, UserProfileRecord } from "../../account-db";
import { PROJECT_CARD_IMAGE_MAX_BYTES, Storage } from "../../storage";
import type { KVEntryDetail, KVEntryPage, KnowledgeDocumentLinesRecord, KnowledgeDocumentListItem, KnowledgeDocumentPageRecord, KnowledgeDocumentRecord, KnowledgeDocumentSearchResult, TokenUsageDetail, TokenUsagePage } from "../../storage";
import { STEAMHARNESS_PROJECT_TYPES } from "@steamharness/project-types";

test("configuration file uploads persist exact raw bytes in the authenticated project without a conversation", async () => {
  const bytes=Buffer.from([0,137,255,13,10]), writes:unknown[]=[];
  const storage=createStorageStub({saveManagedFiles:async options=>{
    writes.push(options);assert.equal(options.projectName,"demo");assert.deepEqual(options.files[0]!.buffer,bytes);
    assert.equal(options.files[0]!.name,"底图.png");assert.equal(options.files[0]!.conversationId,undefined);
    return [{id:"wf_ab12",name:"底图.png",mimeType:"image/png",size:bytes.length,kind:"image",storage:"server",projectId:"demo",createdAt:"2026-10-21T00:00:00Z"}];
  }});
  const server=await listen(storage,createApiKeyPrincipal("desktop"));
  try {
    const query=new URLSearchParams({fileName:"底图.png",mimeType:"image/png"});
    const response=await fetchJson(server.url(`/api/projects/demo/files?${query}`),{method:"POST",headers:{"Content-Type":"image/png"},body:bytes});
    assert.equal(response.errCode,0);assert.equal(writes.length,1);
    assert.equal((response.data as {storage:string}[])[0]!.storage,"server");
  }finally{await server.close();}
});

test("Kanban workspace issues a short-lived preview capability for Bearer-authenticated App users", async () => {
  const storage = createStorageStub({
    getKanbanWorkspace: async (options) => {
      assert.deepEqual(options, {
        projectName: "demo",
        entryId:"board",target: "draft",
        actorId: "user-1",
      });
      return {
        projectId: "demo",
        projectName: "Kanban Demo",
        target: "draft",
        resolvedTarget: "draft",
        artifactDir: "dist",
        entry: "pages/board view.htm",

        entryId:"board",databases:[],configurations: [],
      };
    },
    issueKanbanPreviewCapability: async (options) => {
      assert.deepEqual(options, {
        projectName: "demo",
        entryId:"board",target: "draft",
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
    const response = await fetchJson(server.url("/api/projects/demo/kanban?entryId=board&target=draft"));

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
  const server = await listen(storage, createPrincipal(false));

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
  const server = await listen(storage, createPrincipal(false));

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
  const server = await listen(storage, createPrincipal(false));
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
  const server = await listen(storage, createPrincipal(false));

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


  };
  const storage = createStorageStub({
    updateProjectInfoMetadata: async (options) => {
      assert.equal(options.projectName, "demo");
      assert.equal(options.name, "Default Name");
      assert.deepEqual(options.projectInfo, projectInfo);
      return { name: options.name, projectInfo: options.projectInfo };
    },
  });
  const server = await listen(storage, createPrincipal(false));

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

test("source download recipients cannot read or clone unpublished configuration source", async () => {
  const reads: string[] = [], clones: string[] = [];
  const storage = createStorageStub({
    getProjectAccessSummary: async projectId => ({ projectId, projectName: projectId, visibility: "private", member:{projectId,userId:"recipient",role:"guest",createdAt:"2026-10-22T00:00:00Z"} }),
    getFiles: async options => {
      reads.push(options.target);
      return { projectId: "demo", projectName: "demo", target: options.target, resolvedTarget: "1.0.0", files: [],sourceHash:"hash",entries:entrySet(),defaultEntry:"main" };
    },
    cloneProject: async options => {
      assert.match(options.targetProjectName!, /^[a-f0-9-]{36}$/);
      clones.push(options.sourceTarget!);
      return { projectId: "copy", projectName: "copy", sourceTarget: options.sourceTarget!, resolvedSourceTarget: "1.0.0", nextVersion: "1.0.1" };
    },
  });
  const server = await listen(storage, createPrincipal(false, { userId: "recipient" }));
  try {
    for (const suffix of ["?target=draft", "?target=%20draft%20"]) {
      assert.equal((await fetch(server.url(`/api/projects/demo/files${suffix}`))).status, 403);
    }
    for (const sourceTarget of ["draft", " draft "]) {
      assert.equal((await fetch(server.url("/api/projects/demo/clone"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceTarget }),
      })).status, 403);
    }
    for (const body of [{ targetProjectName: "111" }, { projectId: "8bd4fef2-e083-4201-a89f-6f7d0676df53" }]) {
      assert.equal((await fetch(server.url("/api/projects/demo/clone"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 400);
    }
    assert.deepEqual(reads, []); assert.deepEqual(clones, []);
    assert.equal((await fetch(server.url("/api/projects/demo/files?target=1.0.0"))).status, 200);
    assert.equal((await fetch(server.url("/api/projects/demo/clone"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceTarget: "1.0.0" }),
    })).status, 200);
    assert.deepEqual(reads, ["1.0.0"]); assert.deepEqual(clones, ["1.0.0"]);
  } finally { await server.close(); }
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
    getDownloadableSourceFiles: async () => {
      sourceRead = true;
      throw new Error("Source must not be read without project access.");
    },
  });
  const server = await listen(
    storage,
    createPrincipal(false, { userId: "developer-1" }),
  );

  try {
    const response = await fetch(server.url("/api/projects/demo/source-files"));
    assert.equal(response.status, 403);
    assert.equal(sourceRead, false);
  } finally {
    await server.close();
  }
});

for (const projectType of STEAMHARNESS_PROJECT_TYPES) test(`create ${projectType} assigns a fresh Server ID and forwards project info`, async () => {
  const projectInfo = { localizedNames: {}, declarations: [],  platformSupport: { mode: "agnostic" as const },  };
  const ids: string[] = [];
  const storage = createStorageStub({ createProject: async options => {
    assert.match(options.projectId!, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(options, { projectId: options.projectId, projectName: "New Application", entries:entrySet(projectType),defaultEntry:"main", projectInfo,
      ownerUserId: "creator-1", groupId: undefined, isSystemAdmin: false, createdByUserId: "creator-1", visibility: "private" });
    ids.push(options.projectId!);
    return { projectId: options.projectId!, projectName: options.projectName, entries:entrySet(projectType),defaultEntry:"main", projectInfo, visibility: "private" };
  } });
  const server = await listen(storage, createPrincipal(false, { userId: "creator-1" }));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchJson(server.url("/api/projects"), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Application", entries:entrySet(projectType),defaultEntry:"main", projectInfo }) });
      assert.equal(response.errCode, 0); assert.equal((response.data as { projectId: string }).projectId, ids[attempt]);
    }
    assert.notEqual(ids[0], ids[1]);
  } finally { await server.close(); }
});

test("creation refuses every client-selected ID without touching storage", async () => {
  let calls = 0;
  const server = await listen(createStorageStub({ createProject: async () => { calls++; throw new Error("must not create"); } }), createPrincipal(false, { userId: "creator-1" }));
  try {
    for (const projectId of ["111", 111, null, "", "8bd4fef2-e083-4201-a89f-6f7d0676df53"]) {
      const response = await fetch(server.url("/api/projects"), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: "Chosen", entries:entrySet("workflow"),defaultEntry:"main", projectInfo: { platformSupport: { mode: "agnostic" },  } }) });
      assert.equal(response.status, 400); assert.match((await response.json()).errMessage, /assigned by the Server/);
    }
    const localized = await fetch(server.url("/api/projects"), { method: "POST", headers: { "Content-Type": "application/json", "X-SteamHarness-Locale": "zh-CN" }, body: JSON.stringify({ projectId: "111" }) });
    assert.match((await localized.json()).errMessage, /服务器分配/); assert.equal(calls, 0);
  } finally { await server.close(); }
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


  };
  let receivedOptions: unknown;
  const storage = createStorageStub({
    createProject: async (options) => {
      receivedOptions = options;
      return {
        projectId: options.projectId,
        projectName: "Round Conversation",
        entries:entrySet("conversation"),defaultEntry:"main",
        projectInfo,
        visibility: "private",
      };
    },
  });
  const server = await listen(storage, createPrincipal(false, { userId: "creator-1" }));

  try {
    const response = await fetchJson(server.url("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Round Conversation",
        entries:entrySet("conversation"),defaultEntry:"main",
        projectInfo,
        projectCard,
      }),
    });

    assert.equal(response.errCode, 0);
    assert.deepEqual(receivedOptions, {
      projectId: (receivedOptions as { projectId: string }).projectId,
      projectName: "Round Conversation",
      entries:entrySet("conversation"),defaultEntry:"main",
      projectInfo,
      ownerUserId: "creator-1",
      groupId: undefined,
      isSystemAdmin: false,
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
  const server = await listen(storage, createPrincipal(false));

  try {
    const response = await fetchJson(server.url("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid Card",
        entries:entrySet("workflow"),defaultEntry:"main",
        projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" },  },
        projectCard: { icon: "unknown", iconBackgroundColor: "teal" },
      }),
    });

    assert.equal(response.errCode, 400);
    assert.equal(createCalls, 0);
  } finally {
    await server.close();
  }
});

test("audit events endpoint requires a system administrator", async () => {
  configureProjectAuthContext({ accountDb: createAccountDbStub() as any });
  const server = await listen(createStorageStub({}), createPrincipal(false));

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
  const server = await listen(createStorageStub({}), createPrincipal(true));

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

test("publish endpoint forwards exact version and source preconditions", async () => {
  const sourceHash = "a".repeat(64);
  const published: unknown[] = [];
  const storage = createStorageStub({
    publish: async (options) => {
      published.push(options);
      return { projectId: "demo", projectName: "demo", version: "1.2.3", latest: "1.2.3", nextVersion: "1.2.4", releaseLog: "Version notes", dependencies: [] };
    },
  });
  const server = await listen(storage, createPrincipal(false));
  try {
    const response = await fetchJson(server.url("/api/projects/demo/publish"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseLog: "Version notes", expectedVersion: "1.2.3", expectedSourceHash: sourceHash }),
    });
    assert.equal(response.errCode, 0);
    assert.deepEqual(published, [{ projectName: "demo", releaseLog: "Version notes", expectedVersion: "1.2.3", expectedSourceHash: sourceHash, expectedConfigurationRevisions:undefined, administrator: false, createdByUserId: "user-1" }]);
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
  const server = await listen(storage, createPrincipal(false));

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
    assertManagedFileAccountAccess:async()=>{},
    configurationAttachment:async()=>{throw new HttpError(404,404,"Configuration attachment does not exist.");},
    assertServerProjectDataAccess: async () => ({
      localizedNames: {},
      declarations: [],
      platformSupport: { mode: "agnostic" },


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
    requireProjectCapability: async (id: string, actor: AccessActor, capability: AccessCapability) => {
      const summary=await stub.getProjectAccessSummary!(id,actor.userId);
      const sources=summary.access?.sources ?? (summary.member?[{type:"project" as const,id,role:summary.member.role}]:[]);
      if(actor.userId && summary.visibility==='public') sources.push({type:"project",id,role:"guest"});
      const access=resolveResourceAccess(sources,actor);
      if(!access.capabilities.includes(capability)) throw new HttpError(403,403,"Permission denied.");
      return access;
    },
    getSourceDownloadAvailability: async () => ({available:true,target:"1.0.0"}),
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
    res.locals.principal = principal ?? createPrincipal(true);
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
      server.closeAllConnections();
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
    isSystemAdmin: false,
  };
}

function createPrincipal(
  isSystemAdmin = false,
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
      isSystemAdmin,
    },
    isSystemAdmin,
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function createApiKeyPrincipal(source: "desktop" | "cli"): AuthenticatedPrincipal {
  const sessionPrincipal = createPrincipal(false);
  assert.equal(sessionPrincipal.kind, "user_session");
  return {
    kind: "api_key",
    tokenSource: "bearer",
    userId: sessionPrincipal.userId,
    profile: sessionPrincipal.profile,
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

test("project configurations use account-scoped generic routes and preserve version conflicts", async () => {
  const calls: unknown[] = [];
  const storage = createStorageStub({ projectConfigurations: async (options, call) => {
    calls.push({options,call});
    if(call.action === 'save') throw new HttpError(409,409,'Configuration changed',{code:'CONFIGURATION_CONFLICT'});
    return {version:1,revision:2,fields:[],customFields:[],configurations:[],activeConfigurationId:'profile'};
  }});
  const server = await listen(storage,createApiKeyPrincipal('cli'));
  try {
    const read = await fetch(server.url('/api/projects/demo/configurations?target=latest'));
    assert.equal(read.status,200); assert.equal(read.headers.get('cache-control'),'no-store');
    const input = {target:'latest',call:{action:'save',revision:1,id:'profile',values:{enabled:false,data:{nested:[null,1]}}}};
    const write = await fetch(server.url('/api/projects/demo/configurations'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal(write.status,409); assert.deepEqual((await write.json()).data,{code:'CONFIGURATION_CONFLICT'});
    assert.deepEqual(calls,[{options:{projectName:'demo',entryId:undefined,actorId:'user-1',administrator:false,actor:{userId:'user-1',isSystemAdmin:false},target:'latest'},call:{action:'get'}},{options:{projectName:'demo',entryId:undefined,actorId:'user-1',administrator:false,actor:{userId:'user-1',isSystemAdmin:false},target:'latest'},call:input.call}]);
    const old=await fetch(server.url('/api/projects/demo/kanban/configurations'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(old.status,404);
  } finally {await server.close();}
});

test("configuration routes reject unreadable projects before reaching the store", async () => {
  let called=false;
  const storage=createStorageStub({requireProjectCapability:async()=>{throw new HttpError(403,403,"Forbidden");},projectConfigurations:async()=>{called=true;throw new Error('must not run');}});
  const server=await listen(storage,createPrincipal(false));
  try {for(const method of ['GET','POST']) {
    const response=await fetch(server.url('/api/projects/demo/configurations'),{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({call:{action:'get'}})}:{})});
    assert.notEqual(response.status,200);
  }assert.equal(called,false);}finally{await server.close();}
});

function entrySet(type: "workflow"|"conversation"|"kanban"="workflow") { return [{entryId:"main",name:"Main",type,root:".",entry:type==="kanban"?"index.html":"index.ts",databases:[]}]; }

test('resource cards resolve the requested entry, database alias and conversation without executing source',async()=>{
  const calls:unknown[]=[];
  const database={kv:{getValue:async(key:string)=>{calls.push(['kv',key]);return 7;},conversation:{getValue:async(key:string)=>{calls.push(['conversation',key]);return 9;}}},knowledge:{getDocument:async(id:string)=>{calls.push(['document',id]);return {id,title:'Guide',markdown:'shared'};},listDocuments:async()=>({items:[],total:0,hasMore:false})}};
  const storage=createStorageStub({entryDatabases:async(...args)=>{calls.push(args);return {get:(alias:string)=>{assert.equal(alias,'data');return database;}} as unknown as Awaited<ReturnType<Storage['entryDatabases']>>;}});
  const server=await listen(storage,createPrincipal(false));
  const post=(body:unknown)=>fetch(server.url('/api/projects/demo/entries/agent/resources/read'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await (await post({kind:'kv',database:'data',key:'x',scope:'conversation',conversationId:'thread'})).json()).data,9);
    assert.deepEqual(calls[0],['demo','agent',{userId:'user-1',isSystemAdmin:false},'draft','thread']);
    assert.deepEqual(calls[1],['conversation','x']);
    assert.equal((await (await post({kind:'knowledge',database:'data',documentId:'guide'})).json()).data.id,'guide');
    for(const body of [{kind:'storage',database:'data'},{kind:'kv',database:'data',key:'x',scope:'global'}])assert.equal((await post(body)).status,400);
    for(const route of ['/api/projects/demo/kv','/api/projects/demo/storage','/api/projects/demo/knowledge','/api/projects/demo/related-projects','/api/projects/demo/dependencies','/api/projects/demo/project-group'])assert.equal((await fetch(server.url(route))).status,404);
  }finally{await server.close();}
});

test('Kanban bridges enforce project roles before using the entry database grant',async()=>{
  let calls=0;
  const storage=createStorageStub({
    getProjectAccessSummary:async projectId=>({projectId,projectName:'Board',visibility:'private',member:{projectId,userId:'user-1',role:'guest',createdAt:'2026-10-27'}}),
    entryDatabases:async(projectId,entryId,actor)=>{assert.equal(projectId,'demo');assert.equal(entryId,'board');assert.equal(actor.userId,'user-1');calls++;return {get:(alias:string)=>{assert.equal(alias,'data');return {kv:{getValue:async()=>1}};}} as unknown as Awaited<ReturnType<Storage['entryDatabases']>>;},
  });
  const server=await listen(storage,createPrincipal(false));
  const post=(operation:string,input:unknown)=>fetch(server.url('/api/projects/demo/kanban/bridge'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entryId:'board',call:{requestId:operation,operation,input}})});
  try{
    assert.equal((await post('kv.getValue',{database:'data',key:'map'})).status,200);
    assert.equal((await post('kv.setValue',{database:'data',key:'map',value:2})).status,403);
    assert.equal((await post('files.createFile',{database:'data',name:'map.png',mimeType:'image/png',base64:'aA=='})).status,403);
    assert.equal((await post('relatedProject.kv.getValue',{alias:'other',key:'x'})).status,400);
    assert.equal(calls,1);
  }finally{await server.close();}
});

test('project creation rejects legacy declarations, duplicate entries and invalid defaults',async()=>{
  let calls=0;
  const server=await listen(createStorageStub({createProject:async()=>{calls++;throw new Error('must not create');}}),createPrincipal(false));
  try{
    for(const body of [{projectType:'workflow'}, {entries:[...entrySet(),...entrySet()],defaultEntry:'main'}, {entries:entrySet(),defaultEntry:'absent'}, {entries:[],defaultEntry:'main'}]){
      const response=await fetch(server.url('/api/projects'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Invalid',projectInfo:{localizedNames:{},declarations:[],platformSupport:{mode:'agnostic'}},...body})});
      assert.equal(response.status,400);
    }
    assert.equal(calls,0);
  }finally{await server.close();}
});
