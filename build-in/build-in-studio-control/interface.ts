import type {
  WorkflowOutputPayload,
  WorkflowPayload as CoreWorkflowPayload,
} from "workflow-code";

export interface WorkflowPayload extends CoreWorkflowPayload {}

export interface StudioControlInput extends WorkflowPayload {
  operation: string;
  input: Record<string, unknown>;
}

export interface StudioControlOutputPayload extends WorkflowOutputPayload {
  operation: string;
  value: unknown;
}
