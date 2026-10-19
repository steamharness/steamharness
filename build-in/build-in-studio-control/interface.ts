import type {
  RunOutputPayload,
  RunPayload as CoreWorkflowPayload,
} from "steamharness";

export interface RunPayload extends CoreWorkflowPayload {}

export interface StudioControlInput extends RunPayload {
  operation: string;
  input: Record<string, unknown>;
}

export interface StudioControlOutputPayload extends RunOutputPayload {
  operation: string;
  value: unknown;
}
