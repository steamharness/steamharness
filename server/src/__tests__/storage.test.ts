import {resolveResourceAccess} from "@steamharness/project-access";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { defaultProjectCardIcon, getProjectCardColorContrastRatio, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { Header } from "tar";
import type { KVNamespaceLockInput, KVStore, KVStoreGetInput, KVStoreSetInput } from "steamharness";
import { AccountRepository } from "../account-db";
import {
  ArtifactStorage,
  DatabaseRepository,
} from "../persistence";
import { validateArchiveEntries, validateTarArchiveEntries, Storage, type PreparationJob, type KVEntryDetail, type KnowledgeDocumentListItem, type TokenUsagePage } from "../storage";

// assertProjectId now requires UUID format; use fixed UUID fixtures
const DEMO_WF_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_CONV_WF_ID = "00000000-0000-4000-8000-000000000002";
const DECLARED_SERVER_PROJECT_INFO = {
  localizedNames: {},
  declarations: [],
  platformSupport: { mode: "agnostic" as const },


};
const serverPackage = JSON.parse(
  await readFile(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const exactReleaseVersionPattern = /^\d+\.\d+\.\d+(?:-\d{11})?$/;
const configuredCoreVersion = serverPackage.dependencies?.["steamharness"];
if (typeof configuredCoreVersion !== "string" || !exactReleaseVersionPattern.test(configuredCoreVersion)) {
  throw new Error("Server tests require an exact steamharness dependency version.");
}
const coreVersion: string = configuredCoreVersion;
const cliVersion = serverPackage.devDependencies?.["@steamharness/cli"];
if (typeof cliVersion !== "string" || !exactReleaseVersionPattern.test(cliVersion)) {
  throw new Error("Server tests require an exact @steamharness/cli development dependency version.");
}
const testBuildInfo = {
  productVersion: serverPackage.version,
  coreVersion,
  commitSha: "test",
  nodeVersion: process.versions.node,
};
const testToolchainDependencies = {
  "steamharness": coreVersion,
  "@steamharness/cli": cliVersion,
};

test("archive entry validation rejects traversal aliases and duplicate normalized paths", () => {
  assert.doesNotThrow(() => validateArchiveEntries([
    "./",
    "./workspace/",
    "./workspace/package.json",
    "./workspace/index.ts",
  ]));
  assert.throws(
    () => validateArchiveEntries(["workspace\\package.json", "workspace/package.json"]),
    /Duplicate archive entry/,
  );
  assert.throws(
    () => validateArchiveEntries(["workspace/Assets/App.js", "workspace/assets/other.js"]),
    /Duplicate or case-conflicting archive entry/,
  );
  assert.throws(
    () => validateArchiveEntries(["./workspace/./package.json"]),
    /Unsafe archive entry/,
  );
  assert.throws(
    () => validateArchiveEntries(["workspace/assets", "workspace/assets/app.js"]),
    /uses file "workspace\/assets" as a directory/,
  );
  assert.throws(
    () => validateArchiveEntries(["workspace/assets/app.js", "workspace/assets"]),
    /conflicts with a directory path/,
  );
});

test("tar archive validation rejects links and expanded archive bombs before extraction", () => {
  assert.equal(validateTarArchiveEntries([
    { path: "workspace/", type: "Directory", size: 0 },
    { path: "workspace/package.json", type: "File", size: 128 },
  ]), 128);
  assert.throws(
    () => validateTarArchiveEntries([
      { path: "workspace/source", type: "SymbolicLink", size: 0 },
    ]),
    /unsupported type "SymbolicLink"/,
  );
  assert.throws(
    () => validateTarArchiveEntries([
      { path: "workspace/source", type: "Link", size: 0 },
    ]),
    /unsupported type "Link"/,
  );
  assert.throws(
    () => validateTarArchiveEntries([
      { path: "workspace/large.bin", type: "File", size: 512 * 1024 * 1024 + 1 },
    ]),
    /expanded size exceeds/,
  );
  assert.throws(
    () => validateTarArchiveEntries([
      { path: "workspace/second.bin", type: "File", size: 257 },
    ], { maxExpandedSizeBytes: 256 }),
    /expanded size exceeds/,
  );
});

test("Storage rejects an actual tar symbolic-link member before extraction", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-tar-link-"));
  const archivePath = path.join(dataRoot, "linked.tgz");
  const extractDir = path.join(dataRoot, "extract");
  const header = new Header({
    path: "workspace/source-link",
    type: "SymbolicLink",
    linkpath: "../outside",
    mode: 0o777,
    uid: 0,
    gid: 0,
    size: 0,
    mtime: new Date(0),
  });
  assert.equal(header.encode(), false);
  assert.ok(header.block);
  await writeFile(archivePath, gzipSync(Buffer.concat([header.block, Buffer.alloc(1024)])));
  await mkdir(extractDir, { recursive: true });
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  const extractArchive = Reflect.get(storage, "extractArchive") as (
    archive: string,
    archiveName: string,
    target: string,
  ) => Promise<number>;

  try {
    await assert.rejects(
      extractArchive.call(storage, archivePath, "linked.tgz", extractDir),
      /unsupported type "SymbolicLink"/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage init keeps server online when artifact storage init fails", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-artifact-init-"));
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    artifacts: {
      async init() {
        throw new Error("object storage request timed out after 5000ms.");
      },
    } as any,
  });

  try {
    await storage.init();
    await waitFor(() => warnings.length > 0);
    assert.match(String(warnings[0]?.[0] ?? ""), /artifact storage initialization failed/);
  } finally {
    console.warn = originalWarn;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("ArtifactStorage delegates immutable archives to the object storage backend", async () => {
  const calls: Array<{ operation: string; objectPath: string; filePath: string; contentType?: string }> = [];
  const storage = new ArtifactStorage({
    bucket: "steamharness",
    async uploadPrivateFile(objectPath: string, filePath: string, contentType: string) {
      calls.push({ operation: "upload", objectPath, filePath, contentType });
    },
    async downloadPrivateFile(objectPath: string, filePath: string) {
      calls.push({ operation: "download", objectPath, filePath });
    },
  } as never);

  await storage.init();
  await storage.uploadFile("projects/demo/1.0.0/hash/source.tar.gz", "/tmp/source.tar.gz");
  await storage.downloadFile("projects/demo/1.0.0/hash/runtime.tar.gz", "/tmp/runtime.tar.gz");

  assert.deepEqual(calls, [
    {
      operation: "upload",
      objectPath: "projects/demo/1.0.0/hash/source.tar.gz",
      filePath: "/tmp/source.tar.gz",
      contentType: "application/gzip",
    },
    {
      operation: "download",
      objectPath: "projects/demo/1.0.0/hash/runtime.tar.gz",
      filePath: "/tmp/runtime.tar.gz",
    },
  ]);
});

test("Storage.saveManagedFiles stores opaque image references outside workflow source", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-files-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
  });

  try {
    await storage.init();
    const [reference] = await storage.saveManagedFiles({
      projectName: DEMO_WF_ID,
      files: [{
        name: "screenshot.png",
        mimeType: "image/png",
        buffer: Buffer.from("image-bytes"),
        conversationId: "thread-1",
      }],
    });

    assert.ok(reference);
    assert.match(reference.id, /^wf_[a-f0-9]+$/);
    assert.equal(reference.kind, "image");
    assert.equal(reference.storage, "server");
    assert.equal(reference.projectId, DEMO_WF_ID);
    assert.equal(reference.conversationId, "thread-1");

    const stored = await storage.getManagedFile(reference.id);
    assert.deepEqual(stored.metadata, reference);
    assert.equal(await readFile(stored.filePath, "utf8"), "image-bytes");
    assert.equal(stored.filePath.includes(path.join("projects", DEMO_WF_ID)), false);

    // protects the file-param attachment contract used by App,
    // server/web replay, and workflow runtime file stores.
    assert.equal(await existsPath(path.join(dataRoot, "files", reference.id, "metadata.json")), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.saveManagedFiles infers video types and preserves explicit audio WebM", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-video-files-"));
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  try {
    await storage.init();
    const cases = [
      ["clip.MP4", "", "video/mp4"],
      ["clip.mov", "application/octet-stream", "video/quicktime"],
      ["clip.avi", "", "video/x-msvideo"],
      ["clip.mkv", "", "video/x-matroska"],
      ["clip.webm", "", "video/webm"],
      ["recording.webm", "audio/webm", "audio/webm"],
    ];
    const refs = await storage.saveManagedFiles({
      projectName: DEMO_WF_ID,
      files: cases.map(([name, mimeType]) => ({ name: name!, mimeType, buffer: Buffer.from(name!) })),
    });
    for (const [index, reference] of refs.entries()) {
      assert.equal(reference.mimeType, cases[index]![2]);
      assert.equal(reference.kind, "file");
      const stored = await storage.getManagedFile(reference.id);
      assert.deepEqual(stored.metadata, JSON.parse(JSON.stringify(reference)));
      assert.equal(await readFile(stored.filePath, "utf8"), reference.name);
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.saveManagedFiles leaves no partial batch when a later file is invalid", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-file-rollback-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
  });
  const previousLimit = process.env.STEAMHARNESS_MANAGED_FILE_SIZE_LIMIT_BYTES;

  try {
    await storage.init();
    process.env.STEAMHARNESS_MANAGED_FILE_SIZE_LIMIT_BYTES = "1";
    await assert.rejects(storage.saveManagedFiles({
      projectName: DEMO_WF_ID,
      files: [
        { name: "first.png", mimeType: "image/png", buffer: Buffer.alloc(1) },
        { name: "second.png", mimeType: "image/png", buffer: Buffer.alloc(2) },
      ],
    }), /exceeds 1 B limit/u);
    const storedFiles = await readdir(path.join(dataRoot, "files")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(storedFiles, []);
  } finally {
    if (previousLimit === undefined) delete process.env.STEAMHARNESS_MANAGED_FILE_SIZE_LIMIT_BYTES;
    else process.env.STEAMHARNESS_MANAGED_FILE_SIZE_LIMIT_BYTES = previousLimit;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.saveManagedFiles rolls back earlier files after a filesystem failure", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-file-write-rollback-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
  });

  try {
    await storage.init();
    const firstDir = path.join(dataRoot, "first-file");
    const blocker = path.join(dataRoot, "not-a-directory");
    await writeFile(blocker, "block mkdir", "utf8");
    const generatedDirs = [firstDir, path.join(blocker, "second-file")];
    (storage as unknown as { managedFileDir(fileId: string): string }).managedFileDir = () => generatedDirs.shift()!;

    await assert.rejects(storage.saveManagedFiles({
      projectName: DEMO_WF_ID,
      files: [
        { name: "first.png", mimeType: "image/png", buffer: Buffer.from("first") },
        { name: "second.png", mimeType: "image/png", buffer: Buffer.from("second") },
      ],
    }), (error: NodeJS.ErrnoException) => error.code === "ENOTDIR");
    await assert.rejects(lstat(firstDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("DatabaseRepository.getSystemTokenUsage aggregates project totals", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;

  pool.query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/select value\s+from project_storage/.test(sql)) {
      return { rows: [{ value: createTokenUsageAggregate(300) }] };
    }
    if (/select count\(\*\) as total/.test(sql)) {
      return { rows: [{ total: "1" }] };
    }
    return {
      rows: [
        {
          project_id: DEMO_WF_ID,
          value: createTokenUsageAggregate(100),
          updated_at: new Date("2026-05-22T00:00:00.000Z"),
          updated_at_cursor: "2026-05-22T00:00:00.000000Z",
        },
      ],
    };
  };
  pool.end = async () => {};

  try {
    const page = await repository.getSystemTokenUsage({
      pageSize: 10,
    });

    assert.equal(page.systemTotal.totalTokens, 300);
    assert.equal(page.projects[0]?.projectId, DEMO_WF_ID);
    assert.equal(page.projects[0]?.total.totalTokens, 100);
    const projectQuery = queries.find((item) => /select\s+project_id,\s+value/.test(item.sql));
    assert.ok(projectQuery);
    assert.match(projectQuery.sql, /storage_kind = 'kv'/);
    assert.match(projectQuery.sql, /scope = 'project'/);
    assert.match(projectQuery.sql, /key = \$1/);
    assert.deepEqual(projectQuery.params, ["tokenUsage.total", 11]);
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository.getProjectTokenUsage reads project and conversation aggregates", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;

  pool.query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/key like \$3/.test(sql)) {
      return {
        rows: [
          {
            value: {
              id: "run-1.1",
              projectId: DEMO_WF_ID,
              runId: "run-1",
              conversationId: "Thread-A",
              sequence: 1,
              createdAt: "2026-05-22T00:00:00.000Z",
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
              reasoningTokens: 0,
              cachedInputTokens: 0,
            },
          },
        ],
      };
    }
    return { rows: [{ value: createTokenUsageAggregate(30) }] };
  };
  pool.end = async () => {};

  try {
    const detail = await repository.getProjectTokenUsage({
      projectId: DEMO_WF_ID,
      conversationId: "Thread-A",
      includeEntries: true,
    });

    assert.equal(detail.projectTotal.totalTokens, 30);
    assert.equal(detail.conversationTotal?.totalTokens, 30);
    assert.equal(detail.entries?.length, 1);
    assert.equal(detail.entries?.[0]?.cacheCreationTokens, 0);
    const entriesQuery = queries.find((item) => /key like \$3/.test(item.sql));
    assert.ok(entriesQuery);
    assert.deepEqual(entriesQuery.params, [DEMO_WF_ID, "Thread-A", "tokenUsage.entry.%"]);
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("Storage token usage inspection requires PostgreSQL storage", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-token-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    buildInfo: testBuildInfo,
  });

  try {
    await writeFileBackedProject(dataRoot, DEMO_WF_ID);
    await assert.rejects(
      () => storage.getSystemTokenUsage(),
      { statusCode: 501, errCode: 501 },
    );
    await assert.rejects(
      () => storage.getProjectTokenUsage({ projectId: DEMO_WF_ID }),
      { statusCode: 501, errCode: 501 },
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.getSystemTokenUsage forwards clamped pagination", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-token-"));
  const calls: unknown[] = [];
  const page: TokenUsagePage = {
    systemTotal: createTokenUsageAggregate(120),
    projects: [],
    hasMore: false,
    total: 0,
  };
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getSystemTokenUsage: async (options: unknown) => {
        calls.push(options);
        return page;
      },
    } as unknown as DatabaseRepository,
  });

  try {
    const result = await storage.getSystemTokenUsage({
      pageSize: 500,
      cursor: "cursor-a",
    });

    assert.equal(result, page);
    assert.deepEqual(calls[0], {
      pageSize: 100,
      cursor: "cursor-a",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.getProjectTokenUsage preserves conversation filter case", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-token-"));
  const calls: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getProject: async () => createDbProjectRecord(DEMO_WF_ID, null),
      getProjectTokenUsage: async (options: unknown) => {
        calls.push(options);
        return {
          projectId: DEMO_WF_ID,
          projectTotal: createTokenUsageAggregate(0),
        };
      },
    } as unknown as DatabaseRepository,
  });

  try {
    await storage.getProjectTokenUsage({
      projectId: DEMO_WF_ID,
      conversationId: "  Thread-A  ",
      includeEntries: true,
    });

    assert.deepEqual(calls[0], {
      projectId: DEMO_WF_ID,
      conversationId: "Thread-A",
      includeEntries: true,
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage creates a readable random avatar when no projectCard is supplied", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "project-avatar-create-"));
  let saved: ProjectCardMetadata | undefined;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot,
    db: { getProject: async () => undefined, createProjectRecord: async (input: { projectCard: ProjectCardMetadata }) => {
      saved = input.projectCard;
      return createDbProjectRecord(DEMO_WF_ID, null);
    } } as unknown as DatabaseRepository });
  try {
    for (const projectType of ["workflow", "conversation", "kanban"] as const) {
      await storage.createProject({ projectId: DEMO_WF_ID, projectName: "Demo", entries:[{entryId:"main",name:"Main",type:projectType,root:".",entry:projectType==="kanban"?"index.html":"index.ts",databases:[]}],defaultEntry:"main", projectInfo: DECLARED_SERVER_PROJECT_INFO,ownerUserId:"owner" });
      assert.equal(saved!.icon, defaultProjectCardIcon(projectType));
      assert.ok(getProjectCardColorContrastRatio(saved!.iconColor!, saved!.iconBackgroundColor) >= 4.5);
    }
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("Storage reuses an existing project without overwriting management fields", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-restore-"));
  const existing = {
    ...createDbProjectRecord(DEMO_WF_ID, null),
    ownerUserId: "owner-1",
    projectInfo: {
      ...DECLARED_SERVER_PROJECT_INFO,

    },
  };
  const projectInfo = {
    localizedNames: { "zh-CN": "恢复项目", en: "Restored project" },
    declarations: ["restored"],
    platformSupport: { mode: "specific" as const, platforms: ["macos"] },


  };
  const projectCard = {
    icon: "workflow" as const,
    iconColor: "#f8fafc",
    iconBackgroundColor: "#0f766e",
  };
  const updates: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      access:{assert:async()=>resolveResourceAccess([{type:"project",id:DEMO_WF_ID,role:"developer"}])},
      getProject: async () => existing,
      getProjectMember: async () => undefined,
      updateProjectInfo: async (projectId: string, projectName: string, value: unknown) => {
        updates.push({ projectId, projectName, projectInfo: value });
        return { ...existing, name: projectName, projectInfo: value };
      },
      updateProjectCard: async (projectId: string, value: unknown) => {
        updates.push({ projectId, projectCard: value });
        return { ...existing, projectCard: value };
      },
    } as unknown as DatabaseRepository,
  });

  try {
    const restored = await storage.createProject({
      projectId: DEMO_WF_ID,
      projectName: DEMO_WF_ID,
      entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[]}],defaultEntry:"main",
      projectInfo,
      projectCard,
      ownerUserId: "owner-1",
      createdByUserId: "owner-1",
    });

    assert.deepEqual(updates, []);
    assert.deepEqual(restored.projectInfo, existing.projectInfo);
    assert.equal(restored.projectId, DEMO_WF_ID);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("AccountRepository.getUserProfilesByIds returns a keyed profile map", async () => {
  const connectionString = "postgresql://example.invalid/postgres";
  const repository = new AccountRepository(connectionString);
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;

  pool.query = async (sql: string, params?: unknown[]) => {
    if (String(sql).includes("from user_profiles")) {
      assert.deepEqual(params, [["user-1", "user-2"]]);
      return {
        rows: [
          {
            user_id: "user-1",
            email: "user-1@example.com",
            display_name: "User One",
            avatar_url: "https://example.test/user-1.png",
            status: "active",
            created_by_user_id: null,
            created_at: new Date("2026-06-18T00:00:00.000Z"),
            updated_at: new Date("2026-06-18T00:00:00.000Z"),
            last_login_at: null,
          },
          {
            user_id: "user-2",
            email: "user-2@example.com",
            display_name: "User Two",
            avatar_url: null,
            status: "active",
            created_by_user_id: null,
            created_at: new Date("2026-06-18T00:00:00.000Z"),
            updated_at: new Date("2026-06-18T00:00:00.000Z"),
            last_login_at: null,
          },
        ],
      };
    }
    if (String(sql).includes("from user_roles")) {
      return { rows: [] };
    }
    if (String(sql).includes("from role_permissions")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const profiles = await repository.getUserProfilesByIds(["user-1", "user-2", "user-1"]);

    assert.equal(profiles.size, 2);
    assert.equal(profiles.get("user-1")?.displayName, "User One");
    assert.equal(profiles.get("user-1")?.avatarUrl, "https://example.test/user-1.png");
    assert.equal(profiles.get("user-2")?.displayName, "User Two");
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("Storage.listProjects returns uploaded package project card metadata", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-card-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
  });

  try {
    await storage.init();
    await writeFileVersion(dataRoot, DEMO_CONV_WF_ID, "1.0.0", "2026-05-21T00:00:00.000Z", {
      steamHarness: { defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"conversation",root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}],
        projectInfo: DECLARED_SERVER_PROJECT_INFO,
        projectCard: {
          icon: "bot",
          iconUrl: "https://example.test/bot.png",
          iconColor: "#f8fafc",
          iconBackgroundColor: "#7c3aed",
        },
      },
    }, "conversation");
    await writeFile(
      path.join(dataRoot, "projects", DEMO_CONV_WF_ID, "latest.json"),
      JSON.stringify({ version: "1.0.0" }),
      "utf8",
    );

    const workflows = await storage.listProjects();

    assert.equal(workflows[0]?.id, DEMO_CONV_WF_ID);
    assert.equal(workflows[0]?.entries[0]?.type, "conversation");
    assert.deepEqual(workflows[0]?.projectCard, {
      icon: "bot",
      iconUrl: "https://example.test/bot.png",
      iconColor: "#f8fafc",
      iconBackgroundColor: "#7c3aed",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage stores cropped project card images by content hash", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-card-image-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
  });
  const content = Buffer.from("project-card", "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(content.byteLength + 4);
  const webp = Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), content]);

  try {
    await storage.init();
    const saved = await storage.saveProjectCardImage({
      projectName: DEMO_WF_ID,
      buffer: webp,
      origin: "https://steamharness.example/",
    });
    const resolved = await storage.getProjectCardImage(DEMO_WF_ID, saved.hash);

    assert.equal(saved.mimeType, "image/webp");
    assert.equal(saved.size, webp.byteLength);
    assert.equal(saved.url, `https://steamharness.example/project-card-images/${DEMO_WF_ID}/${saved.hash}.webp`);
    assert.deepEqual(await readFile(resolved.filePath), webp);
    await assert.rejects(
      storage.saveProjectCardImage({
        projectName: DEMO_WF_ID,
        buffer: Buffer.from("not-webp"),
        origin: "https://steamharness.example",
      }),
      /valid WebP/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage atomically checks project configuration versions and isolates accounts", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "project-configuration-storage-"));
  const sourceRoot = path.join(dataRoot, "projects", DEMO_WF_ID, "draft", "source");
  const storage = new Storage({serverRoot:process.cwd(),repoRoot:process.cwd(),dataRoot,buildInfo:testBuildInfo});
  storage.getProjectAccessSummary=async()=>({projectId:DEMO_WF_ID,projectName:"Config",visibility:"private",access:resolveResourceAccess([{type:"project",id:DEMO_WF_ID,role:"developer"}])});
  try {
    await mkdir(sourceRoot,{recursive:true});
    await writeFile(path.join(sourceRoot,"package.json"),JSON.stringify({id:DEMO_WF_ID,name:"Configurations",version:"0.1.0",devDependencies:testToolchainDependencies,steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"kanban",root:".",entry:"index.html",configuration:"configuration.json",databases:[]}],projectInfo:DECLARED_SERVER_PROJECT_INFO}}));
    await writeFile(path.join(sourceRoot,"index.html"),"<!doctype html>");
    await writeFile(path.join(sourceRoot,"configuration.json"),JSON.stringify({version:1,fields:[{name:"title",type:"string",defaultValue:"Roadmap"}]}));
    const options={projectName:DEMO_WF_ID,actorId:"user-a",target:"draft"};
    const initial=await storage.projectConfigurations(options,{action:"get"}) as import("@steamharness/project-configuration").ProjectConfigurationState;
    const writes=await Promise.allSettled(["one","two"].map(title=>storage.projectConfigurations(options,{action:"save",revision:initial.revision,id:initial.activeConfigurationId,values:{title}})));
    assert.equal(writes.filter(write=>write.status==="fulfilled").length,1);
    const failed=writes.find(write=>write.status==="rejected") as PromiseRejectedResult;
    assert.equal((failed.reason as {statusCode:number}).statusCode,409);
    const state=await storage.projectConfigurations(options,{action:"get"}) as typeof initial;
    assert.equal(state.revision,initial.revision+1);
    const other=await storage.projectConfigurations({...options,actorId:"user-b"},{action:"get"}) as typeof initial;
    assert.equal(other.configurations[0]?.values.title,"Roadmap");
    const before=structuredClone(state);
    await assert.rejects(storage.projectConfigurations(options,{action:"import",revision:state.revision,document:{version:1,kind:"steamharness-project-configurations",fields:[{name:"title",type:"number"}],configurations:[{name:"Invalid",values:{title:2}}]}}));
    assert.deepEqual(await storage.projectConfigurations(options,{action:"get"}),before);
    const workspace=await storage.getKanbanWorkspace(options);
    assert.equal(workspace.configurations[0]?.values.title,state.configurations[0]?.values.title);
  }finally{await rm(dataRoot,{recursive:true,force:true});}
});

test("Storage keeps draft configuration values when an older version is read and edited", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "project-configuration-targets-"));
  const draft = path.join(dataRoot,"projects",DEMO_WF_ID,"draft","source");
  const version = path.join(dataRoot,"projects",DEMO_WF_ID,"versions","0.1.0","source");
  const storage = new Storage({serverRoot:process.cwd(),repoRoot:process.cwd(),dataRoot,buildInfo:testBuildInfo});
  storage.getProjectAccessSummary=async()=>({projectId:DEMO_WF_ID,projectName:"Config",visibility:"private",access:resolveResourceAccess([{type:"project",id:DEMO_WF_ID,role:"developer"}])});
  try {
    await mkdir(draft,{recursive:true});await mkdir(version,{recursive:true});
    await writeFile(path.join(draft,"package.json"),JSON.stringify({id:DEMO_WF_ID,name:"Configuration targets",version:"0.1.1",devDependencies:testToolchainDependencies,steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}],projectInfo:DECLARED_SERVER_PROJECT_INFO}}));
    await writeFile(path.join(draft,"index.ts"),'throw new Error("static source only");');
    await writeFile(path.join(draft,"configuration.json"),JSON.stringify({version:1,fields:[{name:"newField",type:"string"}]}));
    await writeFile(path.join(version,"package.json"),await readFile(path.join(draft,"package.json")));
    await writeFile(path.join(version,"index.ts"),'throw new Error("must not execute");');
    await writeFile(path.join(version,"configuration.json"),JSON.stringify({version:1,fields:[]}));
    const options={projectName:DEMO_WF_ID,actorId:"user-a",target:"draft"};
    const initial=await storage.projectConfigurations(options,{action:"get"}) as import("@steamharness/project-configuration").ProjectConfigurationState;
    await storage.projectConfigurations(options,{action:"save",revision:initial.revision,id:initial.activeConfigurationId,values:{newField:"saved"}});
    const older=await storage.projectConfigurations({...options,target:"0.1.0"},{action:"get"}) as typeof initial;
    await storage.projectConfigurations({...options,target:"0.1.0"},{action:"rename",revision:older.revision,id:older.activeConfigurationId,name:"Renamed"});
    const restored=await storage.projectConfigurations(options,{action:"get"}) as typeof initial;
    assert.equal(restored.configurations[0]!.values.newField,"saved");
    assert.equal(restored.configurations[0]!.name,"Renamed");
  }finally{await rm(dataRoot,{recursive:true,force:true});}
});

test("Storage keeps immutable project card images after metadata changes", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-card-history-"));
  const cards: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      updateProjectCard: async (projectId: string, projectCard: unknown) => {
        cards.push(projectCard);
        return {
          id: projectId,
          name: "Demo",
          projectCard,
        };
      },
    } as unknown as DatabaseRepository,
  });
  const first = createWebpFixture("first");
  const second = createWebpFixture("second");

  try {
    const firstImage = await storage.saveProjectCardImage({
      projectName: DEMO_WF_ID,
      buffer: first,
      origin: "https://steamharness.example",
    });
    const secondImage = await storage.saveProjectCardImage({
      projectName: DEMO_WF_ID,
      buffer: second,
      origin: "https://steamharness.example",
    });
    const projectCard = {
      icon: "workflow" as const,
      iconUrl: secondImage.url,
      iconColor: "#ffffff",
      iconBackgroundColor: "#2563eb",
    };

    assert.deepEqual(await storage.updateProjectCardMetadata({
      projectName: DEMO_WF_ID,
      projectCard,
    }), projectCard);
    assert.deepEqual(cards, [projectCard]);
    assert.deepEqual(await readFile((await storage.getProjectCardImage(DEMO_WF_ID, firstImage.hash)).filePath), first);
    assert.deepEqual(await readFile((await storage.getProjectCardImage(DEMO_WF_ID, secondImage.hash)).filePath), second);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage shares concurrent database draft materialization and reuses its revision", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-draft-materialization-"));
  let revision = "2026-08-07T00:00:00.000Z";
  let content = "first snapshot";
  let readCalls = 0;
  let markFirstReadStarted: () => void = () => {};
  let releaseFirstRead: () => void = () => {};
  const firstReadStarted = new Promise<void>((resolve) => {
    markFirstReadStarted = resolve;
  });
  const firstReadReleased = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getProject: async () => ({
        ...createDbProjectRecord(DEMO_WF_ID, null),
        hasDraft: true,
        updatedAt: revision,
      }),
      readDraftFiles: async () => {
        readCalls += 1;
        if (readCalls === 1) {
          markFirstReadStarted();
          await firstReadReleased;
        }
        return [{ path: "snapshot.txt", content, size: Buffer.byteLength(content) }];
      },
    } as unknown as DatabaseRepository,
  });
  const materializeDraft = Reflect.get(storage, "materializeDbDraftSource") as (
    projectName: string,
  ) => Promise<void>;

  try {
    const first = materializeDraft.call(storage, DEMO_WF_ID);
    await firstReadStarted;
    const concurrent = Array.from(
      { length: 7 },
      () => materializeDraft.call(storage, DEMO_WF_ID),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readCalls, 1);

    releaseFirstRead();
    await Promise.all([first, ...concurrent]);
    const sourceFile = path.join(
      dataRoot,
      "projects",
      DEMO_WF_ID,
      "draft",
      "source",
      "snapshot.txt",
    );
    assert.equal(await readFile(sourceFile, "utf8"), "first snapshot");

    await materializeDraft.call(storage, DEMO_WF_ID);
    assert.equal(readCalls, 1);

    revision = "2026-08-07T00:01:00.000Z";
    content = "second snapshot";
    await Promise.all(Array.from(
      { length: 8 },
      () => materializeDraft.call(storage, DEMO_WF_ID),
    ));
    assert.equal(readCalls, 2);
    assert.equal(await readFile(sourceFile, "utf8"), "second snapshot");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage shares concurrent database version source materialization", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-version-materialization-"));
  const version = createDbVersionRecord(DEMO_WF_ID, "1.0.0");
  let downloads = 0;
  let markDownloadStarted: () => void = () => {};
  let releaseDownload: () => void = () => {};
  const downloadStarted = new Promise<void>((resolve) => {
    markDownloadStarted = resolve;
  });
  const downloadReleased = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getVersion: async () => version,
    } as unknown as DatabaseRepository,
    artifacts: {} as ArtifactStorage,
  });
  Reflect.set(storage, "downloadAndExtractArtifact", async (
    _objectPath: string,
    targetDir: string,
  ) => {
    downloads += 1;
    markDownloadStarted();
    await downloadReleased;
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, "package.json"), "{}", "utf8");
  });
  const materializeVersion = Reflect.get(storage, "materializeDbVersionSource") as (
    projectName: string,
    requestedVersion: string,
  ) => Promise<void>;

  try {
    const first = materializeVersion.call(storage, DEMO_WF_ID, version.version);
    await downloadStarted;
    const concurrent = Array.from(
      { length: 7 },
      () => materializeVersion.call(storage, DEMO_WF_ID, version.version),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(downloads, 1);

    releaseDownload();
    await Promise.all([first, ...concurrent]);
    await materializeVersion.call(storage, DEMO_WF_ID, version.version);
    assert.equal(downloads, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage retries database source materialization after a failed task", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-materialization-retry-"));
  let readCalls = 0;
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getProject: async () => ({
        ...createDbProjectRecord(DEMO_WF_ID, null),
        hasDraft: true,
      }),
      readDraftFiles: async () => {
        readCalls += 1;
        if (readCalls === 1) {
          throw new Error("temporary draft read failure");
        }
        return [{ path: "snapshot.txt", content: "recovered", size: 9 }];
      },
    } as unknown as DatabaseRepository,
  });
  const materializeDraft = Reflect.get(storage, "materializeDbDraftSource") as (
    projectName: string,
  ) => Promise<void>;

  try {
    await assert.rejects(
      materializeDraft.call(storage, DEMO_WF_ID),
      /temporary draft read failure/,
    );
    await materializeDraft.call(storage, DEMO_WF_ID);
    assert.equal(readCalls, 2);
    assert.equal(
      await readFile(path.join(
        dataRoot,
        "projects",
        DEMO_WF_ID,
        "draft",
        "source",
        "snapshot.txt",
      ), "utf8"),
      "recovered",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("DatabaseRepository reads persisted Kanban binary file encoding", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;
  pool.query = async () => ({
    rows: [{ path: "assets/board.png", content: "/wAQIEA=", size: 5, encoding: "base64" }],
  });
  pool.end = async () => {};

  try {
    assert.deepEqual(await repository.readDraftFiles(DEMO_WF_ID), [{
      path: "assets/board.png",
      content: "/wAQIEA=",
      size: 5,
      encoding: "base64",
    }]);
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository.withProjectPublishLock does not occupy storage pool clients", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const lockQueries: Array<{ sql: string; params: unknown[] }> = [];
  const storageQueries: Array<{ sql: string; params: unknown[] }> = [];
  let storageConnects = 0;
  let lockReleased = false;
  const pool = Reflect.get(repository, "pool") as {
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  };
  const publishLockPool = Reflect.get(repository, "publishLockPool") as {
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  };
  const originalConnect = pool.connect;
  const originalPublishLockConnect = publishLockPool.connect;
  const originalEnd = pool.end;
  const originalPublishLockEnd = publishLockPool.end;

  pool.connect = async () => {
    storageConnects += 1;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        storageQueries.push({ sql, params });
        return { rows: [] };
      },
      release: () => {},
    };
  };
  publishLockPool.connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      lockQueries.push({ sql, params });
      return { rows: [] };
    },
    release: () => {
      lockReleased = true;
    },
  });
  pool.end = async () => {};
  publishLockPool.end = async () => {};

  try {
    await repository.withProjectPublishLock(DEMO_WF_ID, async () => {
      await repository.updateProjectName(DEMO_WF_ID, "Demo");
    });

    assert.equal(storageConnects, 1);
    assert.match(storageQueries[0]?.sql ?? "", /^begin$/);
    assert.match(lockQueries[0]?.sql ?? "", /pg_advisory_lock/);
    assert.match(lockQueries[1]?.sql ?? "", /pg_advisory_unlock/);
    assert.equal(lockReleased, true);
  } finally {
    pool.connect = originalConnect;
    publishLockPool.connect = originalPublishLockConnect;
    pool.end = originalEnd;
    publishLockPool.end = originalPublishLockEnd;
    await pool.end();
    await publishLockPool.end();
  }
});

test("Storage preserves preparation failure stage and reason", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-preparation-failure-"));
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  Reflect.set(storage, "uploadPackage", async (options: {
    onStage?: (stage: "validating") => Promise<void>;
  }) => {
    await options.onStage?.("validating");
    throw new Error("package validation failed");
  });

  try {
    await storage.init();
    const accepted = await storage.enqueuePackagePreparation({
      projectName: DEMO_WF_ID,
      archiveName: "demo.tgz",
      archiveBuffer: Buffer.from("archive"),
    });
    const failed = await waitForPreparationTerminal(storage, DEMO_WF_ID, accepted.jobId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "validating");
    assert.equal(failed.failureReason, "package validation failed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function waitForPreparationTerminal(
  storage: Storage,
  projectId: string,
  jobId: string,
): Promise<PreparationJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await storage.getPreparationJob(projectId, jobId);
    if (job.status === "success" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Preparation job ${jobId} did not reach a terminal status.`);
}

async function writePublishableDraft(dataRoot: string, projectName: string): Promise<void> {
  const draftRoot = path.join(dataRoot, "projects", projectName, "draft");
  const sourceRoot = path.join(draftRoot, "source");

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({
      id: projectName,
      name: projectName,
      version: "0.1.0",
      devDependencies: testToolchainDependencies,
      steamHarness: { defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}], projectInfo: DECLARED_SERVER_PROJECT_INFO },
    }),
    "utf8",
  );
  await writeFile(
    path.join(sourceRoot, "index.ts"),
    `const draftProject = steamharness.defineProject({ name: "${projectName}", run: async () => ({ errCode: 0, errMessage: "" }) });\nexport const executor = steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "main", entrypoints: [steamharness.defineEntrypoint({ id: "main", title: "Main", workflow: draftProject, createInput: () => ({ errCode: 0, errMessage: "" }) })] });\nexport default draftProject;\n`,
    "utf8",
  );
  await writeFile(path.join(sourceRoot, "README.md"), `# ${projectName}\n`, "utf8");
}

async function writeFileVersion(
  dataRoot: string,
  projectName: string,
  version: string,
  createdAt: string,
  packageJsonOverrides: Record<string, unknown> = {},
  projectType: "workflow" | "conversation" = "workflow",
): Promise<void> {
  const versionRoot = path.join(dataRoot, "projects", projectName, "versions", version);
  await mkdir(path.join(versionRoot, "source"), { recursive: true });
  await writeFile(
    path.join(versionRoot, "source", "package.json"),
    JSON.stringify({
      id: projectName,
      name: projectName,
      version: "0.1.0",
      devDependencies: testToolchainDependencies,
      steamHarness: { defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}], projectInfo: DECLARED_SERVER_PROJECT_INFO },
      ...packageJsonOverrides,
    }),
    "utf8",
  );
  await writeFile(
    path.join(versionRoot, "source", "index.ts"),
    projectType === "workflow"
      ? `const defined = steamharness.defineProject({ name: "test", run: async () => ({ errCode: 0, errMessage: "" }) });\nexport default steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "main", entrypoints: [steamharness.defineEntrypoint({ id: "main", title: "Main", workflow: defined, createInput: () => ({ errCode: 0, errMessage: "" }) })] });\n`
      : `const defined = steamharness.defineProject({ name: "test", run: async () => ({ errCode: 0, errMessage: "" }) });\nexport default steamharness.defineExecutor({ projectType: "conversation", workflow: defined, createInput: () => ({ errCode: 0, errMessage: "" }) });\n`,
    "utf8",
  );
  await writeFile(path.join(versionRoot, "source", "configuration.json"), JSON.stringify({version:2,fields:[]}));
  await writeFile(
    path.join(versionRoot, "source", "README.md"),
    `# ${projectName}\n`,
    "utf8",
  );
  await writeFile(
    path.join(versionRoot, "manifest.json"),
    JSON.stringify({
      projectId: projectName,
      projectName,
      version,
      createdAt,
      releaseLog: "",
      sourceHash: version,
      projectType,
    }),
    "utf8",
  );
}

async function writeFileBackedProject(
  dataRoot: string,
  projectId: string,
): Promise<void> {
  await writeFileVersion(
    dataRoot,
    projectId,
    "1.0.0",
    "2026-08-25T00:00:00.000Z",
  );
  await writeFile(
    path.join(dataRoot, "projects", projectId, "latest.json"),
    JSON.stringify({ version: "1.0.0" }),
    "utf8",
  );
}

function createDbProjectRecord(projectId: string, latest: string | null) {
  return {
    id: projectId,
    name: projectId,
    entries:[{entryId:"main",name:"Main",type:"workflow" as const,root:".",entry:"index.ts",databases:[]}],defaultEntry:"main",
    projectCard: {
      icon: "workflow",
      iconBackgroundColor: "#2563eb",
    },
    projectInfo: {
      localizedNames: {},
      declarations: [],
      platformSupport: { mode: "agnostic" as const },


    },
    packageVersion: "0.1.0",
    hasDraft: false,
    latest,
    visibility: "public",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function createDbVersionRecord(projectId: string, version: string) {
  return {
    projectId,
    projectName: projectId,
    version,
    createdAt: "2026-05-21T00:00:00.000Z",
    releaseLog: "",
    sourceHash: version,
    sourceObjectPath: `projects/${projectId}/versions/${version}/source.tar.gz`,
  } as const;
}

async function existsPath(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function createKVCursor(cursor: {
  updatedAt: string;
  scope: string;
  projectId: string;
  conversationId: string;
  key: string;
}): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function createKVRow(key: string, updatedAtCursor: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const value = Object.prototype.hasOwnProperty.call(overrides, "value") ? overrides.value : undefined;
  const preview = typeof overrides.value_preview === "string"
    ? overrides.value_preview
    : value === undefined
    ? JSON.stringify({ key })
    : JSON.stringify(value);
  const row: Record<string, unknown> = {
    storage_kind: "kv",
    scope: "conversation",
    project_id: DEMO_WF_ID,
    conversation_id: "thread-a",
    key,
    value_type: "object",
    value_size_bytes: 16,
    value_preview: preview,
    updated_at: new Date("2026-05-20T00:00:00.123Z"),
    updated_at_cursor: updatedAtCursor,
    last_project_id: DEMO_WF_ID,
    last_run_id: "RUN-A",
    last_conversation_id: "thread-a",
  };
  if (value !== undefined) {
    row.value = value;
  }
  return { ...row, ...overrides };
}

function createKVSummary(key: string, overrides: Partial<KVEntryDetail> = {}): KVEntryDetail {
  return {
    storageKind: "kv",
    scope: "conversation",
    key,
    value: { key },
    valueType: "object",
    valueSizeBytes: 16,
    valuePreview: JSON.stringify({ key }),
    projectId: DEMO_WF_ID,
    conversationId: "thread-a",
    updatedAt: "2026-05-20T00:00:00.123Z",
    ...overrides,
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

function createWebpFixture(payload: string): Buffer {
  const content = Buffer.from(payload, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(content.byteLength + 4);
  return Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), content]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
