export interface SmokeInput {
  message: string;
  mode: "ok" | "fail" | "plain-error" | "payload-fail" | "wait";
  waitMs: number;
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

export interface SmokeOutputPayload extends RunOutputPayload {
  mode: SmokeInput["mode"];
  conversationId?: string;
  conversationMessages: number;
  previousMessage?: string;
  kvLastMessage?: string;
}

export type SmokeOutput = ExecutorResult<SmokeOutputPayload>;
