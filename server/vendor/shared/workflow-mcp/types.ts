import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type WorkflowMcpFileInputMode = "local" | "server";

export type WorkflowMcpRunStatus =
  | "running"
  | "waiting_for_input"
  | "success"
  | "failed"
  | "aborted"
  | "timed_out";

export type WorkflowMcpParamType = "string" | "number" | "boolean" | "positional" | "file";
export type WorkflowMcpParamControl =
  | "text"
  | "textarea"
  | "radio"
  | "select"
  | "checkboxes"
  | "date"
  | "time"
  | "datetime"
  | "date-range";

export interface WorkflowMcpParamOption {
  value: string;
  label?: string;
  description?: string;
}

export interface WorkflowMcpParamDefinition {
  name: string;
  flag?: string;
  shortFlag?: string;
  type: WorkflowMcpParamType;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  multiple?: boolean;
  control?: WorkflowMcpParamControl;
  options?: WorkflowMcpParamOption[];
  accept?: string[];
  title?: string;
  label?: string;
}

export interface WorkflowMcpEntrypointStructure {
  id: string;
  title: string;
  description?: string;
  params?: WorkflowMcpParamDefinition[];
}

export interface WorkflowMcpStructureReport {
  projectType: "workflow" | "conversation" | "kanban" | string;
  workflow: { name: string };
  defaultEntrypoint?: string;
  entrypoints?: WorkflowMcpEntrypointStructure[];
}

export interface WorkflowMcpUserInputRequest {
  requestId: string;
  nodeName: string;
  title: string;
  description?: string;
  params: WorkflowMcpParamDefinition[];
  defaultValues?: Record<string, unknown>;
  metadata?: {
    type: string;
    title: string;
    version: string;
    toolName?: string;
  };
  createdAt?: string;
}

export interface WorkflowMcpExecutionReport {
  runId: string;
  workflowName?: string;
  entrypointId?: string;
  entrypointTitle?: string;
  status: WorkflowMcpRunStatus;
  result?: {
    ok: boolean;
    data?: {
      errCode?: unknown;
      errMessage?: unknown;
      output?: unknown;
    };
    error?: {
      type?: string;
      message?: string;
    };
  };
  pendingUserInput?: WorkflowMcpUserInputRequest;
}

export interface WorkflowMcpManagedFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  storage: "local" | "server";
  workflowId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface WorkflowMcpFileResolveContext {
  projectId: string;
  entrypointId: string;
  param: WorkflowMcpParamDefinition;
  signal: AbortSignal;
}

export type WorkflowMcpFileResolver = (
  values: unknown[],
  context: WorkflowMcpFileResolveContext,
) => Promise<WorkflowMcpManagedFileReference[]>;

export interface WorkflowMcpRunRequest {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  /** Schema-validated MCP arguments before file values are imported into managed storage. */
  input: Record<string, unknown>;
  args: string[];
  signal: AbortSignal;
}

export interface WorkflowMcpResumeRequest {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  runId: string;
  requestId: string;
  nodeName: string;
  values: Record<string, unknown>;
  signal: AbortSignal;
}

export interface WorkflowMcpCancelRequest {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  runId: string;
  requestId: string;
  reason: "elicitation_declined" | "elicitation_cancelled" | "elicitation_failed" | "request_cancelled";
  signal: AbortSignal;
}

export interface WorkflowMcpRunner {
  run(request: WorkflowMcpRunRequest): Promise<WorkflowMcpExecutionReport>;
  resume(request: WorkflowMcpResumeRequest): Promise<WorkflowMcpExecutionReport>;
  cancel?(request: WorkflowMcpCancelRequest): Promise<void>;
}

export interface WorkflowMcpResolvedUserInput {
  requestId: string;
  nodeName: string;
  values: Record<string, unknown>;
  submittedAt: string;
}

/**
 * Lossless host-side execution snapshot. It is intentionally separate from
 * the cropped MCP tool result so a trusted host can persist diagnostics without
 * exposing reports, logs, or local inputs to the MCP client.
 */
export interface WorkflowMcpRunSnapshot {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  input: Record<string, unknown>;
  args: string[];
  resolvedUserInputs: WorkflowMcpResolvedUserInput[];
  startedAt: string;
  endedAt: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  report: unknown;
}

export interface WorkflowMcpRunSnapshotMessage {
  type: "workflow_mcp_run_snapshot";
  snapshot: WorkflowMcpRunSnapshot;
}

export interface WorkflowMcpPendingInputSummary {
  requestId: string;
  title: string;
  fields: Array<{
    name: string;
    title: string;
    type: WorkflowMcpParamType;
    required: boolean;
  }>;
}

export interface WorkflowMcpErrorDetail {
  code: "workflow_failed" | "cancelled" | "timed_out" | "interaction_required";
  message: string;
  pendingInput?: WorkflowMcpPendingInputSummary;
}

export interface WorkflowMcpStructuredResult extends Record<string, unknown> {
  runId: string;
  status: WorkflowMcpRunStatus;
  entrypointId: string;
  entrypointTitle: string;
  output: unknown;
  error?: WorkflowMcpErrorDetail;
}

export type WorkflowMcpToolResult = CallToolResult & {
  structuredContent: WorkflowMcpStructuredResult;
};

export interface WorkflowMcpJsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

export interface WorkflowMcpAuditEvent {
  type:
    | "tool_call_started"
    | "tool_call_waiting"
    | "tool_call_resumed"
    | "tool_call_finished";
  projectId: string;
  entrypointId: string;
  runId?: string;
  requestId?: string;
  status?: WorkflowMcpRunStatus;
  isError?: boolean;
}
