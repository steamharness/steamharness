import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  connectMcpServer,
  createMcpTools,
  normalizeMcpServers,
  readInheritedMcpEnvironment,
  toAgentToolContent,
  type McpServerConnection,
} from "../agent/mcp/index";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const INHERITED_KEY = "MCP_TEST_INHERITED";

function createEchoDefinition() {
  return {
    id: "echo",
    command: [process.execPath, FIXTURE],
    timeout: 20_000,
  };
}

test("server definitions are validated before anything is spawned", () => {
  assert.deepEqual(normalizeMcpServers(undefined), []);
  assert.deepEqual(normalizeMcpServers([]), []);

  // A relative command would resolve against whatever the host's cwd happens
  // to be, which is not a decision a project gets to make.
  assert.throws(
    () => normalizeMcpServers([{ id: "x", command: ["node", "server.js"] }]),
    /command must be absolute/u,
  );
  assert.throws(() => normalizeMcpServers([{ id: "Bad Id", command: [process.execPath] }]), /id is invalid/u);
  assert.throws(
    () => normalizeMcpServers([
      { id: "a", command: [process.execPath] },
      { id: "a", command: [process.execPath] },
    ]),
    /duplicated/u,
  );
  assert.throws(() => normalizeMcpServers([{ id: "a", command: [process.execPath], timeout: 10 }]), /timeout is invalid/u);
});

test("a capability must be inherited by name, never written into the config", () => {
  const options = { allowedInheritedEnvKeys: [INHERITED_KEY] };

  // Writing the value into the environment would put a live capability into a
  // configuration that may be logged or committed.
  assert.throws(
    () => normalizeMcpServers(
      [{ id: "echo", command: [process.execPath], environment: { [INHERITED_KEY]: "secret" } }],
      options,
    ),
    /inherit sensitive environment key/u,
  );

  const [normalized] = normalizeMcpServers(
    [{ id: "echo", command: [process.execPath], inheritEnvironment: [INHERITED_KEY] }],
    options,
  );
  assert.deepEqual(normalized?.inheritEnvironment, [INHERITED_KEY]);

  // A key the host did not allow is refused outright.
  assert.throws(
    () => normalizeMcpServers([{ id: "echo", command: [process.execPath], inheritEnvironment: ["HOME"] }], options),
    /inherited environment is invalid/u,
  );
  assert.throws(
    () => readInheritedMcpEnvironment({ id: "echo", command: [], inheritEnvironment: ["HOME"] }, { HOME: "/tmp" }, []),
    /may not inherit/u,
  );
  assert.deepEqual(
    readInheritedMcpEnvironment(
      { id: "echo", command: [], inheritEnvironment: [INHERITED_KEY] },
      { [INHERITED_KEY]: "value" },
      [INHERITED_KEY],
    ),
    { [INHERITED_KEY]: "value" },
  );
});

test("MCP content maps onto what the agent SDK understands", () => {
  assert.deepEqual(toAgentToolContent("plain"), [{ type: "text", text: "plain" }]);
  assert.deepEqual(toAgentToolContent(undefined), []);
  assert.deepEqual(
    toAgentToolContent([
      { type: "text", text: "hi" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      // Anything the SDK does not model is rendered rather than dropped, so the
      // model still sees that something came back.
      { type: "resource", resource: { uri: "file:///x" } },
    ]),
    [
      { type: "text", text: "hi" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ type: "resource", resource: { uri: "file:///x" } }) },
    ],
  );
});

test("tools are named for the host catalogue and report failures by throwing", async () => {
  const approvals: string[] = [];
  const connection: McpServerConnection = {
    id: "workflow-desktop",
    tools: [
      { name: "desktop_state", description: "Read state.", inputSchema: { type: "object" } },
      { name: "manage_update", inputSchema: { type: "object" } },
    ],
    async callTool(name) {
      return name === "manage_update"
        ? { content: [{ type: "text", text: "denied upstream" }], isError: true }
        : { content: [{ type: "text", text: "ok" }], isError: false };
    },
    async close() {},
  };

  const tools = await createMcpTools({
    // The adapter only ever wraps the schema; a passthrough stands in for
    // TypeBox's Unsafe.
    Type: { Unsafe: (schema: unknown) => schema } as never,
    connection,
    approve: async (toolId) => {
      approvals.push(toolId);
    },
  });

  // The declared catalogue names exactly these ids, so the host's permission
  // panel keeps granting the tool it thinks it is granting.
  assert.deepEqual(tools.map((tool) => tool.name), ["workflow-desktop_desktop_state", "workflow-desktop_manage_update"]);

  const read = tools[0] as unknown as { execute(id: string, params: unknown): Promise<unknown> };
  await read.execute("call-1", {});
  assert.deepEqual(approvals, ["workflow-desktop_desktop_state"]);

  const update = tools[1] as unknown as { execute(id: string, params: unknown): Promise<unknown> };
  await assert.rejects(() => update.execute("call-2", {}), /denied upstream/u);
});

test("a schema no runtime could take is refused, not registered", async () => {
  let deep: Record<string, unknown> = { type: "object" };
  for (let index = 0; index < 200; index += 1) {
    deep = { type: "object", properties: { nested: deep } };
  }

  const connection: McpServerConnection = {
    id: "hostile",
    tools: [
      { name: "deep", inputSchema: deep },
      { name: "missing", inputSchema: undefined as unknown as Record<string, unknown> },
    ],
    async callTool() {
      return { content: [], isError: false };
    },
    async close() {},
  };

  const Type = { Unsafe: (schema: unknown) => schema } as never;
  // Both would otherwise be handed to the agent SDK as-is: the deep one blows
  // the stack while the tool is being registered, before any turn can fail.
  await assert.rejects(
    () => createMcpTools({ Type, connection, createToolId: (_server, name) => name }),
    /nested \d+ levels deep/u,
  );

  await assert.rejects(
    () => createMcpTools({
      Type,
      connection: { ...connection, tools: [{ name: "missing", inputSchema: undefined as never }] },
      createToolId: (_server, name) => name,
    }),
    /not an object/u,
  );
});

test("a real stdio MCP server is connected, listed and called", async () => {
  const connection = await connectMcpServer(createEchoDefinition());

  try {
    assert.equal(connection.id, "echo");
    assert.deepEqual(
      connection.tools.map((tool) => tool.name).sort(),
      ["echo", "fail", "inherited"],
    );
    // The schema travels through untouched, so the model sees the real shape.
    assert.deepEqual(connection.tools.find((tool) => tool.name === "echo")?.inputSchema, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });

    const echoed = await connection.callTool("echo", { text: "hi" });
    assert.equal(echoed.isError, false);
    assert.deepEqual(echoed.content, [{ type: "text", text: "echo:hi" }]);

    // A tool that fails upstream reports it instead of pretending to succeed.
    const failed = await connection.callTool("fail", {});
    assert.equal(failed.isError, true);

    await assert.rejects(() => connection.callTool("nope", {}), /does not expose tool/u);
  } finally {
    await connection.close();
  }
});

test("a caller with no SDK to hand still gets usable tools", async () => {
  const connection: McpServerConnection = {
    id: "echo",
    tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    async callTool() {
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    async close() {},
  };

  // A project cannot import the agent SDK — it travels inside Core's `dist` —
  // so leaving `Type` out has to work, not throw.
  const [tool] = await createMcpTools({ connection });
  assert.equal(tool?.name, "echo_echo");
  assert.deepEqual(
    (tool as unknown as { parameters: unknown }).parameters,
    { type: "object", properties: { text: { type: "string" } } },
  );
});

test("a server whose tool listing never ends is stopped rather than obeyed", async () => {
  const loopFixture = fileURLToPath(new URL("./fixtures/mcp-loop-server.mjs", import.meta.url));

  // The server decides when a listing ends. One that says "there is more"
  // forever would otherwise keep the client — and the process — there until
  // the per-request timeout fires, over and over.
  await assert.rejects(
    () => connectMcpServer({ id: "loop", command: [process.execPath, loopFixture], timeout: 20_000 }),
    /repeated a tool-listing cursor/u,
  );

  // An empty cursor is what a careful server uses for the same thing as no
  // cursor at all, and it means the listing is over.
  const connection = await connectMcpServer({
    id: "loop",
    command: [process.execPath, loopFixture, "empty"],
    timeout: 20_000,
  });
  try {
    assert.deepEqual(connection.tools.map((tool) => tool.name), ["ping"]);
  } finally {
    await connection.close();
  }
});

test("an inherited capability reaches the child by name", async () => {
  const definition = createEchoDefinition();
  const connection = await connectMcpServer(
    { ...definition, inheritEnvironment: [INHERITED_KEY] },
    { allowedInheritedEnvKeys: [INHERITED_KEY], env: { [INHERITED_KEY]: "through" } },
  );

  try {
    const result = await connection.callTool("inherited", {});
    assert.deepEqual(result.content, [{ type: "text", text: "through" }]);
  } finally {
    await connection.close();
  }
});
