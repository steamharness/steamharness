import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { withProjectConfiguration } from "../configuration";
import { parseUserSettings, withUserSettings } from "../user-settings";
import { createAgentProjectParamResolver } from "../agent/system-llm";
import { resolveAgentSystemAIInput } from "../agent/model-resolution";
import { createAgentRuntime } from "../agent/runtime";
import { createAgentProjectParams } from "../agent/project-params";
import { parseProjectParamValues } from "../executor/params";
import type { ConfiguredAgentModel } from "@steamharness/project-configuration";

const user: ConfiguredAgentModel = { id: "shared", name: "User model", model: "user-model", source: "third-party", apiKind: "openai-completions", baseUrl: "https://user.example/v1", apiKey: "user-test-key" };
const local = { ...user, name: "Project model", model: "project-model", apiKey: "project-test-key" };
const reference = { id: "reference", name: "Project alias", source: "user-settings", modelId: user.id };
const settings = (model = user) => ({ agent: { permissionPolicy: "auto" as const, models: [model] } });
const snapshot = (models: unknown[]) => ({ id: "profile", name: "Project", revision: 1, values: { STEAMHARNESS_AGENT_MODELS: models as any } });
const input = { errCode: 0, errMessage: "", prompt: "Hello" };

test("parameter defaults, option groups and runtime share the composed project model identity", async () => {
  await withUserSettings(settings(), () => withProjectConfiguration(snapshot([local]), async () => {
    const params = createAgentProjectParams({ modelSource: "user-settings" });
    assert.equal(parseProjectParamValues(params, []).model, "project:shared");
    const choices = await createAgentProjectParamResolver({ modelSource: "user-settings" })({});
    assert.deepEqual(choices.params?.model?.resolvedOptions?.map(model => [model.value, model.group]), [["project:shared", "Project models"], ["shared", "Settings models"]]);
    assert.ok(!JSON.stringify(choices).includes("test-key"));
    for (const [model, actual] of [[undefined, "project-model"], ["project:shared", "project-model"], ["shared", "user-model"]]) {
      const resolved = await resolveAgentSystemAIInput({ ...input, model }, { modelSource: "user-settings" }, undefined);
      assert.equal(resolved.input.model, actual); await resolved.close();
    }
    assert.equal((await resolveAgentSystemAIInput({ ...input, model: "shared" }, { modelSource: "project" }, undefined)).input.model, "project-model");
  }));
  assert.throws(() => parseUserSettings({ agent: { permissionPolicy: "auto", models: [reference] } }), /Invalid/);
});

test("references resolve from the host snapshot, remain unavailable when missing and obey source restrictions", async () => {
  await withUserSettings(settings(), () => withProjectConfiguration(snapshot([reference]), async () => {
    const choices = await createAgentProjectParamResolver({ modelSource: "project" })({});
    assert.deepEqual(choices.params?.model?.resolvedOptions?.map(model => model.value), ["reference"]);
    const resolved = await resolveAgentSystemAIInput(input, { modelSource: "project" }, undefined);
    assert.equal(resolved.input.apiKey, "user-test-key"); assert.equal(resolved.input.model, "user-model"); await resolved.close();
  }));
  await withUserSettings({ agent: { permissionPolicy: "auto", models: [] } }, () => withProjectConfiguration(snapshot([reference, local]), async () => {
    const choices = await createAgentProjectParamResolver()({});
    assert.equal(choices.params?.model?.options?.reference?.disabled, true);
    await assert.rejects(resolveAgentSystemAIInput(input, {}, undefined), /referenced model is unavailable/);
  }));
  await withUserSettings(settings(), () => withProjectConfiguration({ ...snapshot([reference]), agentModelPolicy: { allowThirdParty: false } }, async () => {
    assert.deepEqual((await createAgentProjectParamResolver()({})).params?.model?.resolvedOptions, []);
    await assert.rejects(resolveAgentSystemAIInput({ ...input, model: "reference" }, {}, undefined), /only allows system AI/);
  }));
});

test("composed selections make real offline HTTP requests and preserve model connections for the run", async t => {
  const requests: { model: string; key?: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ model: body.model, key: request.headers.authorization });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.end(event({ role: "assistant", content: "Composed answer" }, null) + event({}, "stop") + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const configured = { ...user, baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const configuration = snapshot([{ ...local, baseUrl: configured.baseUrl }]);
  const runtime = await withUserSettings(settings(configured), () => withProjectConfiguration(configuration, () => createAgentRuntime({ modelSource: "user-settings", tools: [] })));
  try {
    for await (const _event of runtime.run(input)) { /* Project default. */ }
    await withUserSettings(settings({ ...configured, apiKey: "updated-user-key" }), async () => {
      for await (const _event of runtime.run({ ...input, model: "shared" })) { /* Frozen host selection. */ }
    });
  } finally { await runtime.close(); }
  const referenced = await withUserSettings(settings({ ...configured, apiKey: "updated-user-key" }), () => withProjectConfiguration(snapshot([reference]), () => createAgentRuntime({ modelSource: "project", tools: [] })));
  try { for await (const _event of referenced.run(input)) { /* Latest reference on a new execution. */ } }
  finally { await referenced.close(); }
  assert.deepEqual(requests, [
    { model: "project-model", key: "Bearer project-test-key" },
    { model: "user-model", key: "Bearer user-test-key" },
    { model: "user-model", key: "Bearer updated-user-key" },
  ]);
});
