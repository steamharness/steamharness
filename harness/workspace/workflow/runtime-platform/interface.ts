export type RuntimePlatformInput = Record<string, never>;

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

export type RuntimePlatformName = "cli" | "desktop";

export interface RuntimePlatformOutputPayload extends WorkflowOutputPayload {
  platform: RuntimePlatformName;
  isCli: boolean;
  isDesktop: boolean;
}

export type RuntimePlatformOutput = WorkflowExecutorResult<RuntimePlatformOutputPayload>;
