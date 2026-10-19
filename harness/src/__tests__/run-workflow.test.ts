import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledWorkflowTokenUsageContext,
  MockLLMProvider,
  createWorkflowConversationContext,
  createWorkflowRelatedProjectsContext,
  createWorkflowTokenUsageContext,
  type KVContext,
} from "../index";
import { analyzeWorkflowScriptSource } from "../executor/rules";
import {
  readEntrypointOutput,
  runNode,
  runStreamNode,
  runWorkflow,
  safeRunWorkflow,
  HarnessError,
} from "../workflow/index";
import type {
  NodeExecutionHookChunkEvent,
  NodeExecutionHookFinishEvent,
  NodeExecutionHookStartEvent,
  RunContext,
  Definition,
} from "../types/index";

test("readEntrypointOutput unwraps a payload and refuses to unwrap a failure", () => {
  assert.deepEqual(readEntrypointOutput({ errCode: 0, errMessage: "", output: { id: "note-1" } }), {
    id: "note-1",
  });
  // A failure carries the same envelope shape with `output: null`; returning it
  // would hand the caller a null it cannot tell from an empty answer.
  assert.throws(
    () => readEntrypointOutput({ errCode: 4001, errMessage: "title must not be empty", output: null }),
    (error: Error) => error instanceof HarnessError && error.message === "title must not be empty",
  );
  // Anything that is not this package's envelope is left alone.
  assert.deepEqual(readEntrypointOutput({ id: "note-2" }), { id: "note-2" });
  assert.equal(readEntrypointOutput(undefined), undefined);
});

test("runWorkflow calls a child workflow inside the parent context", async () => {
  const context = createTestWorkflowContext();
  await context.storage.local.kv.setValue("shared-key", "from-parent");

  const child: Definition<{ value: number }, { value: number; shared: unknown }> = {
    name: "child-workflow",
    async run(input, childContext) {
      return {
        value: input.value + 1,
        shared: await childContext.storage.local.kv.getValue("shared-key"),
      };
    },
  };

  const output = await runWorkflow(child, { value: 4 }, context);

  assert.deepEqual(output, {
    value: 5,
    shared: "from-parent",
  });
});

test("runWorkflow shares persistentValue with child workflows", async () => {
  const context = createTestWorkflowContext();
  await context.storage.local.persistentValue.setValue("shared-key", "from-persistent-parent");

  const child: Definition<Record<string, never>, { value: unknown }> = {
    name: "child-workflow",
    async run(input, childContext) {
      return {
        value: await childContext.storage.local.persistentValue.getValue("shared-key"),
      };
    },
  };

  const output = await runWorkflow(child, {}, context);

  assert.deepEqual(output, {
    value: "from-persistent-parent",
  });
});

test("runWorkflow emits a parent trace wrapper and keeps child node events in the same trace", async () => {
  const starts: NodeExecutionHookStartEvent[] = [];
  const finishes: NodeExecutionHookFinishEvent[] = [];
  const context = createTestWorkflowContext({
    onStart(event) {
      starts.push(event);
    },
    onFinish(event) {
      finishes.push(event);
    },
  });
  const childNode = {
    name: "child-node",
    async run(input: { message: string }) {
      return `${input.message}!`;
    },
  };
  const child: Definition<{ message: string }, string> = {
    name: "child-workflow",
    async run(input, childContext) {
      return runNode(childNode, input, childContext);
    },
  };

  const output = await runWorkflow(child, { message: "hello" }, context, {
    name: "Nested child",
    metadata: {
      title: "Nested child trace",
    },
  });

  assert.equal(output, "hello!");
  assert.deepEqual(starts.map((event) => event.nodeName), ["run-workflow", "child-node"]);
  assert.equal(finishes.at(-1)?.nodeName, "run-workflow");
  assert.equal(finishes.at(-1)?.metadata?.title, "Nested child trace");
  assert.deepEqual(finishes.at(-1)?.executionInfo, {
    projectName: "child-workflow",
    conversationMode: "shared",
    kvMode: "shared",
    outputVisibility: "visible",
    outputBridge: false,
  });
});

test("safeRunWorkflow top-level execution does not emit a synthetic run-workflow node", async () => {
  const starts: NodeExecutionHookStartEvent[] = [];
  const context = createTestWorkflowContext({
    onStart(event) {
      starts.push(event);
    },
  });
  const childNode = {
    name: "top-child-node",
    async run() {
      return "ok";
    },
  };
  const topLevel: Definition<Record<string, never>, string> = {
    name: "top-level-workflow",
    run(input, childContext) {
      return runNode(childNode, input, childContext);
    },
  };

  const result = await safeRunWorkflow(topLevel, {}, context);

  assert.deepEqual(result, { ok: true, data: "ok" });
  assert.deepEqual(starts.map((event) => event.nodeName), ["top-child-node"]);
});

test("runWorkflow options with only name keep shared conversation and visible output defaults", async () => {
  const chunks: NodeExecutionHookChunkEvent[] = [];
  const finishes: NodeExecutionHookFinishEvent[] = [];
  const context = createTestWorkflowContext({
    conversationId: "thread-defaults",
    onChunk(event) {
      chunks.push(event);
    },
    onFinish(event) {
      finishes.push(event);
    },
  });
  const outputNode = {
    name: "child-output",
    standardName: "output",
    async *stream() {
      yield "visible child text";
    },
    finalize() {
      return { errCode: 0, errMessage: "", items: [] };
    },
  };
  const child: Definition<Record<string, never>, { messageCount: number; errCode: number; errMessage: string; items: unknown[] }> = {
    name: "child-workflow",
    async run(input, childContext) {
      await childContext.conversation.appendMessage({ role: "assistant", content: "child wrote" });
      const state = await childContext.conversation.getValue();
      const output = await runStreamNode(outputNode, input, childContext);
      return {
        ...output.output!,
        messageCount: state.messages.length,
      };
    },
  };

  const output = await runWorkflow(child, {}, context, {
    name: "Only display name",
  });
  const parentState = await context.conversation.getValue();

  assert.equal(output.messageCount, 1);
  assert.equal(parentState.messages.length, 1);
  assert.deepEqual(chunks.map((event) => event.chunk), ["visible child text"]);
  assert.equal(finishes.find((event) => event.nodeName === "output")?.outputVisibility, undefined);
  assert.deepEqual(finishes.at(-1)?.executionInfo, {
    projectName: "child-workflow",
    conversationMode: "shared",
    kvMode: "shared",
    outputVisibility: "visible",
    outputBridge: false,
  });
});

test("runWorkflow shared-readonly conversation lets the child read but not write transcript or title", async () => {
  const context = createTestWorkflowContext({
    conversationId: "thread-1",
  });
  await context.conversation.appendMessage({ role: "user", content: "parent message" });
  await context.conversation.setTitle("Parent title");

  const child: Definition<Record<string, never>, { before: number; after: number; title?: string }> = {
    name: "child-workflow",
    async run(input, childContext) {
      const before = await childContext.conversation.getValue();
      await childContext.conversation.appendMessage({ role: "assistant", content: "child message" });
      await childContext.conversation.setTitle("Child title");
      const after = await childContext.conversation.getValue();
      return {
        before: before.messages.length,
        after: after.messages.length,
        title: after.title,
      };
    },
  };

  const output = await runWorkflow(child, {}, context, {
    name: "Readonly child",
    conversationMode: "shared-readonly",
  });
  const parentState = await context.conversation.getValue();

  assert.deepEqual(output, {
    before: 1,
    after: 1,
    title: "Parent title",
  });
  assert.equal(parentState.messages.length, 1);
  assert.equal(parentState.title, "Parent title");
});

test("runWorkflow passes abortSignal, providers, files, and tokenUsage through to the child", async () => {
  const controller = new AbortController();
  const tokenUsage = createWorkflowTokenUsageContext({
    definition: { enabled: true },
    kv: createMemoryKVContext(),
    projectId: "parent",
    runId: "run-1",
    conversationId: "thread-1",
  });
  const files: RunContext["files"] = {
    resolveFile: async () => {
      throw new Error("not used");
    },
  };
  const context = createTestWorkflowContext({
    abortSignal: controller.signal,
    providers: { llm: new MockLLMProvider({ text: "mock-provider" }) },
    files,
    tokenUsage,
  });

  const child: Definition<Record<string, never>, {
    aborted: boolean;
    sameFiles: boolean;
    providerId?: string;
    tokenCalls: number;
  }> = {
    name: "child-workflow",
    async run(input, childContext) {
      await childContext.tokenUsage.report({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
      return {
        aborted: childContext.abortSignal === controller.signal,
        sameFiles: childContext.files === files,
        providerId: childContext.providers.llm?.name,
        tokenCalls: childContext.tokenUsage.getRunUsage().calls,
      };
    },
  };

  const output = await runWorkflow(child, {}, context, {
    name: "Context child",
  });

  assert.deepEqual(output, {
    aborted: true,
    sameFiles: true,
    providerId: "mock",
    tokenCalls: 1,
  });
  assert.equal(tokenUsage.getRunUsage().totalTokens, 3);
});

test("runWorkflow isolates local and server child KV namespaces", async () => {
  const context = createTestWorkflowContext();
  await context.storage.local.kv.setValue("state", "parent-workflow");
  await context.storage.local.kv.conversation.setValue("state", "parent-conversation");
  await context.storage.server.kv.setValue("state", "parent-server-workflow");

  const child: Definition<Record<string, never>, {
    beforeWorkflow: unknown;
    beforeConversation: unknown;
    afterWorkflow: unknown;
    afterConversation: unknown;
    beforeServerWorkflow: unknown;
    afterServerWorkflow: unknown;
  }> = {
    name: "child-workflow",
    async run(input, childContext) {
      const beforeWorkflow = await childContext.storage.local.kv.getValue("state");
      const beforeConversation = await childContext.storage.local.kv.conversation.getValue("state");
      const beforeServerWorkflow = await childContext.storage.server.kv.getValue("state");
      await childContext.storage.local.kv.setValue("state", "child-workflow");
      await childContext.storage.local.kv.conversation.setValue("state", "child-conversation");
      await childContext.storage.server.kv.setValue("state", "child-server-workflow");
      return {
        beforeWorkflow,
        beforeConversation,
        afterWorkflow: await childContext.storage.local.kv.getValue("state"),
        afterConversation: await childContext.storage.local.kv.conversation.getValue("state"),
        beforeServerWorkflow,
        afterServerWorkflow: await childContext.storage.server.kv.getValue("state"),
      };
    },
  };

  const output = await runWorkflow(child, {}, context, {
    name: "Isolated KV child",
    kvMode: "isolated",
  });

  assert.deepEqual(output, {
    beforeWorkflow: undefined,
    beforeConversation: undefined,
    afterWorkflow: "child-workflow",
    afterConversation: "child-conversation",
    beforeServerWorkflow: undefined,
    afterServerWorkflow: "child-server-workflow",
  });
  assert.equal(await context.storage.local.kv.getValue("state"), "parent-workflow");
  assert.equal(await context.storage.local.kv.conversation.getValue("state"), "parent-conversation");
  assert.equal(
    await context.storage.server.kv.getValue("state"),
    "parent-server-workflow",
  );
});

test("runWorkflow stops recursive workflow composition at maxDepth", async () => {
  const context = createTestWorkflowContext();
  const recursive: Definition<{ depth: number }, number> = {
    name: "recursive-workflow",
    async run(input, childContext) {
      return runWorkflow(recursive, { depth: input.depth + 1 }, childContext, {
        name: "Recursive child",
        maxDepth: 2,
      });
    },
  };

  await assert.rejects(
    () => runWorkflow(recursive, { depth: 0 }, context, {
      name: "Recursive root",
      maxDepth: 2,
    }),
    /runWorkflow exceeded maxDepth \(2\)/,
  );
});

test("runWorkflow hidden output visibility suppresses child output chunks", async () => {
  const chunks: NodeExecutionHookChunkEvent[] = [];
  const finishes: NodeExecutionHookFinishEvent[] = [];
  const context = createTestWorkflowContext({
    onChunk(event) {
      chunks.push(event);
    },
    onFinish(event) {
      finishes.push(event);
    },
  });
  const outputNode = {
    name: "child-output",
    standardName: "output",
    async *stream() {
      yield "hidden child text";
    },
    finalize() {
      return { errCode: 0, errMessage: "", items: [] };
    },
  };
  const child: Definition<Record<string, never>, { errCode: number; errMessage: string; items: unknown[] }> = {
    name: "child-workflow",
    async run(input, childContext) {
      return runStreamNode(outputNode, input, childContext).then((result) => result.output!);
    },
  };

  await runWorkflow(child, {}, context, {
    name: "Hidden child",
    outputVisibility: "hidden",
  });

  assert.equal(chunks.length, 0);
  assert.equal(finishes.find((event) => event.nodeName === "output")?.outputVisibility, "hidden");
});

test("runWorkflow can route child streaming output chunks to a parent handler", async () => {
  const bridgedChunks: unknown[] = [];
  const visibleChunks: NodeExecutionHookChunkEvent[] = [];
  const context = createTestWorkflowContext({
    onChunk(event) {
      visibleChunks.push(event);
    },
  });
  const outputNode = {
    name: "child-output",
    standardName: "output",
    async *stream() {
      yield "hello ";
      yield "stream";
    },
    finalize() {
      return { errCode: 0, errMessage: "", items: [] };
    },
  };
  const child: Definition<Record<string, never>, { errCode: number; errMessage: string; items: unknown[] }> = {
    name: "child-workflow",
    async run(input, childContext) {
      return runStreamNode(outputNode, input, childContext).then((result) => result.output!);
    },
  };

  await runWorkflow(child, {}, context, {
    name: "Bridge child stream",
    outputVisibility: "hidden",
    onOutputChunk(chunk) {
      bridgedChunks.push(chunk);
    },
  });

  assert.deepEqual(bridgedChunks, ["hello ", "stream"]);
  assert.equal(visibleChunks.length, 0);
});

test("runWorkflow fails fast when an output bridge handler throws", async () => {
  const visibleErrors: NodeExecutionHookFinishEvent[] = [];
  const context = createTestWorkflowContext({
    onFinish(event) {
      if (event.status === "failed") {
        visibleErrors.push(event);
      }
    },
  });
  let emittedChunks = 0;
  const outputNode = {
    name: "child-output",
    standardName: "output",
    async *stream() {
      emittedChunks += 1;
      yield "first";
      emittedChunks += 1;
      yield "second";
    },
    finalize() {
      return { errCode: 0, errMessage: "", items: [] };
    },
  };
  const child: Definition<Record<string, never>, { errCode: number; errMessage: string; items: unknown[] }> = {
    name: "child-workflow",
    async run(input, childContext) {
      return runStreamNode(outputNode, input, childContext).then((result) => result.output!);
    },
  };

  await assert.rejects(
    () => runWorkflow(child, {}, context, {
      name: "Bridge failure child",
      outputVisibility: "hidden",
      onOutputChunk() {
        throw new Error("bridge handler failed");
      },
    }),
    (error) => {
      assert.ok(error instanceof HarnessError);
      assert.equal(error.metadata?.outputBridgeFailed, true);
      assert.match(error.safeCause?.message ?? "", /bridge handler failed/);
      return true;
    },
  );

  assert.equal(emittedChunks, 1);
  assert.equal(visibleErrors.find((event) => event.nodeName === "output")?.outputVisibility, "hidden");
  assert.equal(visibleErrors.at(-1)?.nodeName, "run-workflow");
});

test("runWorkflow can route child final output when the child is not streaming", async () => {
  const bridgedOutputs: unknown[] = [];
  const context = createTestWorkflowContext();
  const child: Definition<Record<string, never>, { errCode: number; errMessage: string; items: Array<{ title: string; content: string }> }> = {
    name: "child-workflow",
    async run() {
      return {
        errCode: 0,
        errMessage: "",
        items: [
          {
            title: "Child",
            content: "final child output",
          },
        ],
      };
    },
  };

  const output = await runWorkflow(child, {}, context, {
    name: "Bridge child final output",
    outputVisibility: "hidden",
    onOutput(childOutput) {
      bridgedOutputs.push(childOutput);
    },
  });

  assert.deepEqual(bridgedOutputs, [output]);
});

test("workflow structure records runWorkflow calls in the execution tree", () => {
  const analysis = analyzeWorkflowScriptSource(`
    import childWorkflow from "../child";

    const outputNode = workflow.createOutputNode({
      name: "output",
      format(input) {
        return { errCode: 0, errMessage: "", content: String(input.value) };
      },
    });

    export const demo = workflow.defineWorkflow({
      name: "demo",
      async run(input, context) {
        const childOutput = await workflow.runWorkflow(childWorkflow, input, context, {
          name: "Child workflow",
          conversationMode: "shared-readonly",
        });

        return workflow.runNode(outputNode, childOutput, context);
      },
    });
  `);

  assert.equal(analysis.structureCalls.filter((call) => call.callee === "runWorkflow").length, 1);
  assert.equal(analysis.structureTrees.length, 1);

  const workflowCall = analysis.structureTrees[0]?.children[0];
  assert.equal(workflowCall?.kind, "call");
  assert.equal(workflowCall.callee, "runWorkflow");
  assert.equal(workflowCall.standardName, "run-workflow");
  assert.equal(workflowCall.nodeRef, "childWorkflow");
});

function createTestWorkflowContext(options: {
  onStart?: (event: NodeExecutionHookStartEvent) => void;
  onChunk?: (event: NodeExecutionHookChunkEvent) => void;
  onFinish?: (event: NodeExecutionHookFinishEvent) => void;
  conversationId?: string;
  abortSignal?: AbortSignal;
  providers?: RunContext["providers"];
  files?: RunContext["files"];
  tokenUsage?: RunContext["tokenUsage"];
} = {}): RunContext {
  const kv = createMemoryKVContext();

  return {
    providers: options.providers ?? {},
    storage: {
      local: { kv, persistentValue: createMemoryKVContext(), relatedProjects: createWorkflowRelatedProjectsContext() },
      server: { kv: createMemoryKVContext(), persistentValue: createMemoryKVContext(), relatedProjects: createWorkflowRelatedProjectsContext() },
    },
    conversation: createWorkflowConversationContext({
      enabled: options.conversationId !== undefined,
      conversationId: options.conversationId,
      projectName: "parent-workflow",
      kv,
    }),
    tokenUsage: options.tokenUsage ?? createDisabledWorkflowTokenUsageContext(),
    files: options.files,
    abortSignal: options.abortSignal,
    nodeHooks: {
      onNodeStart: options.onStart,
      onNodeChunk: options.onChunk,
      onNodeFinish: options.onFinish,
    },
  };
}

function createMemoryKVContext(): KVContext {
  const values = new Map<string, unknown>();

  function createNamespace(prefix: string) {
    return {
      async getValue(key: string) {
        return values.get(`${prefix}:${key}`);
      },
      async setValue(key: string, value: unknown) {
        values.set(`${prefix}:${key}`, value);
      },
      async deleteValue(key: string) {
        return values.delete(`${prefix}:${key}`);
      },
      async updateValue(key: string, updater: (current: unknown | undefined) => unknown) {
        const next = updater(values.get(`${prefix}:${key}`));
        values.set(`${prefix}:${key}`, next);
        return next;
      },
    };
  }

  const project = createNamespace("project");

  return {
    getValue: project.getValue,
    setValue: project.setValue,
    deleteValue: project.deleteValue,
    updateValue: project.updateValue,
    conversation: createNamespace("conversation"),
  };
}
