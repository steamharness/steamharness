export type ClassifyInput = string;

export type ClassifyCategory = "uniapp" | "uni-app x" | "unicloud";

export type ClassifyCategoryResult = ClassifyCategory | "";

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

export interface ClassifyOutputPayload extends RunOutputPayload {
  category: ClassifyCategoryResult;
  success: boolean;
}

export type ClassifyOutput = ExecutorResult<ClassifyOutputPayload>;
