import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "vitest";
import * as steamHarness from "steamharness";
import {
  createCliRelatedProjectRuntime,
  parseCliRelatedProjectSpec,
  type CliWorkflowRelatedProjectKVResolver,
} from "../related-projects";

const CONSUMER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
const hasRelatedProjectCore = typeof (steamHarness as unknown as {
  createWorkflowRelatedProjectsContext?: unknown;
}).createWorkflowRelatedProjectsContext === "function";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("parses one related project only from an explicit absolute path", () => {
  const projectDir = path.join(os.tmpdir(), "inventory-project");
  assert.deepEqual(parseCliRelatedProjectSpec(`inventory=${projectDir}`), {
    alias: "inventory",
    projectDir,
  });
  assert.throws(
    () => parseCliRelatedProjectSpec("inventory=../inventory"),
    /absolute directory path/,
  );
  assert.throws(() => parseCliRelatedProjectSpec("Inventory=/tmp/inventory"), /Invalid related project alias/);
  assert.throws(() => parseCliRelatedProjectSpec("inventory"), /alias=\/absolute\/project\/path/);
});

it("rejects duplicate arguments, unavailable directories, invalid UUIDs, and pending declarations", async () => {
  const fixture = await createRelatedFixture({ confirmed: true });
  assert.throws(() => createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [
      { alias: "inventory", projectDir: fixture.targetDir },
      { alias: "inventory", projectDir: fixture.targetDir },
    ],
  }), /specified more than once/);
  assert.throws(() => createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "missing", projectDir: path.join(fixture.root, "missing") }],
  }), /directory is unavailable/);

  await writeProjectPackage(fixture.targetDir, {
    id: "not-a-uuid",
    relatedProjects: [],
  });
  assert.throws(() => createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "inventory", projectDir: fixture.targetDir }],
  }), /Invalid Related project .* package\.json\.id/);

  await writeProjectPackage(fixture.targetDir, {
    id: TARGET_ID,
    relatedProjects: [],
  });
  assert.throws(() => createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "inventory", projectDir: fixture.targetDir }],
  }), /not confirmed by both project manifests/);
});

it.runIf(hasRelatedProjectCore)("reads and writes confirmed local related KV and applies revocation immediately", async () => {
  const fixture = await createRelatedFixture({ confirmed: true, targetWriteMode: "all" });
  const runtime = createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "inventory", projectDir: fixture.targetDir }],
    localKvStoreDir: fixture.storeDir,
  });
  const related = createRelatedProjectsContext(runtime.localResolver).get("inventory").kv;

  await related.setValue("catalog:item", { stock: 3 });
  assert.deepEqual(await related.getValue("catalog:item"), { stock: 3 });

  const rawStore = runtime.localKvStore!;
  assert.deepEqual(await rawStore.getValue({
    storageKind: "kv",
    scope: "project",
    projectId: TARGET_ID,
    key: "catalog:item",
  }), { stock: 3 });

  await writeProjectPackage(fixture.targetDir, {
    id: TARGET_ID,
    relatedProjects: [createRelation("consumer", CONSUMER_ID, "all", "none")],
  });
  await assert.rejects(
    () => related.setValue("catalog:item", { stock: 4 }),
    /does not grant write access/,
  );

  await writeProjectPackage(fixture.targetDir, { id: TARGET_ID, relatedProjects: [] });
  await assert.rejects(() => related.getValue("catalog:item"), /unavailable or awaiting confirmation/);
});

it.runIf(hasRelatedProjectCore)("keeps related KV in the selected location and initializes a dedicated local format once", async () => {
  const fixture = await createRelatedFixture({ confirmed: true, targetStorageMode: "server" });
  await mkdir(path.join(fixture.storeDir, "global"), { recursive: true });
  await writeFile(path.join(fixture.storeDir, "global", "legacy-value.json"), "legacy\n");
  const runtime = createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "inventory", projectDir: fixture.targetDir }],
    localKvStoreDir: fixture.storeDir,
  });

  assert.equal(runtime.localResolver?.resolve("inventory"), undefined);
  await runtime.localKvStore?.getValue({
    storageKind: "kv",
    scope: "project",
    projectId: CONSUMER_ID,
    key: "initialize",
  });
  const marker = JSON.parse(await readFile(
    path.join(fixture.storeDir, ".workflow-storage-format.json"),
    "utf8",
  )) as Record<string, unknown>;
  assert.deepEqual(marker, { version: 2, storageKind: "kv" });
  await assert.rejects(() => readFile(
    path.join(fixture.storeDir, "global", "legacy-value.json"),
    "utf8",
  ));
});

it.runIf(hasRelatedProjectCore)("hands a local run the target's persistent values and its runner", async () => {
  const fixture = await createRelatedFixture({
    confirmed: true,
    targetStorageMode: "local",
    targetKnowledge: true,
  });
  const persistentValueDir = path.join(fixture.root, "workflow-persistent-value");
  await mkdir(persistentValueDir, { recursive: true });
  const runtime = createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "inventory", projectDir: fixture.targetDir }],
    localKvStoreDir: fixture.storeDir,
    localPersistentValueStoreDir: persistentValueDir,
  });

  const resolved = runtime.localResolver?.resolve("inventory");
  assert.ok(resolved?.persistentValue, "a local target's knowledge base is reachable");
  assert.ok(resolved?.runner, "and a local target can be run from its own directory");

  // The namespace has to be the *target's*: built from the target's project
  // id inside the shared root, so what the consumer writes is what the target
  // reads back on its own side.
  const knowledge = createRelatedKnowledge(resolved.persistentValue);
  const created = await knowledge.createDocument({ title: "Runbook", markdown: "# Runbook" });
  const readBack = await createRelatedKnowledge(
    createTargetPersistentValue(persistentValueDir, TARGET_ID),
  ).getDocument(created.id);
  assert.equal(readBack?.title, "Runbook");
});

it.runIf(hasRelatedProjectCore)("leaves the knowledge base closed when the run has no persistent-value root", async () => {
  const fixture = await createRelatedFixture({
    confirmed: true,
    targetStorageMode: "local",
    targetKnowledge: true,
  });
  const runtime = createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "inventory", projectDir: fixture.targetDir }],
    localKvStoreDir: fixture.storeDir,
  });

  const resolved = runtime.localResolver?.resolve("inventory");
  // Persistent values have no default root — that is where a project's
  // knowledge lives — so a run that was not pointed at one has none to hand
  // over. Inventing a temp directory would open a knowledge base the target
  // itself never reads, and the target's own child run would fail against it.
  assert.equal(resolved?.persistentValue, undefined);
  assert.ok(resolved?.runner, "the entrypoint runner does not depend on a store");
});

it.runIf(hasRelatedProjectCore)("gives a server-located target a runner, so its entrypoints are callable", async () => {
  const fixture = await createRelatedFixture({
    confirmed: true,
    targetStorageMode: "server",
  });
  const runtime = createCliRelatedProjectRuntime({
    consumerProjectDir: fixture.consumerDir,
    relatedProjects: [{ alias: "inventory", projectDir: fixture.targetDir }],
    localKvStoreDir: fixture.storeDir,
    // The relation's server store comes from the environment the run was given,
    // never from whichever login the machine running the tests happens to have
    // saved: without these the resolver has no store to build and returns
    // undefined, so the test would silently assert the machine's credentials.
    env: {
      STEAMHARNESS_SERVER_URL: "http://127.0.0.1:1",
      STEAMHARNESS_SERVER_ADMIN_KEY: "related-projects-test-key",
    },
  });

  const resolved = runtime.serverResolver?.resolve("inventory");
  // A target that keeps its data on the server is still run here; the target's
  // own storage declaration decides which store its run uses, exactly as if its
  // author had started it from this directory.
  assert.ok(resolved?.runner, "a server-located target can be run from its own directory");
  // Held in a local so the narrowing survives into the callback: an assertion
  // on a property does not narrow it inside a closure.
  const runner = resolved.runner;
  // Reading that runner's source is what `listEntrypoints` does; the fixture
  // projects carry no source of their own, so the call is expected to report
  // the target's script rather than a missing runner.
  await assert.rejects(() => runner.listEntrypoints(), /script validation failed/);
});

/**
 * The knowledge helpers through the narrow surface this file can see the
 * installed Core through — enough to prove which namespace was handed over.
 */
function createRelatedKnowledge(persistentValue: unknown) {
  const api = steamHarness as unknown as {
    createKnowledgeDocument(
      context: { persistentValue: unknown },
      input: { title: string; markdown: string },
    ): Promise<{ id: string; title: string }>;
    getKnowledgeDocument(
      context: { persistentValue: unknown },
      documentId: string,
    ): Promise<{ id: string; title: string } | undefined>;
  };
  return {
    createDocument: (input: { title: string; markdown: string }) =>
      api.createKnowledgeDocument({ persistentValue }, input),
    getDocument: (documentId: string) =>
      api.getKnowledgeDocument({ persistentValue }, documentId),
  };
}

function createTargetPersistentValue(rootDir: string, projectId: string): unknown {
  const api = steamHarness as unknown as {
    createLocalWorkflowKVStore(options: { rootDir: string; storageKind: "persistent_value" }): unknown;
    createWorkflowPersistentValueContext(options: { store: unknown; projectId: string }): unknown;
  };
  return api.createWorkflowPersistentValueContext({
    store: api.createLocalWorkflowKVStore({ rootDir, storageKind: "persistent_value" }),
    projectId,
  });
}

async function createRelatedFixture(options: {
  confirmed: boolean;
  targetWriteMode?: "none" | "all";
  targetStorageMode?: "local" | "server" | "both";
  targetKnowledge?: boolean;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-related-projects-"));
  roots.push(root);
  const consumerDir = path.join(root, "consumer");
  const targetDir = path.join(root, "target");
  const storeDir = path.join(root, "workflow-kv");
  await Promise.all([
    mkdir(consumerDir, { recursive: true }),
    mkdir(targetDir, { recursive: true }),
    mkdir(storeDir, { recursive: true }),
  ]);
  await writeProjectPackage(consumerDir, {
    id: CONSUMER_ID,
    relatedProjects: [createRelation("inventory", TARGET_ID, "all", "none")],
  });
  await writeProjectPackage(targetDir, {
    id: TARGET_ID,
    dataStorageMode: options.targetStorageMode,
    relatedProjects: options.confirmed
      ? [{
          ...createRelation("consumer", CONSUMER_ID, "all", options.targetWriteMode ?? "none"),
          ...(options.targetKnowledge === true
            ? {
                grantToRelatedProject: {
                  read: { mode: "all" },
                  write: { mode: "none" },
                  knowledge: { read: { mode: "all" }, write: { mode: "all" } },
                },
              }
            : {}),
        }]
      : [],
  });
  return { root, consumerDir, targetDir, storeDir };
}

async function writeProjectPackage(projectDir: string, options: {
  id: string;
  dataStorageMode?: "local" | "server" | "both";
  relatedProjects: Record<string, unknown>[];
}): Promise<void> {
  await writeFile(path.join(projectDir, "package.json"), `${JSON.stringify({
    id: options.id,
    name: path.basename(projectDir),
    steamHarness: {
      projectInfo: {
        dataStorage: { mode: options.dataStorageMode ?? "local" },
        relatedProjects: options.relatedProjects,
      },
    },
  }, null, 2)}\n`);
}

function createRelation(
  alias: string,
  projectId: string,
  readMode: "none" | "all",
  writeMode: "none" | "all",
): Record<string, unknown> {
  return {
    alias,
    projectId,
    grantToRelatedProject: {
      read: { mode: readMode },
      write: { mode: writeMode },
    },
  };
}

interface RelatedProjectsTestContext {
  get(alias: string): {
    kv: {
      getValue(key: string): Promise<unknown | undefined>;
      setValue(key: string, value: unknown): Promise<void>;
    };
  };
}

function createRelatedProjectsContext(
  resolver: CliWorkflowRelatedProjectKVResolver | undefined,
): RelatedProjectsTestContext {
  const create = (steamHarness as unknown as {
    createWorkflowRelatedProjectsContext?: (
      resolver: CliWorkflowRelatedProjectKVResolver | undefined,
    ) => RelatedProjectsTestContext;
  }).createWorkflowRelatedProjectsContext;
  if (typeof create !== "function") {
    throw new Error("Installed steamharness does not support related project storage.");
  }
  return create(resolver);
}
