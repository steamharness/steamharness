import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkflowProjectInfo,
  WorkflowProjectKVAccessRule,
} from "@steamharness/project-info";
import {
  createDeclaredWorkflowRelatedProjectKVResolver,
  createKnowledgeDocument,
  createWorkflowRelatedProjectsContext,
  type WorkflowKVNamespace,
  type WorkflowKVNamespaceMutation,
} from "../index";

const CONSUMER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

test("confirmed related projects use the target grant and recheck revocation", async () => {
  let consumerInfo = createProjectInfo([
    createRelation("inventory", TARGET_ID, { mode: "none" }, { mode: "none" }),
  ]);
  let targetInfo = createProjectInfo([
    createRelation("consumer", CONSUMER_ID, { mode: "all" }, { mode: "none" }),
  ]);
  const targetKV = createMemoryNamespace({ "catalog:item": { stock: 2 } });
  const relatedProjects = createWorkflowRelatedProjectsContext(
    createDeclaredWorkflowRelatedProjectKVResolver({
      getConsumerProject: () => ({ projectId: CONSUMER_ID, projectInfo: consumerInfo }),
      getTargetProject: (projectId) => projectId === TARGET_ID
        ? { projectId: TARGET_ID, projectInfo: targetInfo, kv: targetKV }
        : undefined,
    }),
  );
  const inventory = relatedProjects.get("inventory").kv;

  assert.deepEqual(await inventory.getValue("catalog:item"), { stock: 2 });
  await assert.rejects(
    () => inventory.setValue("catalog:item", { stock: 3 }),
    /does not grant write access/,
  );
  await assert.rejects(
    () => inventory.updateValue("catalog:item", () => ({ stock: 3 })),
    /does not grant write access/,
  );

  targetInfo = createProjectInfo([
    createRelation("consumer", CONSUMER_ID, { mode: "all" }, { mode: "all" }),
  ]);
  await inventory.setValue("catalog:item", { stock: 3 });
  assert.deepEqual(await inventory.updateValue("catalog:item", (current) => ({
    stock: Number((current as { stock?: number } | undefined)?.stock ?? 0) + 1,
  })), { stock: 4 });

  targetInfo = createProjectInfo([]);
  await assert.rejects(
    () => inventory.getValue("catalog:item"),
    /unavailable or awaiting confirmation/,
  );

  consumerInfo = createProjectInfo([]);
  await assert.rejects(
    () => inventory.getValue("catalog:item"),
    /unavailable or awaiting confirmation/,
  );
});

test("prefix grants are enforced independently and updateValue requires both", async () => {
  const targetKV = createMemoryNamespace({
    "read:item": 1,
    "shared:item": 1,
  });
  let targetInfo = createProjectInfo([
    createRelation(
      "consumer",
      CONSUMER_ID,
      { mode: "prefixes", prefixes: ["read:", "shared:"] },
      { mode: "prefixes", prefixes: ["write:", "shared:"] },
    ),
  ]);
  const related = createWorkflowRelatedProjectsContext(
    createDeclaredWorkflowRelatedProjectKVResolver({
      getConsumerProject: () => ({
        projectId: CONSUMER_ID,
        projectInfo: createProjectInfo([
          createRelation("inventory", TARGET_ID, { mode: "all" }, { mode: "all" }),
        ]),
      }),
      getTargetProject: () => ({ projectId: TARGET_ID, projectInfo: targetInfo, kv: targetKV }),
    }),
  ).get("inventory").kv;

  assert.equal(await related.getValue("read:item"), 1);
  await related.setValue("write:item", 2);
  assert.equal(await targetKV.getValue("write:item"), 2);
  assert.equal(await related.updateValue("shared:item", (value) => Number(value) + 1), 2);
  await assert.rejects(() => related.getValue("write:item"), /does not grant read access/);
  await assert.rejects(() => related.setValue("read:item", 2), /does not grant write access/);

  targetInfo = createProjectInfo([
    createRelation(
      "consumer",
      CONSUMER_ID,
      { mode: "prefixes", prefixes: ["shared:"] },
      { mode: "none" },
    ),
  ]);
  await assert.rejects(
    () => related.updateValue("shared:item", (value) => Number(value) + 1),
    /does not grant write access/,
  );
});

test("single-sided declarations stay pending and related KV is not recursive", async () => {
  const targetKV = createMemoryNamespace();
  const relatedProjects = createWorkflowRelatedProjectsContext(
    createDeclaredWorkflowRelatedProjectKVResolver({
      getConsumerProject: () => ({
        projectId: CONSUMER_ID,
        projectInfo: createProjectInfo([
          createRelation("inventory", TARGET_ID, { mode: "all" }, { mode: "none" }),
        ]),
      }),
      getTargetProject: () => ({
        projectId: TARGET_ID,
        projectInfo: createProjectInfo([]),
        kv: targetKV,
      }),
    }),
  );

  const target = relatedProjects.get("inventory");
  assert.equal("relatedProjects" in target.kv, false);
  await assert.rejects(
    () => target.kv.getValue("catalog:item"),
    /unavailable or awaiting confirmation/,
  );
  assert.throws(() => relatedProjects.get("Invalid Alias"), /alias is invalid/);
});

test("local and server related-project resolvers stay isolated", async () => {
  const projectInfo = createProjectInfo([
    createRelation("inventory", TARGET_ID, { mode: "all" }, { mode: "none" }),
  ]);
  const targetInfo = createProjectInfo([
    createRelation("consumer", CONSUMER_ID, { mode: "all" }, { mode: "all" }),
  ]);
  const localKV = createMemoryNamespace({ value: "local" });
  const serverKV = createMemoryNamespace({ value: "server" });
  const createResolver = (kv: WorkflowKVNamespace) =>
    createDeclaredWorkflowRelatedProjectKVResolver({
      getConsumerProject: () => ({ projectId: CONSUMER_ID, projectInfo }),
      getTargetProject: () => ({ projectId: TARGET_ID, projectInfo: targetInfo, kv }),
    });
  const local = createWorkflowRelatedProjectsContext(createResolver(localKV));
  const server = createWorkflowRelatedProjectsContext(createResolver(serverKV));

  assert.equal(await local.get("inventory").kv.getValue("value"), "local");
  assert.equal(await server.get("inventory").kv.getValue("value"), "server");
  await local.get("inventory").kv.setValue("value", "local-updated");
  assert.equal(await serverKV.getValue("value"), "server");
});

/** A relation whose grant is written out in full, knowledge and entrypoints included. */
function createGrantedRelation(
  alias: string,
  projectId: string,
  grantToRelatedProject: WorkflowProjectInfo["relatedProjects"][number]["grantToRelatedProject"],
): WorkflowProjectInfo["relatedProjects"][number] {
  return { alias, projectId, grantToRelatedProject };
}

interface RelatedProjectFixture {
  grant: WorkflowProjectInfo["relatedProjects"][number]["grantToRelatedProject"];
  persistentValue?: WorkflowKVNamespace;
  runner?: {
    listEntrypoints(): Promise<Array<{ id: string }>>;
    run(entrypointId: string, args: readonly string[]): Promise<unknown>;
  };
}

/**
 * The consumer asking for `database`, and the target's answer to it, wired the
 * way a host wires them: the resolver hands Core the target's stores and, when
 * it can reach the target project at all, a way to run it.
 */
function createKnowledgeFixture(fixture: RelatedProjectFixture) {
  return createWorkflowRelatedProjectsContext(
    createDeclaredWorkflowRelatedProjectKVResolver({
      getConsumerProject: () => ({
        projectId: CONSUMER_ID,
        projectInfo: createProjectInfo([
          createRelation("database", TARGET_ID, { mode: "none" }, { mode: "none" }),
        ]),
      }),
      getTargetProject: () => ({
        projectId: TARGET_ID,
        projectInfo: createProjectInfo([
          createGrantedRelation("consumer", CONSUMER_ID, fixture.grant),
        ]),
        kv: createMemoryNamespace(),
        ...(fixture.persistentValue === undefined ? {} : { persistentValue: fixture.persistentValue }),
        ...(fixture.runner === undefined ? {} : { runner: fixture.runner }),
      }),
    }),
  ).get("database");
}

/** A persistent-value namespace that can also take a namespace lock, as a local store does. */
function createLockingNamespace(initial: Record<string, unknown> = {}): WorkflowKVNamespace {
  const namespace = createMemoryNamespace(initial);
  return {
    ...namespace,
    async withLock<T>(operation: () => Promise<T> | T): Promise<T> {
      return operation();
    },
  };
}

test("a granted knowledge scope reads and writes the target's documents", async () => {
  const target = createLockingNamespace();
  const database = createKnowledgeFixture({
    grant: {
      read: { mode: "none" },
      write: { mode: "none" },
      knowledge: { read: { mode: "all" }, write: { mode: "all" } },
    },
    persistentValue: target,
  });

  const created = await database.knowledge.createDocument({
    title: "Runbook",
    markdown: "# Runbook\n\nRestart the collector.",
  });
  assert.equal((await database.knowledge.getDocument(created.id))?.title, "Runbook");
  assert.deepEqual(
    (await database.knowledge.listDocuments()).items.map((item) => item.id),
    [created.id],
  );
  assert.equal((await database.knowledge.searchDocuments({ query: "collector" })).matches.length, 1);

  await database.knowledge.editDocument({ id: created.id, markdown: "# Runbook\n\nRestart it twice." });
  assert.match((await database.knowledge.getDocument(created.id))?.markdown ?? "", /twice/);
  assert.deepEqual(await database.knowledge.deleteDocument(created.id), { id: created.id, deleted: true });
});

test("a knowledge scope nobody granted stays closed", async () => {
  const database = createKnowledgeFixture({
    grant: { read: { mode: "all" }, write: { mode: "all" } },
    persistentValue: createLockingNamespace(),
  });

  // The KV grant next to it says nothing about the knowledge base.
  await assert.rejects(
    () => database.knowledge.listDocuments(),
    /does not share its knowledge base/,
  );
});

test("a knowledge prefix opens the documents it names and says which key refused the rest", async () => {
  const target = createLockingNamespace();
  await createKnowledgeDocument({ persistentValue: target }, {
    id: "assistant-memory-1",
    title: "Memory",
    markdown: "- likes tea",
  });
  await createKnowledgeDocument({ persistentValue: target }, {
    id: "payroll",
    title: "Payroll",
    markdown: "- secret",
  });
  const database = createKnowledgeFixture({
    grant: {
      read: { mode: "none" },
      write: { mode: "none" },
      knowledge: {
        read: { mode: "prefixes", prefixes: ["knowledge.document.assistant-"] },
        write: { mode: "none" },
      },
    },
    persistentValue: target,
  });

  assert.equal((await database.knowledge.getDocument("assistant-memory-1"))?.title, "Memory");
  await assert.rejects(
    () => database.knowledge.getDocument("payroll"),
    /does not grant read access to this knowledge document/,
  );
  // Every document shares one index key, so listing needs a rule that covers
  // it — the refusal names that key rather than the prefix.
  await assert.rejects(
    () => database.knowledge.listDocuments(),
    /does not grant read access to this knowledge document/,
  );
});

test("the knowledge scope mutates through whatever the target's store offers", async () => {
  const grant: RelatedProjectFixture["grant"] = {
    read: { mode: "none" },
    write: { mode: "none" },
    knowledge: { read: { mode: "all" }, write: { mode: "all" } },
  };
  // A store that can only take a namespace lock.
  const locks: string[] = [];
  const lockingStore: WorkflowKVNamespace = {
    ...createMemoryNamespace(),
    async withLock<T>(operation: () => Promise<T> | T): Promise<T> {
      locks.push("lock");
      return operation();
    },
  };
  await createKnowledgeFixture({ grant, persistentValue: lockingStore })
    .knowledge.createDocument({ title: "Locked", markdown: "x" });
  assert.deepEqual(locks, ["lock"]);

  // A store that can only run a namespace mutation. The sentinel proves which
  // of the two routes the helper took.
  const mutationRoute = new Error("mutation route");
  const mutatingStore: WorkflowKVNamespace = {
    ...createMemoryNamespace(),
    async executeMutation<T>(): Promise<T> {
      throw mutationRoute;
    },
  };
  await assert.rejects(
    () => createKnowledgeFixture({ grant, persistentValue: mutatingStore })
      .knowledge.createDocument({ title: "Mutated", markdown: "x" }),
    (error: Error) => error === mutationRoute,
  );

  // Neither: the helper's own refusal, rather than a view claiming a route the
  // target does not have.
  await assert.rejects(
    () => createKnowledgeFixture({ grant, persistentValue: createMemoryNamespace() })
      .knowledge.createDocument({ title: "Bare", markdown: "x" }),
    /require an atomic PersistentValue namespace lock or mutation executor/,
  );
});

test("the mutation route checks the document key before the store runs the mutation", async () => {
  // The index the mutation rewrites is covered, the document is not: a store
  // that executes the mutation itself never runs the per-key checks, so the
  // view has to make them on the keys the mutation names, before handing over.
  const grant: RelatedProjectFixture["grant"] = {
    read: { mode: "none" },
    write: { mode: "none" },
    knowledge: {
      read: { mode: "prefixes", prefixes: ["knowledge.documents"] },
      write: { mode: "prefixes", prefixes: ["knowledge.documents"] },
    },
  };
  const handedOver: WorkflowKVNamespaceMutation[] = [];
  const mutatingStore: WorkflowKVNamespace = {
    ...createMemoryNamespace(),
    async executeMutation<T>(mutation: WorkflowKVNamespaceMutation): Promise<T> {
      handedOver.push(mutation);
      throw new Error("the store ran an unchecked mutation");
    },
  };
  const database = createKnowledgeFixture({ grant, persistentValue: mutatingStore });

  await assert.rejects(
    () => database.knowledge.createDocument({ id: "payroll", title: "Payroll", markdown: "x" }),
    /does not grant write access to this knowledge document/,
  );
  assert.deepEqual(handedOver, []);
});

test("entrypoint calls are listed and run through the target's grant", async () => {
  const calls: Array<{ id: string; input: unknown }> = [];
  const database = createKnowledgeFixture({
    grant: {
      read: { mode: "none" },
      write: { mode: "none" },
      entrypoints: { mode: "prefixes", prefixes: ["kb_"] },
    },
    runner: {
      listEntrypoints: async () => [{ id: "kb_search" }, { id: "kv_get" }, { id: "admin_reset" }],
      run: async (entrypointId, args) => {
        calls.push({ id: entrypointId, input: args });
        return { ok: true };
      },
    },
  });

  assert.deepEqual(
    (await database.listEntrypoints()).map((entrypoint) => entrypoint.id),
    ["kb_search"],
    "the list is what the grant covers, not what the target happens to expose",
  );
  assert.deepEqual(await database.runEntrypoint("kb_search", ["--query", "tea"]), { ok: true });
  assert.deepEqual(calls, [{ id: "kb_search", input: ["--query", "tea"] }]);
  await assert.rejects(
    () => database.runEntrypoint("admin_reset", []),
    /does not grant this project access to entrypoint "admin_reset"/,
  );
  await assert.rejects(() => database.runEntrypoint("  ", []), /must be a non-empty string/);
});

test("a host that cannot reach the target's knowledge or entrypoints says so", async () => {
  const database = createKnowledgeFixture({
    grant: {
      read: { mode: "none" },
      write: { mode: "none" },
      knowledge: { read: { mode: "all" }, write: { mode: "all" } },
      entrypoints: { mode: "all" },
    },
  });

  await assert.rejects(
    () => database.knowledge.listDocuments(),
    /knowledge base cannot be reached from here/,
  );
  await assert.rejects(() => database.listEntrypoints(), /cannot be run from here/);
  await assert.rejects(() => database.runEntrypoint("kb_search", []), /cannot be run from here/);
});

function createProjectInfo(
  relatedProjects: WorkflowProjectInfo["relatedProjects"],
): WorkflowProjectInfo {
  return {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" },
    dataStorage: { mode: "both" },
    relatedProjects,
  };
}

function createRelation(
  alias: string,
  projectId: string,
  read: WorkflowProjectKVAccessRule,
  write: WorkflowProjectKVAccessRule,
): WorkflowProjectInfo["relatedProjects"][number] {
  return {
    alias,
    projectId,
    grantToRelatedProject: { read, write },
  };
}

function createMemoryNamespace(initial: Record<string, unknown> = {}): WorkflowKVNamespace {
  const values = new Map(Object.entries(initial));
  return {
    async getValue(key) {
      return values.get(key);
    },
    async setValue(key, value) {
      values.set(key, value);
    },
    async deleteValue(key) {
      return values.delete(key);
    },
    async updateValue(key, updater) {
      const value = updater(values.get(key));
      values.set(key, value);
      return value;
    },
  };
}
