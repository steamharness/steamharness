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

export interface OutputShowcaseDisplaySnapshotItem {
  id: string;
  kind: "output" | "tool" | "user-input-resolved" | "timer";
  title: string;
  content: unknown;
  contentType: OutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OutputShowcaseDisplaySnapshot {
  projectName: string;
  projectName: string;
  confirmed: boolean;
  toolSummary: string;
  longTaskTimerId: string;
  items: OutputShowcaseDisplaySnapshotItem[];
}

export interface ExecutorResult<Output extends RunPayload> {
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

export interface OutputShowcaseConfirmationPayload extends RunPayload {
  requestId: string;
  values: OutputShowcaseConfirmationValues;
  submittedAt: string;
}

export interface OutputShowcaseOutputPayload extends RunOutputPayload {
  projectName: string;
  toolSummary: string;
  confirmed: boolean;
  longTaskTimerId: string;
  pageSnapshot: OutputShowcaseDisplaySnapshot;
}

export type OutputShowcaseResult = ExecutorResult<OutputShowcaseOutputPayload>;
