import { createTestResources } from "./entry-test-resources";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { agentConversationDirectory } from "../agent/storage";
import { createAgentConversationProject, createAgentProjectInput, defineAgentConversationExecutor } from "../agent/project";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues } from "../executor/params";
import { AGENT_OUTPUT_KINDS } from "../agent/output-items";
import { createAgentNode } from "../agent/node";
import type { OutputItemStreamChunk } from "../node/output/index";
import { createAgentPlanApprovalRequest, readAgentPlanDecision } from "../agent/plan";
import { createProjectConversationContext } from "../conversation/index";
import type { UserInputRequest } from "../types/index";
import { createLocalProjectFileStore, type FileReference, type FileStore } from "../files/index";
import { HarnessError } from "../workflow/errors";
import { createProjectToolPermissionContext } from "../tool-permissions/index";
import { readAgentToolDefinitions } from "../agent/permission";
import { createDisabledProjectTokenUsageContext } from "../token-usage/index";
import type { RunContext } from "../types/index";
import type { KVContext } from "../kv/index";

/**
 * A project built from one factory call is what every builtin will ship, so the
 * shape it produces is a contract: if the executor loses its conversation
 * wiring or its params, a builtin silently loses a feature.
 */
async function createFauxModel() {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({
    models: [{ id: "faux-1", name: "Faux", reasoning: true, contextWindow: 1_000, maxTokens: 100 }],
  });
  const models = ai.createModels();
  models.setProvider(faux.provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);

  return { ai, faux, models, model };
}

function createMemoryKV(): KVContext {
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
  } as unknown as KVContext;
}

for (const outcome of ["success", "failed", "error", "length"] as const) {
  test(`manual context compaction streams running then ${outcome} and preserves the stored transcript`, async () => {
    const { ai, faux, models, model } = await createFauxModel();
    const requests: string[][] = [];
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxText("Original answer")]),
      ai.fauxAssistantMessage([ai.fauxText(outcome === "success" ? "Remember the user's goal." : outcome === "failed" ? "" : "Partial summary")],
        { stopReason: outcome === "error" || outcome === "length" ? outcome : "stop", errorMessage: outcome === "error" ? "Summary provider failed" : undefined }),
      (request: { messages: AgentRequestMessage[] }) => {
        requests.push(readRequestLines(request.messages));
        return ai.fauxAssistantMessage([ai.fauxText("Continued")]);
      },
    ] as never[]);
    await withTempDir(async workdir => {
      const context = createContext(`compact-${outcome}`);
      const executor = defineAgentConversationExecutor({ models, resolvedModel: model });
      await executor.workflow.run({ prompt: "Original goal", workdir, errCode: 0, errMessage: "" }, context);
      const before = await readStoredTranscript(context);
      const node = createAgentNode({ models, resolvedModel: model });
      const input = { prompt: "/compact", workdir, errCode: 0, errMessage: "" };
      const chunks: OutputItemStreamChunk[] = [];
      const collect = async () => { for await (const chunk of node.stream(input, context)) chunks.push(chunk); };
      if (outcome === "failed") { await assert.rejects(collect, /empty compaction summary/); }
      else if (outcome === "error") { await assert.rejects(collect, /Summary provider failed/); }
      else if (outcome === "length") { await assert.rejects(collect, /incomplete compaction summary/); }
      else { await collect(); }
      const updates = chunks.filter(chunk => chunk.type === "output_item_delta" && chunk.item?.metadata?.partType === "compaction");
      assert.deepEqual(updates.map(chunk => chunk.type === "output_item_delta" ? chunk.item?.metadata?.status : undefined), ["running", outcome === "success" ? "success" : "failed"]);
      const stored = await readStoredTranscript(context);
      if (outcome !== "success") { assert.deepEqual(stored, before); }
      else { assert.equal(stored.length, 1); assert.match(JSON.stringify(stored), /Remember the user's goal/); }
      const reopened = defineAgentConversationExecutor({ models, resolvedModel: model });
      await reopened.workflow.run({ prompt: "Continue", workdir, errCode: 0, errMessage: "" }, context);
      assert.match(requests[0]?.join("\n") ?? "", outcome === "success" ? /Remember the user's goal/ : /Original answer/);
      if (outcome === "success") { assert.doesNotMatch(requests[0]?.join("\n") ?? "", /Original answer/); }
    });
  });
}

test("a context command with no history emits a complete success item", async () => {
  const { models, model } = await createFauxModel();
  const context = createContext("compact-empty");
  const node = createAgentNode({ models, resolvedModel: model });
  const input = { prompt: "/compact", errCode: 0, errMessage: "" };
  const chunks: OutputItemStreamChunk[] = [];
  for await (const chunk of node.stream(input, context)) chunks.push(chunk);
  const start = chunks.find(chunk => chunk.type === "output_item_start" && chunk.item.metadata?.partType === "compaction");
  assert.ok(start?.type === "output_item_start");
  assert.equal(start.item.metadata?.status, "success");
  assert.ok(chunks.some(chunk => chunk.type === "output_item_end" && chunk.itemId === start.item.id));
  assert.deepEqual((await context.conversation.getValue()).values, {});
});

test("cancelled context compaction preserves the stored transcript even if the provider returns a summary", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([ai.fauxAssistantMessage("Original answer")]);
  await withTempDir(async workdir => {
    const context = createContext("compact-cancelled");
    const executor = defineAgentConversationExecutor({ models, resolvedModel: model });
    await executor.workflow.run({ prompt: "Original goal", workdir, errCode: 0, errMessage: "" }, context);
    const before = await readStoredTranscript(context);
    const controller = new AbortController();
    context.abortSignal = controller.signal;
    models.completeSimple = async () => {
      controller.abort(new Error("Summary cancelled"));
      return ai.fauxAssistantMessage("Late summary");
    };
    const node = createAgentNode({ models, resolvedModel: model });
    const chunks: OutputItemStreamChunk[] = [];
    await assert.rejects(async () => {
      for await (const chunk of node.stream({ prompt: "/compact", workdir, errCode: 0, errMessage: "" }, context)) chunks.push(chunk);
    }, error => error instanceof HarnessError && error.type === "execution_aborted");
    assert.deepEqual(await readStoredTranscript(context), before);
    assert.equal(chunks.some(chunk => chunk.type === "output_item_delta" && chunk.item?.metadata?.partType === "compaction" && chunk.item.metadata.status === "success"), false);
    assert.equal(chunks.some(chunk => chunk.type === "output_item_start" && chunk.item.metadata?.kind === "agent-error"), false);
  });
});

const agentStores = new Set<string>();
after(async () => { for (const directory of agentStores) await rm(directory, { recursive: true, force: true }); });

function createContext(conversationId: string, files?: FileStore): RunContext {
  const kv = createMemoryKV();
  const agentStoreDir = mkdtempSync(path.join(tmpdir(), "workflow-agent-store-"));
  agentStores.add(agentStoreDir);
  return {
    metadata: { agentStoreDir },
    providers: {},
    ...(files === undefined ? {} : { files }),
    ...createTestResources(),
    conversation: createProjectConversationContext({
      enabled: true,
      conversationId,
      projectName: "pi",
      kv,
    }),
    tokenUsage: createDisabledProjectTokenUsageContext(),
    toolPermissions: createProjectToolPermissionContext({
      definitions: readAgentToolDefinitions(undefined),
      projectName: "pi",
      runId: "run-1",
    }),
  } as unknown as RunContext;
}

/** The message shape the model is asked with, as the faux provider sees it. */
interface AgentRequestMessage {
  role: string;
  content: unknown;
}

/** A request rendered as one line per message, so an assertion reads as a transcript. */
function readRequestLines(messages: readonly AgentRequestMessage[]): string[] {
  return messages.filter(message => message.role !== "system").map((message) => `${message.role}:${readRequestText(message.content)}`);
}

function readRequestText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const record = block as { type?: unknown; text?: unknown; name?: unknown };
      if (record.type === "text" && typeof record.text === "string") return [record.text];
      // A tool call and its result carry no text, but they are what the next
      // turn has to remember happened, so they are named rather than dropped.
      if (record.type === "toolCall" && typeof record.name === "string") return [`<toolCall:${record.name}>`];
      return [];
    })
    .join("");
}

/** The transcript this node keeps, under the session key a bare project uses. */
async function readStoredTranscript(
  context: RunContext,
): Promise<Array<{ role: string; content: unknown }>> {
  const directory = agentConversationDirectory(context.metadata!["agentStoreDir"] as string, context.conversation.conversationId!);
  const files = (await readdir(directory)).filter(file => file.endsWith(".sqlite"));
  assert.equal(files.length, 1);
  const storage = await openNodeSqliteStorage(path.join(directory, files[0]!));
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try { return (await (await harness.root(BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT)).messages.filter(message => message.role !== "system"); }
  finally { await harness.close(BACKGROUND_CONTEXT); }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-agent-project-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("defineAgentConversationExecutor produces a complete conversation executor", () => {
  const executor = defineAgentConversationExecutor({
    projectName: "Pi",
    executorName: "pi",
    outputItemId: "pi-answer",
  });

  assert.equal(executor.projectType, "conversation");
  assert.equal(executor.workflow.name, "pi");
  assert.equal("defaultInput" in (executor.conversation ?? {}), false);
  assert.equal(executor.conversation?.inputQueue?.enabled, true);
  assert.equal(executor.conversation?.collapseIntermediate, true);
  assert.equal(defineAgentConversationExecutor({ collapseIntermediate: false }).conversation?.collapseIntermediate, false);
  assert.equal(executor.conversation?.openai?.enabled, true);
  assert.equal(executor.conversation?.openai?.outputItemId, "pi-answer");
  assert.equal(executor.tokenUsage?.enabled, true);

  const toolNames = (executor.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["bash", "edit", "find", "grep", "ls", "read", "write"]);

  const paramNames = normalizeProjectParamDeclarations(executor.params).params.map((param) => param.name);
  assert.deepEqual(
    paramNames,
    ["provider", "model", "effort", "plan", "permissionPolicy"],
  );
});

test("the generated params expose the agent capability in the UI", () => {
  const executor = defineAgentConversationExecutor({});
  const normalized = normalizeProjectParamDeclarations(executor.params);
  const params = new Map(normalized.params.map((param) => [param.name, param]));

  assert.equal(params.get("plan")?.panel, "slash");
  assert.equal(params.get("plan")?.defaultValue, "false");
  assert.deepEqual(
    params.get("permissionPolicy")?.options?.map((option) => option.value),
    ["read-only", "workspace", "auto"],
  );
  assert.equal(params.get("effort")?.defaultValue, "high");
  // Model, effort and permission each have their own composer control.
  assert.deepEqual(
    ["provider", "model", "effort", "permissionPolicy"].map((name) => params.get(name)?.panel),
    ["quick", "quick", "quick", "quick"],
  );
  assert.deepEqual(normalized.layout?.actions.map((action) => action.kind), [
    "quick", "quick", "slash", "quick",
  ]);
});

test("createInput reads the composer message and the agent params", () => {
  const executor = defineAgentConversationExecutor({ projectName: "pi", permissionPolicy: "workspace" });
  const args = ["--plan", "true", "--effort", "high", "--permission-policy", "read-only", "refactor the parser"];
  const input = executor.createInput({
    args, paramValues: parseProjectParamValues(executor.params, args),
  } as never) as unknown as Record<string, unknown> | undefined;

  assert.ok(input);
  assert.equal(input["prompt"], "refactor the parser");
  assert.equal(input["agent"], "plan");
  assert.equal(input["effort"], "high");
  assert.equal(input["permissionPolicy"], "read-only");
});

test("a project-fixed permission reaches the real agent despite an explicit input override", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  let offered: string[] = [];
  faux.setResponses([request => {
    const tools = new Set<string>();
    for (const message of request.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    }
    offered = [...tools];
    return ai.fauxAssistantMessage("Business answer");
  }]);
  const project = createAgentConversationProject({ models, resolvedModel: model,
    paramOptions: { fields: { effort: { defaultValue: "medium" }, permissionPolicy: { visible: false, fixedValue: "read-only" } } } });
  await withTempDir(async workdir => {
    const result = await project.run({ errCode: 0, errMessage: "", prompt: "Question", workdir, permissionPolicy: "auto" }, createContext("fixed-policy"));
    assert.equal(result.effort, "medium");
    assert.ok(offered.includes("read"));
    assert.equal(offered.includes("write"), false);
    assert.equal(offered.includes("bash"), false);
    assert.ok(JSON.stringify(result.items).includes("Business answer"));
  });
});

test("declared skill roots supply the real skill tool, preserve the custom tool lifecycle and obey disabled permissions", async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, "guides/alpha"), { recursive: true });
    await writeFile(path.join(root, "guides/alpha/SKILL.md"), "---\nname: alpha\n---\n# Alpha guide");
    for (const enabled of [true, false]) {
      const { ai, faux, models, model } = await createFauxModel();
      const closed: boolean[] = [];
      const seen: string[] = [];
      faux.setResponses([
        ...(enabled ? [ai.fauxAssistantMessage([ai.fauxToolCall("skill", { action: "read", skill: "alpha" })], { stopReason: "toolUse" })] : []),
        request => { seen.push(JSON.stringify(request)); return ai.fauxAssistantMessage("Done"); },
      ]);
      const project = createAgentConversationProject({ models, resolvedModel: model, skills: { directories: ["guides"] },
        createTools: () => ({ tools: [], close: async () => { closed.push(true); } }) });
      const context = createContext(`skills-${enabled}`);
      context.metadata = { ...context.metadata, entryRootDir: root };
      context.toolPermissions = createProjectToolPermissionContext({ definitions: [{ name: "skill", enabled, autoApprove: true }], projectName: "skills", runId: `skills-${enabled}` });
      const result = await project.run({ errCode: 0, errMessage: "", prompt: "Read alpha", workdir: root }, context);
      assert.deepEqual(closed, [true]);
      if (enabled) { assert.equal(result.toolCallCount, 1); assert.ok(seen.join("").includes("# Alpha guide")); }
      else { assert.equal(result.toolCallCount, 0); assert.equal(seen.join("").includes('"name":"skill"'), false); }
    }
  });
});

/** The host's catalogue, as the workflow runtime builds it: built-ins plus the declared tools. */
function createToolPermissionContext(extra: Array<{ name: string; autoApprove: boolean }>) {
  return createProjectToolPermissionContext({
    definitions: [
      ...readAgentToolDefinitions(undefined),
      ...extra.map((tool) => ({ name: tool.name, enabled: true, autoApprove: tool.autoApprove })),
    ],
    projectName: "pi",
    runId: "run-1",
  });
}

test("tool approval identity separates calls, arguments and permission definitions", async () => {
  async function identity(callId: string, args: unknown, label = "External") {
    const permissions = createProjectToolPermissionContext({
      definitions: [{ name: "external", label, enabled: true, autoApprove: false }],
      projectName: "pi", runId: "approval-run",
    });
    try { await permissions.requireToolApproval({ name: "external", callId, arguments: args }); }
    catch (error) {
      assert.ok(error instanceof HarnessError && error.type === "user_input_required");
      return (error.metadata?.["request"] as UserInputRequest).requestId;
    }
    assert.fail("Approval must wait for a decision");
  }
  const first = await identity("call-1", { a: 1, b: 2 });
  assert.equal(await identity("call-1", { b: 2, a: 1 }), first);
  assert.notEqual(await identity("call-2", { a: 1, b: 2 }), first);
  assert.notEqual(await identity("call-1", { a: 2, b: 2 }), first);
  assert.notEqual(await identity("call-1", { a: 1, b: 2 }, "Changed permission"), first);
});

test("a plan turn pauses for approval and runs the tool once approved", async () => {
  const runs: string[] = [];
  let resolvedRequestId: string | undefined;

  const { ai, faux, models, model } = await createFauxModel();
  let attempt = 0;
  const responses = () => {
    attempt += 1;
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall("external_thing", { value: attempt === 1 ? "x" : "y" })], { stopReason: "toolUse" }),
      // The test is about the tool, not the plan: a plan turn that writes
      // something ends by asking to approve it, and an empty answer keeps the
      // approved turn from pausing a second time.
      ai.fauxAssistantMessage([]),
    ] as never[]);
  };
  responses();

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      models,
      resolvedModel: model,
      createTools: () => [{
        name: "external_thing",
        label: "External",
        description: "A caller-supplied tool.",
        parameters: { type: "object", properties: { value: { type: "string" } } },
        execute: async (_id: string, params: { value: string }) => {
          runs.push(params.value);
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as never],
    });

    const context = createContext("conv-tool-approval");
    context.toolPermissions = createToolPermissionContext([
      { name: "external_thing", autoApprove: false },
    ]);
    let requested: string | undefined;
    context.userInput = {
      getResolvedInput: async (id: string) => (resolvedRequestId === id
        ? { requestId: id, nodeName: "tool-approval", values: { approved: true }, submittedAt: new Date() }
        : undefined),
      requestInput: async (request: { requestId: string }) => {
        requested = request.requestId;
      },
    };

    // First run parks: the gate asks and the run waits for the answer.
    await assert.rejects(
      async () => {
        await executor.workflow.run({ prompt: "use the tool", requestId: "approval-run", agent: "plan", errCode: 0, errMessage: "", workdir }, context);
      },
      (error: Error & { type?: string }) => error.type === "user_input_required",
    );
    assert.ok(requested, "the gate must have asked for approval");
    assert.deepEqual(runs, [], "nothing runs before the user answers");

    // Second run finds the answer and executes the tool.
    resolvedRequestId = requested;
    faux.setResponses([ai.fauxAssistantMessage([])]);

    const result = await executor.workflow.run(
      { prompt: "use the tool", requestId: "approval-run", agent: "plan", errCode: 0, errMessage: "", workdir },
      context,
    );

    assert.deepEqual(runs, ["x"]);
    assert.equal(result.toolCallCount, 1);
  });
});

test("a build turn runs the tool that a plan turn would have asked about", async () => {
  const runs: string[] = [];
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("external_thing", { value: "x" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("ran it")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      models,
      resolvedModel: model,
      createTools: () => [{
        name: "external_thing",
        label: "External",
        description: "A caller-supplied tool.",
        parameters: { type: "object", properties: { value: { type: "string" } } },
        execute: async (_id: string, params: { value: string }) => {
          runs.push(params.value);
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as never],
    });

    const context = createContext("conv-build-executes");
    context.toolPermissions = createToolPermissionContext([
      { name: "external_thing", autoApprove: false },
    ]);
    let requested: string | undefined;
    context.userInput = {
      getResolvedInput: async () => undefined,
      requestInput: async (request: { requestId: string }) => {
        requested = request.requestId;
      },
    };

    // A build turn is executing a plan the user already approved, so even a
    // tool declared as needing approval runs instead of parking the run.
    const result = await executor.workflow.run(
      { prompt: "use the tool", agent: "build", errCode: 0, errMessage: "", workdir },
      context,
    );

    assert.equal(requested, undefined, "a build turn must not ask for approval");
    assert.deepEqual(runs, ["x"]);
    assert.equal(result.toolCallCount, 1);
  });
});

test("a tool factory's own resources are released when the run ends", async () => {
  const closed: string[] = [];
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    () => ai.fauxAssistantMessage([ai.fauxText("done")]),
    () => ai.fauxAssistantMessage([ai.fauxText("done again")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const abort = new AbortController();
    let failNextRun = false;
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      models,
      resolvedModel: model,
      createTools: async () => {
        // The factory runs after the run has begun and before the model does,
        // so aborting here fails the turn for certain — which is the point:
        // a resource started and then interrupted still has to be released.
        if (failNextRun) abort.abort();
        return {
          tools: [],
          close: async () => {
            closed.push("closed");
          },
        };
      },
    });

    await executor.workflow.run(
      { prompt: "hello", errCode: 0, errMessage: "", workdir },
      createContext("conv-tool-set"),
    );
    assert.deepEqual(closed, ["closed"], "a finished run must not leave its resources behind");

    // A run that fails has to release them too: a child process left behind is
    // a leak whether or not the turn succeeded.
    failNextRun = true;
    const failing = createContext("conv-tool-set");
    failing.abortSignal = abort.signal;
    await assert.rejects(async () => {
      await executor.workflow.run(
        { prompt: "again", errCode: 0, errMessage: "", workdir },
        failing,
      );
    });
    assert.deepEqual(closed, ["closed", "closed"]);
  });
});

test("a resource that will not release does not decide the run", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("external_thing", { value: "x" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("ran it")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      models,
      resolvedModel: model,
      createTools: () => ({
        tools: [{
          name: "external_thing",
          label: "External",
          description: "A caller-supplied tool.",
          parameters: { type: "object", properties: { value: { type: "string" } } },
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        } as never],
        close: async () => {
          // A child process that will not exit is worth knowing about, but it
          // is not the run's result.
          throw new Error("the child refused to exit");
        },
      }),
    });

    const context = createContext("conv-tool-close-failure");
    context.toolPermissions = createToolPermissionContext([
      { name: "external_thing", autoApprove: false },
    ]);
    let requested: string | undefined;
    context.userInput = {
      getResolvedInput: async () => undefined,
      requestInput: async (request: { requestId: string }) => {
        requested = request.requestId;
      },
    };

    // The pause has to survive the cleanup: a run that pauses and reports
    // success identically, but where the caller sees a cleanup failure, is
    // not resumable.
    await assert.rejects(
      async () => {
        await executor.workflow.run({ prompt: "use the tool", agent: "plan", errCode: 0, errMessage: "", workdir }, context);
      },
      (error: Error & { type?: string }) => error.type === "user_input_required",
    );
    assert.ok(requested, "the gate must have asked for approval");
  });
});

test("the plan approval asks for a decision, not a bare yes/no", async () => {
  const request = createAgentPlanApprovalRequest({ requestId: "r1", plan: "1. do the thing" });

  // A radio plus an instructions field, matching the built-in OpenCode project:
  // the two outcomes explain themselves and a user can redirect the plan
  // without rejecting it.
  assert.deepEqual(request.params.map((param) => param.name), ["decision", "instructions"]);
  assert.equal(request.params[0]?.control, "radio");
  assert.equal(request.params[1]?.control, "textarea");
  assert.deepEqual(
    (request.params[0] as { options?: Array<{ value: string }> }).options?.map((option) => option.value),
    ["approve", "decline"],
  );

  const approved = readAgentPlanDecision({
    requestId: "r1",
    nodeName: "plan-approval",
    values: { decision: "approve", instructions: "  keep it small  " },
    submittedAt: new Date(),
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.instructions, "keep it small");

  const declined = readAgentPlanDecision({
    requestId: "r1",
    nodeName: "plan-approval",
    values: { decision: "decline" },
    submittedAt: new Date(),
  });
  assert.equal(declined.approved, false);
  assert.equal(declined.instructions, undefined);
});

test("an approved plan resumes as a build turn that runs it", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const prompts: string[] = [];
  faux.setResponses([
    (context: { messages: Array<{ content: unknown }> }) => {
      prompts.push(JSON.stringify(context.messages));
      return ai.fauxAssistantMessage([ai.fauxText("已按计划执行")]);
    },
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
    const context = createContext("conv-resume");
    const requestId = "agent-plan-approval:agent";
    await context.conversation.setValue("agent.pendingPlanApproval", {
      requestId,
      plan: "1. 先做第一步",
    });
    context.userInput = {
      getResolvedInput: async (id: string) => (id === requestId
        ? { requestId, nodeName: "plan-approval", values: { decision: "approve" }, submittedAt: new Date() }
        : undefined),
      requestInput: async () => undefined,
    };

    const result = await executor.workflow.run(
      { prompt: "原始请求", errCode: 0, errMessage: "", workdir, agent: "plan" },
      context,
    );

    // The resume re-sends the plan, so a compaction before the approval cannot
    // drop it, and it runs in build mode rather than planning again.
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Execute the approved plan/);
    assert.match(prompts[0] ?? "", /先做第一步/);
    assert.equal(result.agent, "build");
    const texts = result.items.filter((item) => item.metadata?.["partType"] === "text");
    assert.equal(texts.length, 1, "the resumed turn answers instead of planning again");
    assert.equal(result.items.filter((item) => item.metadata?.["plan"] === true).length, 0);
  });
});

test("plan mode shows the plan once, and not in the answer body", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("1. read the code\n2. propose")])] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
    const result = await executor.workflow.run(
      { prompt: "plan it", errCode: 0, errMessage: "", workdir, agent: "plan" },
      createContext("conv-plan"),
    );

    const plans = result.items.filter((item) => item.metadata?.["plan"] === true);
    const answers = result.items.filter((item) => item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.answer);

    // The same text once as the answer and once as the Plan row is the
    // duplicate the plan row was introduced to avoid.
    assert.equal(plans.length, 1, "exactly one Plan row");
    assert.equal(answers.length, 0, "no answer item during a plan turn");
    assert.equal(plans[0]?.content, "1. read the code\n2. propose");
    // The conversation still records what the turn produced.
    assert.equal(result.prompt, "plan it");
  });
});

test("plan introductions stay before the tool and the final plan remains in conversation history", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxText("Let me look. "), ai.fauxToolCall("ls", {})], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("1. read the code\n2. propose")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
    const context = createContext("conv-plan-introduction");
    const result = await executor.workflow.run(
      { prompt: "plan it", errCode: 0, errMessage: "", workdir, agent: "plan" }, context,
    );

    const transcriptItems = result.items.filter((item) => item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.part ||
      item.metadata?.["plan"] === true);
    assert.deepEqual(transcriptItems.map((item) => [item.metadata?.["kind"], item.metadata?.["partType"]]), [
      [AGENT_OUTPUT_KINDS.part, "text"],
      [AGENT_OUTPUT_KINDS.part, "tool"],
      [AGENT_OUTPUT_KINDS.notice, undefined],
    ]);
    assert.equal(result.items[0]?.content, "Let me look. ");
    assert.equal(result.items[0]?.metadata?.["plan"], undefined);
    assert.equal(transcriptItems.at(-1)?.content, "1. read the code\n2. propose");
    assert.equal(transcriptItems.at(-1)?.metadata?.["plan"], true);
    const state = await context.conversation.getValue();
    assert.equal(state.messages.at(-1)?.content, "Let me look. 1. read the code\n2. propose");
  });
});

test("a host-driven plan streams into its declared answer without a duplicate plan card", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("1. read the code\n2. propose")])] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi", outputItemId: "pi-answer", models, resolvedModel: model,
    });
    const result = await executor.workflow.run({
      prompt: "plan it", errCode: 0, errMessage: "", workdir, agent: "plan", hostInput: { messages: [] },
    }, createContext("conv-host-plan"));

    const answer = result.items.find((item) => item.id === "pi-answer");
    assert.equal(answer?.metadata?.["kind"], AGENT_OUTPUT_KINDS.answer);
    assert.equal(answer?.content, "1. read the code\n2. propose");
    assert.equal(result.items.some((item) => item.metadata?.["plan"] === true), false);
  });
});

for (const outcome of ["failed", "aborted"] as const) {
  test(`${outcome === "failed" ? "A failed" : "An aborted"} plan turn keeps partial text as ordinary output`, async () => {
    const { ai, faux, models, model } = await createFauxModel();
    faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("Still gathering requirements.")], outcome === "failed"
      ? { stopReason: "error", errorMessage: "upstream refused the request" }
      : {})] as never[]);

    await withTempDir(async (workdir) => {
      const context = createContext(`conv-plan-${outcome}`);
      if (outcome === "aborted") {
        const controller = new AbortController();
        context.abortSignal = controller.signal;
        context.tokenUsage.report = async () => { controller.abort(); };
      }
      const node = createAgentNode({ models, resolvedModel: model });
      const input = { prompt: "plan it", errCode: 0, errMessage: "", workdir, agent: "plan" as const };
      const chunks: OutputItemStreamChunk[] = [];
      await assert.rejects(async () => {
        for await (const chunk of node.stream(input, context)) chunks.push(chunk);
      }, (error: unknown) => error instanceof HarnessError && error.type ===
        (outcome === "failed" ? "execution" : "execution_aborted"));

      assert.ok(node.finalize);
      const result = await node.finalize(chunks, context, input);
      assert.equal(result.items.some((item) => item.metadata?.["plan"] === true), false);
      assert.equal(result.items.find((item) => item.metadata?.["partType"] === "text")?.content,
        "Still gathering requirements.");
      assert.equal(result.items.some((item) => item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.error),
        outcome === "failed");
    });
  });
}

test("the agent emits context usage as a standard ring output pinned to the composer", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  // Two runs below, so two answers: a turn whose model call never happened is
  // a failed run now, not a quiet one.
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxText("hello")]),
    ai.fauxAssistantMessage([ai.fauxText("hello")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
    const result = await executor.workflow.run(
      { prompt: "hi", errCode: 0, errMessage: "", workdir },
      createContext("conv-usage"),
    );

    assert.ok(result.contextUsage, "contextUsage must reach the output payload");
    assert.equal(result.contextUsage.total, 1_000);
    assert.ok(result.contextUsage.used > 0);
    const ring = result.items.find((item) => item.display?.type === "ring");
    assert.ok(ring, "context must be present in the standard output items");
    assert.deepEqual(ring.display, { type: "ring", placement: "composer-right" });
    assert.deepEqual(ring.content, { value: result.contextUsage.used, total: 1_000, unit: "tokens" });

    // An explicit window overrides what the model advertises.
    const overridden = await executor.workflow.run(
      { prompt: "hi", errCode: 0, errMessage: "", workdir, contextWindow: 5_000 },
      createContext("conv-usage-2"),
    );
    assert.equal(overridden.contextUsage?.total, 5_000);
    const nextRing = overridden.items.find((item) => item.display?.type === "ring");
    assert.equal(nextRing?.id, ring.id, "a later turn updates the same pinned item");
    assert.deepEqual(nextRing?.content, { value: overridden.contextUsage?.used, total: 5_000, unit: "tokens" });
  });
});

test("the context ring streams before the provider responds and retains its final value", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  let called = false;
  faux.setResponses([() => {
    called = true;
    return ai.fauxAssistantMessage("answer".repeat(50));
  }] as never[]);
  await withTempDir(async (workdir) => {
    const context = createContext("conv-live-context");
    const node = createAgentNode({ models, resolvedModel: model });
    const input = { prompt: "hello", workdir, errCode: 0, errMessage: "" };
    const events = node.stream(input, context)[Symbol.asyncIterator]();
    const first = await events.next();
    assert.equal(called, false);
    assert.equal(first.value?.type, "output_item_start");
    assert.ok(first.value?.type === "output_item_start");
    assert.deepEqual(first.value.item.display, { type: "ring", placement: "composer-right" });
    assert.deepEqual(first.value.item.content, { value: 0, total: 1_000, unit: "tokens" });
    const chunks: OutputItemStreamChunk[] = [first.value];
    for (let next = await events.next(); !next.done; next = await events.next()) chunks.push(next.value);
    const updates = chunks.filter((chunk) => chunk.type === "output_item_start" && chunk.item.display?.type === "ring");
    assert.ok(updates.length > 2);
    assert.ok(node.finalize);
    const result = await node.finalize(chunks, context, input);
    const ring = result.items.find((item) => item.display?.type === "ring");
    assert.deepEqual(ring?.content, { value: result.contextUsage?.used, total: 1_000, unit: "tokens" });
    assert.ok(result.contextUsage!.used > 0);
  });
});

test("context output IDs keep distinct session keys separate", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const sessionKeys = ["research notes", "research-notes", "\u5206\u6790", "\u89c4\u5212"];
  faux.setResponses(Array.from({ length: sessionKeys.length + 1 }, () =>
    ai.fauxAssistantMessage([ai.fauxText("hello")])) as never[]);

  await withTempDir(async (workdir) => {
    const context = createContext("conv-multiple-agents");
    const ids: string[] = [];
    for (const sessionKey of [...sessionKeys, sessionKeys[0]]) {
      const executor = defineAgentConversationExecutor({ projectName: "pi", sessionKey, models, resolvedModel: model });
      const result = await executor.workflow.run({ prompt: "hi", errCode: 0, errMessage: "", workdir }, context);
      const ring = result.items.find((item) => item.display?.placement === "composer-right");
      assert.ok(ring);
      ids.push(ring.id);
    }
    assert.equal(new Set(ids.slice(0, sessionKeys.length)).size, sessionKeys.length);
    assert.equal(ids.at(-1), ids[0], "later turns must update the same session's ring");
    assert.equal(ids[1], "agent-context-research-notes", "existing ASCII IDs stay stable");
  });
});

test("the permission policy decides how far the tools reach", async () => {
  // Asserted through what the run does rather than through a list recomputed
  // from the same policy: a policy that stopped reaching the tool set would
  // still satisfy the latter.
  const cases = [
    { policy: "auto" as const, writes: true },
    { policy: "workspace" as const, writes: true },
    { policy: "read-only" as const, writes: false },
  ];

  for (const item of cases) {
    const { ai, faux, models, model } = await createFauxModel();
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "note.txt", content: "x" })], { stopReason: "toolUse" }),
      ai.fauxAssistantMessage([ai.fauxText("done")]),
    ] as never[]);

    await withTempDir(async (workdir) => {
      const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
      const result = await executor.workflow.run(
        { prompt: "hi", errCode: 0, errMessage: "", workdir, permissionPolicy: item.policy },
        createContext(`conv-${item.policy}`),
      );

      assert.equal(result.errCode, 0);
      const written = await readFile(path.join(workdir, "note.txt"), "utf8").catch(() => undefined);
      assert.equal(written, item.writes ? "x" : undefined, `${item.policy} wrote ${String(written)}`);
    });
  }
});

test("a write runs without asking under the aligned policies", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "note.txt", content: "x" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("done")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
    const result = await executor.workflow.run(
      { prompt: "write a file", errCode: 0, errMessage: "", workdir, permissionPolicy: "workspace" },
      createContext("conv-write"),
    );

    // OpenCode's `workspace` approves edits inside the workspace, so the call
    // must not park on a user-input node.
    assert.equal(await readFile(path.join(workdir, "note.txt"), "utf8"), "x");
    assert.equal(result.toolCallCount, 1);
    const tool = result.items.find((item) => item.metadata?.["partType"] === "tool");
    assert.deepEqual((tool?.content as { input?: unknown } | undefined)?.input, {
      path: "note.txt", content: "x",
    });
  });
});

test("reasoning and tool rows are emitted alongside the answer", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxThinking("weighing options"), ai.fauxToolCall("ls", {})], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("all done")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
    const result = await executor.workflow.run(
      { prompt: "list the directory", errCode: 0, errMessage: "", workdir },
      createContext("conv-2"),
    );

    const kinds = result.items.map((item) => [
      item.metadata?.["kind"],
      item.metadata?.["partType"],
    ]);

    // The model's thinking is kept as its own collapsed row rather than dropped.
    assert.equal(
      result.items.some((item) =>
        item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.part && item.metadata["partType"] === "reasoning"),
      true,
      `reasoning row missing in ${JSON.stringify(kinds)}`,
    );
    assert.equal(
      result.items.some((item) =>
        item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.part && item.metadata["partType"] === "tool"),
      true,
    );
    assert.equal(result.toolCallCount, 1);
  });
});

test("thinking reaches the host while it happens, not once it is over", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxThinking("weighing options"), ai.fauxText("all done")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({ projectName: "pi", models, resolvedModel: model });
    const chunks: Array<Record<string, unknown>> = [];
    const context = {
      ...createContext("conv-reasoning"),
      nodeHooks: {
        onNodeChunk(event: { chunk: Record<string, unknown> }) {
          chunks.push(event.chunk);
        },
      },
    } as unknown as RunContext;

    await executor.workflow.run(
      { prompt: "list the directory", errCode: 0, errMessage: "", workdir },
      context,
    );

    const readPart = (chunk: Record<string, unknown>) => {
      const item = chunk["item"];
      return item === undefined || item === null
        ? undefined
        : (item as { metadata?: Record<string, unknown> }).metadata?.["partType"];
    };
    const reasoningStart = chunks.findIndex((chunk) =>
      chunk["type"] === "output_item_start" && readPart(chunk) === "reasoning");
    const answerStart = chunks.findIndex((chunk) =>
      chunk["type"] === "output_item_start" && readPart(chunk) === "text");

    assert.ok(reasoningStart >= 0, "the reasoning row must open");
    assert.equal(
      (chunks[reasoningStart]?.["item"] as { metadata?: Record<string, unknown> } | undefined)
        ?.metadata?.["status"],
      "running",
      "the row opens as running, which is what makes it visible while the model thinks",
    );
    // A host that only saw the row after the thinking would have been showing
    // nothing at all for the whole phase.
    assert.ok(
      answerStart === -1 || answerStart > reasoningStart,
      "the reasoning row must appear before the answer it precedes",
    );

    const reasoningId = (chunks[reasoningStart]?.["item"] as { id?: string } | undefined)?.id;
    assert.equal(
      chunks.some((chunk) => chunk["type"] === "output_item_end" && chunk["itemId"] === reasoningId),
      true,
      "the row has to be closed once the thinking is over",
    );
  });
});

test("a conversation run streams its text as a row and appends it to the conversation", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("hello from the agent")])] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-1");
    const result = await executor.workflow.run(
      { prompt: "hi", errCode: 0, errMessage: "", workdir },
      context,
    );

    assert.equal(result.errCode, 0);
    assert.equal(result.prompt, "hi");
    assert.equal(result.agent, "build");
    assert.equal(result.workdir, workdir);

    // A conversation writes its text where it was spoken, so the turn is a
    // text row rather than the declared answer item — that item exists for a
    // host that reads the response text back by id.
    assert.deepEqual(
      result.items.filter((item) => item.display?.placement !== "composer-right")
        .map((item) => [item.metadata?.["kind"], item.metadata?.["partType"]]),
      [[AGENT_OUTPUT_KINDS.part, "text"]],
    );
    const text = result.items.find((item) => item.metadata?.["partType"] === "text");
    assert.equal(text?.content, "hello from the agent");
    assert.equal(text?.collapsed, false);
    assert.equal(text?.title, "Output");

    const state = await context.conversation.getValue();
    assert.deepEqual(
      state.messages.map((message) => [message.role, message.content]),
      [["user", "hi"], ["assistant", "hello from the agent"]],
    );
  });
});

test("a host-input run leaves the workflow conversation alone", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("hello from the agent")])] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-2");
    const result = await executor.workflow.run(
      {
        prompt: "hi",
        errCode: 0,
        errMessage: "",
        workdir,
        // The gateway keeps this run's transcript in its own store, the same
        // arrangement the built-in conversation project makes.
        hostInput: { kind: "openai.responses" },
      },
      context,
    );

    assert.equal(result.errCode, 0);
    // A host reads the response text out of this one item, and it only knows
    // the id the project declared: the item has to carry exactly that, and the
    // whole turn's text. It is not broken up the way a conversation's rows are,
    // because the host renders the transcript itself.
    const answer = result.items.find((item) => item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.answer);
    assert.ok(answer, "the answer item must be present");
    assert.equal(answer.id, "pi-answer");
    assert.equal(answer.content, "hello from the agent");
    assert.equal(answer.collapsed, false);

    const state = await context.conversation.getValue();
    assert.deepEqual(state.messages, []);
  });
});

test("a turn that only called tools appends no empty answer", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("ls", {})], { stopReason: "toolUse" }),
    // The tool result goes back to the model, and this turn it answers with
    // nothing at all — the case a conversation used to record as an empty
    // assistant message.
    ai.fauxAssistantMessage([]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-3");
    const result = await executor.workflow.run(
      { prompt: "list the files", errCode: 0, errMessage: "", workdir },
      context,
    );

    const state = await context.conversation.getValue();
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ["user"],
    );
    // The tool row is what the turn has to show; an empty follow-up adds no
    // second row of its own.
    assert.deepEqual(
      result.items.filter((item) => item.display?.placement !== "composer-right")
        .map((item) => item.metadata?.["kind"]),
      [AGENT_OUTPUT_KINDS.part],
    );
  });
});

/**
 * The run the user actually had: the model got half an answer out, the
 * connection died, and the whole turn was thrown away over a word from the
 * transport. Now the half answer is kept and the turn carries on from it — and
 * the transcript says why, so an answer that resumes mid-sentence does not read
 * as the model repeating itself.
 */
test("a stream cut off mid-answer is continued, and the turn says so", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxText("half an answer")], {
      stopReason: "error",
      errorMessage: "terminated",
    }),
    ai.fauxAssistantMessage([ai.fauxText(" and the rest")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const result = await executor.workflow.run(
      { prompt: "hi", errCode: 0, errMessage: "", workdir },
      createContext("conv-continued"),
    );

    const rows = result.items.filter((item) => item.metadata?.["partType"] === "retry");
    assert.equal(rows.length, 1, "the interruption has to be visible, not silent");
    assert.equal(rows[0]?.collapsed, true);
    assert.deepEqual(result.items.filter(item => item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.part)
      .map(item => item.metadata?.["partType"]), ["text", "retry", "text"]);

    const text = result.items
      .map((item) => (typeof item.content === "string" ? item.content : ""))
      .join("");
    assert.match(text, /half an answer/);
    assert.match(text, /and the rest/);
  });
});

test("restarted retry sequences keep separate rows after a successful tool request", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage("First partial", { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Second partial", { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage("Finished"),
  ]);
  await withTempDir(async workdir => {
    const executor = defineAgentConversationExecutor({ models, resolvedModel: model });
    const result = await executor.workflow.run({ prompt: "Inspect then continue", errCode: 0, errMessage: "", workdir }, createContext("retry-reset"));
    const retries = result.items.filter(item => item.metadata?.partType === "retry");
    assert.equal(retries.length, 2);
    assert.equal(new Set(retries.map(item => item.id)).size, 2);
    assert.deepEqual(retries.map(item => (item.content as { attempt: number }).attempt), [1, 1]);
    const positions = retries.map(item => result.items.indexOf(item));
    assert.ok(positions[0]! < result.items.findIndex(item => item.content === "Second partial"));
    assert.ok(positions[1]! > result.items.findIndex(item => item.content === "Second partial"));
  });
});

test("a retry follows interrupted thinking before the resumed answer", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxThinking("Partial reasoning")], { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage("Recovered answer"),
  ] as never[]);
  await withTempDir(async workdir => {
    const executor = defineAgentConversationExecutor({ models, resolvedModel: model });
    const result = await executor.workflow.run({ prompt: "Think then answer", errCode: 0, errMessage: "", workdir }, createContext("thinking-retry"));
    assert.deepEqual(result.items.filter(item => item.metadata?.kind === AGENT_OUTPUT_KINDS.part)
      .map(item => item.metadata?.partType), ["reasoning", "retry", "text"]);
  });
});

test("a provider failure reaches the host as a failure", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream refused the request" }),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    await assert.rejects(async () => {
      await executor.workflow.run(
        { prompt: "hi", errCode: 0, errMessage: "", workdir },
        createContext("conv-failed"),
      );
    }, /upstream refused the request/);
  });
});

test("a turn's text stays where it was written, on either side of its tool", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    // The model opens with a sentence and immediately calls a tool, then
    // finishes the answer after the tool came back.
    ai.fauxAssistantMessage([ai.fauxText("Let me look. "), ai.fauxToolCall("ls", {})], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("There are three files.")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-order");
    const result = await executor.workflow.run(
      { prompt: "list the files", errCode: 0, errMessage: "", workdir },
      context,
    );

    // The opening sentence keeps its place above the tool it introduced, and
    // the sentence written after the tool comes after it — one row per run of
    // text, in the order the model wrote them.
    assert.deepEqual(
      result.items.filter((item) => item.display?.placement !== "composer-right")
        .map((item) => [item.metadata?.["kind"], item.metadata?.["partType"]]),
      [
        [AGENT_OUTPUT_KINDS.part, "text"],
        [AGENT_OUTPUT_KINDS.part, "tool"],
        [AGENT_OUTPUT_KINDS.part, "text"],
      ],
    );
    assert.equal(result.items[0]?.content, "Let me look. ");
    assert.equal(result.items.at(-1)?.content, "There are three files.");

    // The conversation message is the same answer, so the history agrees with
    // what the turn showed.
    const state = await context.conversation.getValue();
    assert.deepEqual(
      state.messages.map((message) => [message.role, message.content]),
      [["user", "list the files"], ["assistant", "Let me look. There are three files."]],
    );
  });
});

test("a turn the model answered with nothing still says so", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  // An assistant message with no content at all: no text, no tool call. The
  // host closes a turn when output arrives, so a silent one leaves it waiting.
  faux.setResponses([ai.fauxAssistantMessage([])] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const result = await executor.workflow.run(
      { prompt: "hi", errCode: 0, errMessage: "", workdir },
      createContext("conv-empty"),
    );

    assert.equal(result.errCode, 0);
    const rows = result.items.filter((item) => item.display?.placement !== "composer-right");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.metadata?.["kind"], AGENT_OUTPUT_KINDS.notice);
  });
});

test("a second turn in the same conversation sees the first one", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  // Every turn is its own process, so the only thing that can carry the first
  // turn into the second is what the first one left behind.
  const requests: string[][] = [];
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxText("first answer")]),
    ((request: { messages: AgentRequestMessage[] }) => {
      requests.push(readRequestLines(request.messages));
      return ai.fauxAssistantMessage([ai.fauxText("second answer")]);
    }) as never,
  ] as never[]);

  await withTempDir(async (workdir) => {
    // A fresh executor per turn is what the host actually does: every message
    // is a new process, so nothing the first turn held in memory can reach the
    // second one. The conversation store is the only channel between them.
    const turn = () => defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-history");
    await turn().workflow.run({ prompt: "hello", errCode: 0, errMessage: "", workdir }, context);
    await turn().workflow.run({ prompt: "what did I just say?", errCode: 0, errMessage: "", workdir }, context);
  });

  assert.equal(requests.length, 1, "the second turn must have reached the model");
  assert.deepEqual(requests[0], [
    "user:hello",
    "assistant:first answer",
    "user:what did I just say?",
  ]);
});

test("a tool call and its result are still there on the next turn", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const requests: string[][] = [];
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("ls", {})], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("three files")]),
    ((request: { messages: AgentRequestMessage[] }) => {
      requests.push(readRequestLines(request.messages));
      return ai.fauxAssistantMessage([ai.fauxText("still three")]);
    }) as never,
  ] as never[]);

  await withTempDir(async (workdir) => {
    const turn = () => defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-tool-history");
    await turn().workflow.run({ prompt: "list them", errCode: 0, errMessage: "", workdir }, context);
    await turn().workflow.run({ prompt: "and now?", errCode: 0, errMessage: "", workdir }, context);
  });

  // What the model did — not just what it said — is what it has to remember:
  // a coding assistant that forgets it listed the directory lists it again.
  assert.deepEqual(
    requests[0]?.map((line) => line.split(":")[0]),
    ["user", "assistant", "toolResult", "assistant", "user"],
  );
  assert.match(requests[0]?.[1] ?? "", /<toolCall:ls>/);
});

test("a cancelled turn leaves the conversation where it was", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const requests: string[][] = [];
  const cancelled = new AbortController();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxText("first answer")]),
    (() => {
      cancelled.abort();
      return ai.fauxAssistantMessage([ai.fauxText("never sent")]);
    }) as never,
    ((request: { messages: AgentRequestMessage[] }) => {
      requests.push(readRequestLines(request.messages));
      return ai.fauxAssistantMessage([ai.fauxText("third answer")]);
    }) as never,
  ] as never[]);

  await withTempDir(async (workdir) => {
    const turn = () => defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-cancelled");
    await turn().workflow.run({ prompt: "hello", errCode: 0, errMessage: "", workdir }, context);

    context.abortSignal = cancelled.signal;
    await assert.rejects(async () => {
      await turn().workflow.run({ prompt: "and now?", errCode: 0, errMessage: "", workdir }, context);
    });

    // The turn after the cancellation still knows what was said before it.
    context.abortSignal = undefined;
    await turn().workflow.run({ prompt: "still there?", errCode: 0, errMessage: "", workdir }, context);

    // A cancelled turn is not history: whatever it left half-done is dropped
    // rather than sent back, where it would fail the whole next request.
    const stored = await readStoredTranscript(context);
    assert.match(JSON.stringify(stored), /first answer/);
  });

  assert.deepEqual(requests[0]?.slice(0, 2), ["user:hello", "assistant:first answer"]);
});

test("a plan turn can ask the user, and the answers carry on into the resumed turn", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const requests: string[][] = [];
  const askTheQuestion = () => {
    faux.setResponses([
      ai.fauxAssistantMessage([
        ai.fauxText("Which scope should the plan cover? "),
        ai.fauxToolCall("ask_user", {
          questions: [{
            question: "Which directory should I look at first?",
            header: "Scope",
            options: [{ label: "core", description: "Core runtime." }, { label: "desktop" }],
            custom: true,
          }],
        }),
      ], { stopReason: "toolUse" }),
    ] as never[]);
  };
  const readTheAnswer = () => {
    faux.setResponses([
      ((request: { messages: AgentRequestMessage[] }) => {
        requests.push(readRequestLines(request.messages));
        return ai.fauxAssistantMessage([ai.fauxText("1. read the code")]);
      }) as never,
    ] as never[]);
  };
  askTheQuestion();

  await withTempDir(async (workdir) => {
    const turn = () => createAgentNode({
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-ask");
    let asked: UserInputRequest | undefined;
    context.userInput = {
      getResolvedInput: async () => undefined,
      requestInput: async (request: UserInputRequest) => {
        asked = request;
      },
    };

    // The question parks the run rather than being answered by the model.
    const input = { prompt: "plan it", requestId: "ask-run", agent: "plan" as const, errCode: 0, errMessage: "", workdir };
    const askingNode = turn();
    const askingChunks: OutputItemStreamChunk[] = [];
    await assert.rejects(async () => {
      for await (const chunk of askingNode.stream(input, context)) askingChunks.push(chunk);
    }, (error: Error & { type?: string; nodeName?: string }) =>
      error.type === "user_input_required" && error.nodeName === "ask-user");

    assert.ok(askingNode.finalize);
    const askingOutput = await askingNode.finalize(askingChunks, context, input);
    assert.equal(askingOutput.items.some((item) => item.metadata?.["plan"] === true), false);
    assert.deepEqual(askingOutput.items.filter((item) => item.metadata?.["partType"] === "text")
      .map((item) => item.content), ["Which scope should the plan cover? "]);
    const pausedState = await context.conversation.getValue();
    assert.equal(pausedState.values["agent.pendingPlanApproval"], undefined);

    assert.ok(asked, "the model's question must reach the user");
    assert.equal(asked?.nodeName, "ask-user");
    assert.equal(asked?.title, "Scope");
    // One step per question, and the custom answer box belongs to it.
    assert.deepEqual(asked?.params.map((param) => param.name), ["question_1", "question_1_custom"]);
    assert.equal(asked?.params[0]?.label, "Which directory should I look at first?");
    assert.equal(asked?.params[0]?.step, 1);
    assert.equal(asked?.params[1]?.step, 1);
    assert.deepEqual(asked?.params[0]?.options?.map((option) => option.label), ["core", "desktop", "我来写"]);
    assert.equal(asked?.metadata?.type, "agent-ask");

    // Answering it resumes the plan with the answers in the prompt.
    const requestId = asked?.requestId ?? "";
    context.userInput = {
      getResolvedInput: async (id: string, request?: UserInputRequest) => (id === requestId
        ? {
            requestId: id,
            nodeName: "ask-user",
            values: { question_1: "custom", question_1_custom: "or the CLI" },
            submittedAt: new Date(),
            request,
          }
        : undefined),
      requestInput: async () => undefined,
    };

    readTheAnswer();
    // The plan carries on and, having written one, ends where a plan turn
    // always ends: on the approval of the plan it just produced.
    const planningNode = turn();
    const planningChunks: OutputItemStreamChunk[] = [];
    await assert.rejects(async () => {
      for await (const chunk of planningNode.stream(input, context)) planningChunks.push(chunk);
    }, (error: Error & { type?: string; nodeName?: string }) =>
      error.type === "user_input_required" && error.nodeName === "plan-approval");

    assert.ok(planningNode.finalize);
    const planningOutput = await planningNode.finalize(planningChunks, context, input);
    assert.deepEqual(planningOutput.items.filter((item) => item.metadata?.["plan"] === true)
      .map((item) => item.content), ["1. read the code"]);

    const resumed = requests[0]?.join("\n") ?? "";
    assert.match(resumed, /toolResult:/);
    assert.match(resumed, /<toolCall:ask_user>/);
    // The label the user picked, not the value the form stored.
    assert.match(resumed, /or the CLI/);
  });
});

test("a build turn is never offered the asking tool", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([
      ai.fauxToolCall("ask_user", { questions: [{ question: "Which one?", options: [{ label: "a" }] }] }),
    ], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxText("done")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-ask-build");
    let asked: string | undefined;
    context.userInput = {
      getResolvedInput: async () => undefined,
      requestInput: async (request: UserInputRequest) => {
        asked = request.requestId;
      },
    };

    // A build turn is running an agreed plan: the call cannot reach the user,
    // so the run finishes instead of parking.
    const result = await executor.workflow.run(
      { prompt: "do it", agent: "build", errCode: 0, errMessage: "", workdir },
      context,
    );

    assert.equal(asked, undefined);
    assert.equal(result.errCode, 0);
  });
});

test("a plan pause is remembered by the turn that resumes it", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const requests: string[][] = [];
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxText("1. read the code")]),
    ((request: { messages: AgentRequestMessage[] }) => {
      requests.push(readRequestLines(request.messages));
      return ai.fauxAssistantMessage([ai.fauxText("done")]);
    }) as never,
  ] as never[]);

  await withTempDir(async (workdir) => {
    const turn = () => defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-plan-history");
    let requested: string | undefined;
    let answeredLabel: string | undefined;
    context.userInput = {
      getResolvedInput: async () => undefined,
      requestInput: async (request: { requestId: string }) => {
        requested = request.requestId;
      },
    };

    await assert.rejects(async () => {
      await turn().workflow.run(
        { prompt: "plan it", errCode: 0, errMessage: "", workdir, agent: "plan" },
        context,
      );
    }, (error: Error & { type?: string }) => error.type === "user_input_required");
    assert.ok(requested, "the plan must have been put to the user");

    context.userInput = {
      getResolvedInput: async (id: string, request?: UserInputRequest) => {
        if (id !== requested) return undefined;
        answeredLabel = request?.params[0]?.label;
        return { requestId: id, nodeName: "plan-approval", values: { decision: "approve" }, submittedAt: new Date(), request };
      },
      requestInput: async () => undefined,
    };
    await turn().workflow.run(
      { prompt: "plan it", errCode: 0, errMessage: "", workdir, agent: "plan" },
      context,
    );
    // The answer comes back with the question it answered, which is what lets
    // a host show the user their own choice instead of the stored value.
    assert.equal(answeredLabel, "如何处理这份计划");
  });

  // The plan survives the process that produced it, so the resumed turn reads
  // as a continuation rather than as a fresh instruction to plan again.
  assert.deepEqual(requests[0]?.slice(0, 2), ["user:plan it", "assistant:1. read the code"]);
});

test("each revised plan waits for a fresh decision before executing", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const prompts: string[] = [];
  const plans = ["1. read the code", "1. update note.txt", "1. update note.txt"];
  faux.setResponses([
    ...plans.map((plan) => ((request: { messages: AgentRequestMessage[] }) => {
      prompts.push(readRequestLines(request.messages).join("\n"));
      return ai.fauxAssistantMessage([ai.fauxThinking("Considering the plan."), ai.fauxText(plan)]);
    }) as never),
    ((request: { messages: AgentRequestMessage[] }) => {
      prompts.push(readRequestLines(request.messages).join("\n"));
      return ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "note.txt", content: "approved" })], { stopReason: "toolUse" });
    }) as never,
    ai.fauxAssistantMessage([ai.fauxText("done")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const context = createContext("conv-plan-revisions");
    const requests: UserInputRequest[] = [];
    const answers = new Map<string, Record<string, unknown>>();
    context.userInput = {
      getResolvedInput: async (requestId: string, request?: UserInputRequest) => {
        const values = answers.get(requestId);
        return values === undefined ? undefined : {
          requestId, nodeName: "plan-approval", values, submittedAt: new Date(), request,
        };
      },
      requestInput: async (request: UserInputRequest) => { requests.push(request); },
    };
    const input = { prompt: "plan it", agent: "plan" as const, errCode: 0, errMessage: "", workdir };
    const turn = () => createAgentNode({ outputItemId: "pi-answer", models, resolvedModel: model });
    const outputIds = new Set<string>();

    for (let index = 0; index < plans.length; index++) {
      const node = turn();
      const chunks: OutputItemStreamChunk[] = [];
      await assert.rejects(async () => {
        for await (const chunk of node.stream(input, context)) chunks.push(chunk);
      }, (error: Error & { type?: string; nodeName?: string }) =>
        error.type === "user_input_required" && error.nodeName === "plan-approval");
      assert.ok(node.finalize);
      const output = await node.finalize(chunks, context, input);
      assert.deepEqual(output.items.filter((item) => item.metadata?.["plan"] === true)
        .map((item) => item.content), [plans[index]]);
      assert.equal(output.items.some((item) => item.title === "Plan declined"), false);
      assert.ok(chunks.some((chunk) => chunk.type === "output_item_start"
        && chunk.item.display?.placement === "composer-right"), "context arrives through the standard stream before approval");
      for (const item of output.items.filter((item) => item.display?.placement !== "composer-right")) {
        assert.equal(outputIds.has(item.id), false, "resumed rows must not replace earlier plans or reasoning");
        outputIds.add(item.id);
      }
      assert.equal(requests.length, index + 1);
      assert.equal(new Set(requests.map((request) => request.requestId)).size, index + 1);
      await assert.rejects(() => readFile(path.join(workdir, "note.txt"), "utf8"));
      answers.set(requests[index]!.requestId, index < plans.length - 1
        ? { decision: "decline", instructions: `revision ${index + 1}` }
        : { decision: "approve" });
    }

    const node = turn();
    const chunks: OutputItemStreamChunk[] = [];
    for await (const chunk of node.stream(input, context)) chunks.push(chunk);
    assert.ok(node.finalize);
    const output = await node.finalize(chunks, context, input);
    assert.equal(output.items.some((item) => item.content === "done"), true);
    assert.equal(output.items.some((item) => outputIds.has(item.id)), false);
    assert.equal(await readFile(path.join(workdir, "note.txt"), "utf8"), "approved");
    assert.equal(requests.length, 3);
    assert.match(prompts[1] ?? "", /revision 1/);
    assert.match(prompts[2] ?? "", /revision 2/);
    assert.match(prompts[3] ?? "", /Execute the approved plan/);
    assert.match(prompts[3] ?? "", /1\. update note\.txt/);
  });
});

test("a pause for approval leaves a transcript that can be sent", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("external_thing", { value: "x" })], { stopReason: "toolUse" }),
    // The blocked call comes back as a tool error, so the turn settles before
    // the pause is raised and the model gets to speak once more.
    ai.fauxAssistantMessage([ai.fauxText("waiting for approval")]),
  ] as never[]);

  await withTempDir(async (workdir) => {
    const turn = () => defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
      createTools: () => [{
        name: "external_thing",
        label: "External",
        description: "A caller-supplied tool.",
        parameters: { type: "object", properties: { value: { type: "string" } } },
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      } as never],
    });

    const context = createContext("conv-approval-history");
    context.toolPermissions = createToolPermissionContext([
      { name: "external_thing", autoApprove: false },
    ]);
    context.userInput = {
      getResolvedInput: async () => undefined,
      requestInput: async () => undefined,
    };

    await assert.rejects(async () => {
      await turn().workflow.run({ prompt: "use the tool", agent: "plan", errCode: 0, errMessage: "", workdir }, context);
    }, (error: Error & { type?: string }) => error.type === "user_input_required");

    // Harness preserves the pending intent and projects an incomplete result
    // for model-context inspection until the original tool task is resumed.
    const stored = await readStoredTranscript(context);
    assert.deepEqual(stored.map((message) => message.role).slice(0, 3), ["user", "assistant", "toolResult"]);
    assert.match(JSON.stringify(stored), /external_thing/);
  });
});

test("a host-driven run neither reads nor writes the conversation transcript", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("from the gateway")])] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-host-input");
    await executor.workflow.run(
      {
        prompt: "hello from the gateway",
        errCode: 0,
        errMessage: "",
        workdir,
        // The gateway keeps this run's transcript in its own store; a second
        // copy here would be a record nothing keeps in step with it.
        hostInput: { kind: "openai.responses" },
      },
      context,
    );

    const state = await context.conversation.getValue();
    assert.deepEqual(Object.keys(state.values), []);
  });
});

test("a corrupt durable store fails without silently starting a new conversation", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const requests: string[][] = [];
  faux.setResponses([
    ((request: { messages: AgentRequestMessage[] }) => {
      requests.push(readRequestLines(request.messages));
      return ai.fauxAssistantMessage([ai.fauxText("starting over")]);
    }) as never,
  ] as never[]);

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    const context = createContext("conv-corrupt");
    await executor.workflow.run({ prompt: "First", workdir, errCode: 0, errMessage: "" }, context);
    const directory = agentConversationDirectory(context.metadata!["agentStoreDir"] as string, "conv-corrupt");
    const file = (await readdir(directory)).find(file => file.endsWith(".sqlite"))!;
    await writeFile(path.join(directory, file), "corrupt sqlite");
    await assert.rejects(async () => executor.workflow.run(
      { prompt: "hello", errCode: 0, errMessage: "", workdir },
      context,
    ));
  });

  assert.deepEqual(requests, [["user:First"]]);
});

test("an unknown flag is not typed into the prompt", () => {
  assert.equal(
    createAgentProjectInput(["--unknown", "value", "--message", "the real prompt"], {}).prompt,
    "the real prompt",
  );
  // A flag this project does not declare used to arrive as prompt text, along
  // with its value; nothing at all is a better prompt than "--unknown value".
  assert.equal(createAgentProjectInput(["--unknown", "value"], {}).prompt, "");
  assert.equal(createAgentProjectInput(["a bare prompt"], {}).prompt, "a bare prompt");
});

/** The `wf_…` reference a composer stores, pointing at bytes on disk. */
function createImageReference(id: string): FileReference {
  return {
    id,
    name: "image.png",
    mimeType: "image/png",
    size: 3,
    kind: "image",
    storage: "local",
    createdAt: "2026-09-21T00:00:00.000Z",
  };
}

/** Writes the file a local reference resolves to, and returns its store. */
async function createFileStore(rootDir: string, ids: readonly string[]): Promise<FileStore> {
  for (const id of ids) {
    await mkdir(path.join(rootDir, id), { recursive: true });
    await writeFile(path.join(rootDir, id, "content"), "hi!", "utf8");
  }
  return createLocalProjectFileStore({ rootDir });
}

test("createInput carries attachments as references the run resolves", () => {
  // A composer can only hand over what it stored; the bytes are reachable from
  // the workflow process, so the reference travels and the node reads it.
  const input = createAgentProjectInput(
    ["--images", JSON.stringify([createImageReference("wf-image")])],
    {},
  );

  assert.equal(input.prompt, "");
  assert.equal(input.images, undefined);
  assert.equal(input.imageFiles?.length, 1);
  assert.equal(input.imageFiles?.[0]?.id, "wf-image");
});

test("an image-only turn runs and says how many images it carried", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("a picture of a cat")])] as never[]);

  const previousLocale = process.env["STEAMHARNESS_RUNTIME_LOCALE"];
  process.env["STEAMHARNESS_RUNTIME_LOCALE"] = "en";
  try {
    await withTempDir(async (workdir) => {
      const files = await createFileStore(path.join(workdir, "files"), ["wf-image"]);
      const executor = defineAgentConversationExecutor({
        projectName: "pi",
        outputItemId: "pi-answer",
        models,
        resolvedModel: model,
      });

      const context = createContext("conv-image-only", files);
      const result = await executor.workflow.run(
        {
          prompt: "",
          errCode: 0,
          errMessage: "",
          workdir,
          imageFiles: [createImageReference("wf-image")],
        },
        context,
      );

      assert.equal(result.errCode, 0);
      assert.equal(result.items.find((item) => item.metadata?.["partType"] === "text")?.content, "a picture of a cat");

      // The turn is in the conversation under something the user can recognize
      // as their own action, without the framework pretending they typed it.
      const state = await context.conversation.getValue();
      assert.deepEqual(
        state.messages.map((message) => [message.role, message.content]),
        [["user", "(1 image)"], ["assistant", "a picture of a cat"]],
      );
    });
  } finally {
    if (previousLocale === undefined) {
      delete process.env["STEAMHARNESS_RUNTIME_LOCALE"];
    } else {
      process.env["STEAMHARNESS_RUNTIME_LOCALE"] = previousLocale;
    }
  }
});

test("an attachment nothing can read fails the turn instead of vanishing", async () => {
  const { models, model } = await createFauxModel();

  await withTempDir(async (workdir) => {
    // The store exists but holds no such file: the old behavior dropped the
    // attachment silently and the model answered as if nothing was attached.
    const files = await createFileStore(path.join(workdir, "files"), []);
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    await assert.rejects(
      async () => {
        await executor.workflow.run(
          {
            prompt: "what is this",
            errCode: 0,
            errMessage: "",
            workdir,
            imageFiles: [createImageReference("wf-missing")],
          },
          createContext("conv-missing-image", files),
        );
      },
      (error: unknown) => error instanceof HarnessError && error.type === "input_validation",
    );
  });
});

test("a turn with neither text nor attachments is still refused", async () => {
  const { models, model } = await createFauxModel();

  await withTempDir(async (workdir) => {
    const executor = defineAgentConversationExecutor({
      projectName: "pi",
      outputItemId: "pi-answer",
      models,
      resolvedModel: model,
    });

    await assert.rejects(
      async () => {
        await executor.workflow.run(
          { prompt: "  ", errCode: 0, errMessage: "", workdir },
          createContext("conv-empty"),
        );
      },
      (error: unknown) => error instanceof HarnessError && error.message === "Prompt is required.",
    );
  });
});

test("--model-attributes reaches the run as parsed attributes", () => {
  const input = createAgentProjectInput(
    ["--model-attributes", '{"contextWindow":4242,"input":["text"]}', "describe it"],
    {},
  );

  assert.deepEqual(input.modelAttributes, { contextWindow: 4_242, input: ["text"] });
  assert.equal(input.prompt, "describe it");
});

test("--web-search preserves automatic mode and validates explicit per-run choices", () => {
  for (const [value, expected] of [["", undefined], ["true", true], ["false", false]] as const) {
    assert.equal(createAgentProjectInput(["--web-search", value, "Search"], {}).webSearch, expected);
  }
  assert.equal(createAgentProjectInput(["Search"], {}).webSearch, undefined);
  assert.throws(() => createAgentProjectInput(["--web-search", "yes", "Search"], {}), /true or false/);
});

test("native searches render activities and escaped source links without exposing provider replay data", async () => {
  const { ai, faux, models, model } = await createFauxModel();
  const message = ai.fauxAssistantMessage("A sourced answer.");
  const sources = [{ url: "https://example.test/source", title: "Notes [release] <img>" }];
  Object.assign(message, { projectWebSearch: { api: "anthropic-messages", sources,
    searches: [{ id: "search-1", status: "success", query: "Latest release", sources }],
    native: [{ type: "web_search_tool_result", content: [{ encrypted_content: "opaque-provider-search-data" }] }] } });
  // The faux adapter reconstructs portable messages, so add the provider metadata
  // where the real adapter wrapper adds it: on the stream's committed message.
  faux.setResponses([message]);
  const streamSimple = models.streamSimple.bind(models);
  models.streamSimple = (...args) => {
    const source = streamSimple(...args), stream = ai.createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === "done") Object.assign(event.message, { projectWebSearch: (message as unknown as { projectWebSearch: unknown }).projectWebSearch });
        stream.push(event);
      }
      stream.end(await source.result());
    })();
    return stream;
  };
  await withTempDir(async workdir => {
    const executor = defineAgentConversationExecutor({ models, resolvedModel: model });
    const result = await executor.workflow.run({ prompt: "Search", workdir, errCode: 0, errMessage: "" }, createContext("search-output"));
    assert.equal(result.toolCallCount, 1);
    const activity = result.items.find(item => item.metadata?.partType === "tool");
    assert.equal(activity?.metadata?.status, "success");
    assert.match(JSON.stringify(activity?.content), /Latest release/);
    const source = result.items.find(item => item.metadata?.kind === "agent-notice");
    assert.equal(source?.content, "- [Notes \\[release\\] \\<img\\>](<https://example.test/source>)");
    assert.doesNotMatch(JSON.stringify(result.items), /encrypted_content|opaque-provider-search-data/);
  });
});
