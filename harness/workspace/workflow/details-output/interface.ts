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

export interface DetailsOutputInput {
  icon: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  title: string;
  content: string;
}

export interface DetailsOutputPayload extends RunOutputPayload {}

export type DetailsOutputResult = ExecutorResult<DetailsOutputPayload>;
