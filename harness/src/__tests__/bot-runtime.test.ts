import assert from "node:assert/strict";
import test from "node:test";
import { defineBot, type BotDefinition } from "../agent/bot";
import { defineProjectExecutor } from "../executor/definition";
import { projectRuntimeApi } from "../runtime-api";
import { createProjectConversationContext } from "../conversation/index";
import { createMemoryRuntimePersistence } from "../runtime-storage/index";
import { createDisabledProjectTokenUsageContext } from "../token-usage/index";
import { createTestResources } from "./entry-test-resources";
import { testConversationStorage } from "./runtime-test-storage";
import type { AgentInput } from "../agent/types";
import type { ExecutorContext } from "../executor/types";
import type { RunContext } from "../types/index";
import { createAgentSessionHost, controlAgentSession } from "../agent/session-control";
import { createProjectToolPermissionContext } from "../tool-permissions/index";
import type { UserInputRequest } from "../types/index";

function context(): RunContext {
  return { ...createTestResources(), config: {}, providers: {}, metadata: { runtimePersistence: createMemoryRuntimePersistence() },
    conversation: createProjectConversationContext({ enabled: true, conversationId: "test", projectName: "bot", storage: testConversationStorage() }),
    tokenUsage: createDisabledProjectTokenUsageContext() };
}
const executorContext = (args = ["--message", "hello"]): ExecutorContext => ({ projectName: "bot", projectDir: ".", args, paramValues: {}, config: {}, abortSignal: new AbortController().signal });
async function model() {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "bot-test", name: "Bot test", reasoning: true, contextWindow: 4096, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  let calls = 0;
  faux.setResponses([() => { calls++; return ai.fauxAssistantMessage([ai.fauxText("completed answer")]); }] as never[]);
  return { models, resolvedModel: models.getModel("faux", "bot-test")!, calls: () => calls };
}

test("public API exposes only defineBot for Bot declarations and rejects arbitrary workflows", () => {
  assert.equal("createAgentConversationProject" in projectRuntimeApi, false);
  assert.equal("defineAgentConversationExecutor" in projectRuntimeApi, false);
  assert.throws(() => defineProjectExecutor({ projectType: "conversation" } as never), /defineBot/);
  assert.throws(() => defineProjectExecutor({ projectType: "bot" } as never), /defineBot/);
  for (const key of ["workflow", "coreAgent", "createInput", "outputItemId", "tokenUsage"]) {
    assert.throws(() => defineBot({ [key]: {} } as BotDefinition), /Unsupported Bot field/);
  }
});

test("prepared input and fixed policy reach tool and session factories", async () => {
  const fake = await model(); const seen: unknown[] = [];
  const bot = defineBot<AgentInput & { topic: string }>({
    agent: { models: fake.models, resolvedModel: fake.resolvedModel, tools: [],
      paramOptions: { fields: { permissionPolicy: { fixedValue: "read-only" } } },
      createTools(_context, input) { seen.push([input.topic, input.permissionPolicy]); return []; },
      createSession(_context, input) { seen.push([input.topic, input.permissionPolicy]); return {}; } },
    prepareInput(input, run) { assert.equal(run.entries.list().length, 1); return { ...input, topic: "business", permissionPolicy: "auto" }; },
  });
  const output = await bot.workflow.run(await bot.createInput(executorContext()), context());
  assert.equal(output.errCode, 0); assert.equal(fake.calls(), 1);
  assert.deepEqual(seen, [["business", "read-only"], ["business", "read-only"]]);
  assert.equal(output.items.find(item => item.id === "agent-answer")?.content, "completed answer");
});

test("Bot resolves image attachments before preparing business input", async () => {
  const fake = await model(); const run = context(); let reads = 0;
  run.files = { async resolveFile() { reads++; return { mimeType: "image/png", async readBase64() { return "aGkh"; } }; } } as unknown as RunContext["files"];
  const bot = defineBot({ agent: { models: fake.models, resolvedModel: fake.resolvedModel, tools: [] },
    prepareInput(input) {
      assert.deepEqual(input.images, [{ mimeType: "image/png", data: "aGkh" }]);
      assert.equal(input.imageFiles, undefined);
      return { ...input, prompt: "Describe this image" };
    },
  });
  const output = await bot.workflow.run({ errCode: 0, errMessage: "", prompt: "", imageFiles: [{
    id: "wf-image", name: "image.png", mimeType: "image/png", size: 3, kind: "image", storage: "local", createdAt: new Date().toISOString(),
  }] }, run);
  assert.equal(output.errCode, 0); assert.equal(reads, 1); assert.equal(fake.calls(), 1);
});

test("completion failure replays the saved answer and retries only the notification", async () => {
  const fake = await model(); const run = context(); let attempts = 0; let prepareCalls = 0;
  const bot = defineBot({ agent: { models: fake.models, resolvedModel: fake.resolvedModel, tools: [] },
    prepareInput(input) { prepareCalls++; return input; },
    onCompleted(result) {
      attempts++; assert.equal(result.requestId, "stable-request");
      assert.throws(() => { (result.output as { prompt: string }).prompt = "changed"; }, TypeError);
      assert.throws(() => { (result.output.items as unknown[]).push({}); }, TypeError);
      if (attempts === 1) throw new Error("business store unavailable");
    },
  });
  const input = { ...await bot.createInput(executorContext()), requestId: "stable-request" };
  await assert.rejects(Promise.resolve(bot.workflow.run(input, run)), error => {
    const failure = error as Error & { metadata?: { phase?: string; agentCompleted?: boolean } };
    assert.match(failure.message, /business store unavailable/);
    return failure.metadata?.phase === "bot_completion" && failure.metadata.agentCompleted === true;
  });
  const output = await bot.workflow.run(input, run);
  assert.equal(output.errCode, 0); assert.equal(attempts, 2); assert.equal(fake.calls(), 1); assert.equal(prepareCalls, 1);
  const restarted = defineBot({ agent: { models: fake.models, resolvedModel: fake.resolvedModel, tools: [] }, onCompleted() { attempts++; } });
  await restarted.workflow.run(input, run);
  assert.equal(attempts, 2); assert.equal(fake.calls(), 1);
});

test("completion hook cannot return replacement output", async () => {
  const fake = await model();
  const bot = defineBot({ agent: { models: fake.models, resolvedModel: fake.resolvedModel, tools: [] },
    onCompleted: (() => ({ items: [] })) as unknown as BotDefinition["onCompleted"] });
  await assert.rejects(Promise.resolve(bot.workflow.run(await bot.createInput(executorContext()), context())), /output replacement is forbidden/);
});

test("a durable owner prepares and completes subsequent requests before it closes", { timeout: 10_000 }, async () => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "multi", name: "Multi", contextWindow: 4096, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const requests: string[] = [];
  faux.setResponses(Array.from({ length: 2 }, () => (request: unknown) => {
    requests.push(JSON.stringify(request)); return ai.fauxAssistantMessage([ai.fauxText("answer")]);
  }) as never[]);
  const run = context(); const scope = run.conversation.conversationId!;
  const prepared: string[] = [], completed: string[] = [];
  let snapshot: import("../agent/session-types").AgentSessionSnapshot | undefined;
  run.nodeHooks = { onNodeChunk(event) {
    const chunk = event.chunk as { item?: { metadata?: { kind?: string }; content?: unknown } };
    if (chunk.item?.metadata?.kind === "agent-session") snapshot = chunk.item.content as typeof snapshot;
  } };
  const bot = defineBot({ agent: { models, resolvedModel: models.getModel("faux", "multi")!, tools: [] },
    prepareInput(input) { prepared.push(input.prompt); return { ...input, prompt: `prepared: ${input.prompt}`, systemPrompt: `policy for ${input.prompt}` }; },
    onCompleted(result) { completed.push(result.requestId); },
  });
  const host = createAgentSessionHost(scope);
  const running = Promise.resolve(bot.workflow.run({ errCode: 0, errMessage: "", prompt: "first", requestId: "first" }, run));
  const until = async (ready: () => boolean) => {
    const limit = Date.now() + 5000;
    while (!ready()) { if (Date.now() > limit) throw new Error("Bot lifecycle did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await until(() => completed.includes("first"));
    await controlAgentSession(scope, { type: "submit", requestId: "second", prompt: "second", mode: "followUp" });
    await until(() => completed.includes("second") && !!snapshot?.records.some(record => (record.data as { requestId?: string })?.requestId === "second"));
    assert.deepEqual(prepared, ["first", "second"]);
    assert.deepEqual(completed, ["first", "second"]);
    assert.match(requests[1]!, /prepared: second/);
    assert.match(requests[1]!, /policy for second/);
    assert.doesNotMatch(JSON.stringify(snapshot), /policy for second/);
  } finally { host.close(); await running; }
  assert.deepEqual(completed, ["first", "second"]);
});

for (const policy of ["automatic", "approve", "reject"] as const) test(`Bot business tools honor ${policy} in Build mode`, async () => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "approval", name: "Approval", contextWindow: 4096, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("business", {})], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("Finished")]),
  ] as never[]);
  let writes = 0, resolved = false; let request: UserInputRequest | undefined;
  const run = context();
  run.userInput = {
    getResolvedInput: async requestId => resolved && request?.requestId === requestId
      ? { requestId, nodeName: request.nodeName, values: { approved: policy === "approve" }, submittedAt: new Date() } : undefined,
    requestInput: async value => { request = value; },
  };
  const tools = [{ name: "business", enabled: true, autoApprove: policy === "automatic", approvalMode: "always" as const }];
  run.toolPermissions = createProjectToolPermissionContext({ definitions: tools, userInput: run.userInput, projectName: "bot", runId: "approval" });
  const bot = defineBot({ tools, agent: { models, resolvedModel: models.getModel("faux", "approval")!, tools: [],
    createTools: () => [{ name: "business", label: "Business", description: "A guarded business operation.",
      parameters: { type: "object", properties: {} },
      async execute() { writes++; return { content: [{ type: "text" as const, text: "Saved" }], details: {} }; } }],
  } });
  const input: AgentInput = { errCode: 0, errMessage: "", prompt: "Run business", agent: "build", requestId: "approval" };
  if (policy !== "automatic") {
    await assert.rejects(Promise.resolve(bot.workflow.run(input, run)), error => (error as { type?: string }).type === "user_input_required");
    assert.ok(request); assert.equal(writes, 0); resolved = true;
  }
  const output = await bot.workflow.run(input, run);
  assert.equal(output.errCode, 0);
  assert.equal(writes, policy === "reject" ? 0 : 1);
});

test("notification failure stays visible in a live owner and reconnect retries without another model call", { timeout: 10_000 }, async () => {
  const fake = await model(), run = context(), scope = run.conversation.conversationId!;
  let visible = false, notified = false;
  run.nodeHooks = { onNodeChunk(event) {
    const chunk = event.chunk as { item?: { metadata?: { kind?: string }; content?: { turns: { items: { metadata?: { phase?: string } }[] }[] } } };
    if (chunk.item?.metadata?.kind === "agent-session") visible ||= !!chunk.item.content?.turns.some(turn => turn.items.some(item => item.metadata?.phase === "bot_completion"));
  } };
  const input: AgentInput = { errCode: 0, errMessage: "", prompt: "Hello", requestId: "notification" };
  const first = defineBot({ agent: { models: fake.models, resolvedModel: fake.resolvedModel, tools: [] }, onCompleted() { throw new Error("Receipt unavailable"); } });
  const host = createAgentSessionHost(scope);
  const running = Promise.resolve(first.workflow.run(input, run)).catch(error => error);
  const until = async (ready: () => boolean) => {
    const limit = Date.now() + 4000;
    while (!ready()) { if (Date.now() > limit) throw new Error("Notification did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try { await until(() => visible); assert.equal(fake.calls(), 1); }
  finally { host.suspend(); await running; }
  const second = defineBot({ agent: { models: fake.models, resolvedModel: fake.resolvedModel, tools: [] }, onCompleted() { notified = true; } });
  const reopened = createAgentSessionHost(scope, { resume: true });
  const resumed = Promise.resolve(second.workflow.run(input, run));
  try { await until(() => notified); assert.equal(fake.calls(), 1); }
  finally { reopened.close(); await resumed; }
});

test("parallel entries with the same conversation and request IDs keep their input and receipts isolated", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "parallel", name: "Parallel", contextWindow: 4096, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  faux.setResponses([ai.fauxAssistantMessage("First"), ai.fauxAssistantMessage("Second")]);
  const inputs: string[] = [], receipts: string[] = [];
  const bot = defineBot<AgentInput & { topic: string }>({
    params: [{ kind: "auxiliary", id: "business", label: "Business", fields: [{ name: "topic", flag: "--topic", type: "string" }] }],
    agent: { models, resolvedModel: models.getModel("faux", "parallel")!, tools: [],
      createTools(_context, input) { inputs.push(input.topic); return []; } },
    async prepareInput(input, context) { await Promise.resolve(); return { ...input, topic: String(context.paramValues.topic) }; },
    onCompleted(_result, context) { receipts.push(context.entryId); },
  });
  await Promise.all(["one", "two"].map(async entryId => {
    const run = { ...context(), projectId: "shared", entryId };
    const input = await bot.createInput({ ...executorContext(), paramValues: { topic: entryId } });
    run.metadata!.runId = "same";
    await bot.workflow.run(input, run);
  }));
  assert.deepEqual(inputs.sort(), ["one", "two"]);
  assert.deepEqual(receipts.sort(), ["one", "two"]);
});
