import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { workflowMcpInputToArgs } from "./args";
import {
  canWorkflowParamsUseMcpFormElicitation,
  WorkflowMcpInvalidParamsError,
  workflowParamsToMcpElicitationSchema,
  workflowParamsToMcpInputSchema,
  workflowParamsToMcpJsonSchema,
} from "./schema";
import {
  createWorkflowMcpThrownErrorResult,
  summarizePendingWorkflowMcpInput,
  workflowReportToMcpResult,
} from "./result";
import type {
  WorkflowMcpAuditEvent,
  WorkflowMcpCancelRequest,
  WorkflowMcpEntrypointStructure,
  WorkflowMcpExecutionReport,
  WorkflowMcpFileInputMode,
  WorkflowMcpFileResolver,
  WorkflowMcpRunner,
  WorkflowMcpStructureReport,
  WorkflowMcpToolResult,
  WorkflowMcpUserInputRequest,
} from "./types";

export interface CreateWorkflowMcpServerOptions {
  projectId: string;
  structure: WorkflowMcpStructureReport;
  runner: WorkflowMcpRunner;
  fileInputMode: WorkflowMcpFileInputMode;
  resolveFiles?: WorkflowMcpFileResolver;
  version?: string;
  instructions?: string;
  beforeRun?(context: {
    projectId: string;
    entrypointId: string;
    runId?: string;
    signal: AbortSignal;
  }): Promise<void> | void;
  /**
   * Supplies a host-level cancellation signal for an individual JSON-RPC
   * request. Transports such as Node HTTP can use this to propagate a client
   * disconnect; the SDK's own signal only covers protocol cancellation.
   */
  requestSignal?(requestId: RequestId): AbortSignal | undefined;
  onAudit?(event: WorkflowMcpAuditEvent): Promise<void> | void;
}

export function createWorkflowMcpServerName(projectId: string): string {
  const normalized = projectId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error("Workflow MCP project ID must be a safe non-empty identifier.");
  }
  return `workflow-${normalized}`;
}

export function createWorkflowMcpServer(options: CreateWorkflowMcpServerOptions): Server {
  if (options.structure.projectType !== "workflow") {
    throw new Error(`Project type "${options.structure.projectType}" cannot be exposed through MCP.`);
  }
  if (
    !isRecord(options.structure.workflow)
    || typeof options.structure.workflow.name !== "string"
    || options.structure.workflow.name.trim() === ""
  ) {
    throw new Error("Workflow MCP received an invalid workflow structure.");
  }
  const entrypoints = cloneEntrypoints(options.structure.entrypoints);

  const server = new Server(
    { name: createWorkflowMcpServerName(options.projectId), version: options.version ?? "0.1.0" },
    { capabilities: { tools: {} }, instructions: options.instructions },
  );
  const entrypointsById = new Map(entrypoints.map((entrypoint) => [entrypoint.id, entrypoint]));
  const schemas = new Map(entrypoints.map((entrypoint) => [
    entrypoint.id,
    workflowParamsToMcpInputSchema(entrypoint.params, options.fileInputMode),
  ]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: entrypoints.map((entrypoint) => ({
      name: entrypoint.id,
      title: entrypoint.title,
      description: entrypoint.description,
      inputSchema: workflowParamsToMcpJsonSchema(entrypoint.params, options.fileInputMode),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entrypoint = entrypointsById.get(request.params.name);
    if (!entrypoint) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown workflow tool "${request.params.name}".`);
    }
    const parsed = await schemas.get(entrypoint.id)?.safeParseAsync(request.params.arguments ?? {});
    if (!parsed?.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for workflow tool "${entrypoint.id}": ${parsed?.error.message ?? "invalid input"}`,
      );
    }

    const signal = combineAbortSignals(extra.signal, options.requestSignal?.(extra.requestId));
    let auditStarted = false;
    let auditFinished = false;
    try {
      await options.onAudit?.({
        type: "tool_call_started",
        projectId: options.projectId,
        entrypointId: entrypoint.id,
      });
      auditStarted = true;
      await options.beforeRun?.({
        projectId: options.projectId,
        entrypointId: entrypoint.id,
        signal,
      });
      const args = await workflowMcpInputToArgs({
        projectId: options.projectId,
        entrypointId: entrypoint.id,
        params: entrypoint.params,
        input: parsed.data,
        fileInputMode: options.fileInputMode,
        resolveFiles: options.resolveFiles,
        signal,
      });
      let report = await options.runner.run({
        projectId: options.projectId,
        entrypointId: entrypoint.id,
        entrypointTitle: entrypoint.title,
        input: { ...parsed.data },
        args,
        signal,
      });
      report = await resolveWorkflowMcpInteractions(
        server,
        options,
        entrypoint,
        report,
        signal,
        extra.requestId,
      );
      const toolResult = workflowReportToMcpResult(report, entrypoint);
      auditFinished = true;
      await Promise.resolve(options.onAudit?.({
        type: "tool_call_finished",
        projectId: options.projectId,
        entrypointId: entrypoint.id,
        runId: report.runId,
        status: report.status,
        isError: toolResult.isError === true,
      })).catch(() => undefined);
      return toolResult;
    } catch (error) {
      if (auditStarted && !auditFinished) {
        await Promise.resolve(options.onAudit?.({
          type: "tool_call_finished",
          projectId: options.projectId,
          entrypointId: entrypoint.id,
          status: signal.aborted ? "aborted" : "failed",
          isError: true,
        })).catch(() => undefined);
      }
      if (error instanceof WorkflowMcpInvalidParamsError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      if (error instanceof McpError) throw error;
      return createWorkflowMcpThrownErrorResult(error, entrypoint);
    }
  });

  return server;
}

function combineAbortSignals(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): AbortSignal {
  if (secondary === undefined || secondary === primary) return primary;
  return AbortSignal.any([primary, secondary]);
}

async function resolveWorkflowMcpInteractions(
  server: Server,
  options: CreateWorkflowMcpServerOptions,
  entrypoint: WorkflowMcpEntrypointStructure,
  initialReport: WorkflowMcpExecutionReport,
  signal: AbortSignal,
  relatedRequestId: RequestId,
): Promise<WorkflowMcpExecutionReport> {
  let report = initialReport;
  for (let interaction = 0; report.status === "waiting_for_input" && interaction < 32; interaction += 1) {
    let pending: WorkflowMcpUserInputRequest | undefined;
    try {
      pending = clonePendingUserInput(report.pendingUserInput, entrypoint.id);
    } catch {
      return workflowReportToInvalidPendingInput(report, entrypoint);
    }
    if (pending !== undefined && pending !== report.pendingUserInput) {
      report = { ...report, pendingUserInput: pending };
    }
    const supportsFormElicitation = server.getClientCapabilities()?.elicitation?.form !== undefined;
    if (!pending || !supportsFormElicitation || !canWorkflowParamsUseMcpFormElicitation(pending.params)) {
      return report;
    }
    await Promise.resolve(options.onAudit?.({
      type: "tool_call_waiting",
      projectId: options.projectId,
      entrypointId: entrypoint.id,
      runId: report.runId,
      requestId: pending.requestId,
      status: report.status,
    })).catch(() => undefined);
    let elicited;
    try {
      elicited = await server.elicitInput({
        mode: "form",
        message: pending.description?.trim() || pending.title,
        requestedSchema: workflowParamsToMcpElicitationSchema(pending.params, pending.defaultValues) as never,
      }, { signal, relatedRequestId });
    } catch (error) {
      await cancelWorkflowMcpWaitingRun(
        options,
        entrypoint,
        report,
        pending,
        signal.aborted ? "request_cancelled" : "elicitation_failed",
        signal,
      );
      throw error;
    }
    if (elicited.action !== "accept") {
      await cancelWorkflowMcpWaitingRun(
        options,
        entrypoint,
        report,
        pending,
        elicited.action === "decline" ? "elicitation_declined" : "elicitation_cancelled",
        signal,
      );
      return workflowReportToMcpInteractionDeclined(report, entrypoint, elicited.action);
    }
    try {
      if (!elicited.content) {
        throw new McpError(ErrorCode.InvalidParams, "Accepted elicitation response did not contain form data.");
      }
      const parsed = await workflowParamsToMcpInputSchema(pending.params, "local")
        .safeParseAsync(elicited.content);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid elicitation response: ${parsed.error.message}`);
      }
      await options.beforeRun?.({
        projectId: options.projectId,
        entrypointId: entrypoint.id,
        runId: report.runId,
        signal,
      });
      await Promise.resolve(options.onAudit?.({
        type: "tool_call_resumed",
        projectId: options.projectId,
        entrypointId: entrypoint.id,
        runId: report.runId,
        requestId: pending.requestId,
      })).catch(() => undefined);
      const resumed = await options.runner.resume({
        projectId: options.projectId,
        entrypointId: entrypoint.id,
        entrypointTitle: entrypoint.title,
        runId: report.runId,
        requestId: pending.requestId,
        nodeName: pending.nodeName,
        values: parsed.data,
        signal,
      });
      if (resumed.runId !== report.runId) {
        throw new Error("Workflow MCP resume changed the run ID.");
      }
      report = resumed;
    } catch (error) {
      await cancelWorkflowMcpWaitingRun(
        options,
        entrypoint,
        report,
        pending,
        signal.aborted ? "request_cancelled" : "elicitation_failed",
        signal,
      );
      throw error;
    }
  }
  return report;
}

async function cancelWorkflowMcpWaitingRun(
  options: CreateWorkflowMcpServerOptions,
  entrypoint: WorkflowMcpEntrypointStructure,
  report: WorkflowMcpExecutionReport,
  pending: WorkflowMcpUserInputRequest,
  reason: WorkflowMcpCancelRequest["reason"],
  signal: AbortSignal,
): Promise<void> {
  await options.runner.cancel?.({
    projectId: options.projectId,
    entrypointId: entrypoint.id,
    entrypointTitle: entrypoint.title,
    runId: report.runId,
    requestId: pending.requestId,
    reason,
    signal,
  });
}

function workflowReportToInvalidPendingInput(
  report: WorkflowMcpExecutionReport,
  entrypoint: WorkflowMcpEntrypointStructure,
): WorkflowMcpExecutionReport {
  return {
    ...report,
    status: "failed",
    entrypointId: report.entrypointId ?? entrypoint.id,
    entrypointTitle: report.entrypointTitle ?? entrypoint.title,
    pendingUserInput: undefined,
    result: {
      ok: true,
      data: {
        errCode: 500,
        errMessage: "Workflow returned an invalid pending input request.",
        output: null,
      },
    },
  };
}

function workflowReportToMcpInteractionDeclined(
  report: WorkflowMcpExecutionReport,
  entrypoint: WorkflowMcpEntrypointStructure,
  action: "decline" | "cancel",
): WorkflowMcpExecutionReport {
  const pending = summarizePendingWorkflowMcpInput(report);
  return {
    ...report,
    status: "aborted",
    result: {
      ok: true,
      data: {
        errCode: 499,
        errMessage: action === "decline"
          ? "The user declined the requested workflow input."
          : "The user cancelled the requested workflow input.",
        output: null,
      },
    },
    entrypointId: report.entrypointId ?? entrypoint.id,
    entrypointTitle: report.entrypointTitle ?? entrypoint.title,
    pendingUserInput: pending ? report.pendingUserInput : undefined,
  };
}

function cloneEntrypoints(
  entrypoints: WorkflowMcpEntrypointStructure[] | undefined,
): WorkflowMcpEntrypointStructure[] {
  if (entrypoints !== undefined && !Array.isArray(entrypoints)) {
    throw new Error("Workflow MCP received an invalid entrypoint catalog.");
  }
  const ids = new Set<string>();
  return (entrypoints ?? []).map((entrypoint) => {
    if (!isRecord(entrypoint)) {
      throw new Error("Workflow MCP received an invalid entrypoint structure.");
    }
    if (
      typeof entrypoint.id !== "string"
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(entrypoint.id)
      || ids.has(entrypoint.id)
    ) {
      throw new Error(`Workflow MCP received an invalid or duplicate entrypoint id "${String(entrypoint.id)}".`);
    }
    if (typeof entrypoint.title !== "string" || entrypoint.title.trim() === "") {
      throw new Error(`Workflow MCP entrypoint "${entrypoint.id}" must have a non-empty title.`);
    }
    if (entrypoint.description !== undefined && typeof entrypoint.description !== "string") {
      throw new Error(`Workflow MCP entrypoint "${entrypoint.id}" has an invalid description.`);
    }
    ids.add(entrypoint.id);
    const rawParams = entrypoint.params;
    if (rawParams !== undefined && !Array.isArray(rawParams)) {
      throw new Error(`Workflow MCP entrypoint "${entrypoint.id}" has an invalid parameter list.`);
    }
    const paramNames = new Set<string>();
    const params = rawParams?.map((param) => {
      const normalized = cloneParam(param, entrypoint.id);
      if (paramNames.has(normalized.name)) {
        throw new Error(`Workflow MCP entrypoint "${entrypoint.id}" has duplicate parameter "${normalized.name}".`);
      }
      paramNames.add(normalized.name);
      return normalized;
    });
    return {
      id: entrypoint.id,
      title: entrypoint.title,
      description: typeof entrypoint.description === "string" ? entrypoint.description : undefined,
      params,
    };
  });
}

function clonePendingUserInput(
  value: WorkflowMcpUserInputRequest | undefined,
  entrypointId: string,
): WorkflowMcpUserInputRequest | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Workflow MCP received an invalid pending input request.");
  }
  for (const field of ["requestId", "nodeName", "title"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`Workflow MCP pending input has an invalid ${field}.`);
    }
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error("Workflow MCP pending input has an invalid description.");
  }
  if (!Array.isArray(value.params)) {
    throw new Error("Workflow MCP pending input has an invalid parameter list.");
  }
  if (value.defaultValues !== undefined && !isRecord(value.defaultValues)) {
    throw new Error("Workflow MCP pending input has invalid default values.");
  }
  const names = new Set<string>();
  const params = value.params.map((param) => {
    const normalized = cloneParam(param, entrypointId);
    if (names.has(normalized.name)) {
      throw new Error(`Workflow MCP pending input has duplicate parameter "${normalized.name}".`);
    }
    names.add(normalized.name);
    return normalized;
  });
  return {
    requestId: value.requestId,
    nodeName: value.nodeName,
    title: value.title,
    ...(value.description !== undefined ? { description: value.description } : {}),
    params,
    ...(value.defaultValues !== undefined ? { defaultValues: { ...value.defaultValues } } : {}),
  };
}

const WORKFLOW_MCP_PARAM_NAME_PATTERN = /^[\p{L}_][\p{L}\p{N}_.-]{0,127}$/u;
const WORKFLOW_MCP_PARAM_CONTROLS = new Set([
  "text", "textarea", "radio", "select", "checkboxes",
  "date", "time", "datetime", "date-range",
]);
const WORKFLOW_MCP_RESERVED_PARAM_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function cloneParam(
  value: unknown,
  entrypointId: string,
): NonNullable<WorkflowMcpEntrypointStructure["params"]>[number] {
  if (!isRecord(value)) {
    throw new Error(`Workflow MCP entrypoint "${entrypointId}" has an invalid parameter.`);
  }

  const name = value.name;
  if (
    typeof name !== "string" ||
    name.trim() !== name ||
    !WORKFLOW_MCP_PARAM_NAME_PATTERN.test(name) ||
    WORKFLOW_MCP_RESERVED_PARAM_NAMES.has(name)
  ) {
    throw new Error(`Workflow MCP entrypoint "${entrypointId}" has an invalid parameter name.`);
  }
  if (!isWorkflowMcpParamType(value.type)) {
    throw new Error(`Workflow MCP parameter "${name}" has an unsupported type.`);
  }

  const stringFields = ["flag", "shortFlag", "label", "description", "defaultValue", "title"] as const;
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Workflow MCP parameter "${name}" has an invalid ${field}.`);
    }
  }
  for (const field of ["required", "multiple"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new Error(`Workflow MCP parameter "${name}" has an invalid ${field}.`);
    }
  }
  if (value.control !== undefined && (
    typeof value.control !== "string" || !WORKFLOW_MCP_PARAM_CONTROLS.has(value.control)
  )) {
    throw new Error(`Workflow MCP parameter "${name}" has an invalid control.`);
  }

  const options = cloneParamOptions(value.options, name);
  const accept = cloneParamAccept(value.accept, name);
  return {
    name,
    ...(value.flag !== undefined ? { flag: value.flag as string } : {}),
    ...(value.shortFlag !== undefined ? { shortFlag: value.shortFlag as string } : {}),
    type: value.type,
    ...(value.required !== undefined ? { required: value.required as boolean } : {}),
    ...(value.description !== undefined ? { description: value.description as string } : {}),
    ...(value.defaultValue !== undefined ? { defaultValue: value.defaultValue as string } : {}),
    ...(value.multiple !== undefined ? { multiple: value.multiple as boolean } : {}),
    ...(value.control !== undefined ? { control: value.control as NonNullable<NonNullable<WorkflowMcpEntrypointStructure["params"]>[number]["control"]> } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(accept !== undefined ? { accept } : {}),
    ...(value.title !== undefined ? { title: value.title as string } : {}),
    ...(value.label !== undefined ? { label: value.label as string } : {}),
  };
}

function cloneParamOptions(
  value: unknown,
  paramName: string,
): NonNullable<WorkflowMcpEntrypointStructure["params"]>[number]["options"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Workflow MCP parameter "${paramName}" has an invalid options list.`);
  }
  const values = new Set<string>();
  return value.map((option, index) => {
    if (!isRecord(option) || typeof option.value !== "string") {
      throw new Error(`Workflow MCP parameter "${paramName}" has an invalid option at index ${index}.`);
    }
    if (values.has(option.value)) {
      throw new Error(`Workflow MCP parameter "${paramName}" has duplicate option "${option.value}".`);
    }
    values.add(option.value);
    for (const field of ["label", "description"] as const) {
      if (option[field] !== undefined && typeof option[field] !== "string") {
        throw new Error(`Workflow MCP parameter "${paramName}" option "${option.value}" has an invalid ${field}.`);
      }
    }
    return {
      value: option.value,
      ...(option.label !== undefined ? { label: option.label as string } : {}),
      ...(option.description !== undefined ? { description: option.description as string } : {}),
    };
  });
}

function cloneParamAccept(value: unknown, paramName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Workflow MCP parameter "${paramName}" has an invalid accept list.`);
  }
  return [...value] as string[];
}

function isWorkflowMcpParamType(value: unknown): value is NonNullable<WorkflowMcpEntrypointStructure["params"]>[number]["type"] {
  return value === "string" || value === "number" || value === "boolean" || value === "positional" || value === "file";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createWorkflowMcpInteractionRequiredResult(
  report: WorkflowMcpExecutionReport,
  entrypoint: WorkflowMcpEntrypointStructure,
): WorkflowMcpToolResult {
  return workflowReportToMcpResult(report, entrypoint, {
    code: "interaction_required",
    message: "Reconnect with a client that supports MCP form elicitation to continue this run.",
    pendingInput: summarizePendingWorkflowMcpInput(report),
  });
}
