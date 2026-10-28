import { createTestResources } from "./entry-test-resources";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GLOBAL_MEMORY_CAPABILITY,
  GLOBAL_MEMORY_MCP_TOOL_ID,
  KNOWLEDGE_CAPABILITY,
  KNOWLEDGE_MCP_TOOL_ID,
  KV_CAPABILITY,
  KV_MCP_TOOL_ID,
  PRESENTATION_CARD_MCP_TOOL_ID,
  STEAMHARNESS_CAPABILITIES,
  createProjectCapabilityServer,
  createProjectCapabilityTools,
  findProjectCapability,
  isProjectCapabilityAvailable,
  listProjectCapabilityToolIds,
  readHostConfigurationBridgeConfig,
  runProjectCapabilityAction,
  selectDatabase,
} from "../agent/capabilities/index";
import {
  createProjectKVContext,
  createProjectPersistentValueContext,
  type KVStore,
  type KnowledgeContext,
} from "../index";
import type { NodeContext } from "../types/context";

const BRIDGE_URL_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN";

test("database capabilities require an explicit configured alias", () => {
  const context = createTestResources();
  assert.ok(selectDatabase(context, "data").kv);
  assert.throws(() => selectDatabase(context, ""), /alias/);
  assert.throws(() => selectDatabase(context, "missing"), /not declared for entry/);
});

test("kv stores and reads back through the scope the caller named", async () => {
  const context = createContext();

  assert.deepEqual(await runCapability(KV_MCP_TOOL_ID, context, {
    action: "set",
    scope: "project",
    key: " greeting ",
    value: { hello: "world" },
  }), { action: "set", scope: "project", key: "greeting", stored: true });

  assert.deepEqual(await runCapability(KV_MCP_TOOL_ID, context, {
    action: "get",
    scope: "project",
    key: "greeting",
  }), { action: "get", scope: "project", key: "greeting", found: true, value: { hello: "world" } });

  // The conversation namespace is a different drawer, not the same one.
  assert.deepEqual(await runCapability(KV_MCP_TOOL_ID, context, {
    action: "get",
    scope: "conversation",
    key: "greeting",
  }), { action: "get", scope: "conversation", key: "greeting", found: false });
});

test("kv rejects arguments no schema check would have caught", async () => {
  const context = createContext();

  // Nothing validates the arguments on the way in, so an enum that only ever
  // existed in the published schema has to be caught here.
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, { action: "delete", scope: "project", key: "k" }),
    /action is invalid/u,
  );
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, { action: "get", scope: "global", key: "k" }),
    /scope is invalid/u,
  );
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, { action: "get", scope: "project", key: "  " }),
    /non-empty key/u,
  );
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, { action: "set", scope: "project", key: "k" }),
    /requires value/u,
  );

  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, { action: "set", scope: "project", key: "k", value: circular }),
    /must be JSON serializable/u,
  );
});

test("kv refuses the keys the runtime keeps for itself", async () => {
  const context = createContext();

  // Both namespaces are shared with Core's own bookkeeping, and a model can be
  // talked into writing any key by anything it reads in the workspace.
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, {
      action: "set",
      scope: "project",
      key: "tokenUsage.total",
      value: { totalTokens: 0 },
    }),
    /belongs to the workflow runtime/,
  );
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, {
      action: "set",
      scope: "conversation",
      key: "agent.pendingPlanApproval",
      value: { requestId: "x", plan: "y" },
    }),
    /belongs to the workflow runtime/,
  );
  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, {
      action: "set",
      scope: "conversation",
      key: "conversation.state",
      value: {},
    }),
    /belongs to the workflow runtime/,
  );

  // An ordinary key is still the caller's to write.
  assert.deepEqual(await runCapability(KV_MCP_TOOL_ID, context, {
    action: "set",
    scope: "project",
    key: "notes",
    value: 1,
  }), { action: "set", scope: "project", key: "notes", stored: true });
});

test("a capability enforces the bounds its schema declares", async () => {
  const context = createContext();

  await assert.rejects(
    () => runCapability(KV_MCP_TOOL_ID, context, {
      action: "set",
      scope: "project",
      key: "k".repeat(501),
      value: 1,
    }),
    /at most 500 characters/,
  );
  await assert.rejects(
    () => runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
      action: "create",
      title: "too big",
      markdown: "m".repeat(200_001),
    }),
    /at most 200000 characters/,
  );
  await assert.rejects(
    () => runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
      action: "remember",
      memoryId: "preference",
      title: "too big",
      markdown: "m".repeat(100_001),
    }),
    /at most 100000 characters/,
  );
});

test("a memory cursor says which action it came from", async () => {
  const context = createContext();
  await runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
    action: "remember",
    memoryId: "preference",
    title: "Preference",
    markdown: "prefers short answers",
  });

  const listed = await runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
    action: "list",
    pageSize: 1,
    cursor: "0",
  }) as { memories: unknown[]; hasMore: boolean; nextCursor?: string };
  assert.equal(listed.hasMore, false);
  assert.equal(listed.nextCursor, undefined);

  // `list` counts memories, `search` carries the store's own token; the field
  // is the same, so a cursor from one is refused by the other rather than
  // silently read as an offset.
  await assert.rejects(
    () => runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
      action: "list",
      cursor: "search:abc",
    }),
    /belongs to another action/,
  );
  await assert.rejects(
    () => runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
      action: "search",
      query: "prefers",
      cursor: "list:0",
    }),
    /belongs to another action/,
  );
});

type JsonPage = { paged: true; content: string; resultHash: string; nextOffset?: number; truncated: boolean };

async function collectJsonPages(call: (args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  let args: Record<string, unknown> = {}, content = "", pages = 0;
  do {
    const result = await call(args) as JsonPage;
    assert.equal(result.paged, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 40_000);
    assert.equal(Buffer.from(result.content).toString(), result.content);
    content += result.content; pages++;
    if (!result.truncated) { assert.equal(result.nextOffset, undefined); break; }
    assert.ok(result.nextOffset! > Number(args.resultOffset ?? 0));
    args = { resultOffset: result.nextOffset, resultHash: result.resultHash };
  } while (pages < 100);
  assert.ok(pages > 1);
  return JSON.parse(content);
}

test("large KV values and knowledge lines survive JSON paging in direct and MCP tools", async () => {
  const context = createContext();
  const body = `${'中文😀"\\\u0001'.repeat(8000)}END`;
  await runCapability(KV_MCP_TOOL_ID, context, { action: "set", scope: "project", key: "big", value: { body } });
  const [kv] = (await createProjectCapabilityTools({ context })).filter(tool => tool.name === KV_MCP_TOOL_ID);
  const direct = await collectJsonPages(async args => {
    const result = await kv!.execute("page", { database: "data", action: "get", scope: "project", key: "big", ...args });
    return JSON.parse(textOf(result.content));
  });
  assert.deepEqual((direct as { value: unknown }).value, { body });

  await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, { action: "create", documentId: "big", title: "Big", markdown: body });
  const server = await createProjectCapabilityServer(KNOWLEDGE_MCP_TOOL_ID, { context });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "paging", version: "1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const recovered = await collectJsonPages(async args => {
      const result = await client.callTool({ name: "knowledge_documents",
        arguments: { database: "data", action: "read_lines", documentId: "big", startLine: 1, endLine: 1, ...args } });
      assert.notEqual(result.isError, true);
      return JSON.parse(textOf(result.content));
    }) as { lines: { content: string }[] };
    assert.equal(recovered.lines[0]!.content, body);
    const search = await collectJsonPages(args => runCapability(KNOWLEDGE_MCP_TOOL_ID, context,
      { action: "search", query: "END", ...args })) as { matches: { line: string }[] };
    assert.equal(search.matches[0]!.line, body);
  } finally { await client.close(); await server.close(); }
});

test("result paging detects concurrent changes, validates cursors and never repeats a mutation", async () => {
  const context = createContext();
  const get = { action: "get", scope: "project", key: "big" };
  await runCapability(KV_MCP_TOOL_ID, context, { ...get, action: "set", value: "a".repeat(50_000) });
  const first = await runCapability(KV_MCP_TOOL_ID, context, get) as JsonPage;
  await runCapability(KV_MCP_TOOL_ID, context, { ...get, action: "set", value: "b".repeat(50_000) });
  await assert.rejects(() => runCapability(KV_MCP_TOOL_ID, context,
    { ...get, resultOffset: first.nextOffset, resultHash: first.resultHash }), /changed.*Restart/);
  for (const invalid of [{ resultOffset: -1 }, { resultOffset: 1.5 }, { resultOffset: 1 }, { resultLimit: 0 }, { resultHash: "bad" }]) {
    await assert.rejects(() => runCapability(KV_MCP_TOOL_ID, context, { ...get, ...invalid }), /resultOffset|resultLimit|resultHash/);
  }
  await assert.rejects(() => runCapability(KV_MCP_TOOL_ID, context,
    { ...get, action: "set", value: "must not be written", resultOffset: 0 }), /only available for read actions/);
  const stored = await collectJsonPages(args => runCapability(KV_MCP_TOOL_ID, context, { ...get, ...args })) as { value: string };
  assert.equal(stored.value, "b".repeat(50_000));
});

test("memory and document writes return bounded acknowledgements and can be fully read afterward", async () => {
  const context = createContext();
  const markdown = `START${'中文😀"\\\u0001'.repeat(8000)}END`;
  const written = await runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context,
    { action: "remember", memoryId: "big", title: "Big", markdown }) as { memory: { markdownTruncated: boolean } };
  assert.ok(Buffer.byteLength(JSON.stringify(written)) <= 40_000);
  assert.equal(written.memory.markdownTruncated, true);
  const read = await collectJsonPages(args => runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context,
    { action: "get", memoryId: "big", ...args })) as { memory: { markdown: string } };
  assert.equal(read.memory.markdown, markdown);
  const created = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context,
    { action: "create", documentId: "big-doc", title: "Big doc", markdown, includeMarkdown: true, maxMarkdownLength: 20_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(created)) <= 40_000);
  for (const pageSize of [0, -1, 1.5, 101, Number.NaN]) {
    await assert.rejects(() => runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, { action: "list", pageSize }), /pageSize/);
  }
  for (const maxMarkdownLength of [-1, 1.5, 20_001, "100"]) {
    await assert.rejects(() => runCapability(KNOWLEDGE_MCP_TOOL_ID, context,
      { action: "edit", documentId: "big-doc", markdown: "must not write", maxMarkdownLength }), /maxMarkdownLength/);
  }
});

test("knowledge documents are managed through one tool", async () => {
  const context = createContext();

  assert.deepEqual(await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, { action: "list" }), {
    action: "list",
    count: 0,
    documents: [],
  });

  const created = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "create",
    documentId: "guide",
    title: "Guide",
    markdown: "# Guide\n\nFirst line.\nSecond line.",
  }) as { action: string; document: { id: string; title: string; lineCount: number } };
  assert.equal(created.action, "create");
  assert.equal(created.document.id, "guide");
  assert.equal(created.document.lineCount, 4);

  // `get` includes the body by default and `create` does not: reading is the
  // common case, and an echoed create would double the token cost of a write.
  const got = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "get",
    documentId: "guide",
  }) as { document: { markdown?: string } };
  assert.equal(got.document.markdown, "# Guide\n\nFirst line.\nSecond line.");

  const searched = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "search",
    query: "First",
  }) as { matches: unknown[] };
  assert.equal(searched.matches.length, 1);

  const lines = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "read_lines",
    documentId: "guide",
    startLine: 3,
    endLine: 3,
  }) as { lines: { content: string }[] };
  assert.deepEqual(lines.lines.map((line) => line.content), ["First line."]);

  assert.deepEqual(await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "delete",
    documentId: "guide",
  }), { action: "delete", id: "guide", deleted: true });
});

test("knowledge reports a missing field as a validation failure, not a crash", async () => {
  const context = createContext();

  await assert.rejects(
    () => runCapability(KNOWLEDGE_MCP_TOOL_ID, context, { action: "get" }),
    /requires documentId/u,
  );
  await assert.rejects(
    () => runCapability(KNOWLEDGE_MCP_TOOL_ID, context, { action: "frobnicate" }),
    /action is invalid/u,
  );
});

test("global memory lives in the knowledge store under a reserved prefix", async () => {
  const context = createContext();

  const remembered = await runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
    action: "remember",
    memoryId: "Release-Cadence",
    title: "Release cadence",
    markdown: "Ships on Thursdays.",
  }) as { action: string; memory: { memoryId: string; id?: string; title: string } };
  assert.equal(remembered.action, "remember");
  assert.equal(remembered.memory.memoryId, "release-cadence");
  assert.equal(remembered.memory.id, undefined);

  const listed = await runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, { action: "list" }) as {
    memories: { memoryId: string }[];
    hasMore: boolean;
  };
  assert.deepEqual(listed.memories.map((memory) => memory.memoryId), ["release-cadence"]);
  assert.equal(listed.hasMore, false);

  const fetched = await runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
    action: "get",
    memoryId: "release-cadence",
  }) as { found: boolean };
  assert.equal(fetched.found, true);

  assert.deepEqual(await runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
    action: "forget",
    memoryId: "release-cadence",
  }), { action: "forget", memoryId: "release-cadence", id: "assistant-memory-release-cadence", deleted: true });
});

test("global memory refuses what looks like a credential", async () => {
  const context = createContext();

  await assert.rejects(
    () => runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
      action: "remember",
      memoryId: "leak",
      title: "Token",
      markdown: `token = ${"ghp_" + "a".repeat(24) + "01"}`,
    }),
    /looks like a credential or secret/u,
  );
  await assert.rejects(
    () => runCapability(GLOBAL_MEMORY_MCP_TOOL_ID, context, {
      action: "remember",
      memoryId: "Not Valid",
      title: "T",
      markdown: "body",
    }),
    /lowercase letters/u,
  );
});

test("memory is left out of a run the host did not offer it", () => {
  const previousUrl = process.env[BRIDGE_URL_ENV];
  const previousToken = process.env[BRIDGE_TOKEN_ENV];
  delete process.env[BRIDGE_URL_ENV];
  delete process.env[BRIDGE_TOKEN_ENV];

  try {
    // Host configuration is missing from the offer for the same reason memory
    // is: this process has no bridge to reach it through.
    assert.deepEqual(listProjectCapabilityToolIds(), [KNOWLEDGE_MCP_TOOL_ID, KV_MCP_TOOL_ID, PRESENTATION_CARD_MCP_TOOL_ID]);
    assert.deepEqual(listProjectCapabilityToolIds({ globalMemory: true }), [
      KNOWLEDGE_MCP_TOOL_ID,
      KV_MCP_TOOL_ID,
      GLOBAL_MEMORY_MCP_TOOL_ID,
      PRESENTATION_CARD_MCP_TOOL_ID,
    ]);

    // The catalogue still describes it — it is the environment, not the
    // declaration, that decided.
    assert.equal(STEAMHARNESS_CAPABILITIES.length, 5);
    assert.equal(isProjectCapabilityAvailable(KNOWLEDGE_MCP_TOOL_ID), true);
    assert.equal(isProjectCapabilityAvailable(GLOBAL_MEMORY_MCP_TOOL_ID), true);
    assert.equal(findProjectCapability(KV_MCP_TOOL_ID), KV_CAPABILITY);
    assert.equal(findProjectCapability("nope"), undefined);
    assert.throws(() => isProjectCapabilityAvailable("nope"), /Unknown workflow capability/u);

    process.env[BRIDGE_URL_ENV] = "http://127.0.0.1:4321/bridge";
    process.env[BRIDGE_TOKEN_ENV] = "token";
    assert.deepEqual(listProjectCapabilityToolIds(), [
      KNOWLEDGE_MCP_TOOL_ID,
      KV_MCP_TOOL_ID,
          PRESENTATION_CARD_MCP_TOOL_ID,
    ]);
  } finally {
    restoreEnv(BRIDGE_URL_ENV, previousUrl);
    restoreEnv(BRIDGE_TOKEN_ENV, previousToken);
  }
});

test("an unavailable capability is not put in front of the model", async () => {
  const previousUrl = process.env[BRIDGE_URL_ENV];
  const previousToken = process.env[BRIDGE_TOKEN_ENV];
  delete process.env[BRIDGE_URL_ENV];
  delete process.env[BRIDGE_TOKEN_ENV];

  try {
    const tools = await createProjectCapabilityTools({ context: createContext() });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [KNOWLEDGE_MCP_TOOL_ID, KV_MCP_TOOL_ID, PRESENTATION_CARD_MCP_TOOL_ID],
      "a tool whose every call would fail is worse than no tool",
    );
  } finally {
    restoreEnv(BRIDGE_URL_ENV, previousUrl);
    restoreEnv(BRIDGE_TOKEN_ENV, previousToken);
  }
});

test("the agent rendering gates, approves and reports like a tool should", async () => {
  const previousUrl = process.env[BRIDGE_URL_ENV];
  const previousToken = process.env[BRIDGE_TOKEN_ENV];
  // A host that brought its bridge gets all five; availability is covered on
  // its own below.
  process.env[BRIDGE_URL_ENV] = "http://127.0.0.1:4321/bridge";
  process.env[BRIDGE_TOKEN_ENV] = "token";

  const context = createContext();
  const approvals: string[] = [];
  const tools = await createProjectCapabilityTools({
    context,
    globalMemory: true,
    approve: async (toolId) => {
      approvals.push(toolId);
    },
  }).finally(() => {
    restoreEnv(BRIDGE_URL_ENV, previousUrl);
    restoreEnv(BRIDGE_TOKEN_ENV, previousToken);
  });

  assert.deepEqual(tools.map((tool) => tool.name), [
    KNOWLEDGE_MCP_TOOL_ID,
    KV_MCP_TOOL_ID,
    GLOBAL_MEMORY_MCP_TOOL_ID,
      PRESENTATION_CARD_MCP_TOOL_ID,
  ]);

  const kv = tools[1] as unknown as {
    parameters: { properties: { action: { enum: string[] } } };
    execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
  };
  // The schema is the published one, handed over unchanged.
  assert.deepEqual(kv.parameters.properties.action.enum, ["get", "set"]);

  const result = await kv.execute("call-1", { database:"data", action: "get", scope: "project", key: "missing" });
  assert.deepEqual(approvals, [KV_MCP_TOOL_ID]);
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    action: "get",
    scope: "project",
    key: "missing",
    found: false,
  });
});

test("the MCP rendering publishes the same tool and answers the same way", async () => {
  const context = createContext();
  const approvals: string[] = [];
  const server = await createProjectCapabilityServer(KV_MCP_TOOL_ID, {
    context,
    approve: async (toolId) => {
      approvals.push(toolId);
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0]?.name, "kv_store");
    assert.equal(listed.tools[0]?.title, "Workflow KV store");
    assert.deepEqual(
      (listed.tools[0]?.inputSchema as { required?: string[] }).required,
      ["database", "action", "scope", "key"],
    );

    const written = await client.callTool({
      name: "kv_store",
      arguments: { database:"data", action: "set", scope: "project", key: "k", value: [1, 2, 3] },
    });
    assert.deepEqual(JSON.parse(textOf(written.content)), { action: "set", scope: "project", key: "k", stored: true });

    // A failure travels back as an envelope the client can read, not as a
    // protocol error — the model is the one that has to act on it.
    const rejected = await client.callTool({
      name: "kv_store",
      arguments: { database:"data", action: "set", scope: "project", key: "k" },
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(JSON.parse(textOf(rejected.content)), {
      action: "set",
      errCode: 1,
      errMessage: 'kv_store action "set" requires value.',
    });

    const unknown = await client.callTool({ name: "nope", arguments: {} });
    assert.equal(unknown.isError, true);

    assert.deepEqual(approvals, [KV_MCP_TOOL_ID, KV_MCP_TOOL_ID]);
  } finally {
    await client.close();
    await server.close();
  }
});

function textOf(content: unknown): string {
  const [block] = content as { type: string; text: string }[];
  return block!.text;
}

function runCapability(
  toolId: string,
  context: NodeContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  return runProjectCapabilityAction(toolId, context, {database:"data",...args});
}

function createContext(): NodeContext {
  const store = createMemoryKVStore();
  return createTestResources(store) as unknown as NodeContext;
}

function createMemoryKVStore(): KVStore {
  const values = new Map<string, unknown>();
  const key = (input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }) => [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");

  const store: KVStore = {
    getValue: async (input) => values.get(key(input)),
    setValue: async (input) => {
      values.set(key(input), input.value);
    },
    deleteValue: async (input) => values.delete(key(input)),
    updateValue: async (input, updater) => {
      const next = updater(values.get(key(input)));
      values.set(key(input), next);
      return next;
    },
    withNamespaceLock: async (_input, operation) => operation(),
  };

  return store;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
