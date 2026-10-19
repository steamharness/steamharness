import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeWorkflowScriptSource,
  createDisabledWorkflowConversationContext,
  createDisabledWorkflowTokenUsageContext,
  createOutputItemChunk,
  createOutputNode,
  createWorkflowRelatedProjectsContext,
  createUserInputNode,
  HarnessError,
  type NodeContext,
  type KVContext,
  type UserInputRequest,
} from "../index";
import { createNodeExecutionReporter } from "../executor/report";
import { runNode, runStreamNode } from "../workflow/index";

test("createUserInputNode publishes a durable request when no answer is resolved", async () => {
  const requests: UserInputRequest[] = [];
  const node = createUserInputNode<{ prompt: string }>({
    name: "confirm",
    title: "Confirm deployment",
    description: "Review the target before continuing.",
    params: [
      { name: "approved", flag: "--approved", type: "boolean" },
      { name: "notes", flag: "--notes", type: "string", control: "textarea" },
    ],
    defaultValues: { approved: false, notes: "Looks good" },
    metadata: { type: "user-input", title: "Confirm deployment" },
  });

  await assert.rejects(
    () => runNode(node, { prompt: "deploy" }, createTestWorkflowContext({
      async getResolvedInput() {
        return undefined;
      },
      async requestInput(request) {
        requests.push(request);
      },
    })),
    (error) => {
      assert.equal(error instanceof HarnessError, true);
      assert.equal((error as HarnessError).type, "user_input_required");
      assert.equal((error as HarnessError).metadata?.["request"], requests[0]);
      return true;
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.requestId, "demo:run-1:confirm");
  assert.equal(requests[0]?.nodeName, "confirm");
  assert.equal(requests[0]?.title, "Confirm deployment");
  assert.equal(requests[0]?.description, "Review the target before continuing.");
  assert.deepEqual(requests[0]?.params.map((param) => param.name), ["approved", "notes"]);
  assert.deepEqual(requests[0]?.defaultValues, { approved: false, notes: "Looks good" });
  assert.deepEqual(requests[0]?.metadata, {
    type: "user-input",
    title: "Confirm deployment",
    version: "1.0.0",
  });
  assert.equal(requests[0]?.createdAt instanceof Date, true);
});

test("createUserInputNode keeps runtime node running while waiting for input", async () => {
  const reporter = createNodeExecutionReporter({
    runId: "run-1",
    projectName: "demo",
  });
  const node = createUserInputNode<{ prompt: string }>({
    name: "review",
    title: "Review plan",
    params: [{ name: "approved", flag: "--approved", type: "boolean" }],
  });

  await assert.rejects(
    () => runNode(node, { prompt: "deploy" }, createTestWorkflowContext({
      getResolvedInput() {
        return undefined;
      },
      requestInput() {
        return undefined;
      },
    }, {
      nodeHooks: reporter.hooks,
    })),
    (error) => {
      assert.equal(error instanceof HarnessError, true);
      assert.equal((error as HarnessError).type, "user_input_required");
      return true;
    },
  );

  const reports = reporter.getReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.name, "user-input");
  // Waiting for user input is a durable pause, not a node failure.
  assert.equal(reports[0]?.status, "running");
  assert.equal(reports[0]?.endedAt, undefined);
  assert.equal(reports[0]?.error, undefined);
});

test("stream nodes stay running when waiting for user input", async () => {
  const reporter = createNodeExecutionReporter({
    runId: "run-1",
    projectName: "demo",
  });
  const requests: UserInputRequest[] = [];
  const node = createOutputNode<{ prompt: string }, { errCode: number; errMessage: string }>({
    name: "agent-stream",
    async *stream(_input, context) {
      const approval = createUserInputNode({
        name: "tool-approval",
        title: "Approve tool",
        params: [{ name: "approved", flag: "--approved", type: "boolean" }],
      });
      await runNode(approval, {}, context);
      yield createOutputItemChunk({
        type: "output_item_start",
        item: { id: "done", title: "Done", content: "" },
      });
    },
    format() {
      return { errCode: 0, errMessage: "" };
    },
  });

  await assert.rejects(
    () => runStreamNode(node, { prompt: "deploy" }, createTestWorkflowContext({
      getResolvedInput() {
        return undefined;
      },
      requestInput(request) {
        requests.push(request);
      },
    }, {
      nodeHooks: reporter.hooks,
    })),
    (error) => {
      assert.equal(error instanceof HarnessError, true);
      assert.equal((error as HarnessError).type, "user_input_required");
      return true;
    },
  );

  assert.equal(requests.length, 1);
  const reports = reporter.getReports();
  assert.equal(reports.length, 2);
  assert.equal(reports[0]?.name, "output");
  assert.equal(reports[0]?.status, "running");
  assert.equal(reports[0]?.error, undefined);
  assert.equal(reports[1]?.name, "user-input");
  assert.equal(reports[1]?.status, "running");
});

test("createUserInputNode resumes from a resolved answer and returns a standard payload", async () => {
  const submittedAt = new Date("2026-06-04T10:00:00.000Z");
  const node = createUserInputNode<{ prompt: string }>({
    name: "ask-owner",
    title: "Ask owner",
    params: [{ name: "owner", flag: "--owner", type: "string" }],
  });

  const output = await runNode(node, { prompt: "who owns this?" }, createTestWorkflowContext({
    getResolvedInput(requestId) {
      assert.equal(requestId, "demo:run-1:ask-owner");
      return {
        requestId,
        nodeName: "ask-owner",
        values: { owner: "platform" },
        submittedAt,
      };
    },
    requestInput() {
      throw new Error("requestInput should not run when a resolved value exists.");
    },
  }));

  assert.deepEqual(output, {
    errCode: 0,
    errMessage: "",
    requestId: "demo:run-1:ask-owner",
    values: { owner: "platform" },
    submittedAt: submittedAt.toISOString(),
  });
});

test("createUserInputNode resolves a dynamic request definition from the current input", async () => {
  const requests: UserInputRequest[] = [];
  const node = createUserInputNode<{ question: string; choices: string[] }>({
    name: "agent-question",
    title: "Fallback title",
    params: [],
    async resolveRequest(input) {
      await Promise.resolve();
      return {
        title: "Choose an approach",
        description: input.question,
        params: [{
          name: "answer",
          type: "string",
          control: "radio",
          required: true,
          options: input.choices.map((choice) => ({ value: choice, label: choice })),
        }],
        defaultValues: { answer: input.choices[0] },
      };
    },
  });

  await assert.rejects(
    () => runNode(node, {
      question: "Inspect tests or docs first?",
      choices: ["Tests", "Docs"],
    }, createTestWorkflowContext({
      getResolvedInput() {
        return undefined;
      },
      requestInput(request) {
        requests.push(request);
      },
    })),
    (error) => error instanceof HarnessError && error.type === "user_input_required",
  );

  assert.equal(requests[0]?.title, "Choose an approach");
  assert.equal(requests[0]?.description, "Inspect tests or docs first?");
  assert.deepEqual(requests[0]?.params, [{
    name: "answer",
    type: "string",
    control: "radio",
    required: true,
    options: [
      { value: "Tests", label: "Tests" },
      { value: "Docs", label: "Docs" },
    ],
  }]);
  assert.deepEqual(requests[0]?.defaultValues, { answer: "Tests" });
});

test("createUserInputNode rejects invalid dynamic date parameter combinations", async () => {
  const node = createUserInputNode({
    name: "invalid-date-question",
    params: [],
    resolveRequest() {
      return {
        params: [{
          name: "reviewDate",
          type: "string",
          control: "date",
          panel: "quick",
        }],
      } as never;
    },
  });

  await assert.rejects(
    () => runNode(node, {}, createTestWorkflowContext(undefined)),
    (error) => error instanceof HarnessError &&
      error.type === "input_validation" &&
      /cannot use panel: "quick"/.test(error.message),
  );
});

test("createUserInputNode lets workflows format the resolved payload", async () => {
  interface OwnerPayload {
    errCode: number;
    errMessage: string;
    owner: string;
    sourceRequestId: string;
  }

  const node = createUserInputNode<{ ticket: string }, OwnerPayload>({
    name: "route-ticket",
    params: [{ name: "owner", flag: "--owner", type: "string" }],
    format(payload, input) {
      return {
        errCode: 0,
        errMessage: "",
        owner: String(payload.values["owner"]),
        sourceRequestId: `${input.ticket}:${payload.requestId}`,
      };
    },
  });

  const output = await runNode(node, { ticket: "T-1" }, createTestWorkflowContext({
    getResolvedInput(requestId) {
      return {
        requestId,
        nodeName: "route-ticket",
        values: { owner: "support" },
        submittedAt: new Date("2026-06-04T10:01:00.000Z"),
      };
    },
    requestInput() {
      throw new Error("requestInput should not run when a resolved value exists.");
    },
  }));

  assert.deepEqual(output, {
    errCode: 0,
    errMessage: "",
    owner: "support",
    sourceRequestId: "T-1:demo:run-1:route-ticket",
  });
});

test("workflow structure recognizes createUserInputNode as a user-input node", () => {
  const analysis = analyzeWorkflowScriptSource(`
    const approvalNode = workflow.createUserInputNode({
      name: "approval",
      title: "Review request",
      params: [
        { name: "approved", flag: "--approved", type: "boolean" },
      ],
    });

    export const demo = workflow.defineWorkflow({
      name: "demo",
      async run(input, context) {
        return workflow.runNode(approvalNode, input, context);
      },
    });
  `);

  assert.equal(analysis.structureApiCalls.some((call) => call.method === "createUserInputNode"), true);
  assert.equal(analysis.structureNodes[0]?.factory, "createUserInputNode");
  assert.equal(analysis.structureNodes[0]?.standardName, "user-input");
});

// The user-input node must respect the run-level abort signal so
// the local host's cancel button can end a paused run
// without leaving the run stuck in waiting_for_input forever. Surface the
// abort as execution_aborted (not user_input_required) so the executor's
// existing createAbortedWorkflowResult handler picks it up.
test("createUserInputNode aborts when the run signal is already aborted", async () => {
  const requests: UserInputRequest[] = [];
  const node = createUserInputNode<{ prompt: string }>({
    name: "confirm",
    title: "Confirm",
    params: [{ name: "approved", flag: "--approved", type: "boolean" }],
  });

  const controller = new AbortController();
  controller.abort(new Error("cancelled from outside"));

  await assert.rejects(
    () => runNode(node, { prompt: "deploy" }, {
      ...createTestWorkflowContext({
        async getResolvedInput() {
          return undefined;
        },
        async requestInput(request) {
          requests.push(request);
        },
      }),
      abortSignal: controller.signal,
    }),
    (error) => {
      // When the run is already cancelled before the node
      // runs, throwIfContextAborted surfaces execution_aborted without
      // reaching the user input node's own abort check. Either way the
      // host must see execution_aborted (never user_input_required)
      // and the run must end with status="aborted".
      assert.equal(error instanceof HarnessError, true);
      assert.equal((error as HarnessError).type, "execution_aborted");
      return true;
    },
  );

  // The user input request must NOT be registered when the run
  // is already cancelled — otherwise the panel would still surface a
  // pending input that can never be resolved.
  assert.equal(requests.length, 0);
});

test("createUserInputNode aborts when the run signal fires after requestInput", async () => {
  const requests: UserInputRequest[] = [];
  const node = createUserInputNode<{ prompt: string }>({
    name: "confirm",
    title: "Confirm",
    params: [{ name: "approved", flag: "--approved", type: "boolean" }],
  });

  const controller = new AbortController();

  await assert.rejects(
    () => runNode(node, { prompt: "deploy" }, {
      ...createTestWorkflowContext({
        async getResolvedInput() {
          return undefined;
        },
        async requestInput(request) {
          requests.push(request);
          // Simulate the host aborting the run while the request is in
          // flight (e.g. the user clicked "结束运行" right after the
          // panel mounted).
          controller.abort(new Error("cancelled from outside"));
        },
      }),
      abortSignal: controller.signal,
    }),
    (error) => {
      assert.equal(error instanceof HarnessError, true);
      assert.equal((error as HarnessError).type, "execution_aborted");
      return true;
    },
  );

  assert.equal(requests.length, 1);
});

function createTestWorkflowContext(
  userInput: NodeContext["userInput"],
  options: Pick<NodeContext, "nodeHooks"> = {},
): NodeContext {
  return {
    providers: {},
    storage: {
      local: { kv: createMemoryKVContext(), persistentValue: createMemoryKVContext(), relatedProjects: createWorkflowRelatedProjectsContext() },
      server: { kv: createMemoryKVContext(), persistentValue: createMemoryKVContext(), relatedProjects: createWorkflowRelatedProjectsContext() },
    },
    conversation: createDisabledWorkflowConversationContext(),
    tokenUsage: createDisabledWorkflowTokenUsageContext(),
    userInput,
    nodeHooks: options.nodeHooks,
    metadata: {
      workflow: "demo",
      runId: "run-1",
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
    ...project,
    conversation: createNamespace("conversation"),
  };
}
