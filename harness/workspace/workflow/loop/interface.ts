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

export interface LoopInput {
  rounds: number;
  target: number;
}

export interface LoopState extends WorkflowPayload {
  rounds: number;
  target: number;
  total: number;
  steps: string[];
  lastBoostRoute?: "burst" | "steady" | "finish";
}

export interface LoopOutputPayload extends WorkflowOutputPayload {
  rounds: number;
  target: number;
  total: number;
  steps: string[];
  success: boolean;
}

export type LoopOutput = WorkflowExecutorResult<LoopOutputPayload>;
