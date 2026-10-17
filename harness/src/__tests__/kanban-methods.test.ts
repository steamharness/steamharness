import assert from "node:assert/strict";
import test from "node:test";
import { runKanbanMethodsAction, readKanbanMethodsBridgeConfig, KANBAN_METHODS_CAPABILITY } from "../agent/capabilities/kanban-methods";
import { createWorkflowCapabilityTools, listWorkflowCapabilityToolIds } from "../agent/capabilities/index";
import type { NodeContext } from "../types/context";

const config = { url: "http://127.0.0.1:12345/host", token: "test-token" };
const env = { STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL: config.url, STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN: config.token };

test("Kanban capability requires an explicitly enabled authenticated loopback host", () => {
  assert.equal(readKanbanMethodsBridgeConfig(env), undefined);
  assert.deepEqual(readKanbanMethodsBridgeConfig({ ...env, STEAMHARNESS_DEVELOPER_ASSISTANT_KANBAN_METHODS_ENABLED: "1" }), config);
  assert.throws(() => readKanbanMethodsBridgeConfig({ ...env,
    STEAMHARNESS_DEVELOPER_ASSISTANT_KANBAN_METHODS_ENABLED: "1", STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL: "https://example.com/host" }), /loopback/);
  assert.equal(KANBAN_METHODS_CAPABILITY.toolId, "steamharness-kanban_kanban_methods");
});

test("Kanban methods discovery and invocation preserve explicit instance and native JSON", async () => {
  const calls: Array<{ body: unknown; signal: AbortSignal }> = [];
  const fetchImpl = (async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer test-token");
    const body = JSON.parse(init!.body as string);
    calls.push({ body, signal: init!.signal as AbortSignal });
    return Response.json({ ok: true, value: body.operation.endsWith("list") ? { instances: [{ instanceId: "card-one" }] } : { focused: "军营" } });
  }) as typeof fetch;
  await runKanbanMethodsAction({ action: "list" }, config, fetchImpl);
  const controller = new AbortController();
  assert.deepEqual(await runKanbanMethodsAction({ action: "invoke", instanceId: "card-one", configurationId: "profile-one", method: "map.focus", args: { name: "军营" } }, config, fetchImpl, controller.signal), { focused: "军营" });
  assert.deepEqual(calls.map((call) => call.body), [
    { operation: "kanban.methods.list", input: {} },
    { operation: "kanban.methods.invoke", input: { instanceId: "card-one", configurationId: "profile-one", method: "map.focus", args: { name: "军营" } } },
  ]);
  controller.abort();
  assert.equal(calls[1]!.signal.aborted, true);
});

test("malformed calls never reach the host and host method errors are returned", async () => {
  let count = 0;
  const fetchImpl = (async () => { count += 1; return Response.json({ ok: false, error: { code: "KANBAN_METHOD_STALE", message: "Configuration changed" } }, { status: 409 }); }) as typeof fetch;
  for (const args of [
    { action: "invoke", instanceId: "card", method: "map.focus", args: {} },
    { action: "list", instanceId: "card" },
    { action: "invoke", instanceId: "card", configurationId: "one", method: "eval()", args: {} },
    { action: "invoke", instanceId: "card", configurationId: "one", method: "map.focus", args: { x: Infinity } },
  ]) await assert.rejects(() => runKanbanMethodsAction(args as never, config, fetchImpl));
  assert.equal(count, 0);
  await assert.rejects(() => runKanbanMethodsAction({ action: "list" }, config, fetchImpl), { code: "KANBAN_METHOD_STALE", message: "Configuration changed" });
  assert.equal(count, 1);
});

test("the Agent offers the enabled Kanban capability and asks approval before sending a call", async () => {
  const enabled = { ...env, STEAMHARNESS_DEVELOPER_ASSISTANT_KANBAN_METHODS_ENABLED: "1" };
  const previous = Object.fromEntries(Object.keys(enabled).map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  Object.assign(process.env, enabled);
  globalThis.fetch = (async () => { requests += 1; return Response.json({ ok: true, value: { instances: [] } }); }) as typeof fetch;
  try {
    assert.ok(listWorkflowCapabilityToolIds().includes(KANBAN_METHODS_CAPABILITY.toolId));
    const tools = await createWorkflowCapabilityTools({ context: {} as NodeContext,
      approve: async (toolId) => { assert.equal(toolId, KANBAN_METHODS_CAPABILITY.toolId); throw new Error("approval denied"); } });
    const tool = tools.find((item) => item.name === KANBAN_METHODS_CAPABILITY.toolId)!;
    await assert.rejects(() => tool.execute("call", { action: "list" }), /approval denied/);
    assert.equal(requests, 0);
    const approved = await createWorkflowCapabilityTools({ context: {} as NodeContext, approve: async () => {} });
    const result = await approved.find((item) => item.name === KANBAN_METHODS_CAPABILITY.toolId)!.execute("call", { action: "list" });
    assert.equal(requests, 1);
    assert.match(JSON.stringify(result.content), /instances/);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
