import { testConversationStorage } from "./runtime-test-storage";
import { createTestResources } from "./entry-test-resources";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledProjectTokenUsageContext,
  MockLLMProvider,
  createProjectConversationContext,
  createProjectTokenUsageContext,
} from "../index";
import { analyzeProjectScriptSource } from "../executor/rules";
import {
  readEntrypointOutput,
  runNode,
  runStreamNode,
  runProject,
  safeRunProject,
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

test("runProject shares persistentValue with child workflows", async () => {
  const context = createTestProjectContext();
  await context.knowledgeBases.get("data").createDocument({ id: "shared-key", title: "Shared", markdown: "from-persistent-parent" });

  const child: Definition<Record<string, never>, { value: unknown }> = {
    name: "child-workflow",
    async run(input, childContext) {
      return {
        value: (await childContext.knowledgeBases.get("data").getDocument("shared-key"))?.markdown,
      };
    },
  };

  const output = await runProject(child, {}, context);

  assert.deepEqual(output, {
    value: "from-persistent-parent",
  });
});

test("safeRunProject top-level execution does not emit a synthetic run-workflow node", async () => {
  const starts: NodeExecutionHookStartEvent[] = [];
  const context = createTestProjectContext({
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

  const result = await safeRunProject(topLevel, {}, context);

  assert.deepEqual(result, { ok: true, data: "ok" });
  assert.deepEqual(starts.map((event) => event.nodeName), ["top-child-node"]);
});

test("runProject shared-readonly conversation lets the child read but not write transcript or title", async () => {
  const context = createTestProjectContext({
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

  const output = await runProject(child, {}, context, {
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

test("runProject passes abortSignal, providers, files, and tokenUsage through to the child", async () => {
  const controller = new AbortController();
  const tokenUsage = createProjectTokenUsageContext({
    definition: { enabled: true },
    store: async () => undefined,
    projectId: "parent",
    runId: "run-1",
    conversationId: "thread-1",
  });
  const files: RunContext["files"] = {
    resolveFile: async () => {
      throw new Error("not used");
    },
  };
  const context = createTestProjectContext({
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

  const output = await runProject(child, {}, context, {
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

test("runProject stops recursive workflow composition at maxDepth", async () => {
  const context = createTestProjectContext();
  const recursive: Definition<{ depth: number }, number> = {
    name: "recursive-workflow",
    async run(input, childContext) {
      return runProject(recursive, { depth: input.depth + 1 }, childContext, {
        name: "Recursive child",
        maxDepth: 2,
      });
    },
  };

  await assert.rejects(
    () => runProject(recursive, { depth: 0 }, context, {
      name: "Recursive root",
      maxDepth: 2,
    }),
    /runProject exceeded maxDepth \(2\)/,
  );
});

test("runProject hidden output visibility suppresses child output chunks", async () => {
  const chunks: NodeExecutionHookChunkEvent[] = [];
  const finishes: NodeExecutionHookFinishEvent[] = [];
  const context = createTestProjectContext({
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

  await runProject(child, {}, context, {
    name: "Hidden child",
    outputVisibility: "hidden",
  });

  assert.equal(chunks.length, 0);
  assert.equal(finishes.find((event) => event.nodeName === "output")?.outputVisibility, "hidden");
});

test("runProject can route child streaming output chunks to a parent handler", async () => {
  const bridgedChunks: unknown[] = [];
  const visibleChunks: NodeExecutionHookChunkEvent[] = [];
  const context = createTestProjectContext({
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

  await runProject(child, {}, context, {
    name: "Bridge child stream",
    outputVisibility: "hidden",
    onOutputChunk(chunk) {
      bridgedChunks.push(chunk);
    },
  });

  assert.deepEqual(bridgedChunks, ["hello ", "stream"]);
  assert.equal(visibleChunks.length, 0);
});

test("runProject fails fast when an output bridge handler throws", async () => {
  const visibleErrors: NodeExecutionHookFinishEvent[] = [];
  const context = createTestProjectContext({
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
    () => runProject(child, {}, context, {
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

test("runProject can route child final output when the child is not streaming", async () => {
  const bridgedOutputs: unknown[] = [];
  const context = createTestProjectContext();
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

  const output = await runProject(child, {}, context, {
    name: "Bridge child final output",
    outputVisibility: "hidden",
    onOutput(childOutput) {
      bridgedOutputs.push(childOutput);
    },
  });

  assert.deepEqual(bridgedOutputs, [output]);
});

test("workflow structure records runProject calls in the execution tree", () => {
  const analysis = analyzeProjectScriptSource(`
    import childProject from "../child";

    const outputNode = steamharness.createOutputNode({
      name: "output",
      format(input) {
        return { errCode: 0, errMessage: "", content: String(input.value) };
      },
    });

    export const demo = steamharness.defineProject({
      name: "demo",
      async run(input, context) {
        const childOutput = await steamharness.runProject(childProject, input, context, {
          name: "Child workflow",
          conversationMode: "shared-readonly",
        });

        return steamharness.runNode(outputNode, childOutput, context);
      },
    });
  `);

  assert.equal(analysis.structureCalls.filter((call) => call.callee === "runProject").length, 1);
  assert.equal(analysis.structureTrees.length, 1);

  const projectCall = analysis.structureTrees[0]?.children[0];
  assert.equal(projectCall?.kind, "call");
  assert.equal(projectCall.callee, "runProject");
  assert.equal(projectCall.standardName, "run-workflow");
  assert.equal(projectCall.nodeRef, "childProject");
});

function createTestProjectContext(options: {
  onStart?: (event: NodeExecutionHookStartEvent) => void;
  onChunk?: (event: NodeExecutionHookChunkEvent) => void;
  onFinish?: (event: NodeExecutionHookFinishEvent) => void;
  conversationId?: string;
  abortSignal?: AbortSignal;
  providers?: RunContext["providers"];
  files?: RunContext["files"];
  tokenUsage?: RunContext["tokenUsage"];
} = {}): RunContext {
  const kv = {};

  return {
    config: {},
    providers: options.providers ?? {},
    ...createTestResources(),
    conversation: createProjectConversationContext({
      enabled: options.conversationId !== undefined,
      conversationId: options.conversationId,
      projectName: "parent-workflow",
      storage: testConversationStorage(kv),
    }),
    tokenUsage: options.tokenUsage ?? createDisabledProjectTokenUsageContext(),
    files: options.files,
    abortSignal: options.abortSignal,
    nodeHooks: {
      onNodeStart: options.onStart,
      onNodeChunk: options.onChunk,
      onNodeFinish: options.onFinish,
    },
  };
}
