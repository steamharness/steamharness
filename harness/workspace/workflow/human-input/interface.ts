export interface PermissionInput {
  requestedAt: string;
}

export interface NetworkPermissionValues {
  allowed: boolean;
}

export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export type OutputContentType = "markdown" | "text" | "json";

export interface OutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: OutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunOutputPayload extends RunPayload {
  items: OutputItem[];
}

export interface ExecutorResult<Output extends RunPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export interface NetworkPermissionPayload extends RunPayload {
  requestId: string;
  values: NetworkPermissionValues;
  submittedAt: string;
}

export interface PermissionOutputPayload extends RunOutputPayload {
  allowed: boolean;
  message: string;
  requestId: string;
  submittedAt: string;
}

export type HumanInputResult = ExecutorResult<PermissionOutputPayload>;
