import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage, type StorageWrite, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import * as ai from "@earendil-works/pi-ai";
import { DurableAgent } from "../agent/durable-agent";
import { createServerAgentStorage, ServerAgentStorage, RuntimeStorageError, type RuntimeStorageOperation, type ServerAgentStorageOptions } from "../runtime-storage/index";

const context = BACKGROUND_CONTEXT;
const assertions = {
  ok: (value: unknown, message?: string) => assert.ok(value, message),
  strictEqual: (actual: unknown, expected: unknown) => assert.strictEqual(actual, expected),
  deepEqual: (actual: unknown, expected: unknown) => assert.deepEqual(actual, expected),
  partialDeepEqual: (actual: unknown, expected: unknown) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual: number, expected: number) => assert.ok(actual > expected),
  rejects: async (operation: Promise<unknown>, message: string) => { await assert.rejects(operation, error => error instanceof Error && error.message.includes(message)); },
};

function referenceService() {
  const memory = new MemoryStorage();
  const committed = new Map<string, unknown>();
  const received: RuntimeStorageOperation[] = [];
  let lostResponse: RuntimeStorageOperation["kind"] | undefined;
  let releaseCount = 0;
  let renewFailure = false;
  let leaseMs = 30_000;
  const lease = () => ({ sessionId: randomUUID(), fence: 1, expiresAt: new Date(Date.now() + leaseMs).toISOString(), durationMs: leaseMs });
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-only-token");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(_url).endsWith("/workspaces")) return response({ id: randomUUID(), ...body });
    if (String(_url).endsWith("/sessions/open")) return response(lease());
    const op = body.operation as RuntimeStorageOperation;
    received.push(op);
    let result: unknown;
    try {
      if (op.kind === "renew") {
        if (renewFailure) return new Response(JSON.stringify({ errCode: 409, errMessage: "Lease lost", data: { code: "RUNTIME_STORAGE_LEASE_LOST" } }), { status: 409 });
        return response(lease());
      }
      if (op.kind === "release") { releaseCount++; return response(null); }
      const requestId = op.kind === "commit" || op.kind === "mintId" ? op.requestId : undefined;
      if (requestId && committed.has(requestId)) return response(committed.get(requestId));
      switch (op.kind) {
        case "commit": result = await memory.commit(op.writes, context); break;
        case "mintId": result = await memory.mintId(); break;
        case "conversation": result = await memory.conversation(op.id as ConversationId, context); break;
        case "task": result = await memory.task(op.id as Parameters<Storage["task"]>[0], context); break;
        case "submission": result = await memory.submission(op.id as Parameters<Storage["submission"]>[0], context); break;
        case "entry": result = op.conversationId === undefined ? await memory.entry(op.id as EntryId, context) : await memory.entry(op.conversationId as ConversationId, op.id as EntryId, context); break;
        case "head": result = await memory.findLatestHeadMarker(op.conversationId as ConversationId, op.atOrBeforeEntryId as EntryId | undefined, context); break;
        case "conversations": result = await memory.scanConversations(op.query, op.limit, op.cursor, context); break;
        case "entries": result = await memory.scanEntries(op.query, op.limit, op.cursor, context); break;
        case "tasks": result = await memory.scanTasks(op.query, op.limit, op.cursor, context); break;
        case "submissions": result = await memory.scanSubmissions(op.query, op.limit, op.cursor, context); break;
        case "submissionByRequest": result = await memory.submissionByRequest(op.conversationId as ConversationId, op.requestId, context); break;
        case "findDocument": result = await memory.findDocument(op.address, op.at, context); break;
        case "document": result = await memory.document(op.id as Parameters<Storage["document"]>[0], op.at, context); break;
        case "documents": result = await memory.scanDocuments(op.query, op.limit, op.cursor, context); break;
      }
      if (requestId) committed.set(requestId, result);
    } catch (error) {
      return new Response(JSON.stringify({ errCode: 400, errMessage: (error as Error).message, data: { code: "RUNTIME_STORAGE_INVALID_REQUEST" } }), { status: 400 });
    }
    if (lostResponse === op.kind) { lostResponse = undefined; throw new TypeError("Connection closed after commit"); }
    return response(result);
  };
  const options = (): ServerAgentStorageOptions => ({ serverUrl: "http://127.0.0.1:18126", token: "test-only-token", sessionKey: randomUUID(),
    workspace: { kind: "local", projectId: randomUUID(), entryId: "agent", localKey: randomUUID() }, fetch: fetcher, retryDelayMs: 0 });
  return { memory, received, options, dropNext: (kind: RuntimeStorageOperation["kind"]) => { lostResponse = kind; },
    releases: () => releaseCount, failRenew: () => { renewFailure = true; }, setLease: (duration: number) => { leaseMs = duration; } };
}
function response(data: unknown): Response {
  return new Response(JSON.stringify({ errCode: 0, errMessage: "", data: data ?? null }), { headers: { "Content-Type": "application/json" } });
}

for (const item of createStorageConformance({ assertions, withStorage: async use => {
  const service = referenceService();
  const opened = await createServerAgentStorage(service.options()).open();
  try { await use(opened.storage); } finally { await opened.storage.close(context); await opened.release?.(); }
} })) test(`runtime HTTP contract: ${item.name}`, item.run);

const liveServer = process.env.STEAMHARNESS_TEST_RUNTIME_SERVER_URL;
const liveToken = process.env.STEAMHARNESS_TEST_RUNTIME_TOKEN;
for (const item of createStorageConformance({ assertions, withStorage: async use => {
  const storage = await ServerAgentStorage.open({ serverUrl: liveServer!, token: liveToken!, sessionKey: randomUUID(),
    workspace: { kind: "local", projectId: randomUUID(), entryId: "agent", localKey: randomUUID() } });
  try { await use(storage); } finally { await storage.close(context); }
} })) test(`PostgreSQL HTTP conformance: ${item.name}`, { skip: !(liveServer && liveToken), timeout: 120_000 }, item.run);

test("lost commit and ID responses reuse operation IDs without duplicate writes or reservations", async () => {
  const service = referenceService(), storage = await ServerAgentStorage.open(service.options());
  try {
    service.dropNext("mintId");
    const id = await storage.mintId<EntryId>();
    assert.equal(id, 2);
    service.dropNext("commit");
    await storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }, { type: "entry", value: { id, conversationId: 1 as ConversationId, kind: "message" } }], context);
    assert.equal((await storage.scanEntries({ conversationId: 1 as ConversationId }, 10, undefined, context)).items.length, 1);
    assert.equal(await storage.mintId(), 3);
    for (const kind of ["mintId", "commit"] as const) {
      const operations = service.received.filter((op): op is Extract<RuntimeStorageOperation, { requestId: string }> => op.kind === kind);
      assert.equal(operations[0].requestId, operations[1].requestId);
    }
  } finally { await storage.close(); }
});

test("writes are serialized before a caller can mutate their input", async () => {
  const service = referenceService(), storage = await ServerAgentStorage.open(service.options());
  try {
    const writes: StorageWrite[] = [{ type: "conversation", value: { id: 1 as ConversationId } }];
    const commit = storage.commit(writes, context);
    writes.length = 0;
    await commit;
    assert.deepEqual(await storage.conversation(1 as ConversationId, context), { id: 1 });
  } finally { await storage.close(); }
});

test("close drains admitted operations before releasing its lease", async () => {
  const service = referenceService();
  let releaseRead!: () => void;
  const gate = new Promise<void>(resolve => { releaseRead = resolve; });
  const options = service.options();
  const fetcher = options.fetch!;
  options.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.operation?.kind === "conversation") await gate;
    return fetcher(url, init);
  };
  const storage = await ServerAgentStorage.open(options);
  const read = storage.conversation(1 as ConversationId, context);
  const close = storage.close();
  assert.equal(service.releases(), 0);
  releaseRead(); await read; await close;
  assert.equal(service.releases(), 1);
  await assert.rejects(storage.mintId(), /closed/);
});

test("lease renewal loss fences subsequent operations", async () => {
  const service = referenceService(); service.setLease(300);
  const storage = await ServerAgentStorage.open(service.options());
  try {
    service.failRenew();
    await new Promise(resolve => setTimeout(resolve, 350));
    await assert.rejects(storage.mintId(), error => error instanceof RuntimeStorageError && error.code === "RUNTIME_STORAGE_LEASE_LOST");
  } finally { await storage.close(); }
});

test("cancelled contexts send no request and invalid origins never receive credentials", async () => {
  const service = referenceService(), storage = await ServerAgentStorage.open(service.options());
  try {
    const cancellation = new AbortController(); cancellation.abort(new Error("test cancellation"));
    await assert.rejects(storage.conversation(1 as ConversationId, withAbortSignal(cancellation.signal, context)), /test cancellation/);
    assert.equal(service.received.length, 0);
    await assert.rejects(ServerAgentStorage.open({ ...service.options(), serverUrl: "https://user:password@example.test" }), /without credentials/);
  } finally { await storage.close(); }
});

test("authentication failures are surfaced without connection retries", async () => {
  let calls = 0;
  const options = referenceService().options();
  options.fetch = async () => { calls++; return new Response(JSON.stringify({ errCode: 401, errMessage: "Unauthorized." }), { status: 401 }); };
  await assert.rejects(ServerAgentStorage.open(options), error => error instanceof RuntimeStorageError && error.code === "RUNTIME_STORAGE_ACCESS_DENIED");
  assert.equal(calls, 1);
});

test("DurableAgent reopens PostgreSQL history without replaying a completed tool", { skip: !(liveServer && liveToken), timeout: 30_000 }, async () => {
  const options: ServerAgentStorageOptions = { serverUrl: liveServer!, token: liveToken!, sessionKey: randomUUID(),
    workspace: { kind: "local", projectId: randomUUID(), entryId: "agent", localKey: randomUUID() } };
  let toolCalls = 0;
  const agent = () => {
    const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 100 }] });
    const models = ai.createModels(); models.setProvider(faux.provider);
    const instance = new DurableAgent({ models, storage: createServerAgentStorage(options), retryDelayMs: 0, initialState: {
      systemPrompt: "Test", model: models.getModel("faux", "test")!, thinkingLevel: "off", messages: [],
      tools: [{ name: "inspect", label: "Inspect", description: "Test", parameters: ai.Type.Object({}),
        execute: async () => { toolCalls++; return { content: [ai.fauxText("Inspected")], details: {} }; } }],
    } });
    return { instance, faux };
  };
  const first = agent();
  first.faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" }), ai.fauxAssistantMessage("First committed answer")]);
  try { await first.instance.prompt("Inspect once"); assert.equal(first.instance.state.errorMessage, undefined); }
  finally { await first.instance.close(); }
  const second = agent();
  second.faux.setResponses([ai.fauxAssistantMessage("Second committed answer")]);
  try {
    await second.instance.prompt("Continue after reopening");
    assert.equal(second.instance.state.errorMessage, undefined);
    assert.equal(toolCalls, 1);
    assert.ok(second.instance.state.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "First committed answer")));
  } finally { await second.instance.close(); }
});
