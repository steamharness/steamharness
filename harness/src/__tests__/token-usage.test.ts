import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledWorkflowConversationContext,
  createLLMNode,
  createLLMStreamNode,
  createWorkflowKVContext,
  createWorkflowRelatedProjectsContext,
  createWorkflowTokenUsageContext,
  getLLMProvider,
  runNode,
  runStreamNode,
  TOKEN_USAGE_TOTAL_KEY,
  type LLMProvider,
  type LLMStreamChunk,
  type NodeContext,
  type KVStore,
  type TokenUsageAggregate,
  type TokenUsageContext,
} from "../index";

test("disabled token usage report is a safe no-op", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    conversationId: "conv-1",
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: false },
    kv,
    projectId: "demo",
    runId: "run-1",
    conversationId: "conv-1",
  });

  assert.equal(await tokenUsage.report({ totalTokens: 12 }), undefined);
  assert.equal(await kv.getValue(TOKEN_USAGE_TOTAL_KEY), undefined);
});

test("manual token usage report writes project and conversation totals plus conversation entries", async () => {
  const store = createMemoryKVStore();
  const kv = createWorkflowKVContext({
    store,
    projectId: "demo",
    conversationId: "conv-1",
    source: { projectId: "demo", runId: "run-1", conversationId: "conv-1" },
  });
  const updates: TokenUsageAggregate[] = [];
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-1",
    conversationId: "conv-1",
    onUpdate: (usage) => {
      updates.push(usage);
    },
  });

  const entry = await tokenUsage.report({
    inputTokens: 2,
    outputTokens: 3,
    reasoningTokens: 5,
    cachedInputTokens: 1,
    cacheCreationTokens: 4,
    nodeName: "answer",
  });

  assert.equal(entry?.totalTokens, 10);
  assert.equal(entry?.projectId, "demo");
  assert.equal(entry?.cacheCreationTokens, 4);
  assert.equal(updates.length, 1);
  assert.deepEqual(tokenUsage.getRunUsage(), {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 10,
    reasoningTokens: 5,
    cachedInputTokens: 1,
    cacheCreationTokens: 4,
    calls: 1,
    updatedAt: entry?.createdAt,
  });
  assert.equal(readAggregate(await kv.getValue(TOKEN_USAGE_TOTAL_KEY)).totalTokens, 10);
  assert.equal(readAggregate(await kv.getValue(TOKEN_USAGE_TOTAL_KEY)).cacheCreationTokens, 4);
  assert.equal(readAggregate(await kv.conversation.getValue(TOKEN_USAGE_TOTAL_KEY)).totalTokens, 10);
  assert.equal(readAggregate(await kv.conversation.getValue(TOKEN_USAGE_TOTAL_KEY)).cacheCreationTokens, 4);
  assert.equal(store.values.size, 3);
});

test("durable billing receipts repair a partial write and replace replayed usage", async () => {
  const store = createMemoryKVStore();
  const kv = createWorkflowKVContext({ store, projectId: "durable", conversationId: "session" });
  const makeUsage = () => createWorkflowTokenUsageContext({ definition: { enabled: true }, kv,
    projectId: "durable", conversationId: "session", runId: "same-run" });
  const update = kv.conversation.updateValue;
  kv.conversation.updateValue = async () => { throw new Error("crash between aggregates"); };
  await assert.rejects(() => makeUsage().report({ recordId: "request:response", inputTokens: 10, outputTokens: 5 }), /crash between/);
  assert.equal(readAggregate(await kv.getValue(TOKEN_USAGE_TOTAL_KEY)).totalTokens, 15);
  kv.conversation.updateValue = update;
  const usage = makeUsage();
  await usage.report({ recordId: "request:response", inputTokens: 10, outputTokens: 5 });
  await usage.report({ recordId: "request:response", inputTokens: 10, outputTokens: 8 });
  for (const namespace of [kv, kv.conversation]) {
    const aggregate = readAggregate(await namespace.getValue(TOKEN_USAGE_TOTAL_KEY));
    assert.equal(aggregate.totalTokens, 18); assert.equal(aggregate.calls, 1);
  }
  assert.equal(usage.getRunUsage().totalTokens, 18);
  assert.equal(usage.getRunUsage().calls, 1);
  assert.equal(store.values.size, 3, "replay upserts one detail record");
});

test("token usage report upgrades stored aggregate without cache creation tokens", async () => {
  const store = createMemoryKVStore();
  const kv = createWorkflowKVContext({
    store,
    projectId: "demo",
    source: { projectId: "demo", runId: "run-upgrade" },
  });
  await kv.setValue(TOKEN_USAGE_TOTAL_KEY, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    reasoningTokens: 0,
    cachedInputTokens: 1,
    calls: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-upgrade",
  });

  await tokenUsage.report({
    inputTokens: 4,
    outputTokens: 5,
    totalTokens: 9,
    cacheCreationTokens: 6,
  });

  assert.deepEqual(readAggregate(await kv.getValue(TOKEN_USAGE_TOTAL_KEY)), {
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 12,
    reasoningTokens: 0,
    cachedInputTokens: 1,
    cacheCreationTokens: 6,
    calls: 2,
    updatedAt: tokenUsage.getRunUsage().updatedAt,
  });
});

test("LLM node provider usage is reported before mapOutput can strip it", async () => {
  const store = createMemoryKVStore();
  const kv = createWorkflowKVContext({
    store,
    projectId: "demo",
    source: { projectId: "demo", runId: "run-llm" },
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-llm",
  });
  const provider: LLMProvider = {
    name: "fake-llm",
    async chat() {
      return {
        text: "ok",
        usage: {
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: 1,
            cacheWriteTokens: 4,
          },
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: 2,
          },
        },
      };
    },
    async *stream() {
      yield { type: "text-delta", text: "" };
    },
  };
  const context = createNodeContext(kv, tokenUsage, provider);
  const node = createLLMNode({
    name: "answer",
    provider,
    mapInput() {
      return { prompt: "hello" };
    },
    mapOutput(output) {
      return { text: output.text };
    },
  });

  const output = await runNode(node, {}, context);

  assert.deepEqual(output, { text: "ok" });
  assert.equal(tokenUsage.getRunUsage().totalTokens, 10);
  assert.equal(tokenUsage.getRunUsage().reasoningTokens, 2);
  assert.equal(tokenUsage.getRunUsage().cachedInputTokens, 1);
  assert.equal(tokenUsage.getRunUsage().cacheCreationTokens, 4);
  assert.equal(readAggregate(await kv.getValue(TOKEN_USAGE_TOTAL_KEY)).calls, 1);
});

test("token usage parser reads snake case cache creation aliases", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-alias" },
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-alias",
  });
  const provider: LLMProvider = {
    name: "fake-llm",
    async chat() {
      return {
        text: "ok",
        usage: {
          input_tokens: 11,
          output_tokens: 13,
          total_tokens: 24,
          input_token_details: {
            cache_read_tokens: 3,
            cache_write_tokens: 5,
          },
          output_token_details: {
            reasoning_tokens: 7,
          },
        } as unknown as NonNullable<Awaited<ReturnType<LLMProvider["chat"]>>["usage"]>,
      };
    },
    async *stream() {
      yield { type: "text-delta", text: "" };
    },
  };
  const context = createNodeContext(kv, tokenUsage, provider);

  await getLLMProvider(context, "custom-llm").chat({ prompt: "hello" });

  assert.equal(tokenUsage.getRunUsage().inputTokens, 11);
  assert.equal(tokenUsage.getRunUsage().outputTokens, 13);
  assert.equal(tokenUsage.getRunUsage().reasoningTokens, 7);
  assert.equal(tokenUsage.getRunUsage().cachedInputTokens, 3);
  assert.equal(tokenUsage.getRunUsage().cacheCreationTokens, 5);
});

test("token usage parser reads Claude cache creation alias", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-claude-alias" },
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-claude-alias",
  });
  const provider: LLMProvider = {
    name: "fake-llm",
    async chat() {
      return {
        text: "ok",
        usage: {
          input_tokens: 8,
          output_tokens: 9,
          cache_read_input_tokens: 2,
          cache_creation_tokens: 6,
        } as unknown as NonNullable<Awaited<ReturnType<LLMProvider["chat"]>>["usage"]>,
      };
    },
    async *stream() {
      yield { type: "text-delta", text: "" };
    },
  };
  const context = createNodeContext(kv, tokenUsage, provider);

  await getLLMProvider(context, "custom-llm").chat({ prompt: "hello" });

  assert.equal(tokenUsage.getRunUsage().totalTokens, 17);
  assert.equal(tokenUsage.getRunUsage().cachedInputTokens, 2);
  assert.equal(tokenUsage.getRunUsage().cacheCreationTokens, 6);
});

test("custom node usage-shaped output is not reported automatically", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-custom" },
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-custom",
  });
  const context = createNodeContext(kv, tokenUsage);
  const node = {
    name: "custom",
    async run() {
      return {
        usage: {
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
        },
      };
    },
  };

  await runNode(node, {}, context);

  assert.equal(tokenUsage.getRunUsage().totalTokens, 0);
  assert.equal(await kv.getValue(TOKEN_USAGE_TOTAL_KEY), undefined);
});

test("getLLMProvider reports provider usage for custom node calls", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-provider" },
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-provider",
  });
  const provider: LLMProvider = {
    name: "fake-llm",
    async chat() {
      return {
        text: "ok",
        usage: {
          inputTokens: 3,
          inputTokenDetails: {
            noCacheTokens: 3,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 4,
          outputTokenDetails: {
            textTokens: 4,
            reasoningTokens: 0,
          },
          totalTokens: 7,
        },
      };
    },
    async *stream() {
      yield { type: "text-delta", text: "" };
    },
  };
  const context = createNodeContext(kv, tokenUsage, provider);

  const output = await getLLMProvider(context, "custom-llm").chat({ prompt: "hello" });

  assert.equal(output.text, "ok");
  assert.equal(tokenUsage.getRunUsage().totalTokens, 7);
  assert.equal(tokenUsage.getRunUsage().calls, 1);
  assert.equal(readAggregate(await kv.getValue(TOKEN_USAGE_TOTAL_KEY)).totalTokens, 7);
});

test("LLM stream finish usage is reported once by the stream node", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-stream" },
  });
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv,
    projectId: "demo",
    runId: "run-stream",
  });
  const provider: LLMProvider = {
    name: "fake-llm",
    async chat() {
      return { text: "" };
    },
    async *stream(): AsyncIterable<LLMStreamChunk> {
      yield { type: "text-delta", text: "hi" };
      yield {
        type: "finish",
        usage: {
          inputTokens: 7,
          outputTokens: 8,
          totalTokens: 15,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
          },
        },
      };
    },
  };
  const context = createNodeContext(kv, tokenUsage, provider);
  const node = createLLMStreamNode({
    name: "answer",
    provider,
    mapInput() {
      return { prompt: "hello" };
    },
  });

  const result = await runStreamNode(node, {}, context);

  assert.equal(result.output, "hi");
  assert.equal(tokenUsage.getRunUsage().totalTokens, 15);
  assert.equal(tokenUsage.getRunUsage().calls, 1);
});

function createNodeContext(
  kv: ReturnType<typeof createWorkflowKVContext>,
  tokenUsage: TokenUsageContext,
  llm?: LLMProvider,
): NodeContext {
  return {
    providers: llm === undefined ? {} : { llm },
    storage: {
      local: { kv, persistentValue: kv, relatedProjects: createWorkflowRelatedProjectsContext() },
      server: { kv, persistentValue: kv, relatedProjects: createWorkflowRelatedProjectsContext() },
    },
    conversation: createDisabledWorkflowConversationContext(),
    tokenUsage,
  };
}

function readAggregate(value: unknown): TokenUsageAggregate {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as TokenUsageAggregate;
}

function createMemoryKVStore(): KVStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();

  function createKey(input: {
    scope: string;
    projectId?: string;
    conversationId?: string;
    key: string;
  }): string {
    return [
      input.scope,
      input.projectId ?? "",
      input.conversationId ?? "",
      input.key,
    ].join(":");
  }

  return {
    values,
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      values.set(createKey(input), input.value);
    },
    async deleteValue(input) {
      return values.delete(createKey(input));
    },
    async updateValue(input, updater) {
      const next = updater(values.get(createKey(input)));
      values.set(createKey(input), next);
      return next;
    },
  };
}
