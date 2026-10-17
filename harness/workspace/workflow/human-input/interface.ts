export interface PermissionInput {
  requestedAt: string;
}

export interface NetworkPermissionValues {
  allowed: boolean;
}

export interface WorkflowPayload {
  errCode: number;
  errMessage: string;
}

export type WorkflowOutputContentType = "markdown" | "text" | "json";

export interface WorkflowOutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: WorkflowOutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowOutputPayload extends WorkflowPayload {
  items: WorkflowOutputItem[];
}

export interface WorkflowExecutorResult<Output extends WorkflowPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export interface NetworkPermissionPayload extends WorkflowPayload {
  requestId: string;
  values: NetworkPermissionValues;
  submittedAt: string;
}

export interface PermissionOutputPayload extends WorkflowOutputPayload {
  allowed: boolean;
  message: string;
  requestId: string;
  submittedAt: string;
}

export type HumanInputResult = WorkflowExecutorResult<PermissionOutputPayload>;
