import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type McpFileInputMode = "local" | "server";

export type McpRunStatus =
  | "running"
  | "waiting_for_input"
  | "success"
  | "failed"
  | "aborted"
  | "timed_out";

export type McpParamType = "string" | "number" | "boolean" | "positional" | "file";
export type McpParamControl =
  | "text"
  | "textarea"
  | "radio"
  | "select"
  | "checkboxes"
  | "date"
  | "time"
  | "datetime"
  | "date-range";

export interface McpParamOption {
  value: string;
  label?: string;
  description?: string;
}

export interface McpParamDefinition {
  name: string;
  flag?: string;
  shortFlag?: string;
  type: McpParamType;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  multiple?: boolean;
  control?: McpParamControl;
  options?: McpParamOption[];
  accept?: string[];
  title?: string;
  label?: string;
}

export interface McpEntrypointStructure {
  id: string;
  title: string;
  description?: string;
  params?: McpParamDefinition[];
}

export interface McpStructureReport {
  projectType: "workflow" | "conversation" | "kanban" | string;
  workflow: { name: string };
  defaultEntrypoint?: string;
  entrypoints?: McpEntrypointStructure[];
}

export interface McpUserInputRequest {
  requestId: string;
  nodeName: string;
  title: string;
  description?: string;
  params: McpParamDefinition[];
  defaultValues?: Record<string, unknown>;
  metadata?: {
    type: string;
    title: string;
    version: string;
    toolName?: string;
  };
  createdAt?: string;
}

export interface McpExecutionReport {
  runId: string;
  projectName?: string;
  entrypointId?: string;
  entrypointTitle?: string;
  status: McpRunStatus;
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
  pendingUserInput?: McpUserInputRequest;
}

export interface McpManagedFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  storage: "local" | "server";
  projectId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface McpFileResolveContext {
  projectId: string;
  entrypointId: string;
  param: McpParamDefinition;
  signal: AbortSignal;
}

export type McpFileResolver = (
  values: unknown[],
  context: McpFileResolveContext,
) => Promise<McpManagedFileReference[]>;

export interface McpRunRequest {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  /** Schema-validated MCP arguments before file values are imported into managed storage. */
  input: Record<string, unknown>;
  args: string[];
  signal: AbortSignal;
}

export interface McpResumeRequest {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  runId: string;
  requestId: string;
  nodeName: string;
  values: Record<string, unknown>;
  signal: AbortSignal;
}

export interface McpCancelRequest {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  runId: string;
  requestId: string;
  reason: "elicitation_declined" | "elicitation_cancelled" | "elicitation_failed" | "request_cancelled";
  signal: AbortSignal;
}

export interface McpRunner {
  run(request: McpRunRequest): Promise<McpExecutionReport>;
  resume(request: McpResumeRequest): Promise<McpExecutionReport>;
  cancel?(request: McpCancelRequest): Promise<void>;
}

export interface McpResolvedUserInput {
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
export interface McpRunSnapshot {
  projectId: string;
  entrypointId: string;
  entrypointTitle: string;
  input: Record<string, unknown>;
  args: string[];
  resolvedUserInputs: McpResolvedUserInput[];
  startedAt: string;
  endedAt: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  report: unknown;
}

export interface McpRunSnapshotMessage {
  type: "workflow_mcp_run_snapshot";
  snapshot: McpRunSnapshot;
}

export interface McpPendingInputSummary {
  requestId: string;
  title: string;
  fields: Array<{
    name: string;
    title: string;
    type: McpParamType;
    required: boolean;
  }>;
}

export interface McpErrorDetail {
  code: "project_failed" | "cancelled" | "timed_out" | "interaction_required";
  message: string;
  pendingInput?: McpPendingInputSummary;
}

export interface McpStructuredResult extends Record<string, unknown> {
  runId: string;
  status: McpRunStatus;
  entrypointId: string;
  entrypointTitle: string;
  output: unknown;
  error?: McpErrorDetail;
}

export type McpToolResult = CallToolResult & {
  structuredContent: McpStructuredResult;
};

export interface McpJsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

export interface McpAuditEvent {
  type:
    | "tool_call_started"
    | "tool_call_waiting"
    | "tool_call_resumed"
    | "tool_call_finished";
  projectId: string;
  entrypointId: string;
  runId?: string;
  requestId?: string;
  status?: McpRunStatus;
  isError?: boolean;
}
