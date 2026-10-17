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

export interface GitlabWebhookInput {
  payload: string;
  message: string;
}

export interface GitlabWebhookEventSummary {
  event: string;
  action: string;
  id: string;
  url: string;
  content: string;
  project: string;
  author: string;
  rawEvent: string;
}

export interface GitlabWebhookOutputPayload extends WorkflowOutputPayload {
  event: string;
  action: string;
  id: string;
  url: string;
  summary: GitlabWebhookEventSummary;
  conversationId?: string;
  historyLength: number;
  success: true;
}

export type GitlabWebhookOutput = WorkflowExecutorResult<GitlabWebhookOutputPayload>;
