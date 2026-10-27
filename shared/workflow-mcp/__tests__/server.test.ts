import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  ErrorCode,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectMcpServer,
  projectReportToMcpResult,
  type McpExecutionReport,
  type McpRunner,
  type CreateProjectMcpServerOptions,
} from "../index";

const openConnections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(openConnections.splice(0).map((connection) => connection.close()));
});

describe("workflow MCP server", () => {
  it("rejects unsafe or duplicate structure declarations before serving tools", () => {
    const base = {
      runner: { run: vi.fn(), resume: vi.fn() },
      fileInputMode: "local" as const,
    };
    expect(() => createProjectMcpServer({ entryId: "main",
      ...base,
      projectId: "../secrets",
      structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main", projectType: "workflow", workflow: { name: "bad" }, entrypoints: [] },
    })).toThrow(/safe non-empty identifier/);
    expect(() => createProjectMcpServer({ entryId: "main",
      ...base,
      projectId: "project-1",
      structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main",
        projectType: "workflow",
        workflow: { name: "bad" },
        entrypoints: [
          { id: "main", title: "Main", params: [{ name: "value", type: "string" }] },
          { id: "main", title: "Again", params: [] },
        ],
      },
    })).toThrow(/duplicate entrypoint id/);
    expect(() => createProjectMcpServer({ entryId: "main",
      ...base,
      projectId: "project-1",
      structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main",
        projectType: "workflow",
        workflow: { name: "bad" },
        entrypoints: [{ id: "main", title: "Main", params: [
          { name: "value", type: "string" },
          { name: "value", type: "string" },
        ] }],
      },
    })).toThrow(/duplicate parameter/);
  });

  it("rejects malformed parameter metadata instead of silently changing the contract", () => {
    const base = { entryId: "main",
      runner: { run: vi.fn(), resume: vi.fn() },
      fileInputMode: "local" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main",
        projectType: "workflow" as const,
        workflow: { name: "bad" },
        entrypoints: [{ id: "main", title: "Main", params: [] }],
      },
    };
    const expectInvalid = (param: Record<string, unknown>, pattern: RegExp) => {
      expect(() => createProjectMcpServer({
        ...base,
        structure: {
          ...base.structure,
          entrypoints: [{ id: "main", title: "Main", params: [param as never] }],
        },
      })).toThrow(pattern);
    };

    expectInvalid({ name: "bad name", type: "string" }, /invalid parameter name/);
    expectInvalid({ name: "__proto__", type: "string" }, /invalid parameter name/);
    expectInvalid({ name: "value", type: "string", options: null }, /invalid options list/);
    expectInvalid({ name: "value", type: "string", options: [null] }, /invalid option/);
    expectInvalid({ name: "value", type: "string", options: [{ value: 1 }] }, /invalid option/);
    expectInvalid({
      name: "value",
      type: "string",
      options: [{ value: "same" }, { value: "same" }],
    }, /duplicate option/);
    expectInvalid({ name: "value", type: "string", accept: ["text/plain", 1] }, /invalid accept list/);
    expectInvalid({ name: "value", type: "string", required: "yes" }, /invalid required/);
    expectInvalid({ name: "value", type: "string", defaultValue: 1 }, /invalid defaultValue/);
    expectInvalid({ name: "value", type: "string", description: { text: "bad" } }, /invalid description/);
    expect(() => createProjectMcpServer({
      ...base,
      structure: {
        ...base.structure,
        entrypoints: [{ id: "main", title: "Main", description: 1 as never, params: [] }],
      },
    })).toThrow(/invalid description/);
  });

  it("lists a fixed entrypoint catalog and calls tools through the SDK", async () => {
    const runner: McpRunner = {
      run: vi.fn(async (request) => successReport(request.entrypointId, request.entrypointTitle, request.args)),
      resume: vi.fn(),
    };
    const { client } = await connect(runner);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]).toMatchObject({
      name: "main",
      title: "Main workflow",
      inputSchema: {
        additionalProperties: false,
        required: ["message"],
      },
    });

    const result = await client.callTool({ name: "main", arguments: { message: "hello" } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      runId: "run-1",
      status: "success",
      entrypointId: "main",
      output: { args: ["--message", "hello"] },
    });
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      input: { message: "hello" },
      args: ["--message", "hello"],
    }));
  });

  it("returns protocol InvalidParams for malformed calls", async () => {
    const { client } = await connect({
      run: vi.fn(),
      resume: vi.fn(),
    });

    await expect(client.callTool({ name: "missing", arguments: {} }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(client.callTool({ name: "main", arguments: { unknown: true } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(client.callTool({ name: "main", arguments: { message: 1 } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("closes the audit event when a valid tool call fails before creating a run", async () => {
    const onAudit = vi.fn();
    const server = createProjectMcpServer({ entryId: "main",
      projectId: "11111111-1111-4111-8111-111111111111",
      structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main",
        projectType: "workflow",
        workflow: { name: "failed-workflow" },
        entrypoints: [{ id: "main", title: "Main", params: [] }],
      },
      runner: { run: vi.fn(), resume: vi.fn() },
      fileInputMode: "local",
      beforeRun: async () => { throw new Error("preflight failed"); },
      onAudit,
    });
    const client = new Client({ name: "audit-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    const result = await client.callTool({ name: "main", arguments: {} });
    expect(result.isError).toBe(true);
    expect(onAudit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: "tool_call_started", entrypointId: "main" }),
      expect.objectContaining({ type: "tool_call_finished", entrypointId: "main", status: "failed" }),
    ]);
  });

  it("keeps Workflow projects with no entrypoints available as an empty MCP server", async () => {
    const server = createProjectMcpServer({ entryId: "main",
      projectId: "11111111-1111-4111-8111-111111111111",
      structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main",
        projectType: "workflow",
        workflow: { name: "empty-workflow" },
        entrypoints: [],
      },
      runner: { run: vi.fn(), resume: vi.fn() },
      fileInputMode: "local",
    });
    const client = new Client({ name: "empty-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    expect((await client.listTools()).tools).toEqual([]);
  });

  it("resumes the same run through consecutive form elicitations", async () => {
    let resumeCount = 0;
    const runner: McpRunner = {
      run: vi.fn(async () => waitingReport("request-1", [
        { name: "name", type: "string", required: true, label: "Name" },
      ])),
      resume: vi.fn(async (request) => {
        resumeCount += 1;
        if (resumeCount === 1) {
          expect(request).toMatchObject({ runId: "run-1", values: { name: "Ada" } });
          return waitingReport("request-2", [
            { name: "approved", type: "boolean", required: true, label: "Approve" },
          ]);
        }
        expect(request).toMatchObject({ runId: "run-1", values: { approved: true } });
        return successReport("main", "Main workflow", ["done"]);
      }),
    };
    const responses: ElicitResult[] = [
      { action: "accept", content: { name: "Ada" } },
      { action: "accept", content: { approved: true } },
    ];
    const { client, serverTransport } = await connect(runner, responses);
    const send = vi.spyOn(serverTransport, "send");

    const result = await client.callTool({ name: "main", arguments: { message: "hello" } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ runId: "run-1", status: "success" });
    expect(runner.resume).toHaveBeenCalledTimes(2);
    const elicitationCalls = send.mock.calls.filter(([message]) => (
      "method" in message && message.method === "elicitation/create"
    ));
    expect(elicitationCalls).toHaveLength(2);
    expect(elicitationCalls.every(([, options]) => options?.relatedRequestId !== undefined)).toBe(true);
  });

  it("returns a compact interaction-required tool error when elicitation is unavailable", async () => {
    const runner: McpRunner = {
      run: vi.fn(async () => waitingReport("request-1", [
        { name: "name", type: "string", required: true, label: "Name" },
      ])),
      resume: vi.fn(),
    };
    const { client } = await connect(runner);

    const result = await client.callTool({ name: "main", arguments: { message: "hello" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      runId: "run-1",
      status: "waiting_for_input",
      error: {
        code: "interaction_required",
        pendingInput: {
          requestId: "request-1",
          fields: [{ name: "name", type: "string", required: true }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("stdout");
  });

  it("turns malformed pending input metadata into a compact run failure", async () => {
    const runner: McpRunner = {
      run: vi.fn(async () => ({
        ...waitingReport("request-1", []),
        pendingUserInput: {
          requestId: "request-1",
          nodeName: "input",
          title: "Input",
          params: null,
        } as never,
      })),
      resume: vi.fn(),
    };
    const { client } = await connect(runner);

    const result = await client.callTool({ name: "main", arguments: { message: "hello" } });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        runId: "run-1",
        status: "failed",
        error: {
          code: "project_failed",
          message: "Workflow returned an invalid pending input request.",
        },
      },
    });
    expect(runner.resume).not.toHaveBeenCalled();
  });

  it("keeps the waiting run resumable when MCP forms cannot represent an arbitrary array", async () => {
    const runner: McpRunner = {
      run: vi.fn(async () => waitingReport("request-1", [
        { name: "items", type: "string", multiple: true, required: true, label: "Items" },
      ])),
      resume: vi.fn(),
    };
    const responses: ElicitResult[] = [{ action: "accept", content: { items: ["a"] } }];
    const { client } = await connect(runner, responses);

    const result = await client.callTool({ name: "main", arguments: { message: "hello" } });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        runId: "run-1",
        status: "waiting_for_input",
        error: {
          code: "interaction_required",
          pendingInput: { fields: [{ name: "items", type: "string", required: true }] },
        },
      },
    });
    expect(responses).toHaveLength(1);
    expect(runner.resume).not.toHaveBeenCalled();
  });

  it("resumes static checkbox input through a standard MCP multi-select form", async () => {
    const runner: McpRunner = {
      run: vi.fn(async () => waitingReport("request-1", [{
        name: "choices",
        type: "string",
        control: "checkboxes",
        required: true,
        options: [{ value: "a" }, { value: "b" }],
      }])),
      resume: vi.fn(async (request) => {
        expect(request.values).toEqual({ choices: ["a", "b"] });
        return successReport("main", "Main workflow", ["done"]);
      }),
    };
    const { client } = await connect(runner, [{
      action: "accept",
      content: { choices: ["a", "b"] },
    }]);

    const result = await client.callTool({ name: "main", arguments: { message: "hello" } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ runId: "run-1", status: "success" });
    expect(runner.resume).toHaveBeenCalledOnce();
  });

  it.each(["decline", "cancel"] as const)(
    "cancels the waiting run when form elicitation returns %s",
    async (action) => {
      const runner: McpRunner = {
        run: vi.fn(async () => waitingReport("request-1", [
          { name: "name", type: "string", required: true, label: "Name" },
        ])),
        resume: vi.fn(),
        cancel: vi.fn(async () => undefined),
      };
      const { client } = await connect(runner, [{ action }]);

      const result = await client.callTool({ name: "main", arguments: { message: "hello" } });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          runId: "run-1",
          status: "aborted",
          error: { code: "cancelled" },
        },
      });
      expect(runner.cancel).toHaveBeenCalledWith(expect.objectContaining({
        runId: "run-1",
        requestId: "request-1",
        reason: action === "decline" ? "elicitation_declined" : "elicitation_cancelled",
      }));
      expect(runner.resume).not.toHaveBeenCalled();
    },
  );

  it("cancels the waiting run when the MCP tool request is aborted during elicitation", async () => {
    let markElicitationStarted!: () => void;
    const elicitationStarted = new Promise<void>((resolve) => { markElicitationStarted = resolve; });
    const runner: McpRunner = {
      run: vi.fn(async () => waitingReport("request-1", [
        { name: "name", type: "string", required: true, label: "Name" },
      ])),
      resume: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const { client } = await connect(runner, [async () => {
      markElicitationStarted();
      return new Promise<ElicitResult>(() => undefined);
    }]);
    const controller = new AbortController();
    const call = client.callTool(
      { name: "main", arguments: { message: "hello" } },
      undefined,
      { signal: controller.signal },
    );

    await elicitationStarted;
    controller.abort(new Error("cancel fixture"));
    await expect(call).rejects.toThrow(/cancel|abort/i);
    await vi.waitFor(() => {
      expect(runner.cancel).toHaveBeenCalledWith(expect.objectContaining({
        runId: "run-1",
        requestId: "request-1",
        reason: "request_cancelled",
      }));
    });
  });

  it("cancels the waiting run when the client elicitation request fails", async () => {
    const runner: McpRunner = {
      run: vi.fn(async () => waitingReport("request-1", [
        { name: "name", type: "string", required: true, label: "Name" },
      ])),
      resume: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const { client } = await connect(runner, [async () => {
      throw new Error("elicitation transport failed");
    }]);

    await expect(client.callTool({ name: "main", arguments: { message: "hello" } }))
      .rejects.toThrow(/elicitation transport failed/u);
    expect(runner.cancel).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      requestId: "request-1",
      reason: "elicitation_failed",
    }));
    expect(runner.resume).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing form content", response: { action: "accept" } as ElicitResult },
    { name: "invalid form content", response: { action: "accept", content: { name: 42 } } as ElicitResult },
  ])("cancels the waiting run for $name", async ({ response }) => {
    const runner: McpRunner = {
      run: vi.fn(async () => waitingReport("request-1", [
        { name: "name", type: "string", required: true, label: "Name" },
      ])),
      resume: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const { client } = await connect(runner, [response]);

    await expect(client.callTool({ name: "main", arguments: { message: "hello" } }))
      .rejects.toThrow(/elicitation response|form data|requested schema/u);
    expect(runner.cancel).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      requestId: "request-1",
      reason: "elicitation_failed",
    }));
    expect(runner.resume).not.toHaveBeenCalled();
  });

  it.each(["beforeRun", "resume", "runId"] as const)(
    "cancels the waiting run when %s fails after elicitation",
    async (failure) => {
      const runner: McpRunner = {
        run: vi.fn(async () => waitingReport("request-1", [
          { name: "name", type: "string", required: true, label: "Name" },
        ])),
        resume: vi.fn(async () => {
          if (failure === "resume") throw new Error("resume failed");
          const report = successReport("main", "Main workflow", ["done"]);
          return failure === "runId" ? { ...report, runId: "run-other" } : report;
        }),
        cancel: vi.fn(async () => undefined),
      };
      const beforeRun: CreateProjectMcpServerOptions["beforeRun"] = failure === "beforeRun"
        ? async ({ runId }) => {
            if (runId) throw new Error("resume preflight failed");
          }
        : undefined;
      const { client } = await connect(
        runner,
        [{ action: "accept", content: { name: "Ada" } }],
        beforeRun,
      );

      const result = await client.callTool({ name: "main", arguments: { message: "hello" } });
      expect(result.isError).toBe(true);
      expect(runner.cancel).toHaveBeenCalledWith(expect.objectContaining({
        runId: "run-1",
        requestId: "request-1",
        reason: "elicitation_failed",
      }));
    },
  );

  it("combines a transport-provided request signal with the SDK signal", async () => {
    const external = new AbortController();
    let requestId: string | number | undefined;
    let runnerSignal: AbortSignal | undefined;
    const runner: McpRunner = {
      run: vi.fn(async (request) => {
        runnerSignal = request.signal;
        return new Promise<McpExecutionReport>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }),
      resume: vi.fn(),
    };
    const server = createProjectMcpServer({ entryId: "main",
      projectId: "11111111-1111-4111-8111-111111111111",
      structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main",
        projectType: "workflow",
        workflow: { name: "request-signal-workflow" },
        entrypoints: [{
          id: "main",
          title: "Main workflow",
          params: [{ name: "message", flag: "--message", type: "string", required: true }],
        }],
      },
      runner,
      fileInputMode: "local",
      requestSignal: (id) => {
        requestId = id;
        return external.signal;
      },
    });
    const client = new Client({ name: "request-signal-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    const call = client.callTool({ name: "main", arguments: { message: "cancel" } });
    await vi.waitFor(() => expect(requestId).toBeDefined());
    external.abort(new Error("transport disconnected"));
    const result = await call;

    expect(result.isError).toBe(true);
    expect(runnerSignal?.aborted).toBe(true);
  });

  it("crops successful and failed reports to the public MCP result", () => {
    const success = projectReportToMcpResult(successReport("main", "Main workflow", []), {
      id: "main",
      title: "Main workflow",
    });
    expect(success.structuredContent).toEqual({
      runId: "run-1",
      status: "success",
      entrypointId: "main",
      entrypointTitle: "Main workflow",
      output: { args: [] },
    });

    const failed = projectReportToMcpResult({
      runId: "run-2",
      status: "failed",
      result: { ok: true, data: { errCode: 42, errMessage: "Not available", output: null } },
    }, { id: "main", title: "Main workflow" });
    expect(failed).toMatchObject({
      isError: true,
      structuredContent: {
        runId: "run-2",
        error: { code: "project_failed", message: "Not available" },
      },
    });

    const rejectedResult = projectReportToMcpResult({
      runId: "run-rejected",
      status: "success",
      result: { ok: false, error: { message: "Execution was rejected" } },
    }, { id: "main", title: "Main workflow" });
    expect(rejectedResult).toMatchObject({
      isError: true,
      structuredContent: {
        runId: "run-rejected",
        error: { code: "project_failed", message: "Execution was rejected" },
      },
    });

    const redacted = projectReportToMcpResult({
      runId: "run-3",
      status: "failed",
      result: {
        ok: true,
        data: {
          errCode: 500,
          errMessage: "Authorization: Bearer top-secret-token\nSTEAMHARNESS_SERVER_ADMIN_KEY=secret-value",
          output: null,
        },
      },
    }, { id: "main", title: "Main workflow" });
    expect(JSON.stringify(redacted)).not.toContain("top-secret-token");
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(redacted.structuredContent.error?.message).toContain("[redacted]");
  });
});

async function connect(
  runner: McpRunner,
  elicitationResponses?: Array<ElicitResult | (() => Promise<ElicitResult>)>,
  beforeRun?: CreateProjectMcpServerOptions["beforeRun"],
): Promise<{ client: Client; serverTransport: InMemoryTransport }> {
  const server = createProjectMcpServer({ entryId: "main",
    projectId: "11111111-1111-4111-8111-111111111111",
    structure: { projectId: "11111111-1111-4111-8111-111111111111", entryId: "main",
      projectType: "workflow",
      workflow: { name: "test-workflow" },
      defaultEntrypoint: "main",
      entrypoints: [{
        id: "main",
        title: "Main workflow",
        description: "Runs the main workflow",
        params: [{ name: "message", flag: "--message", type: "string", required: true }],
      }],
    },
    runner,
    fileInputMode: "local",
    beforeRun,
  });
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    elicitationResponses ? { capabilities: { elicitation: { form: {} } } } : undefined,
  );
  if (elicitationResponses) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
      const response = elicitationResponses.shift();
      if (!response) throw new Error("Missing elicitation response.");
      return typeof response === "function" ? response() : response;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openConnections.push(client, server);
  return { client, serverTransport };
}

function successReport(
  entrypointId: string,
  entrypointTitle: string,
  args: string[],
): McpExecutionReport {
  return {
    runId: "run-1",
    status: "success",
    entrypointId,
    entrypointTitle,
    result: { ok: true, data: { errCode: 0, errMessage: "", output: { args } } },
  };
}

function waitingReport(
  requestId: string,
  params: NonNullable<McpExecutionReport["pendingUserInput"]>["params"],
): McpExecutionReport {
  return {
    runId: "run-1",
    status: "waiting_for_input",
    entrypointId: "main",
    entrypointTitle: "Main workflow",
    result: { ok: true, data: { errCode: 202, errMessage: "Input required", output: null } },
    pendingUserInput: {
      requestId,
      nodeName: `node-${requestId}`,
      title: `Input ${requestId}`,
      params,
    },
  };
}
