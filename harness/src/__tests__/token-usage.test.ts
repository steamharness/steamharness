import { createTestResources } from "./entry-test-resources";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledProjectConversationContext,
  createLLMNode,
  createLLMStreamNode,
  createProjectKVContext,
  createProjectTokenUsageContext,
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

test("disabled token usage never calls persistence", async () => {
  const usage = createProjectTokenUsageContext({ definition: { enabled: false }, projectId: "demo", runId: "run", store: async () => { throw new Error("must not write"); } });
  assert.equal(await usage.report({ totalTokens: 12 }), undefined);
});

test("usage persists one detail per stable receipt and updates run totals after commit", async () => {
  const records = new Map<string, import("../token-usage").TokenUsageEntry>();
  const usage = createProjectTokenUsageContext({ definition: { enabled: true }, projectId: "demo", runId: "run", conversationId: "conversation", store: async entry => { records.set(entry.id, entry); } });
  await usage.report({ recordId: "receipt", inputTokens: 10, outputTokens: 5, cacheCreationTokens: 4 });
  await usage.report({ recordId: "receipt", inputTokens: 10, outputTokens: 8, cacheCreationTokens: 6 });
  assert.equal(records.size, 1); assert.equal(records.get("receipt")?.conversationId, "conversation");
  assert.equal(usage.getRunUsage().totalTokens, 18); assert.equal(usage.getRunUsage().calls, 1);
  assert.equal(usage.getRunUsage().cacheCreationTokens, 6);
});

test("a storage failure leaves run accounting unchanged and can be retried", async () => {
  let fail = true;
  const usage = createProjectTokenUsageContext({ definition: { enabled: true }, projectId: "demo", runId: "run", store: async () => { if (fail) throw new Error("unavailable"); } });
  await assert.rejects(() => usage.report({ recordId: "receipt", totalTokens: 12 }), /unavailable/);
  assert.equal(usage.getRunUsage().calls, 0);
  fail = false; await usage.report({ recordId: "receipt", totalTokens: 12 });
  assert.equal(usage.getRunUsage().calls, 1);
});

test("LLM node provider usage is reported before mapOutput can strip it", async () => {
  const store = createMemoryKVStore();
  const kv = createProjectKVContext({
    store,
    projectId: "demo",
    source: { projectId: "demo", runId: "run-llm" },
  });
  const tokenUsage = createProjectTokenUsageContext({
    definition: { enabled: true },
    store: async () => undefined,
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
  assert.equal(tokenUsage.getRunUsage().calls, 1);
});

test("token usage parser reads snake case cache creation aliases", async () => {
  const kv = createProjectKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-alias" },
  });
  const tokenUsage = createProjectTokenUsageContext({
    definition: { enabled: true },
    store: async () => undefined,
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
  const kv = createProjectKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-claude-alias" },
  });
  const tokenUsage = createProjectTokenUsageContext({
    definition: { enabled: true },
    store: async () => undefined,
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
  const kv = createProjectKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-custom" },
  });
  const tokenUsage = createProjectTokenUsageContext({
    definition: { enabled: true },
    store: async () => undefined,
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
  const kv = createProjectKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-provider" },
  });
  const tokenUsage = createProjectTokenUsageContext({
    definition: { enabled: true },
    store: async () => undefined,
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
  assert.equal(tokenUsage.getRunUsage().totalTokens, 7);
});

test("LLM stream finish usage is reported once by the stream node", async () => {
  const kv = createProjectKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    source: { projectId: "demo", runId: "run-stream" },
  });
  const tokenUsage = createProjectTokenUsageContext({
    definition: { enabled: true },
    store: async () => undefined,
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
  kv: ReturnType<typeof createProjectKVContext>,
  tokenUsage: TokenUsageContext,
  llm?: LLMProvider,
): NodeContext {
  return {
    config: {},
    providers: llm === undefined ? {} : { llm },
    ...createTestResources(),
    conversation: createDisabledProjectConversationContext(),
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
