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

export interface GitlabWebhookOutputPayload extends RunOutputPayload {
  event: string;
  action: string;
  id: string;
  url: string;
  summary: GitlabWebhookEventSummary;
  conversationId?: string;
  historyLength: number;
  success: true;
}

export type GitlabWebhookOutput = ExecutorResult<GitlabWebhookOutputPayload>;
