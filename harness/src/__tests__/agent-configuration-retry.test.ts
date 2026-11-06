import assert from "node:assert/strict";
import test from "node:test";
import { ProjectConfigurationError } from "../configuration";
import { retryAgentConfigurationAccess } from "../agent/provider-retry";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { projectEntryKey } from "@steamharness/project-manifest";
import { withProjectConfiguration } from "../configuration";
import { configurationFixtureStore, declareConfigurationFixture, writeConfigurationFixtureManifest } from "./configuration-fixture";
import { DurableAgent } from "../agent/durable-agent";
import type { AgentSessionSnapshot } from "../agent/session-types";

const unavailable = () => new ProjectConfigurationError("This run configuration is not available to this account.", "CONFIGURATION_FORBIDDEN");

test("run configuration access is rechecked before continuing, with a bounded retry budget", async () => {
  let checks = 0;
  const retries: number[] = [];
  await retryAgentConfigurationAccess(async () => { if (++checks < 4) throw unavailable(); }, {
    delayMs: 0, onRetry: async attempt => { retries.push(attempt); },
  });
  assert.equal(checks, 4); assert.deepEqual(retries, [1, 2, 3]);
  checks = 0;
  const denial = unavailable();
  await assert.rejects(retryAgentConfigurationAccess(async () => { checks++; throw denial; }, { delayMs: 0 }), error => error === denial);
  assert.equal(checks, 11, "An unchanged denial must never allow execution or retry forever");
});

test("configuration retries stop during backoff and leave unrelated failures alone", async () => {
  const abort = new AbortController();
  let checks = 0;
  const waiting = retryAgentConfigurationAccess(async () => { checks++; throw unavailable(); }, {
    signal: abort.signal, delayMs: 8000, onRetry: async () => { abort.abort(); },
  });
  await assert.rejects(waiting, /abort/i); assert.equal(checks, 1);
  const hostError = new Error("storage unavailable");
  await assert.rejects(retryAgentConfigurationAccess(async () => { throw hostError; }, { delayMs: 0 }), error => error === hostError);
  const invalid = new ProjectConfigurationError("Invalid configuration");
  await assert.rejects(retryAgentConfigurationAccess(async () => { throw invalid; }, { delayMs: 0 }), error => error === invalid);
});

for (const boundary of ["request", "tool"] as const) test(`durable ${boundary} retries a temporarily unavailable run configuration before executing`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-configuration-retry-"));
  const id = randomUUID(), token = randomUUID(), origin = "https://configuration-retry.test";
  const subject = JSON.stringify([origin, "alice"]);
  const originalFetch = globalThis.fetch;
  const env = { STEAMHARNESS_SERVER_URL: origin, STEAMHARNESS_SERVER_ADMIN_KEY: token };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    const key = createHash("sha256").update(JSON.stringify([projectEntryKey(id, "main"), subject])).digest("hex");
    const accessKey = createHash("sha256").update(JSON.stringify([origin, token, id])).digest("hex");
    for (const file of [path.join("configurations", `${key}.json`), path.join("configurations", `${key}.json.lock.sqlite`), path.join("configuration-access", `${accessKey}.json`)]) {
      await rm(path.join(homedir(), ".steamharness", file), { force: true });
    }
    await rm(directory, { recursive: true, force: true });
  });
  await declareConfigurationFixture(directory); await writeConfigurationFixtureManifest(directory, id);
  await writeFile(path.join(directory, "configuration.json"), JSON.stringify({ version: 2, fields: [{ name: "mode", type: "string" }],
    profilePolicy: { version: 1, defaultProfileKey: "ask", manageMinimumRole: "developer", profiles: [
      { key: "ask", name: "Ask", minimumRole: "guest", fixedValues: { mode: "ask" } },
      { key: "build", name: "Build", minimumRole: "developer", fixedValues: { mode: "build" } },
    ] } }));
  const store = await configurationFixtureStore(directory, { access: { subject, role: "developer", online: true } });
  const configuration = await store.snapshot({ id: "profile-build" });
  let denials = boundary === "request" ? 2 : 0, tools = 0, recovered = false;
  globalThis.fetch = async input => {
    assert.ok(String(input).startsWith(origin));
    if (String(input).endsWith("/api/auth/me")) return Response.json({ errCode: 0, data: { profile: { userId: "alice" } } });
    const role = denials-- > 0 ? "guest" : "developer";
    if (role === "developer") recovered = true;
    return Response.json({ errCode: 0, data: { access: { effectiveRole: role } } });
  };
  const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    ...(boundary === "tool" ? [() => { denials = 2; return ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" }); }] : []),
    ai.fauxAssistantMessage("Finished after authorization recovered"),
  ]);
  const agent = withProjectConfiguration(configuration, () => new DurableAgent({ models, retryDelayMs: 0,
    session: { compaction: { enabled: false } }, initialState: { systemPrompt: "Test", model: models.getModel("faux", "test")!, thinkingLevel: "off", messages: [], tools: [{
      name: "inspect", label: "Inspect", description: "Inspect once", parameters: ai.Type.Object({}),
      execute: async () => { assert.equal(recovered, true); tools++; return { content: [ai.fauxText("Inspected once")], details: {} }; },
    }] } }), directory, "main");
  t.after(() => agent.close());
  let snapshot: AgentSessionSnapshot | undefined;
  agent.subscribe(event => { if ((event as any).type === "project_session") snapshot = (event as any).snapshot; });
  await agent.prompt("Complete the work");
  assert.equal(agent.state.errorMessage, undefined);
  assert.equal(tools, boundary === "tool" ? 1 : 0);
  assert.equal(faux.state.callCount, boundary === "tool" ? 2 : 1);
  const retries = snapshot!.turns[0]!.items.filter(item => item.metadata?.partType === "retry");
  assert.equal(retries.length, 2);
  assert.match(JSON.stringify(retries), /This run configuration is not available to this account/);
});
