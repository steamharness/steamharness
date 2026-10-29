import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { getUserSettings, parseUserSettings, withUserSettings } from "../user-settings";
import { withProjectConfiguration } from "../configuration";
import { createAgentRuntime } from "../agent/runtime";
import { resolveAgentSystemAIInput } from "../agent/model-resolution";
import { createAgentProjectParamResolver } from "../agent/system-llm";
import { createAgentProjectParams } from "../agent/project";
import { parseProjectParamValues } from "../executor/params";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import type { ConfiguredAgentModel } from "@steamharness/project-configuration";

const third: ConfiguredAgentModel = { id: "custom", name: "Custom", model: "actual-model", source: "third-party", apiKind: "openai-completions", baseUrl: "https://example.test/v1", apiKey: "test-only-user-key" };
const system: ConfiguredAgentModel = { id: "system", name: "Plan", model: "system-model", source: "system", credentialId: "plan-one" };
const input = { errCode: 0, errMessage: "", prompt: "Hello" };
const settings = (models: ConfiguredAgentModel[]) => ({ agent: { permissionPolicy: "auto" as const, models } });

test("user model snapshots validate, copy and freeze nested records and isolate concurrent defaults", async () => {
  const source = settings([{ ...third }]); const parsed = parseUserSettings(source);
  source.agent.models[0]!.name = "Changed";
  assert.equal(parsed.agent.models![0]!.name, "Custom");
  assert.ok(Object.isFrozen(parsed.agent.models)); assert.ok(Object.isFrozen(parsed.agent.models![0]));
  for (const models of [null, {}, [{ ...third, apiKey: "" }], [third, third], [{ ...system, credentialToken: "forbidden" }]]) {
    assert.throws(() => parseUserSettings({ agent: { permissionPolicy: "auto", models } }));
  }
  const defaults = await Promise.all([third, system].map(model => withUserSettings(settings([model]), async () => {
    await new Promise(resolve => setImmediate(resolve)); return getUserSettings().agent.models![0]!.id;
  })));
  assert.deepEqual(defaults, ["custom", "system"]); assert.equal(getUserSettings().agent.models, undefined);
});

test("user-bound model fields preserve inheritance, explicit selections and project source restrictions", async () => {
  const declarations = createAgentProjectParams({ modelSource: "user-settings" });
  const quick = declarations.filter(group => group.kind === "quick");
  assert.deepEqual(quick.slice(0, 2).map(group => ({ id: group.id, summary: group.summary })), [
    { id: "model", summary: ["model"] }, { id: "effort", summary: ["effort"] },
  ]);
  assert.ok(!quick[0]!.fields.some(field => field.name === "effort"));
  const fields = normalizeProjectParamDeclarations(declarations).params;
  const model = fields.find(field => field.name === "model")!;
  assert.deepEqual(model.userSetting, { key: "agent.model", mode: "default" });
  assert.deepEqual(normalizeProjectParamDeclarations(createAgentProjectParams()).params.find(field => field.name === "model")!.userSetting,
    { key: "agent.model", mode: "default" }, "Automatic user models must also expose the user model controls");
  assert.equal(normalizeProjectParamDeclarations(createAgentProjectParams({ modelSource: "project" })).params.find(field => field.name === "model")!.userSetting, undefined);
  await withUserSettings(settings([third, system]), async () => {
    assert.equal(parseProjectParamValues(declarations, []).model, "custom");
    assert.equal(parseProjectParamValues(declarations, ["--model", "system"]).model, "system");
    assert.equal(parseProjectParamValues(declarations, ["--model", "inherit"]).model, "inherit", "A model ID is not a permission inheritance marker");
    const resolver = createAgentProjectParamResolver({ modelSource: "user-settings" });
    const choices = await resolver({ paramValues: { model: "custom" } });
    assert.equal(choices.params?.model?.value, undefined, "Do not persist the displayed default as a project override");
    assert.ok(!JSON.stringify(choices).includes("test-only-user-key"));
    assert.equal((await createAgentProjectParamResolver()({ paramValues: { model: "custom" } })).params?.model?.value, undefined,
      "Automatic user defaults must not become saved concrete overrides");
    await withProjectConfiguration({ id: "restricted", name: "Restricted", revision: 1, values: {}, agentModelPolicy: { allowThirdParty: false } }, async () => {
      assert.equal(parseProjectParamValues(declarations, []).model, "system");
      assert.deepEqual((await resolver({})).params?.model?.resolvedOptions?.map(choice => choice.value), ["system"]);
      await assert.rejects(resolveAgentSystemAIInput({ ...input, model: "custom" }, {}, undefined), /only allows system AI/);
      await assert.rejects(createAgentRuntime({ baseUrl: third.source === "third-party" ? third.baseUrl : "", model: "other" }), /only allows system AI/);
    });
    const selected = await resolveAgentSystemAIInput(input, {}, undefined); assert.equal(selected.input.model, "actual-model");
    const developer = await resolveAgentSystemAIInput(input, { baseUrl: "https://developer.test", apiKey: "developer-key" }, undefined);
    assert.deepEqual(developer.input, input, "Explicit developer endpoints keep their existing resolution path");
    await withProjectConfiguration({ id: "old", name: "Old", revision: 1, values: { STEAMHARNESS_AGENT_MODELS: [{ ...third, model: "legacy-model" }] } }, async () => {
      const legacy = await resolveAgentSystemAIInput(input, { modelSource: "project" }, undefined);
      assert.equal(legacy.input.model, "legacy-model");
      const user = await resolveAgentSystemAIInput(input, { modelSource: "user-settings" }, undefined);
      assert.equal(user.input.model, "legacy-model", "Project supplements supply their own default alongside user models");
    });
  });
  await assert.rejects(resolveAgentSystemAIInput(input, { modelSource: "user-settings" }, undefined), /user settings/);
  await withProjectConfiguration({ id: "restricted", name: "Restricted", revision: 1, values: {}, agentModelPolicy: { allowThirdParty: false } }, async () => {
    for (const modelSource of [undefined, "project", "user-settings"] as const) {
      await assert.rejects(createAgentRuntime({ modelSource, baseUrl: "https://custom.test", apiKey: "test-only-key", model: "custom" }), /only allows system AI/);
    }
  });
});

test("host model catalogues may exceed 100 built-ins while custom models and global IDs remain validated", async () => {
  const builtins = Array.from({ length: 150 }, (_, index) => ({ ...system, id: `system-${index}`, model: `model-${index}` }));
  const snapshot = parseUserSettings(settings([...builtins, third]));
  assert.equal(snapshot.agent.models!.length, 151);
  await withUserSettings(snapshot, async () => {
    const resolved = await createAgentProjectParamResolver({ modelSource: "user-settings" })({});
    assert.equal(resolved.params?.model?.resolvedOptions?.length, 151);
  });
  const customs = Array.from({ length: 101 }, (_, index) => ({ ...third, id: `custom-${index}` }));
  assert.throws(() => parseUserSettings(settings([...builtins, ...customs])), /100 custom/);
  assert.throws(() => parseUserSettings(settings([...builtins, { ...third, id: builtins[120]!.id }])), /unique/);
});

test("user system models recheck subscription identity and model availability without falling back", async () => {
  const originalFetch = globalThis.fetch;
  const names = ['STEAMHARNESS_AI_SERVER_URL', 'STEAMHARNESS_AI_API_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.STEAMHARNESS_AI_SERVER_URL = 'https://user-catalog.example.test'; process.env.STEAMHARNESS_AI_API_KEY = 'test-account-token';
  let available = true;
  globalThis.fetch = async () => Response.json({ errCode: 0, errMessage: "", data: { fetchedAt: new Date().toISOString(), credentials: available ? [{
    id: system.source === 'system' ? system.credentialId : '', name: 'Plan', platform: 'fixture', providerType: 'openai-responses', models: [system.model],
    proxyPath: '/api/ai/proxy', credentialToken: 'temporary-test-token', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }] : [] } });
  try {
    await withUserSettings(settings([system]), async () => {
      const resolved = await resolveAgentSystemAIInput(input, {}, undefined);
      try { assert.equal(resolved.input.model, system.model); assert.ok(resolved.input.baseUrl?.startsWith('http://127.0.0.1:')); }
      finally { await resolved.close(); }
      const runtime = await createAgentRuntime({ modelSource: "user-settings", tools: [] });
      try {
        await assert.rejects(async () => {
          for await (const _event of runtime.run({ ...input, compact: true, webSearch: true, modelAttributes: { webSearch: true } })) { /* drain */ }
        }, /does not support/, "Cached connections must retain the system catalogue's search restriction");
      } finally { await runtime.close(); }
      available = false;
      await assert.rejects(resolveAgentSystemAIInput(input, {}, undefined), /unavailable|no available server AI credentials/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});

test("direct Agent runtime runs without connection parameters and keeps its original host snapshot", async t => {
  const requests: { model: string; key?: string; tools: string[] }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ model: body.model, key: request.headers.authorization,
      tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: ' + JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "User configured answer" }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const configured = { ...third, baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const runtime = await withUserSettings({ agent: { permissionPolicy: "read-only", models: [configured] } },
    () => createAgentRuntime({ permissionPolicy: "inherit", modelAttributes: { contextWindow: 16_000 } }));
  t.after(() => runtime.close());
  const events: unknown[] = [];
  await withUserSettings(settings([{ ...configured, apiKey: "new-key" }]), async () => {
    for await (const event of runtime.run(input)) events.push(event);
    assert.equal(runtime.getContextUsage()?.total, 16_000, "Cached third-party models retain developer model attributes");
    for await (const event of runtime.run({ ...input, permissionPolicy: "auto" })) events.push(event);
  });
  assert.ok(JSON.stringify(events).includes("User configured answer"));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, third.model);
    assert.equal(request.key, "Bearer test-only-user-key");
  }
  assert.ok(!requests[0]!.tools.includes("write"), "Inherited permissions use the same snapshot as the model");
  assert.ok(requests[1]!.tools.includes("write"), "An explicit per-run permission still wins");
  const legacy = await withUserSettings(settings([{ ...configured, model: "not-the-project-model" }]), () => withProjectConfiguration({
    id: "legacy", name: "Legacy", revision: 1,
    values: { STEAMHARNESS_AGENT_MODELS: [{ ...configured, model: "project-model", apiKey: "test-project-key" }] },
  }, () => createAgentRuntime({ modelSource: "project", tools: [] })));
  t.after(() => legacy.close());
  for await (const _event of legacy.run(input)) { /* Exercise the actual project connection. */ }
  assert.equal(requests[2]?.model, "project-model");
  assert.equal(requests[2]?.key, "Bearer test-project-key");
});
