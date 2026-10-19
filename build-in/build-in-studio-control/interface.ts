import type {
  RunOutputPayload,
  RunPayload as CoreProjectPayload,
} from "steamharness";

export interface RunPayload extends CoreProjectPayload {}

export interface StudioControlInput extends RunPayload {
  operation: string;
  input: Record<string, unknown>;
}

export interface StudioControlOutputPayload extends RunOutputPayload {
  operation: string;
  value: unknown;
}
