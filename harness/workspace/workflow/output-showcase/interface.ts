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

export interface OutputShowcaseDisplaySnapshotItem {
  id: string;
  kind: "output" | "tool" | "user-input-resolved" | "timer";
  title: string;
  content: unknown;
  contentType: WorkflowOutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OutputShowcaseDisplaySnapshot {
  workflowName: string;
  projectName: string;
  confirmed: boolean;
  toolSummary: string;
  longTaskTimerId: string;
  items: OutputShowcaseDisplaySnapshotItem[];
}

export interface WorkflowExecutorResult<Output extends WorkflowPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export interface OutputShowcaseInput {
  projectName: string;
  toolDelayMs: number;
  taskDurationMs: number;
  streamDelayMs: number;
}

export interface OutputShowcaseConfirmationValues {
  // The wire form of the confirmation node is a radio whose
  // `decision` value is "enter" | "skip". The boolean `confirmed` is
  // derived from it for downstream branches and output payloads that
  // already reason in terms of "did the user enter the long task?".
  decision?: "enter" | "skip";
  confirmed: boolean;
}

export interface OutputShowcaseConfirmationPayload extends WorkflowPayload {
  requestId: string;
  values: OutputShowcaseConfirmationValues;
  submittedAt: string;
}

export interface OutputShowcaseOutputPayload extends WorkflowOutputPayload {
  projectName: string;
  toolSummary: string;
  confirmed: boolean;
  longTaskTimerId: string;
  pageSnapshot: OutputShowcaseDisplaySnapshot;
}

export type OutputShowcaseResult = WorkflowExecutorResult<OutputShowcaseOutputPayload>;
