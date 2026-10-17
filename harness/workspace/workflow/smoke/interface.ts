export interface SmokeInput {
  message: string;
  mode: "ok" | "fail" | "plain-error" | "payload-fail" | "wait";
  waitMs: number;
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

export interface SmokeOutputPayload extends WorkflowOutputPayload {
  mode: SmokeInput["mode"];
  conversationId?: string;
  conversationMessages: number;
  previousMessage?: string;
  kvLastMessage?: string;
}

export type SmokeOutput = WorkflowExecutorResult<SmokeOutputPayload>;
