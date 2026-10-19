import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { Header } from "tar";
import type { KVNamespaceLockInput, KVStore, KVStoreGetInput, KVStoreSetInput } from "steamharness";
import { AccountRepository } from "../account-db";
import {
  ArtifactStorage,
  DatabaseRepository,
  type DeploymentRecord,
} from "../persistence";
import type { RelatedProjectKVGrant } from "@steamharness/project-info";
import { isKnowledgeMutationGranted, validateArchiveEntries, validateTarArchiveEntries, Storage, type PreparationJob, type KVEntryDetail, type KnowledgeDocumentListItem, type TokenUsagePage } from "../storage";

// assertWorkflowId now requires UUID format; use fixed UUID fixtures
const DEMO_WF_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_CONV_WF_ID = "00000000-0000-4000-8000-000000000002";
const DECLARED_SERVER_PROJECT_INFO = {
  localizedNames: {},
  declarations: [],
  platformSupport: { mode: "agnostic" as const },
  dataStorage: { mode: "server" as const },
  relatedProjects: [],
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
  await storage.uploadFile("workflows/demo/1.0.0/hash/source.tar.gz", "/tmp/source.tar.gz");
  await storage.downloadFile("workflows/demo/1.0.0/hash/runtime.tar.gz", "/tmp/runtime.tar.gz");

  assert.deepEqual(calls, [
    {
      operation: "upload",
      objectPath: "workflows/demo/1.0.0/hash/source.tar.gz",
      filePath: "/tmp/source.tar.gz",
      contentType: "application/gzip",
    },
    {
      operation: "download",
      objectPath: "workflows/demo/1.0.0/hash/runtime.tar.gz",
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
      workflowName: DEMO_WF_ID,
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
    assert.equal(reference.workflowId, DEMO_WF_ID);
    assert.equal(reference.conversationId, "thread-1");

    const stored = await storage.getManagedFile(reference.id);
    assert.deepEqual(stored.metadata, reference);
    assert.equal(await readFile(stored.filePath, "utf8"), "image-bytes");
    assert.equal(stored.filePath.includes(path.join("workflows", DEMO_WF_ID)), false);

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
      workflowName: DEMO_WF_ID,
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
      workflowName: DEMO_WF_ID,
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
      workflowName: DEMO_WF_ID,
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

test("DatabaseRepository scopes Kanban configuration reads by workflow and user", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;

  pool.query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (/from workflow_kanban_configurations/.test(sql)) {
      return {
        rows: [{
          configuration_id: "configuration-a",
          name: "User A",
          values: { title: "A" },
          created_at: new Date("2026-07-27T00:00:00.000Z"),
          updated_at: new Date("2026-07-27T00:00:00.000Z"),
        }],
      };
    }
    return { rows: [{ configuration_id: "configuration-a" }] };
  };
  pool.end = async () => {};

  try {
    const state = await repository.readKanbanConfigurationState(DEMO_WF_ID, "user-a");

    assert.equal(state.activeConfigurationId, "configuration-a");
    assert.deepEqual(state.configurations[0]?.values, { title: "A" });
    assert.equal(queries.length, 2);
    assert.ok(queries.every((query) => query.sql.includes("workflow_id = $1 and user_id = $2")));
    assert.ok(queries.every((query) => query.params?.[0] === DEMO_WF_ID && query.params?.[1] === "user-a"));
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository initializes Kanban configurations with PostgreSQL-safe lock keys", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let released = false;
  const pool = Reflect.get(repository, "pool") as {
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  };
  const originalConnect = pool.connect;
  const originalEnd = pool.end;

  pool.connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  });
  pool.end = async () => {};

  try {
    await repository.ensureKanbanConfiguration(DEMO_WF_ID, "user-a", {
      id: "configuration-a",
      name: "默认配置",
      values: { title: "Roadmap" },
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    assert.match(queries[0]?.sql ?? "", /^begin$/);
    assert.match(queries[1]?.sql ?? "", /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/);
    assert.deepEqual(queries[1]?.params, [DEMO_WF_ID, "user-a"]);
    assert.equal(
      queries.some((query) => query.params.some(
        (value) => typeof value === "string" && value.includes("\0"),
      )),
      false,
    );
    assert.match(queries.at(-1)?.sql ?? "", /^commit$/);
    assert.equal(released, true);
  } finally {
    pool.connect = originalConnect;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository.init creates project deployment locks and access-control indexes", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: string[] = [];
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;

  pool.query = async (sql: string) => {
    queries.push(sql);
    return { rows: [] };
  };
  pool.end = async () => {};

  try {
    await repository.init();

    const schema = queries.join("\n");
    assert.match(schema, /create table if not exists workflow_deployments/);
    assert.match(schema, /create table if not exists workflow_deployment_items/);
    assert.match(schema, /create table if not exists workflow_related_project_dependencies/);
    assert.doesNotMatch(schema, /create table if not exists workflow_data_source_grants/);
    assert.match(schema, /create table if not exists workflow_project_access_requests/);
    assert.match(schema, /create table if not exists workflow_project_capability_grants/);
    assert.match(
      schema,
      /create unique index if not exists workflow_deployment_items_active_version_idx[\s\S]*workflow_id, planned_version[\s\S]*published_version is null[\s\S]*status in \('planned', 'preparing', 'prepared', 'publishing'\)/,
    );
    assert.match(
      schema,
      /create unique index if not exists workflow_project_access_requests_pending_idx[\s\S]*where status = 'pending'/,
    );
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository reserves active deployment versions and claims deployment state atomically", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let claimed = false;
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;

  pool.query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/select planned_version/.test(sql)) {
      return { rows: [{ planned_version: "0.0.2" }, { planned_version: "0.0.3" }] };
    }
    if (/update workflow_deployments/.test(sql)) {
      const rowCount = claimed ? 0 : 1;
      claimed = true;
      return { rows: [], rowCount };
    }
    return { rows: [] };
  };
  pool.end = async () => {};

  try {
    assert.deepEqual(
      await repository.listWorkflowVersionReservations(DEMO_WF_ID, "deployment-a"),
      ["0.0.2", "0.0.3"],
    );
    assert.equal(await repository.transitionWorkflowDeploymentStatus({
      id: "deployment-a",
      from: ["planned", "failed"],
      status: "preparing",
    }), true);
    assert.equal(await repository.transitionWorkflowDeploymentStatus({
      id: "deployment-a",
      from: ["planned", "failed"],
      status: "preparing",
    }), false);

    const reservationQuery = queries.find((query) => /select planned_version/.test(query.sql));
    assert.ok(reservationQuery);
    assert.match(reservationQuery.sql, /deployment_id <> \$2/);
    assert.match(reservationQuery.sql, /published_version is null/);
    assert.match(reservationQuery.sql, /status in \('planned', 'preparing', 'prepared', 'publishing'\)/);
    assert.deepEqual(reservationQuery.params, [DEMO_WF_ID, "deployment-a"]);
    const transitionQueries = queries.filter((query) => /update workflow_deployments/.test(query.sql));
    assert.equal(transitionQueries.length, 2);
    assert.ok(transitionQueries.every((query) => /status = any\(\$2::text\[\]\)/.test(query.sql)));
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository keeps one pending source request and grants capability in the approval transaction", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const requestRow = {
    id: "00000000-0000-4000-8000-000000000051",
    workflow_id: DEMO_WF_ID,
    requester_user_id: "user-requester",
    capability: "download_source",
    reason: "Need local source",
    status: "pending",
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: new Date("2026-08-05T00:00:00.000Z"),
    updated_at: new Date("2026-08-05T00:00:00.000Z"),
  };
  const directQueries: Array<{ sql: string; params: unknown[] }> = [];
  const transactionQueries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalEnd = pool.end;

  pool.query = async (sql: string, params: unknown[] = []) => {
    directQueries.push({ sql, params });
    return { rows: [requestRow] };
  };
  pool.connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      transactionQueries.push({ sql, params });
      if (/update workflow_project_access_requests/.test(sql)) return { rows: [requestRow] };
      return { rows: [] };
    },
    release: () => {},
  });
  pool.end = async () => {};

  try {
    const first = await repository.createWorkflowProjectAccessRequest({
      id: requestRow.id,
      projectId: DEMO_WF_ID,
      requesterUserId: "user-requester",
      capability: "download_source",
      reason: requestRow.reason,
    });
    const second = await repository.createWorkflowProjectAccessRequest({
      id: "00000000-0000-4000-8000-000000000052",
      projectId: DEMO_WF_ID,
      requesterUserId: "user-requester",
      capability: "download_source",
      reason: "Duplicate request",
    });
    assert.equal(first.id, requestRow.id);
    assert.equal(second.id, requestRow.id);
    assert.ok(directQueries.every((query) => (
      /on conflict \(workflow_id, requester_user_id, capability\)[\s\S]*where status = 'pending'/.test(query.sql)
    )));

    const approved = await repository.resolveWorkflowProjectAccessRequest({
      projectId: DEMO_WF_ID,
      requestId: requestRow.id,
      status: "approved",
      resolvedByUserId: "owner-1",
    });
    assert.equal(approved?.id, requestRow.id);
    assert.match(transactionQueries[0]?.sql ?? "", /^begin$/);
    assert.ok(transactionQueries.some((query) => (
      /update workflow_project_access_requests[\s\S]*status = 'pending'/.test(query.sql)
    )));
    assert.ok(transactionQueries.some((query) => (
      /insert into workflow_project_capability_grants[\s\S]*revoked_at = null/.test(query.sql)
    )));
    assert.match(transactionQueries.at(-1)?.sql ?? "", /^commit$/);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository.listProjectKVEntries uses a stable full-key cursor", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;
  const cursor = createKVCursor({
    updatedAt: "2026-05-20T00:00:00.000Z",
    scope: "conversation",
    projectId: DEMO_WF_ID,
    conversationId: "thread-a",
    key: "shared",
  });

  pool.query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return /count\(\*\)/.test(sql) ? { rows: [{ total: "0" }] } : { rows: [] };
  };
  pool.end = async () => {};

  try {
    await repository.listProjectKVEntries({
      projectId: DEMO_WF_ID,
      pageSize: 5,
      cursor,
    });

    const query = queries.find((item) => /select\s+storage_kind, scope/.test(item.sql));
    assert.ok(query);
    assert.match(query.sql, /\(\s*updated_at,\s*scope,\s*project_id,\s*conversation_id,\s*key\s*\) < \(/);
    assert.match(query.sql, /order by updated_at desc, scope desc, project_id desc, conversation_id desc, key desc/);
    assert.deepEqual(query.params, [
      DEMO_WF_ID,
      "2026-05-20T00:00:00.000Z",
      "conversation",
      DEMO_WF_ID,
      "thread-a",
      "shared",
      6,
    ]);
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository.listProjectKVEntries preserves microsecond timestamps in next cursor", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;

  pool.query = async (sql: string) => /count\(\*\)/.test(sql)
    ? { rows: [{ total: "2" }] }
    : {
        rows: [
          createKVRow("first", "2026-05-20T00:00:00.123456Z"),
          createKVRow("second", "2026-05-20T00:00:00.123455Z"),
        ],
      };
  pool.end = async () => {};

  try {
    const page = await repository.listProjectKVEntries({
      projectId: DEMO_WF_ID,
      pageSize: 1,
    });

    assert.equal(page.hasMore, true);
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.value, undefined);
    assert.equal(page.items[0]?.valuePreview, "{\"key\":\"first\"}");
    assert.ok(page.nextCursor);
    const cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8")) as Record<string, unknown>;
    assert.equal(cursor["updatedAt"], "2026-05-20T00:00:00.123456Z");
    assert.equal(cursor["key"], "first");
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository.getProjectKVEntry returns the selected full value", async () => {
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
    return {
      rows: [createKVRow("conversation.state", "2026-05-20T00:00:00.123456Z", { value: { messages: [{ role: "assistant" }] } })],
    };
  };
  pool.end = async () => {};

  try {
    const detail = await repository.getProjectKVEntry({
      projectId: DEMO_WF_ID,
      scope: "conversation",
      key: "conversation.state",
      conversationId: "thread-a",
    });

    // expands one KV row through a detail query instead of bloating
    // the list response with every row's full JSON value.
    assert.deepEqual(queries[0]?.params, ["conversation", DEMO_WF_ID, "thread-a", "conversation.state"]);
    assert.match(queries[0]?.sql ?? "", /select\s+[\s\S]*key, value,/);
    assert.deepEqual(detail?.value, { messages: [{ role: "assistant" }] });
    assert.equal(detail?.valuePreview, "{\"messages\":[{\"role\":\"assistant\"}]}");
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
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

test("DatabaseRepository writes isolated project storage with source metadata", async () => {
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
    return { rows: [] };
  };
  pool.end = async () => {};

  try {
    await repository.setValue({
      storageKind: "persistent_value",
      scope: "project",
      projectId: DEMO_WF_ID,
      key: "knowledge.documents",
      value: { documents: [] },
      source: { projectId: DEMO_WF_ID, runId: "RUN-1", conversationId: "Thread-A" },
    });

    const query = queries[0];
    assert.ok(query);
    // Management knowledge writes use the same PostgreSQL KV upsert path as
    // PersistentValue client writes, including source metadata.
    assert.match(query.sql, /insert into project_storage/);
    assert.deepEqual(query.params, [
      "persistent_value",
      "project",
      DEMO_WF_ID,
      "",
      "knowledge.documents",
      "{\"documents\":[]}",
      DEMO_WF_ID,
      "RUN-1",
      "Thread-A",
    ]);
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository compare-and-set uses xmin row revisions", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  const originalQuery = pool.query;
  const originalEnd = pool.end;
  const results = [
    { rows: [{ value: 1, revision: "42" }] },
    { rows: [{ revision: "43" }] },
    { rows: [] },
  ];

  pool.query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return results.shift() ?? { rows: [] };
  };
  pool.end = async () => {};

  try {
    const input = {
      storageKind: "kv" as const,
      scope: "project" as const,
      projectId: DEMO_WF_ID,
      key: "counter",
    };
    assert.deepEqual(await repository.getValueWithRevision(input), { value: 1, revision: "42" });
    assert.deepEqual(await repository.compareAndSetValue({
      ...input,
      value: 2,
      source: { projectId: DEMO_WF_ID, runId: "RUN-2" },
    }, "42"), { applied: true, revision: "43" });
    assert.deepEqual(await repository.compareAndSetValue({ ...input, value: 3 }, "42"), { applied: false });

    assert.match(queries[0]?.sql ?? "", /select value, xmin::text as revision/);
    assert.match(queries[1]?.sql ?? "", /and xmin = \$10::xid/);
    assert.match(queries[1]?.sql ?? "", /returning xmin::text as revision/);
    assert.deepEqual(queries[1]?.params, [
      "kv",
      "project",
      DEMO_WF_ID,
      "",
      "counter",
      "2",
      DEMO_WF_ID,
      "RUN-2",
      null,
      "42",
    ]);
    assert.match(queries[2]?.sql ?? "", /and xmin = \$10::xid/);
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository reconnects the KV revision listener and replays a revision snapshot", async () => {
  type MockRevisionClient = EventEmitter & {
    queries: string[];
    releases: unknown[];
    query: (sql: string) => Promise<{ rows: Array<{ project_id: string; revision: string }> }>;
    release: (reason?: unknown) => void;
  };
  const createClient = (snapshot: Array<{ project_id: string; revision: string }>): MockRevisionClient => {
    const client = new EventEmitter() as MockRevisionClient;
    client.queries = [];
    client.releases = [];
    client.query = async (sql) => {
      client.queries.push(sql);
      return { rows: /from project_storage_revisions/.test(sql) ? snapshot : [] };
    };
    client.release = (reason) => {
      client.releases.push(reason);
    };
    return client;
  };

  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const first = createClient([]);
  const second = createClient([{ project_id: DEMO_WF_ID, revision: "9" }]);
  const clients = [first, second];
  let connectionCount = 0;
  const pool = Reflect.get(repository, "pool") as {
    connect: () => Promise<MockRevisionClient>;
    end: () => Promise<void>;
  };
  const originalConnect = pool.connect;
  const originalEnd = pool.end;
  pool.connect = async () => clients[connectionCount++]!;
  pool.end = async () => {};
  Reflect.set(repository, "workflowKVRevisionReconnectDelayMs", 1);
  const events: Array<{ projectId: string; revision: string }> = [];
  let unsubscribe: (() => Promise<void>) | undefined;

  try {
    unsubscribe = await repository.listenProjectStorageRevisions((event) => events.push(event));
    first.emit("notification", {
      channel: "workflow_project_storage_revision",
      payload: JSON.stringify({ projectId: DEMO_WF_ID, revision: "8" }),
    });
    first.emit("error", new Error("connection lost"));

    await waitFor(() => connectionCount === 2 && events.some((event) => event.revision === "9"));
    second.emit("notification", {
      channel: "workflow_project_storage_revision",
      payload: JSON.stringify({ projectId: DEMO_WF_ID, revision: "10" }),
    });

    assert.deepEqual(events, [
      { projectId: DEMO_WF_ID, revision: "8" },
      { projectId: DEMO_WF_ID, revision: "9" },
      { projectId: DEMO_WF_ID, revision: "10" },
    ]);
    assert.deepEqual(first.releases, [true]);
    await unsubscribe?.();
    unsubscribe = undefined;
    assert.deepEqual(second.releases, [false]);
    second.emit("end");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(connectionCount, 2);
  } finally {
    await unsubscribe?.();
    pool.connect = originalConnect;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("DatabaseRepository orders reconnect snapshots before buffered revision notifications", async () => {
  type MockRevisionClient = EventEmitter & {
    query: (sql: string) => Promise<{ rows: Array<{ project_id: string; revision: string }> }>;
    release: (reason?: unknown) => void;
  };
  const first = new EventEmitter() as MockRevisionClient;
  first.query = async () => ({ rows: [] });
  first.release = () => undefined;
  const second = new EventEmitter() as MockRevisionClient;
  second.query = async (sql) => {
    if (/from project_storage_revisions/.test(sql)) {
      second.emit("notification", {
        channel: "workflow_project_storage_revision",
        payload: JSON.stringify({ projectId: DEMO_WF_ID, revision: "10" }),
      });
      return { rows: [{ project_id: DEMO_WF_ID, revision: "9" }] };
    }
    return { rows: [] };
  };
  second.release = () => undefined;

  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const clients = [first, second];
  let connectionCount = 0;
  const pool = Reflect.get(repository, "pool") as {
    connect: () => Promise<MockRevisionClient>;
    end: () => Promise<void>;
  };
  const originalConnect = pool.connect;
  const originalEnd = pool.end;
  pool.connect = async () => clients[connectionCount++]!;
  pool.end = async () => {};
  Reflect.set(repository, "workflowKVRevisionReconnectDelayMs", 1);
  const events: Array<{ projectId: string; revision: string }> = [];
  let unsubscribe: (() => Promise<void>) | undefined;

  try {
    unsubscribe = await repository.listenProjectStorageRevisions((event) => events.push(event));
    first.emit("notification", {
      channel: "workflow_project_storage_revision",
      payload: JSON.stringify({ projectId: DEMO_WF_ID, revision: "8" }),
    });
    first.emit("error", new Error("connection lost"));

    await waitFor(() => events.some((event) => event.revision === "10"));
    assert.deepEqual(events, [
      { projectId: DEMO_WF_ID, revision: "8" },
      { projectId: DEMO_WF_ID, revision: "9" },
      { projectId: DEMO_WF_ID, revision: "10" },
    ]);
  } finally {
    await unsubscribe?.();
    pool.connect = originalConnect;
    pool.end = originalEnd;
    await pool.end();
  }
});

test("Storage.listProjectKVEntries preserves exact ID filter case", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-kv-"));
  const calls: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
      listProjectKVEntries: async (options: unknown) => {
        calls.push(options);
        return { items: [], hasMore: false, total: 0 };
      },
    } as unknown as DatabaseRepository,
  });

  try {
    await storage.listProjectKVEntries({
      projectId: DEMO_WF_ID,
      pageSize: 20,
      query: "  Memory  ",
      conversationId: "  Thread-A  ",
      runId: "  RUN-A  ",
    });

    assert.deepEqual(calls[0], {
      projectId: DEMO_WF_ID,
      pageSize: 20,
      cursor: undefined,
      scope: undefined,
      query: "memory",
      valueType: undefined,
      conversationId: "Thread-A",
      runId: "RUN-A",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.deleteProjectKVEntry deletes one exact scoped entry", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-kv-delete-"));
  const calls: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
      deleteValue: async (options: unknown) => {
        calls.push(options);
        return true;
      },
    } as unknown as DatabaseRepository,
  });

  try {
    assert.deepEqual(
      await storage.deleteProjectKVEntry({
        projectId: DEMO_WF_ID,
        scope: "conversation",
        key: "  Thread.State  ",
        conversationId: "  Thread-A  ",
      }),
      { scope: "conversation", key: "Thread.State", conversationId: "Thread-A" },
    );
    assert.deepEqual(calls[0], {
      storageKind: "kv",
      scope: "conversation",
      projectId: DEMO_WF_ID,
      key: "Thread.State",
      conversationId: "Thread-A",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.deleteProjectKVEntry omits the conversation for project scope", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-kv-delete-scope-"));
  const calls: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
      deleteValue: async (options: unknown) => {
        calls.push(options);
        return true;
      },
    } as unknown as DatabaseRepository,
  });

  try {
    await storage.deleteProjectKVEntry({
      projectId: DEMO_WF_ID,
      scope: "project",
      key: "settings",
      // A stray conversation id must not widen a project-scope delete.
      conversationId: "Thread-A",
    });
    assert.deepEqual(calls[0], {
      storageKind: "kv",
      scope: "project",
      projectId: DEMO_WF_ID,
      key: "settings",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.deleteProjectKVEntry reports an already-removed entry as missing", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-kv-delete-missing-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
      deleteValue: async () => false,
    } as unknown as DatabaseRepository,
  });

  try {
    await assert.rejects(
      () => storage.deleteProjectKVEntry({
        projectId: DEMO_WF_ID,
        scope: "project",
        key: "already-gone",
      }),
      /"already-gone" does not exist/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.deleteProjectKVEntry requires a conversation id for conversation scope", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-kv-delete-conv-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
      deleteValue: async () => true,
    } as unknown as DatabaseRepository,
  });

  try {
    await assert.rejects(
      () => storage.deleteProjectKVEntry({
        projectId: DEMO_WF_ID,
        scope: "conversation",
        key: "settings",
      }),
      /conversationId is required/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage.getProjectKVEntry preserves exact key and conversation case", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-kv-detail-"));
  const calls: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
      getProjectKVEntry: async (options: unknown) => {
        calls.push(options);
        return createKVSummary("Thread.State", { value: { ok: true } });
      },
    } as unknown as DatabaseRepository,
  });

  try {
    await storage.getProjectKVEntry({
      projectId: DEMO_WF_ID,
      scope: "conversation",
      key: "  Thread.State  ",
      conversationId: "  Thread-A  ",
    });

    assert.deepEqual(calls[0], {
      projectId: DEMO_WF_ID,
      scope: "conversation",
      key: "Thread.State",
      conversationId: "Thread-A",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
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

test("Storage knowledge base requires PostgreSQL storage", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-knowledge-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    buildInfo: testBuildInfo,
  });

  try {
    await writeFileBackedProject(dataRoot, DEMO_WF_ID);
    await assert.rejects(
      () => storage.listKnowledgeDocuments(DEMO_WF_ID),
      { statusCode: 501, errCode: 501 },
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage knowledge documents use the PersistentValue project domain", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-knowledge-"));
  const db = createMemoryKVStore();
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: db as unknown as DatabaseRepository,
  });

  try {
    const created = await storage.createKnowledgeDocument({
      workflowName: DEMO_WF_ID,
      id: "readme",
      title: "Readme",
      markdown: "# Readme\n\nPersistentValue knowledge.",
    });
    const edited = await storage.editKnowledgeDocument({
      workflowName: DEMO_WF_ID,
      documentId: "readme",
      markdown: "# Readme\n\nSearchable markdown.",
    });
    const list = await storage.listKnowledgeDocuments(DEMO_WF_ID);
    const search = await storage.searchKnowledgeDocuments({
      workflowName: DEMO_WF_ID,
      query: "searchable",
      beforeLines: 1,
      afterLines: 0,
    });
    const lines = await storage.readKnowledgeDocumentLines({
      workflowName: DEMO_WF_ID,
      documentId: "readme",
      startLine: 2,
      endLine: 3,
    });

    assert.equal(created.markdown, "# Readme\n\nPersistentValue knowledge.");
    assert.equal(edited.markdown, "# Readme\n\nSearchable markdown.");
    assert.deepEqual(list.items.map((item: KnowledgeDocumentListItem) => item.id), ["readme"]);
    assert.deepEqual(search.matches.map((match) => [match.documentId, match.lineNumber, match.line]), [
      ["readme", 3, "Searchable markdown."],
    ]);
    assert.deepEqual(lines.lines.map((line) => [line.lineNumber, line.content]), [
      [2, ""],
      [3, "Searchable markdown."],
    ]);
    assert.deepEqual(
      db.sources.get(`persistent_value:project:${DEMO_WF_ID}::knowledge.document.readme`),
      { projectId: DEMO_WF_ID },
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage knowledge documents delegate opaque page cursors to core index pages", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-knowledge-page-"));
  const db = createMemoryKVStore();
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: db as unknown as DatabaseRepository,
  });

  try {
    for (const id of ["one", "two", "three"]) {
      await storage.createKnowledgeDocument({
        workflowName: DEMO_WF_ID,
        id,
        title: id,
        markdown: id,
      });
    }

    const first = await storage.listKnowledgeDocuments(DEMO_WF_ID, { pageSize: 2 });
    const second = await storage.listKnowledgeDocuments(DEMO_WF_ID, { pageSize: 2, cursor: first.nextCursor });

    // Storage delegates the bounded PersistentValue index pages to core, so
    // management clients never reconstruct pagination from a full list.
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.total, 3);
    assert.match(first.nextCursor ?? "", /^[A-Za-z0-9_-]+$/);
    assert.notEqual(first.nextCursor, "2");
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal(second.total, 3);
    await assert.rejects(
      () => storage.listKnowledgeDocuments(DEMO_WF_ID, { cursor: "2" }),
      /valid knowledge document page cursor/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage persistent value compare-and-set rejects stale revisions", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-persistent-cas-"));
  const db = createMemoryKVStore();
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: db as unknown as DatabaseRepository,
  });
  const input = {
    storageKind: "persistent_value" as const,
    scope: "project" as const,
    projectId: DEMO_WF_ID,
    key: "counter",
  };

  try {
    const created = await storage.compareAndSetProjectStorageValue({
      ...input,
      value: 1,
      expectedRevision: null,
    });
    assert.equal(created.applied, true);
    assert.ok(created.revision);
    const createdRevision = created.revision;

    const updated = await storage.compareAndSetProjectStorageValue({
      ...input,
      value: 2,
      expectedRevision: createdRevision,
    });
    assert.equal(updated.applied, true);
    assert.notEqual(updated.revision, created.revision);

    const stale = await storage.compareAndSetProjectStorageValue({
      ...input,
      value: 3,
      expectedRevision: createdRevision,
    });
    assert.deepEqual(stale, { applied: false });
    assert.deepEqual(await storage.getProjectStorageValue(input), {
      exists: true,
      value: 2,
      revision: updated.revision,
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage knowledge create conflict maps to HTTP conflict", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-knowledge-conflict-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: createMemoryKVStore() as unknown as DatabaseRepository,
  });

  try {
    await storage.createKnowledgeDocument({
      workflowName: DEMO_WF_ID,
      id: "readme",
      title: "Readme",
      markdown: "",
    });
    await assert.rejects(
      () => storage.createKnowledgeDocument({
        workflowName: DEMO_WF_ID,
        id: "readme",
        title: "Readme",
        markdown: "",
      }),
      { statusCode: 409, errCode: 409 },
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
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
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

test("Storage restores an owned UUID binding and synchronizes its full declaration atomically", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-restore-"));
  const existing = {
    ...createDbWorkflowRecord(DEMO_WF_ID, null),
    ownerUserId: "owner-1",
    projectInfo: {
      ...DECLARED_SERVER_PROJECT_INFO,
      dataStorage: { mode: "local" as const },
    },
  };
  const projectInfo = {
    localizedNames: { "zh-CN": "恢复项目", en: "Restored project" },
    declarations: ["restored"],
    platformSupport: { mode: "specific" as const, platforms: ["macos"] },
    dataStorage: { mode: "both" as const },
    relatedProjects: [],
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
      getWorkflow: async () => existing,
      getWorkflowMember: async () => undefined,
      updateWorkflowProjectInfo: async (workflowId: string, workflowName: string, value: unknown) => {
        updates.push({ workflowId, workflowName, projectInfo: value });
        return { ...existing, name: workflowName, projectInfo: value };
      },
      updateWorkflowProjectCard: async (workflowId: string, value: unknown) => {
        updates.push({ workflowId, projectCard: value });
        return { ...existing, projectCard: value };
      },
    } as unknown as DatabaseRepository,
  });

  try {
    const restored = await storage.createProject({
      workflowId: DEMO_WF_ID,
      workflowName: DEMO_WF_ID,
      projectType: "workflow",
      projectInfo,
      projectCard,
      ownerUserId: "owner-1",
      createdByUserId: "owner-1",
    });

    assert.deepEqual(updates, [
      { workflowId: DEMO_WF_ID, workflowName: DEMO_WF_ID, projectInfo },
      { workflowId: DEMO_WF_ID, projectCard },
    ]);
    assert.deepEqual(restored.projectInfo, projectInfo);
    assert.equal(restored.workflowId, DEMO_WF_ID);
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
    if (String(sql).includes("from workflow_user_profiles")) {
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
    if (String(sql).includes("from workflow_user_roles")) {
      return { rows: [] };
    }
    if (String(sql).includes("from workflow_role_permissions")) {
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

test("Storage.listWorkflows returns uploaded package project card metadata", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-card-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
  });

  try {
    await storage.init();
    await writeFileVersion(dataRoot, DEMO_CONV_WF_ID, "1.0.0", "2026-05-21T00:00:00.000Z", {
      steamHarness: { projectType: "conversation",
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
      path.join(dataRoot, "workflows", DEMO_CONV_WF_ID, "latest.json"),
      JSON.stringify({ version: "1.0.0" }),
      "utf8",
    );

    const workflows = await storage.listWorkflows();

    assert.equal(workflows[0]?.id, DEMO_CONV_WF_ID);
    assert.equal(workflows[0]?.projectType, "conversation");
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
      workflowName: DEMO_WF_ID,
      buffer: webp,
      origin: "https://workflow.example/",
    });
    const resolved = await storage.getProjectCardImage(DEMO_WF_ID, saved.hash);

    assert.equal(saved.mimeType, "image/webp");
    assert.equal(saved.size, webp.byteLength);
    assert.equal(saved.url, `https://workflow.example/project-card-images/${DEMO_WF_ID}/${saved.hash}.webp`);
    assert.deepEqual(await readFile(resolved.filePath), webp);
    await assert.rejects(
      storage.saveProjectCardImage({
        workflowName: DEMO_WF_ID,
        buffer: Buffer.from("not-webp"),
        origin: "https://workflow.example",
      }),
      /valid WebP/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage rejects the first upload when executor type differs from the empty project", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-type-conflict-"));
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      getWorkflow: async () => createDbWorkflowRecord(DEMO_WF_ID, null),
      listVersions: async () => [],
    } as unknown as DatabaseRepository,
  });

  try {
    const assertUploadedProjectType = Reflect.get(storage, "assertUploadedProjectType") as (
      workflowId: string,
      projectType: "workflow" | "conversation",
    ) => Promise<void>;

    await assert.rejects(
      assertUploadedProjectType.call(storage, DEMO_WF_ID, "conversation"),
      /created as projectType "workflow", but package.json declares "conversation"/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage serializes Kanban saves and later configuration selection", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-kanban-lock-"));
  const sourceRoot = path.join(dataRoot, "workflows", DEMO_WF_ID, "draft", "source");
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    buildInfo: testBuildInfo,
  });

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({
        id: DEMO_WF_ID,
        name: "Kanban Lock Demo",
        version: "0.1.0",
        devDependencies: testToolchainDependencies,
        steamHarness: { projectType: "kanban", projectInfo: DECLARED_SERVER_PROJECT_INFO },
      }), "utf8"),
      writeFile(path.join(sourceRoot, "index.html"), "<!doctype html><html><body></body></html>", "utf8"),
      writeFile(path.join(sourceRoot, "kanban.json"), JSON.stringify({
        version: 1,
        params: [{ name: "title", type: "string", defaultValue: "Roadmap" }],
      }), "utf8"),
    ]);

    const initial = await storage.getKanbanWorkspace({
      workflowName: DEMO_WF_ID,
      target: "draft",
      actorId: "user-a",
    });
    const firstConfigurationId = initial.activeConfigurationId!;
    const created = await storage.createKanbanConfiguration({
      workflowName: DEMO_WF_ID,
      target: "draft",
      actorId: "user-a",
    });
    const secondConfigurationId = created.activeConfigurationId!;
    await storage.selectKanbanConfiguration({
      workflowName: DEMO_WF_ID,
      target: "draft",
      actorId: "user-a",
      configurationId: firstConfigurationId,
    });

    const localStore = storage as unknown as {
      writeLocalKanbanConfigurationState: (
        workflowName: string,
        actorId: string,
        state: unknown,
      ) => Promise<void>;
    };
    const originalWrite = localStore.writeLocalKanbanConfigurationState.bind(storage);
    let notifySaveStarted!: () => void;
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      notifySaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let delayNextWrite = true;
    localStore.writeLocalKanbanConfigurationState = async (...args) => {
      if (delayNextWrite) {
        delayNextWrite = false;
        notifySaveStarted();
        await saveGate;
      }
      await originalWrite(...args);
    };

    const savePromise = storage.saveKanbanConfigurationValues({
      workflowName: DEMO_WF_ID,
      target: "draft",
      actorId: "user-a",
      configurationId: firstConfigurationId,
      values: { title: "Saved title" },
    });
    await saveStarted;

    let selectionSettled = false;
    const selectPromise = storage.selectKanbanConfiguration({
      workflowName: DEMO_WF_ID,
      target: "draft",
      actorId: "user-a",
      configurationId: secondConfigurationId,
    }).then((workspace) => {
      selectionSettled = true;
      return workspace;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selectionSettled, false);

    releaseSave();
    const [saved, selected] = await Promise.all([savePromise, selectPromise]);
    assert.equal(saved.activeConfigurationId, firstConfigurationId);
    assert.equal(selected.activeConfigurationId, secondConfigurationId);
    assert.equal(
      selected.configurations.find((configuration) => configuration.id === firstConfigurationId)?.values.title,
      "Saved title",
    );

    const persisted = await storage.getKanbanWorkspace({
      workflowName: DEMO_WF_ID,
      target: "draft",
      actorId: "user-a",
    });
    assert.equal(persisted.activeConfigurationId, secondConfigurationId);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage keeps immutable project card images after metadata changes", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-card-history-"));
  const cards: unknown[] = [];
  const storage = new Storage({
    serverRoot: process.cwd(),
    repoRoot: process.cwd(),
    dataRoot,
    db: {
      updateWorkflowProjectCard: async (workflowId: string, projectCard: unknown) => {
        cards.push(projectCard);
        return {
          id: workflowId,
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
      workflowName: DEMO_WF_ID,
      buffer: first,
      origin: "https://workflow.example",
    });
    const secondImage = await storage.saveProjectCardImage({
      workflowName: DEMO_WF_ID,
      buffer: second,
      origin: "https://workflow.example",
    });
    const projectCard = {
      icon: "workflow" as const,
      iconUrl: secondImage.url,
      iconColor: "#ffffff",
      iconBackgroundColor: "#2563eb",
    };

    assert.deepEqual(await storage.updateProjectCardMetadata({
      workflowName: DEMO_WF_ID,
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
      getWorkflow: async () => ({
        ...createDbWorkflowRecord(DEMO_WF_ID, null),
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
    workflowName: string,
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
      "workflows",
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
    workflowName: string,
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
      getWorkflow: async () => ({
        ...createDbWorkflowRecord(DEMO_WF_ID, null),
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
    workflowName: string,
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
        "workflows",
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

test("DatabaseRepository publish and deployment operations use separate postgres advisory locks", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let released = false;
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
  const originalConnect = publishLockPool.connect;
  const originalEnd = pool.end;
  const originalPublishLockEnd = publishLockPool.end;

  publishLockPool.connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  });
  pool.end = async () => {};
  publishLockPool.end = async () => {};

  try {
    const result = await repository.withWorkflowPublishLock(DEMO_WF_ID, async () => "published");
    const deploymentId = "00000000-0000-4000-8000-000000000099";
    const deploymentResult = await repository.withWorkflowDeploymentLock(
      deploymentId,
      async () => "deployed",
    );

    assert.equal(result, "published");
    assert.equal(deploymentResult, "deployed");
    assert.match(queries[0]?.sql ?? "", /pg_advisory_lock/);
    assert.deepEqual(queries[0]?.params, ["workflow_publish", DEMO_WF_ID]);
    assert.match(queries[1]?.sql ?? "", /pg_advisory_unlock/);
    assert.deepEqual(queries[1]?.params, ["workflow_publish", DEMO_WF_ID]);
    assert.match(queries[2]?.sql ?? "", /pg_advisory_lock/);
    assert.deepEqual(queries[2]?.params, ["workflow_deployment", deploymentId]);
    assert.match(queries[3]?.sql ?? "", /pg_advisory_unlock/);
    assert.deepEqual(queries[3]?.params, ["workflow_deployment", deploymentId]);
    assert.equal(released, true);
  } finally {
    publishLockPool.connect = originalConnect;
    pool.end = originalEnd;
    publishLockPool.end = originalPublishLockEnd;
    await pool.end();
    await publishLockPool.end();
  }
});

test("DatabaseRepository.withWorkflowPublishLock does not occupy storage pool clients", async () => {
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
    await repository.withWorkflowPublishLock(DEMO_WF_ID, async () => {
      await repository.updateWorkflowName(DEMO_WF_ID, "Demo");
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

test("DatabaseRepository namespace transactions commit all knowledge KV writes or roll them back together", async () => {
  const repository = new DatabaseRepository("postgresql://example.invalid/postgres");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let released = 0;
  let failDocumentWrite = false;
  const pool = Reflect.get(repository, "pool") as {
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  };
  const lockPool = Reflect.get(repository, "publishLockPool") as { end: () => Promise<void> };
  const originalConnect = pool.connect;
  const originalEnd = pool.end;
  const originalLockEnd = lockPool.end;

  pool.connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (failDocumentWrite && sql.includes("insert into project_storage") && params[4] === "knowledge.document.guide") {
        throw new Error("document write failed");
      }
      return { rows: [] };
    },
    release: () => {
      released += 1;
    },
  });
  pool.end = async () => {};
  lockPool.end = async () => {};

  const writeKnowledgeValues = async (store: KVStore) => {
    assert.ok(store.withNamespaceLock);
    await store.withNamespaceLock(
      { storageKind: "persistent_value", scope: "project", projectId: DEMO_WF_ID },
      async () => {
        await store.setValue({
          storageKind: "persistent_value",
          scope: "project",
          projectId: DEMO_WF_ID,
          key: "knowledge.documents",
          value: { documents: [{ id: "guide" }] },
          source: { projectId: DEMO_WF_ID },
        });
        await store.setValue({
          storageKind: "persistent_value",
          scope: "project",
          projectId: DEMO_WF_ID,
          key: "knowledge.document.guide",
          value: { id: "guide", title: "Guide", markdown: "# Guide" },
          source: { projectId: DEMO_WF_ID },
        });
      },
    );
  };

  try {
    await repository.withNamespaceTransaction(
      { storageKind: "persistent_value", scope: "project", projectId: DEMO_WF_ID },
      writeKnowledgeValues,
    );

    assert.match(queries[0]?.sql ?? "", /^begin$/);
    assert.match(queries[1]?.sql ?? "", /pg_advisory_xact_lock/);
    assert.deepEqual(queries[1]?.params, [
      "workflow_project_storage_namespace",
      `{"storageKind":"persistent_value","scope":"project","projectId":"${DEMO_WF_ID}"}`,
    ]);
    assert.equal(queries.filter((query) => query.sql.includes("insert into project_storage")).length, 2);
    assert.match(queries.at(-1)?.sql ?? "", /^commit$/);

    queries.length = 0;
    failDocumentWrite = true;
    await assert.rejects(
      repository.withNamespaceTransaction(
        { storageKind: "persistent_value", scope: "project", projectId: DEMO_WF_ID },
        writeKnowledgeValues,
      ),
      /document write failed/,
    );
    assert.match(queries[0]?.sql ?? "", /^begin$/);
    assert.match(queries[1]?.sql ?? "", /pg_advisory_xact_lock/);
    assert.match(queries.at(-1)?.sql ?? "", /^rollback$/);
    assert.equal(queries.some((query) => /^commit$/i.test(query.sql)), false);
    assert.equal(released, 2);
  } finally {
    pool.connect = originalConnect;
    pool.end = originalEnd;
    lockPool.end = originalLockEnd;
    await Promise.all([pool.end(), lockPool.end()]);
  }
});

test("Storage preserves preparation failure stage and reason", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-preparation-failure-"));
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  Reflect.set(storage, "uploadPackage", async (options: {
    onStage?: (stage: "bundling") => Promise<void>;
  }) => {
    await options.onStage?.("bundling");
    throw new Error("bundle command failed");
  });

  try {
    await storage.init();
    const accepted = await storage.enqueuePackagePreparation({
      workflowName: DEMO_WF_ID,
      archiveName: "demo.tgz",
      archiveBuffer: Buffer.from("archive"),
    });
    const failed = await waitForPreparationTerminal(storage, DEMO_WF_ID, accepted.jobId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "bundling");
    assert.equal(failed.failureReason, "bundle command failed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage gives concurrent project deployments distinct reserved versions", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-deployment-reservations-"));
  const createDeployment = (id: string): DeploymentRecord => ({
    id,
    rootProjectId: DEMO_WF_ID,
    status: "planned",
    manifest: {
      version: 1,
      rootProjectId: DEMO_WF_ID,
      projects: [{ projectId: DEMO_WF_ID, role: "root", archivePath: `projects/${DEMO_WF_ID}.tgz` }],
      dependencies: [],
    },
    releaseLog: "",
    createdByUserId: "user-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    items: [{
      deploymentId: id,
      projectId: DEMO_WF_ID,
      role: "root",
      delivery: "included",
      status: "planned",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
  });
  const deployments = new Map([
    ["00000000-0000-4000-8000-000000000011", createDeployment("00000000-0000-4000-8000-000000000011")],
    ["00000000-0000-4000-8000-000000000012", createDeployment("00000000-0000-4000-8000-000000000012")],
  ]);
  const db = {
    getWorkflowDeployment: async (id: string) => deployments.get(id),
    updateWorkflowDeploymentItem: async (input: {
      deploymentId: string;
      projectId: string;
      status: "planned";
      stage: string;
      plannedVersion: string;
    }) => {
      const item = deployments.get(input.deploymentId)?.items.find(
        (candidate) => candidate.projectId === input.projectId,
      );
      assert.ok(item);
      Object.assign(item, input, { updatedAt: "2026-08-05T00:00:01.000Z" });
    },
    listWorkflowVersionReservations: async (workflowId: string) => [...deployments.values()]
      .flatMap((deployment) => deployment.items)
      .filter((item) => item.projectId === workflowId && item.plannedVersion !== undefined)
      .map((item) => item.plannedVersion!),
    listVersions: async () => [],
    getWorkflow: async () => undefined,
    withWorkflowPublishLock: async (_workflowId: string, operation: () => Promise<unknown>) => operation(),
  } as unknown as DatabaseRepository;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot, db });
  const reserve = Reflect.get(storage, "reserveProjectGroupDeploymentVersions") as (
    deployment: DeploymentRecord,
    reset: boolean,
  ) => Promise<DeploymentRecord>;

  try {
    const [first, second] = await Promise.all(
      [...deployments.values()].map((deployment) => reserve.call(storage, deployment, false)),
    );
    assert.deepEqual(
      [first.items[0]?.plannedVersion, second.items[0]?.plannedVersion].sort(),
      ["0.0.1", "0.0.2"],
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage skips active deployment reservations for ordinary publish versions", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-publish-reservations-"));
  const db = {
    listVersions: async () => [{ version: "0.0.2" }],
    getWorkflow: async () => ({ latest: "0.0.2" }),
    listWorkflowVersionReservations: async () => ["0.0.3", "0.0.4"],
  } as unknown as DatabaseRepository;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot, db });
  const resolveNextVersion = Reflect.get(storage, "resolveNextVersion") as (
    workflowName: string,
  ) => Promise<string>;

  try {
    assert.equal(await resolveNextVersion.call(storage, DEMO_WF_ID), "0.0.5");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage resets and re-reserves every item before re-preparing a failed deployment", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-deployment-reprepare-"));
  const deployment: DeploymentRecord = {
    id: "00000000-0000-4000-8000-000000000013",
    rootProjectId: DEMO_WF_ID,
    status: "failed",
    manifest: {
      version: 1,
      rootProjectId: DEMO_WF_ID,
      projects: [{ projectId: DEMO_WF_ID, role: "root", archivePath: `projects/${DEMO_WF_ID}.tgz` }],
      dependencies: [],
    },
    releaseLog: "retry",
    createdByUserId: "user-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    items: [{
      deploymentId: "00000000-0000-4000-8000-000000000013",
      projectId: DEMO_WF_ID,
      role: "root",
      delivery: "included",
      status: "failed",
      plannedVersion: "0.0.8",
      preparedSourceHash: "a".repeat(64),
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
  };
  let resetCalls = 0;
  const db = {
    resetWorkflowDeploymentItemsForPreparation: async () => {
      resetCalls += 1;
      Object.assign(deployment.items[0]!, {
        status: "planned",
        stage: "version_reserved",
        plannedVersion: undefined,
        preparedSourceHash: undefined,
      });
    },
    getWorkflowDeployment: async () => deployment,
    updateWorkflowDeploymentItem: async (input: { plannedVersion: string }) => {
      Object.assign(deployment.items[0]!, input);
    },
    listVersions: async () => [{ version: "0.0.8" }],
    getWorkflow: async () => ({ latest: "0.0.8" }),
    listWorkflowVersionReservations: async () => [],
    withWorkflowPublishLock: async (_workflowId: string, operation: () => Promise<unknown>) => operation(),
  } as unknown as DatabaseRepository;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot, db });
  const reserve = Reflect.get(storage, "reserveProjectGroupDeploymentVersions") as (
    value: DeploymentRecord,
    reset: boolean,
  ) => Promise<DeploymentRecord>;

  try {
    const result = await reserve.call(storage, deployment, true);
    assert.equal(resetCalls, 1);
    assert.equal(result.items[0]?.plannedVersion, "0.0.9");
    assert.equal(result.items[0]?.preparedSourceHash, undefined);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage rejects project-group publishing while a relationship is pending", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-group-grant-error-"));
  const dependency = {
    alias: "stocks",
    projectId: DEMO_CONV_WF_ID,
    delivery: "external" as const,
  };
  const now = "2026-08-05T00:00:00.000Z";
  const deployment: DeploymentRecord = {
    id: "00000000-0000-4000-8000-000000000016",
    rootProjectId: DEMO_WF_ID,
    status: "prepared",
    manifest: {
      version: 1,
      rootProjectId: DEMO_WF_ID,
      projects: [{
        projectId: DEMO_WF_ID,
        role: "root",
        archivePath: `projects/${DEMO_WF_ID}.tgz`,
      }],
      dependencies: [dependency],
    },
    releaseLog: "",
    createdByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
    items: [{
      deploymentId: "00000000-0000-4000-8000-000000000016",
      projectId: DEMO_WF_ID,
      role: "root",
      delivery: "included",
      status: "prepared",
      updatedAt: now,
    }],
  };
  const db = {
    getWorkflow: async () => createDbWorkflowRecord(DEMO_CONV_WF_ID, null),
  } as unknown as DatabaseRepository;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot, db });
  const sourceRoot = path.join(dataRoot, "workflows", DEMO_WF_ID, "draft", "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({
    id: DEMO_WF_ID,
    name: "Stock Board",
    version: "1.0.0",
    steamHarness: {
      projectInfo: {
        ...DECLARED_SERVER_PROJECT_INFO,
        relatedProjects: [{
          alias: dependency.alias,
          projectId: dependency.projectId,
          grantToRelatedProject: {
            read: { mode: "all" },
            write: { mode: "none" },
          },
        }],
      },
      projectType: "kanban",
    },
  }), "utf8");
  const assertReady = Reflect.get(storage, "assertProjectGroupPublishReady") as (
    value: DeploymentRecord,
  ) => Promise<void>;

  try {
    await assert.rejects(
      assertReady.call(storage, deployment),
      /relationships must be confirmed before publishing/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage offers a source request link only when the pinned dependency source exists", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-dependency-request-link-"));
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  const dependency = {
    alias: "stocks",
    projectId: DEMO_CONV_WF_ID,
    delivery: "included" as const,
    version: "1.0.0",
    sourceHash: "a".repeat(64),
  };
  const internals = storage as unknown as Record<string, unknown>;
  internals["resolveSourceTarget"] = async () => ({ resolvedTarget: "1.0.0" });
  internals["readVersionDependencyLocks"] = async () => [dependency];
  internals["requireProjectDependencyDatabase"] = () => ({
    getWorkflow: async (projectId: string) => projectId === DEMO_WF_ID
      ? {
          ...createDbWorkflowRecord(DEMO_WF_ID, null),
          projectInfo: {
            ...DECLARED_SERVER_PROJECT_INFO,
            relatedProjects: [{
              alias: "stocks",
              projectId: DEMO_CONV_WF_ID,
              grantToRelatedProject: {
                read: { mode: "all" },
                write: { mode: "none" },
              },
            }],
          },
        }
      : {
          ...createDbWorkflowRecord(DEMO_CONV_WF_ID, null),
          name: "Stock data",
          projectInfo: {
            ...DECLARED_SERVER_PROJECT_INFO,
            relatedProjects: [{
              alias: "board",
              projectId: DEMO_WF_ID,
              grantToRelatedProject: {
                read: { mode: "all" },
                write: { mode: "none" },
              },
            }],
          },
        },
    hasProjectKV: async () => false,
  });
  let sourceAvailable = false;
  internals["isPinnedProjectSourceAvailable"] = async () => sourceAvailable;

  try {
    const readStatus = () => storage.getProjectDependencyStatus({
      workflowName: DEMO_WF_ID,
      target: "1.0.0",
      canDownloadProject: async () => false,
      requestUrlForProject: () => "https://example.test/access-requests/signed",
    });
    const missing = await readStatus();
    assert.equal(missing.dependencies[0]?.sourceAvailable, false);
    assert.equal(missing.dependencies[0]?.requestUrl, undefined);

    sourceAvailable = true;
    const permissionRequired = await readStatus();
    assert.equal(permissionRequired.dependencies[0]?.sourceAvailable, true);
    assert.equal(
      permissionRequired.dependencies[0]?.requestUrl,
      "https://example.test/access-requests/signed",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage accepts a replacement package after deployment preparation was interrupted", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-group-prepare-resume-"));
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  const deployment: DeploymentRecord = {
    id: "00000000-0000-4000-8000-000000000014",
    rootProjectId: DEMO_WF_ID,
    status: "preparing",
    manifest: {
      version: 1,
      rootProjectId: DEMO_WF_ID,
      projects: [{
        projectId: DEMO_WF_ID,
        role: "root",
        archivePath: `projects/${DEMO_WF_ID}.tgz`,
      }],
      dependencies: [],
    },
    releaseLog: "resume",
    createdByUserId: "user-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    items: [{
      deploymentId: "00000000-0000-4000-8000-000000000014",
      projectId: DEMO_WF_ID,
      role: "root",
      delivery: "included",
      status: "preparing",
      plannedVersion: "1.0.0",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
  };
  let transitionFrom: string[] = [];
  const internals = storage as unknown as Record<string, unknown>;
  internals["getProjectGroupDeployment"] = async () => deployment;
  internals["requireProjectDependencyDatabase"] = () => ({
    transitionWorkflowDeploymentStatus: async ({ from }: { from: string[] }) => {
      transitionFrom = from;
      return true;
    },
    updateWorkflowDeployment: async ({ status }: { status: DeploymentRecord["status"] }) => {
      deployment.status = status;
    },
  });
  internals["reserveProjectGroupDeploymentVersions"] = async () => deployment;
  internals["extractArchive"] = async () => {
    throw new Error("replacement package inspected");
  };

  try {
    await assert.rejects(
      storage.prepareProjectGroupDeployment({
        deploymentId: deployment.id,
        archiveName: "project-group.tgz",
        archiveBuffer: Buffer.from("replacement"),
      }),
      /replacement package inspected/,
    );
    assert.deepEqual(transitionFrom, ["planned", "failed", "preparing"]);
    assert.equal(deployment.status, "failed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Storage resumes a persisted project-group preparation after restart", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-storage-project-group-restart-"));
  const deploymentId = "00000000-0000-4000-8000-000000000016";
  const preparationDir = path.join(dataRoot, "deployment-preparations", deploymentId);
  await mkdir(preparationDir, { recursive: true });
  await writeFile(path.join(preparationDir, "project-group.tgz"), "group-package");
  await writeFile(path.join(preparationDir, "preparation.json"), JSON.stringify({
    deploymentId,
    archiveName: "project-group.tgz",
    createdAt: "2026-08-05T00:00:00.000Z",
  }));
  const deployment = {
    id: deploymentId,
    status: "preparing",
  } as DeploymentRecord;
  const db = {
    getWorkflowDeployment: async () => deployment,
    updateWorkflowDeployment: async () => deployment,
  } as unknown as DatabaseRepository;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot, db });
  let scheduledDeploymentId: string | undefined;
  Reflect.set(storage, "scheduleProjectGroupPreparation", (preparation: { deploymentId: string }) => {
    scheduledDeploymentId = preparation.deploymentId;
  });
  const resume = Reflect.get(storage, "resumePendingProjectGroupPreparations") as () => Promise<void>;

  try {
    await resume.call(storage);
    assert.equal(scheduledDeploymentId, deploymentId);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function waitForPreparationTerminal(
  storage: Storage,
  workflowId: string,
  jobId: string,
): Promise<PreparationJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await storage.getPreparationJob(workflowId, jobId);
    if (job.status === "success" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Preparation job ${jobId} did not reach a terminal status.`);
}

async function writePublishableDraft(dataRoot: string, workflowName: string): Promise<void> {
  const draftRoot = path.join(dataRoot, "workflows", workflowName, "draft");
  const sourceRoot = path.join(draftRoot, "source");

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({
      id: workflowName,
      name: workflowName,
      version: "0.1.0",
      devDependencies: testToolchainDependencies,
      steamHarness: { projectType: "workflow", projectInfo: DECLARED_SERVER_PROJECT_INFO },
    }),
    "utf8",
  );
  await writeFile(
    path.join(sourceRoot, "index.ts"),
    `const draftWorkflow = workflow.defineWorkflow({ name: "${workflowName}", run: async () => ({ errCode: 0, errMessage: "" }) });\nexport const executor = workflow.defineExecutor({ projectType: "workflow", defaultEntrypoint: "main", entrypoints: [workflow.defineEntrypoint({ id: "main", title: "Main", workflow: draftWorkflow, createInput: () => ({ errCode: 0, errMessage: "" }) })] });\nexport default draftWorkflow;\n`,
    "utf8",
  );
  await writeFile(path.join(sourceRoot, "README.md"), `# ${workflowName}\n`, "utf8");
}

async function writeFileVersion(
  dataRoot: string,
  workflowName: string,
  version: string,
  createdAt: string,
  packageJsonOverrides: Record<string, unknown> = {},
  projectType: "workflow" | "conversation" = "workflow",
): Promise<void> {
  const versionRoot = path.join(dataRoot, "workflows", workflowName, "versions", version);
  await mkdir(path.join(versionRoot, "source"), { recursive: true });
  await writeFile(
    path.join(versionRoot, "source", "package.json"),
    JSON.stringify({
      id: workflowName,
      name: workflowName,
      version: "0.1.0",
      devDependencies: testToolchainDependencies,
      steamHarness: { projectType: "workflow", projectInfo: DECLARED_SERVER_PROJECT_INFO },
      ...packageJsonOverrides,
    }),
    "utf8",
  );
  await writeFile(
    path.join(versionRoot, "source", "index.ts"),
    projectType === "workflow"
      ? `const defined = workflow.defineWorkflow({ name: "test", run: async () => ({ errCode: 0, errMessage: "" }) });\nexport default workflow.defineExecutor({ projectType: "workflow", defaultEntrypoint: "main", entrypoints: [workflow.defineEntrypoint({ id: "main", title: "Main", workflow: defined, createInput: () => ({ errCode: 0, errMessage: "" }) })] });\n`
      : `const defined = workflow.defineWorkflow({ name: "test", run: async () => ({ errCode: 0, errMessage: "" }) });\nexport default workflow.defineExecutor({ projectType: "conversation", workflow: defined, createInput: () => ({ errCode: 0, errMessage: "" }) });\n`,
    "utf8",
  );
  await writeFile(
    path.join(versionRoot, "source", "README.md"),
    `# ${workflowName}\n`,
    "utf8",
  );
  await writeFile(
    path.join(versionRoot, "manifest.json"),
    JSON.stringify({
      workflowId: workflowName,
      workflowName,
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
  workflowId: string,
): Promise<void> {
  await writeFileVersion(
    dataRoot,
    workflowId,
    "1.0.0",
    "2026-08-25T00:00:00.000Z",
  );
  await writeFile(
    path.join(dataRoot, "workflows", workflowId, "latest.json"),
    JSON.stringify({ version: "1.0.0" }),
    "utf8",
  );
}

function createDbWorkflowRecord(workflowId: string, latest: string | null) {
  return {
    id: workflowId,
    name: workflowId,
    projectType: "workflow" as const,
    projectCard: {
      icon: "workflow",
      iconBackgroundColor: "#2563eb",
    },
    projectInfo: {
      localizedNames: {},
      declarations: [],
      platformSupport: { mode: "agnostic" as const },
      dataStorage: { mode: "server" as const },
      relatedProjects: [],
    },
    packageVersion: "0.1.0",
    hasDraft: false,
    latest,
    visibility: "public",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function createDbVersionRecord(workflowId: string, version: string) {
  return {
    workflowId,
    workflowName: workflowId,
    version,
    createdAt: "2026-05-21T00:00:00.000Z",
    releaseLog: "",
    sourceHash: version,
    sourceObjectPath: `workflows/${workflowId}/versions/${version}/source.tar.gz`,
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

function createMemoryKVStore(): KVStore & {
  getWorkflow(workflowId: string): Promise<ReturnType<typeof createDbWorkflowRecord>>;
  values: Map<string, unknown>;
  sources: Map<string, unknown>;
  getValueWithRevision(input: KVStoreGetInput): Promise<{ value: unknown; revision: string } | undefined>;
  compareAndSetValue(
    input: KVStoreSetInput,
    expectedRevision: string | null,
  ): Promise<{ applied: boolean; revision?: string }>;
  withNamespaceTransaction<T>(
    input: KVNamespaceLockInput,
    operation: (store: KVStore) => Promise<T> | T,
  ): Promise<T>;
} {
  const values = new Map<string, unknown>();
  const sources = new Map<string, unknown>();
  const revisions = new Map<string, string>();
  let nextRevision = 0;
  const createKey = (input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }) => [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");

  return {
    async getWorkflow(workflowId) {
      return createDbWorkflowRecord(workflowId, null);
    },
    values,
    sources,
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      const key = createKey(input);
      values.set(key, input.value);
      sources.set(key, input.source);
      revisions.set(key, String(nextRevision += 1));
    },
    async getValueWithRevision(input) {
      const key = createKey(input);
      const value = values.get(key);
      const revision = revisions.get(key);
      return value === undefined || revision === undefined ? undefined : { value, revision };
    },
    async compareAndSetValue(input, expectedRevision) {
      const key = createKey(input);
      const currentRevision = revisions.get(key);
      if (
        (expectedRevision === null && currentRevision !== undefined) ||
        (expectedRevision !== null && currentRevision !== expectedRevision)
      ) {
        return { applied: false };
      }
      values.set(key, input.value);
      sources.set(key, input.source);
      const revision = String(nextRevision += 1);
      revisions.set(key, revision);
      return { applied: true, revision };
    },
    async updateValue(input, updater) {
      const key = createKey(input);
      const next = updater(values.get(key));
      values.set(key, next);
      sources.set(key, input.source);
      revisions.set(key, String(nextRevision += 1));
      return next;
    },
    async deleteValue(input) {
      const key = createKey(input);
      const existed = values.delete(key);
      sources.delete(key);
      revisions.delete(key);
      return existed;
    },
    async withNamespaceLock(_input, operation) {
      return operation();
    },
    async withNamespaceTransaction(_input, operation) {
      const valueSnapshot = new Map(values);
      const sourceSnapshot = new Map(sources);
      const revisionSnapshot = new Map(revisions);
      const revisionCounter = nextRevision;
      try {
        return await operation(this);
      } catch (error) {
        values.clear();
        sources.clear();
        revisions.clear();
        for (const [key, value] of valueSnapshot) values.set(key, value);
        for (const [key, value] of sourceSnapshot) sources.set(key, value);
        for (const [key, revision] of revisionSnapshot) revisions.set(key, revision);
        nextRevision = revisionCounter;
        throw error;
      }
    },
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

test("a related knowledge mutation is checked on the document, not only the index", () => {
  const grant = (
    knowledge: { read: RelatedProjectKVGrant["read"]; write: RelatedProjectKVGrant["write"] },
  ): RelatedProjectKVGrant => ({ read: { mode: "none" }, write: { mode: "none" }, knowledge });

  const indexOnly = grant({
    read: { mode: "prefixes", prefixes: ["knowledge.documents"] },
    write: { mode: "prefixes", prefixes: ["knowledge.documents"] },
  });
  const wholeBase = grant({ read: { mode: "all" }, write: { mode: "all" } });

  // `knowledge.documents` covers the index the mutation rewrites and not the
  // document it rewrites — a store that applies the mutation itself never runs
  // the per-key checks, so the index alone must not let the document through.
  assert.equal(
    isKnowledgeMutationGranted(indexOnly, { type: "delete", input: { documentId: "payroll" } }),
    false,
  );
  assert.equal(
    isKnowledgeMutationGranted(wholeBase, { type: "delete", input: { documentId: "payroll" } }),
    true,
  );
  // The read side is checked too: deleting reads the document before removing it.
  assert.equal(
    isKnowledgeMutationGranted(
      grant({ read: { mode: "none" }, write: { mode: "all" } }),
      { type: "delete", input: { documentId: "payroll" } },
    ),
    false,
  );
  // A create that lets the store pick the id cannot be checked, so it is refused.
  assert.equal(
    isKnowledgeMutationGranted(wholeBase, { type: "create", input: { title: "Payroll", markdown: "x" } }),
    false,
  );
  assert.equal(
    isKnowledgeMutationGranted(wholeBase, {
      type: "create",
      input: { id: "payroll", title: "Payroll", markdown: "x" },
    }),
    true,
  );
});
