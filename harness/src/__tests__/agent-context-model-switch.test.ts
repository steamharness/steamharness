import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentRuntime } from "../agent/runtime";
import { withUserSettings } from "../user-settings";
import type { AgentStreamEvent } from "../agent/types";

for (const session of [false, true]) {
  test(`switching the default GPT to MiniMax updates context events and durable snapshots (session=${session})`, async t => {
    const requestedModels: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const { model } = JSON.parse(Buffer.concat(chunks).toString());
      requestedModels.push(model);
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "Continue the conversation." }, null], [{}, "stop"]]) {
        response.write(`data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 1,
          model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const models = [
      { id: "gpt", name: "GPT", model: "gpt-test-272k" },
      { id: "minimax", name: "MiniMax-M3.1-Flash", model: "MiniMax-M3.1-Flash" },
    ].map(model => ({ ...model, source: "third-party" as const, apiKind: "openai-completions" as const,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-key" }));
    const runtime = await withUserSettings({ agent: { permissionPolicy: "read-only", models } },
      () => createAgentRuntime({ tools: [], ...(session ? { session: {} } : {}) }));
    t.after(() => runtime.close());
    for (const [model, total] of [[undefined, 272_000], ["minimax", 1_000_000], ["gpt", 272_000]] as const) {
      const events: AgentStreamEvent[] = [];
      for await (const event of runtime.run({ prompt: "Continue", errCode: 0, errMessage: "", ...(model ? { model } : {}) })) events.push(event);
      assert.equal(runtime.getContextUsage()?.total, total);
      const context = events.filter(event => event.type === "context_usage");
      assert.ok(context.length > 0);
      assert.ok(context.every(event => event.usage.total === total), "Every context event must describe the selected model");
      if (session) {
        const snapshot = events.filter(event => event.type === "session").at(-1)?.snapshot;
        assert.ok(snapshot);
        assert.equal(snapshot.contexts.find(scope => scope.conversationId === snapshot.conversationId)?.contextUsage?.total, total);
      }
    }
    assert.deepEqual(requestedModels, ["gpt-test-272k", "MiniMax-M3.1-Flash", "gpt-test-272k"]);
  });
}
