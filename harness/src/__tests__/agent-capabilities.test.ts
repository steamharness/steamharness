import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GLOBAL_MEMORY_CAPABILITY,
  GLOBAL_MEMORY_MCP_TOOL_ID,
  HOST_CONFIGURATION_CAPABILITY,
  HOST_CONFIGURATION_MCP_TOOL_ID,
  KNOWLEDGE_CAPABILITY,
  KNOWLEDGE_MCP_TOOL_ID,
  KV_CAPABILITY,
  KV_MCP_TOOL_ID,
  PRESENTATION_CARD_MCP_TOOL_ID,
  WORKFLOW_CAPABILITIES,
  createWorkflowCapabilityServer,
  createWorkflowCapabilityTools,
  findWorkflowCapability,
  isWorkflowCapabilityAvailable,
  listWorkflowCapabilityToolIds,
  readHostConfigurationBridgeConfig,
  runHostConfigurationAction,
  runWorkflowCapabilityAction,
  selectWorkflowStorage,
} from "../agent/capabilities/index";
import {
  createWorkflowKVContext,
  createWorkflowPersistentValueContext,
  createWorkflowRelatedProjectsContext,
  type WorkflowKVStore,
  type WorkflowStorageLocationContext,
} from "../index";
import type { NodeContext } from "../types/context";

const BRIDGE_URL_ENV = "WORKFLOW_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "WORKFLOW_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN";

test("capabilities use local storage by default and permit explicit server storage", () => {
  const base = createContext();
  const context = { storage: { local: base.storage.local, server: { ...base.storage.server } } };

  assert.equal(selectWorkflowStorage(context), context.storage.local);

  assert.equal(selectWorkflowStorage(context, "server"), context.storage.server);
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

test("host configuration is only reachable when the host brought a bridge", async () => {
  const previousUrl = process.env[BRIDGE_URL_ENV];
  const previousToken = process.env[BRIDGE_TOKEN_ENV];
  delete process.env[BRIDGE_URL_ENV];
  delete process.env[BRIDGE_TOKEN_ENV];

  try {
    assert.equal(readHostConfigurationBridgeConfig(), undefined);
    await assert.rejects(
      () => runWorkflowCapabilityAction(HOST_CONFIGURATION_MCP_TOOL_ID, createContext(), { action: "get" }),
      /unavailable/u,
    );

    // A bridge that is not an authenticated loopback endpoint is refused
    // rather than dialled — the token would go somewhere it does not belong.
    process.env[BRIDGE_URL_ENV] = "https://example.com/bridge";
    process.env[BRIDGE_TOKEN_ENV] = "token";
    assert.throws(() => readHostConfigurationBridgeConfig(), /authenticated loopback/u);

    process.env[BRIDGE_URL_ENV] = "http://127.0.0.1:4321/bridge";
    assert.deepEqual(readHostConfigurationBridgeConfig(), {
      url: "http://127.0.0.1:4321/bridge",
      token: "token",
    });
  } finally {
    restoreEnv(BRIDGE_URL_ENV, previousUrl);
    restoreEnv(BRIDGE_TOKEN_ENV, previousToken);
  }
});

test("host configuration speaks the bridge protocol and surfaces its refusal", async () => {
  const requests: { url: string; body: unknown; authorization: string | null }[] = [];
  const config = { url: "http://127.0.0.1:4321/bridge", token: "secret" };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as unknown,
      authorization: headers.get("Authorization"),
    });
    return new Response(JSON.stringify({ ok: true, value: { id: "cfg-1" } }), { status: 200 });
  }) as typeof fetch;

  assert.deepEqual(
    await runHostConfigurationAction({ action: "update", configurationName: "Release", values: { tag: "v1" } }, config, fetchImpl),
    { id: "cfg-1" },
  );
  assert.deepEqual(requests, [{
    url: "http://127.0.0.1:4321/bridge",
    body: { operation: "kanban.configuration.update", input: { configurationName: "Release", values: { tag: "v1" } } },
    authorization: "Bearer secret",
  }]);

  const failing = (async () => new Response(JSON.stringify({
    ok: false,
    error: { code: "not_found", message: "No configuration matches." },
  }), { status: 200 })) as typeof fetch;

  await assert.rejects(
    () => runHostConfigurationAction({ action: "get" }, config, failing),
    (error: Error & { code?: string }) => {
      assert.equal(error.message, "No configuration matches.");
      assert.equal(error.code, "not_found");
      return true;
    },
  );
});

test("host configuration checks the shape its schema promises", async () => {
  const config = { url: "http://127.0.0.1:4321/bridge", token: "secret" };
  let called = 0;
  const fetchImpl = (async () => {
    called += 1;
    return new Response(JSON.stringify({ ok: true, value: null }), { status: 200 });
  }) as typeof fetch;

  // Nothing validates arguments on the way in — a client is handed the schema
  // but is not obliged to honour it — so a malformed key would otherwise reach
  // the host bridge and come back in the bridge's vocabulary.
  await assert.rejects(
    () => runHostConfigurationAction({ action: "update", values: { "": "x" } }, config, fetchImpl),
    /keys must be 1-200 characters/u,
  );
  await assert.rejects(
    () => runHostConfigurationAction(
      { action: "update", values: { ["k".repeat(201)]: "x" } },
      config,
      fetchImpl,
    ),
    /keys must be 1-200 characters/u,
  );
  await assert.rejects(
    () => runHostConfigurationAction({ action: "update", values: { tag: { nested: true } } }, config, fetchImpl),
    /strings, finite numbers, booleans, or string arrays/u,
  );
  await assert.rejects(
    () => runHostConfigurationAction({ action: "update", values: { tag: Number.NaN } }, config, fetchImpl),
    /strings, finite numbers, booleans, or string arrays/u,
  );
  assert.equal(called, 0, "a malformed value must not reach the host bridge");

  // The shapes the schema does promise still travel.
  await runHostConfigurationAction(
    { action: "update", values: { tag: "v1", retries: 3, enabled: true, hosts: ["a", "b"] } },
    config,
    fetchImpl,
  );
  assert.equal(called, 1);
});

test("memory is left out of a run the host did not offer it", () => {
  const previousUrl = process.env[BRIDGE_URL_ENV];
  const previousToken = process.env[BRIDGE_TOKEN_ENV];
  delete process.env[BRIDGE_URL_ENV];
  delete process.env[BRIDGE_TOKEN_ENV];

  try {
    // Host configuration is missing from the offer for the same reason memory
    // is: this process has no bridge to reach it through.
    assert.deepEqual(listWorkflowCapabilityToolIds(), [KNOWLEDGE_MCP_TOOL_ID, KV_MCP_TOOL_ID, PRESENTATION_CARD_MCP_TOOL_ID]);
    assert.deepEqual(listWorkflowCapabilityToolIds({ globalMemory: true }), [
      KNOWLEDGE_MCP_TOOL_ID,
      KV_MCP_TOOL_ID,
      GLOBAL_MEMORY_MCP_TOOL_ID,
      PRESENTATION_CARD_MCP_TOOL_ID,
    ]);

    // The catalogue still describes it — it is the environment, not the
    // declaration, that decided.
    assert.equal(WORKFLOW_CAPABILITIES.length, 6);
    assert.equal(isWorkflowCapabilityAvailable(HOST_CONFIGURATION_MCP_TOOL_ID), false);
    assert.equal(isWorkflowCapabilityAvailable(KNOWLEDGE_MCP_TOOL_ID), true);
    assert.equal(isWorkflowCapabilityAvailable(GLOBAL_MEMORY_MCP_TOOL_ID), true);
    assert.equal(findWorkflowCapability(KV_MCP_TOOL_ID), KV_CAPABILITY);
    assert.equal(findWorkflowCapability("nope"), undefined);
    assert.throws(() => isWorkflowCapabilityAvailable("nope"), /Unknown workflow capability/u);

    process.env[BRIDGE_URL_ENV] = "http://127.0.0.1:4321/bridge";
    process.env[BRIDGE_TOKEN_ENV] = "token";
    assert.equal(isWorkflowCapabilityAvailable(HOST_CONFIGURATION_MCP_TOOL_ID), true);
    assert.deepEqual(listWorkflowCapabilityToolIds(), [
      KNOWLEDGE_MCP_TOOL_ID,
      KV_MCP_TOOL_ID,
      HOST_CONFIGURATION_MCP_TOOL_ID,
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
    const tools = await createWorkflowCapabilityTools({ context: createContext() });
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
  const tools = await createWorkflowCapabilityTools({
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
    HOST_CONFIGURATION_MCP_TOOL_ID,
    PRESENTATION_CARD_MCP_TOOL_ID,
  ]);

  const kv = tools[1] as unknown as {
    parameters: { properties: { action: { enum: string[] } } };
    execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
  };
  // The schema is the published one, handed over unchanged.
  assert.deepEqual(kv.parameters.properties.action.enum, ["get", "set"]);

  const result = await kv.execute("call-1", { action: "get", scope: "project", key: "missing" });
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
  const server = await createWorkflowCapabilityServer(KV_MCP_TOOL_ID, {
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
      ["action", "scope", "key"],
    );

    const written = await client.callTool({
      name: "kv_store",
      arguments: { action: "set", scope: "project", key: "k", value: [1, 2, 3] },
    });
    assert.deepEqual(JSON.parse(textOf(written.content)), { action: "set", scope: "project", key: "k", stored: true });

    // A failure travels back as an envelope the client can read, not as a
    // protocol error — the model is the one that has to act on it.
    const rejected = await client.callTool({
      name: "kv_store",
      arguments: { action: "set", scope: "project", key: "k" },
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
  return runWorkflowCapabilityAction(toolId, context, args);
}

function createContext(): NodeContext {
  const store = createMemoryKVStore();
  const location: WorkflowStorageLocationContext = {
    kv: createWorkflowKVContext({ store, projectId: "demo", conversationId: "turn-1" }),
    persistentValue: createWorkflowPersistentValueContext({ store, projectId: "demo" }),
    relatedProjects: createWorkflowRelatedProjectsContext(),
  };
  return { storage: { local: location, server: location } } as unknown as NodeContext;
}

function createMemoryKVStore(): WorkflowKVStore {
  const values = new Map<string, unknown>();
  const key = (input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }) => [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");

  const store: WorkflowKVStore = {
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
