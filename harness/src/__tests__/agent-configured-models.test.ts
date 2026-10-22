import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { createPiRuntime } from "../agent/pi";
import { defineAgentConversationExecutor } from "../agent/project";
import { AGENT_MODELS_CONFIGURATION_KEY as key, createLocalProjectConfigurationStore, readProjectConfigurationDefinition, withProjectConfiguration } from "../configuration";
import { createAgentProjectParamResolver } from "../agent/system-llm";
import { resolveAgentSystemAIInput } from "../agent/node";

const third = { id: "third", name: "Custom", source: "third-party", model: "actual-model", apiKind: "openai-responses", baseUrl: "http://localhost:1234/v1", apiKey: "test-only-key" };
const system = { id: "system", name: "Subscribed", source: "system", model: "subscribed-model", credentialId: "subscription-a" };
const snapshot = (models: unknown[]) => ({ id: "profile", name: "Default", revision: 1, values: { [key]: models as any } });

test("Agent parameter options come only from the frozen configuration and default to its first model", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Parameter resolution must not load a system catalogue."); };
  try {
    const resolver = createAgentProjectParamResolver();
    const first = await withProjectConfiguration(snapshot([third, system]), () => resolver({}));
    assert.equal(first.params?.model?.value, "third");
    assert.deepEqual(first.params?.model?.resolvedOptions?.map(option => option.value), ["third", "system"]);
    assert.deepEqual(first.params?.provider, { value: null, visible: false, disabled: true, resolvedOptions: [] });
    const selected = await resolver({ config: snapshot([third, system]).values, paramValues: { model: "system" } });
    assert.equal(selected.params?.model?.value, "system");
    const removed = await resolver({ config: snapshot([third]).values, paramValues: { model: "deleted" } });
    assert.equal(removed.params?.model?.value, "third");
    const empty = await resolver({ config: snapshot([]).values });
    assert.deepEqual(empty.params?.model?.resolvedOptions, []); assert.equal(empty.params?.model?.value, null);
  } finally { globalThis.fetch = previousFetch; }
});

test("a configured third-party model reaches its own endpoint without contacting system AI", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Third-party execution must not load system AI."); };
  try {
    const result = await withProjectConfiguration(snapshot([third]), () => resolveAgentSystemAIInput({ errCode: 0, errMessage: "", prompt: "Hello", model: "third" }, {}, undefined));
    assert.deepEqual({ provider: result.input.provider, model: result.input.model, baseUrl: result.input.baseUrl, apiKey: result.input.apiKey, apiKind: result.input.apiKind }, {
      provider: "configured-third", model: "actual-model", baseUrl: third.baseUrl, apiKey: third.apiKey, apiKind: third.apiKind,
    });
    await result.close();
    await assert.rejects(withProjectConfiguration(snapshot([]), () => resolveAgentSystemAIInput({ errCode: 0, errMessage: "", prompt: "Hello" }, {}, undefined)), /Add a model/);
    await assert.rejects(withProjectConfiguration({ ...snapshot([]), values: {} }, () => resolveAgentSystemAIInput({ errCode: 0, errMessage: "", prompt: "Hello" }, {}, undefined)), /Add a model/);
    await assert.rejects(withProjectConfiguration(snapshot([third]), () => resolveAgentSystemAIInput({ errCode: 0, errMessage: "", prompt: "Hello", model: "deleted" }, {}, undefined)), /no longer configured/);
  } finally { globalThis.fetch = previousFetch; }
});

test("static Agent discovery adds the first configuration field without executing a project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-model-configuration-"));
  try {
    await writeFile(path.join(root, "index.ts"), 'throw new Error("must never execute");\nexport const resolver = steamharness.createAgentProjectParamResolver();');
    await mkdir(path.join(root, "__tests__"));
    await writeFile(path.join(root, "configuration.json"), JSON.stringify({ version: 1, fields: [{ name: "title", type: "string" }] }));
    assert.deepEqual(readProjectConfigurationDefinition(root).fields.map(field => field.name), [key, "title"]);
    const store = await createLocalProjectConfigurationStore(root, { rootDir: path.join(root, ".configurations") });
    assert.equal((await store.read()).fields[0]!.control, "ai-models");
    assert.deepEqual((await store.snapshot()).values[key], []);
    await writeFile(path.join(root, "index.ts"), '// createAgentProjectParamResolver() is only a comment.');
    await writeFile(path.join(root, "__tests__", "agent.ts"), 'steamharness.createAgentProjectParamResolver();');
    assert.deepEqual(readProjectConfigurationDefinition(root).fields.map(field => field.name), ["title"]);
    await writeFile(path.join(root, "index.ts"), 'import { createAgentNode as agent } from "steamharness/agent"; const node = agent();');
    assert.equal(readProjectConfigurationDefinition(root).fields[0]!.name, key);
    await writeFile(path.join(root, "index.ts"), 'function createAgentNode() {} createAgentNode();');
    assert.deepEqual(readProjectConfigurationDefinition(root).fields.map(field => field.name), ["title"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("custom Agent parameter declarations do not receive patches for undeclared fields", async () => {
  const executor = defineAgentConversationExecutor({ params: [] });
  assert.deepEqual(await executor.resolveParams!({ args: [], config: snapshot([third]).values } as any), { params: {} });
});

test("a configured third-party completion uses the saved URL, key and real model ID", async t => {
  const requests: { url?: string; key?: string; model: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: request.url, key: request.headers.authorization, model: body.model });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Configured answer' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const configured = { ...third, apiKind: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const resolved = await withProjectConfiguration(snapshot([configured]), () => resolveAgentSystemAIInput({ errCode: 0, errMessage: '', prompt: 'Hello', model: 'third' }, {}, undefined));
  const runtime = await createPiRuntime(resolved.input);
  const result = await runtime.models.streamSimple(runtime.model, { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }, { apiKey: resolved.input.apiKey }).result();
  assert.equal(result.stopReason, 'stop'); assert.ok(JSON.stringify(result.content).includes('Configured answer'));
  assert.deepEqual(requests, [{ url: '/v1/chat/completions', key: `Bearer ${third.apiKey}`, model: third.model }]);
  await resolved.close();
});

test("a system model cannot fall back to another subscription or a removed model", async () => {
  const previousFetch = globalThis.fetch;
  const names = ['STEAMHARNESS_AI_SERVER_URL', 'STEAMHARNESS_AI_API_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.STEAMHARNESS_AI_SERVER_URL = 'https://configured-model-auth.test'; process.env.STEAMHARNESS_AI_API_KEY = 'test-account-token';
  const record = { ...system, id: 'another-subscription', platform: 'test', name: 'Another plan', providerType: 'openai-responses', models: ['subscribed-model'], proxyPath: '/api/ai/proxy', credentialToken: 'temporary-token', expiresAt: new Date(Date.now()+3600000).toISOString() };
  globalThis.fetch = async () => Response.json({ errCode: 0, errMessage: '', data: { credentials: [record], fetchedAt: new Date().toISOString() } });
  try {
    await assert.rejects(withProjectConfiguration(snapshot([system]), () => resolveAgentSystemAIInput({ errCode: 0, errMessage: '', prompt: 'Hello' }, {}, undefined)), /system AI model is unavailable/);
    await assert.rejects(withProjectConfiguration(snapshot([{ ...system, credentialId: record.id, model: 'removed-model' }]), () => resolveAgentSystemAIInput({ errCode: 0, errMessage: '', prompt: 'Hello' }, {}, undefined)), /system AI model is unavailable/);
  } finally { globalThis.fetch = previousFetch; names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); }
});

for (const apiKind of ['openai-responses', 'anthropic-messages'] as const) {
  test(`configured ${apiKind} uses its own protocol path and key without duplicating /v1`, async t => {
    const requests: { url?: string; key?: string; model: string }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: new URL(request.url!, 'http://localhost').pathname, key: request.headers[apiKind === 'anthropic-messages' ? 'x-api-key' : 'authorization'] as string, model: body.model });
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'offline fixture rejection' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const resolved = await withProjectConfiguration(snapshot([{ ...third, apiKind, baseUrl: `http://127.0.0.1:${address.port}/v1` }]), () => resolveAgentSystemAIInput({ errCode: 0, errMessage: '', prompt: 'Hello' }, {}, undefined));
    const runtime = await createPiRuntime(resolved.input);
    const result = await runtime.models.streamSimple(runtime.model, { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }, { apiKey: resolved.input.apiKey }).result();
    assert.equal(result.stopReason, 'error');
    assert.deepEqual(requests, [{ url: apiKind === 'anthropic-messages' ? '/v1/messages' : '/v1/responses', key: apiKind === 'anthropic-messages' ? third.apiKey : `Bearer ${third.apiKey}`, model: third.model }]);
    await resolved.close();
  });
}
