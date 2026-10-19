import assert from "node:assert/strict";
import test from "node:test";
import {
  createNodeExecutionReporter,
  createWorkflowExecutionReport,
  type RuntimeEvent,
} from "../report";
import { HarnessError } from "../../workflow/errors";

test("workflow report exposes provider cause status and url in errMessage", () => {
  const cause = new Error("Unauthorized") as Error & {
    statusCode: number;
    url: string;
    isRetryable: boolean;
  };
  cause.name = "AI_APICallError";
  cause.statusCode = 401;
  cause.url = "http://localhost:9000/responses";
  cause.isRetryable = false;

  const report = createWorkflowExecutionReport({
    runId: "run-provider-failed",
    projectName: "provider failure",
    startedAt: new Date("2026-05-26T00:00:00.000Z"),
    endedAt: new Date("2026-05-26T00:00:01.000Z"),
    result: {
      ok: false,
      error: {
        type: "provider_call",
        message: "LLM provider chat call failed.",
        cause: new HarnessError({
          type: "provider_call",
          message: "LLM provider chat call failed.",
          metadata: { provider: "openai-responses" },
          cause,
        }).safeCause,
      },
    },
    nodes: [],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.result.ok, true);
  if (!report.result.ok) {
    return;
  }

  assert.deepEqual(report.result.data, {
    errCode: 502,
    errMessage: "Unauthorized (status 401, http://localhost:9000/responses)",
    output: null,
  });
});

test("workflow report records durable user input pauses without failed finish events", async () => {
  const events: RuntimeEvent[] = [];
  const reporter = createNodeExecutionReporter({
    runId: "run-input",
    projectName: "input-workflow",
    onRuntimeEvent(event) {
      events.push(event);
    },
  });
  const request = {
    requestId: "request-input",
    nodeName: "ask-owner",
    title: "Ask owner",
    params: [{ name: "owner", flag: "--owner", type: "string" as const }],
    createdAt: new Date("2026-06-04T10:00:00.000Z"),
    metadata: { type: "user-input", title: "Ask owner", version: "1.0.0" },
  };

  await reporter.emitUserInputRequested(request);
  await reporter.emitWorkflowFinished({
    runId: "run-input",
    projectName: "input-workflow",
    status: "waiting_for_input",
    startedAt: new Date("2026-06-04T10:00:00.000Z"),
    endedAt: new Date("2026-06-04T10:00:01.000Z"),
    result: {
      ok: false,
      error: {
        type: "user_input_required",
        message: "Waiting for input.",
      },
    },
  });

  assert.equal(reporter.getPendingUserInput()?.requestId, "request-input");
  assert.deepEqual(events.map((event) => event.type), ["user_input_requested"]);

  const report = createWorkflowExecutionReport({
    runId: "run-input",
    projectName: "input-workflow",
    status: "waiting_for_input",
    startedAt: new Date("2026-06-04T10:00:00.000Z"),
    endedAt: new Date("2026-06-04T10:00:01.000Z"),
    pendingUserInput: reporter.getPendingUserInput(),
    resolvedUserInputs: reporter.getResolvedUserInputs(),
    result: {
      ok: false,
      error: {
        type: "user_input_required",
        message: "Waiting for input.",
      },
    },
    nodes: reporter.getReports(),
  });

  assert.equal(report.status, "waiting_for_input");
  assert.equal(report.pendingUserInput?.requestId, "request-input");
  assert.equal(report.result.ok, true);
  if (report.result.ok && isRecord(report.result.data)) {
    assert.equal(report.result.data["errCode"], 202);
  }
});

test("workflow report records resolved user input and clears the pending request", async () => {
  const events: RuntimeEvent[] = [];
  const reporter = createNodeExecutionReporter({
    runId: "run-input",
    projectName: "input-workflow",
    onRuntimeEvent(event) {
      events.push(event);
    },
  });

  const request = {
    requestId: "request-input",
    nodeName: "ask-owner",
    title: "Ask owner",
    params: [{ name: "owner", flag: "--owner", type: "string" as const }],
    createdAt: new Date("2026-06-04T10:00:00.000Z"),
  };
  await reporter.emitUserInputRequested(request);
  await reporter.emitUserInputResolved({
    requestId: "request-input",
    nodeName: "ask-owner",
    values: { owner: "platform" },
    submittedAt: new Date("2026-06-04T10:01:00.000Z"),
    request,
  });

  assert.equal(reporter.getPendingUserInput(), undefined);
  assert.deepEqual(reporter.getResolvedUserInputs(), [{
    requestId: "request-input",
    nodeName: "ask-owner",
    values: { owner: "platform" },
    submittedAt: new Date("2026-06-04T10:01:00.000Z"),
    request: {
      ...request,
      metadata: undefined,
      defaultValues: undefined,
    },
  }]);
  assert.deepEqual(events.map((event) => event.type), [
    "user_input_requested",
    "user_input_resolved",
  ]);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
