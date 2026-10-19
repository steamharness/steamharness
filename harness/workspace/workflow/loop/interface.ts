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

export interface LoopInput {
  rounds: number;
  target: number;
}

export interface LoopState extends RunPayload {
  rounds: number;
  target: number;
  total: number;
  steps: string[];
  lastBoostRoute?: "burst" | "steady" | "finish";
}

export interface LoopOutputPayload extends RunOutputPayload {
  rounds: number;
  target: number;
  total: number;
  steps: string[];
  success: boolean;
}

export type LoopOutput = ExecutorResult<LoopOutputPayload>;
