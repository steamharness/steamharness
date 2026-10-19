import type {
  McpErrorDetail,
  McpExecutionReport,
  McpPendingInputSummary,
  McpStructuredResult,
  McpToolResult,
} from "./types";

export function workflowReportToMcpResult(
  report: McpExecutionReport,
  entrypoint: { id: string; title: string },
  errorOverride?: McpErrorDetail,
): McpToolResult {
  const data = report.result?.ok === true ? report.result.data : undefined;
  const errCode = typeof data?.errCode === "number" ? data.errCode : undefined;
  const failed = report.status !== "success" || report.result?.ok !== true ||
    (errCode !== undefined && errCode !== 0);
  const error = errorOverride ?? (failed ? createReportError(report, errCode) : undefined);
  const structuredContent: McpStructuredResult = {
    runId: report.runId,
    status: report.status,
    entrypointId: report.entrypointId ?? entrypoint.id,
    entrypointTitle: report.entrypointTitle ?? entrypoint.title,
    output: data?.output ?? null,
    ...(error ? { error } : {}),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(failed || errorOverride ? { isError: true } : {}),
  };
}

export function createWorkflowMcpThrownErrorResult(
  error: unknown,
  entrypoint: { id: string; title: string },
): McpToolResult {
  const report: McpExecutionReport = {
    runId: "",
    status: "failed",
    entrypointId: entrypoint.id,
    entrypointTitle: entrypoint.title,
    result: {
      ok: true,
      data: { errCode: 500, errMessage: readSafeErrorMessage(error), output: null },
    },
  };
  return workflowReportToMcpResult(report, entrypoint);
}

export function summarizePendingWorkflowMcpInput(
  report: McpExecutionReport,
): McpPendingInputSummary | undefined {
  const pending = report.pendingUserInput;
  if (!pending) return undefined;
  return {
    requestId: pending.requestId,
    title: pending.title,
    fields: pending.params.map((param) => ({
      name: param.name,
      title: param.title?.trim() || param.label?.trim() || param.name,
      type: param.type,
      required: param.required === true,
    })),
  };
}

function createReportError(
  report: McpExecutionReport,
  errCode: number | undefined,
): McpErrorDetail {
  const data = report.result?.ok === true ? report.result.data : undefined;
  const resultError = report.result?.ok === false ? report.result.error?.message : undefined;
  const rawMessage = typeof data?.errMessage === "string" && data.errMessage.trim() !== ""
    ? data.errMessage
    : resultError?.trim() || defaultStatusMessage(report.status, errCode);
  const message = sanitizeWorkflowMcpErrorMessage(rawMessage);

  if (report.status === "waiting_for_input") {
    return {
      code: "interaction_required",
      message,
      pendingInput: summarizePendingWorkflowMcpInput(report),
    };
  }
  if (report.status === "aborted") return { code: "cancelled", message };
  if (report.status === "timed_out") return { code: "timed_out", message };
  return { code: "workflow_failed", message };
}

function defaultStatusMessage(status: McpExecutionReport["status"], errCode: number | undefined): string {
  if (status === "waiting_for_input") return "Workflow requires user input before it can continue.";
  if (status === "aborted") return "Workflow run was cancelled.";
  if (status === "timed_out") return "Workflow run timed out.";
  if (errCode !== undefined && errCode !== 0) return `Workflow returned errCode ${errCode}.`;
  return "Workflow run failed.";
}

function readSafeErrorMessage(error: unknown): string {
  return sanitizeWorkflowMcpErrorMessage(
    error instanceof Error ? error.message : "",
  );
}

function sanitizeWorkflowMcpErrorMessage(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact === "") return "Workflow run failed.";
  const redacted = compact
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /((?:authorization|[a-z0-9_]*(?:key|token|secret|password|credential))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(/([?&](?:api_key|token|secret|password)=)[^&\s]+/gi, "$1[redacted]");
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 497)}...`;
}
