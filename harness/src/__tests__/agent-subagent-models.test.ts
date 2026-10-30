import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { withProjectConfiguration } from "../configuration";
import { withUserSettings } from "../user-settings";
import { createAgentRuntime } from "../agent/runtime";
import type { AgentSessionOptions } from "../agent/session-types";

const session: AgentSessionOptions = { compaction: { enabled: false }, subagents: {
  tools: [], modelConfiguration: "CHILD_MODEL", definitions: [
    { id: "researcher", description: "Research", systemPrompt: "Research only", tools: [] },
  ],
} };

for (const modelSource of ["project", "user-settings"] as const)
for (const selection of ["inherit", "openai-completions", "anthropic-messages"] as const) test(`subagent model selection: ${modelSource} main, ${selection}, named and anonymous work use their own connection`, { timeout: 20000 }, async t => {
  let rootRequests = 0;
  const requests: { child: boolean; model: string; key?: string; anthropicKey?: string | string[]; url?: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const child = body.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("child-request"));
    requests.push({ child, model: body.model, key: request.headers.authorization, anthropicKey: request.headers["x-api-key"], url: request.url });
    response.setHeader("content-type", "text/event-stream");
    if (new URL(request.url!, "http://fixture").pathname.endsWith("/messages")) {
      const events = [
        { type: "message_start", message: { id: "child", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child answer" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ];
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
    }
    const call = child || rootRequests >= 2 ? undefined : rootRequests++ === 0
      ? { action: "spawn", agentId: "researcher", workId: "named", task: "named-child-request", background: false }
      : { task: "anonymous-child-request" };
    response.end(`data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0,
      delta: call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${rootRequests}`, type: "function", function: { name: "subagent", arguments: JSON.stringify(call) } }] }
        : { role: "assistant", content: child ? "Child answer" : "Main answer" }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => {
    server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const models = [
    { id: "main", name: "Main", model: "main-model", source: "third-party", apiKind: "openai-completions", baseUrl: `${origin}/parent/v1`, apiKey: "fixture-parent-key" },
    { id: "child", name: "Child", model: "child-model", source: "third-party", apiKind: selection === "anthropic-messages" ? selection : "openai-completions", baseUrl: `${origin}/child/v1`, apiKey: "fixture-child-key" },
  ];
  await withUserSettings({ agent: { permissionPolicy: "auto", models: [models[0]!] as any } }, () => withProjectConfiguration({ id: "profile", name: "Default", revision: 1, values: { STEAMHARNESS_AGENT_MODELS: models, CHILD_MODEL: selection === "inherit" ? "" : "child" } }, async () => {
    const runtime = await createAgentRuntime({ modelSource, session, permissionPolicy: "auto", tools: [] });
    try {
      const events = []; for await (const event of runtime.run({ errCode: 0, errMessage: "", prompt: "Delegate two tasks" }, { abortSignal: t.signal })) {
        events.push(event);
      }
      assert.ok(JSON.stringify(events).includes("Main answer"));
      assert.ok(!JSON.stringify(events).includes("fixture-child-key"), "Credentials never enter output or task snapshots");
    } finally { await runtime.close(); }
  }));
  assert.equal(requests.filter(request => request.child).length, 2);
  for (const request of requests) {
    const custom = request.child && selection !== "inherit";
    assert.equal(request.model, custom ? "child-model" : "main-model");
    if (selection === "anthropic-messages" && custom) assert.equal(request.anthropicKey, "fixture-child-key");
    else assert.equal(request.key, `Bearer fixture-${custom ? "child" : "parent"}-key`);
    assert.ok(request.url?.startsWith(custom ? "/child/" : "/parent/"));
  }
});

test("invalid, removed and forbidden child models fail explicitly without falling back to the main model", async () => {
  for (const selected of ["removed", 5, ["one", "two"]]) await withProjectConfiguration({ id: "p", name: "Default", revision: 1,
    values: { CHILD_MODEL: selected as any } }, async () => {
    // Injecting the main SDK runtime keeps validation entirely offline.
    const { createPiRuntime } = await import("../agent/pi");
    const pi = await createPiRuntime({ provider: "main", model: "main", baseUrl: "http://127.0.0.1:1/v1" });
    await assert.rejects(createAgentRuntime({ pi, session }), selected === "removed" ? /Add a model|no longer configured/ : /select one model/);
  });
  await withUserSettings({ agent: { permissionPolicy: "auto", models: [] } }, () => withProjectConfiguration({ id: "p", name: "Default", revision: 1,
    agentModelPolicy: { allowThirdParty: false }, values: { CHILD_MODEL: "custom", STEAMHARNESS_AGENT_MODELS: [
      { id: "custom", name: "Custom", model: "custom", source: "third-party", apiKind: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key" },
    ] } }, async () => {
    const { createPiRuntime } = await import("../agent/pi");
    const pi = await createPiRuntime({ provider: "main", model: "main", baseUrl: "http://127.0.0.1:1/v1" });
    await assert.rejects(createAgentRuntime({ pi, session }), /only allows system AI/);
  }));
});
