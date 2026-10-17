import type { NodeContext, WorkflowContext } from "./context";

export interface WorkflowNodeMetadata {
  type: string;
  title: string;
  version: string;
  [key: string]: unknown;
}

export type WorkflowNodeMetadataInput = Partial<WorkflowNodeMetadata>;

export function createWorkflowNodeMetadata(
  metadata: WorkflowNodeMetadataInput | undefined,
  fallback: {
    type: string;
    title: string;
    version?: string;
  },
): WorkflowNodeMetadata {
  return {
    type: normalizeMetadataText(metadata?.type) ?? fallback.type,
    title: normalizeMetadataText(metadata?.title) ?? fallback.title,
    version: normalizeMetadataText(metadata?.version) ?? fallback.version ?? "1.0.0",
  };
}

export interface NodeDefinition<Input, Output> {
  name: string;
  standardName?: string;
  metadata?: WorkflowNodeMetadata;
  run(input: Input, context: NodeContext): Promise<Output> | Output;
}

export interface StreamNodeDefinition<Input, Chunk, Output = void> {
  name: string;
  standardName?: string;
  metadata?: WorkflowNodeMetadata;
  stream(input: Input, context: NodeContext): AsyncIterable<Chunk>;
  finalize?: (
    chunks: Chunk[],
    context: NodeContext,
    input?: Input,
  ) => Promise<Output> | Output;
}

export interface WorkflowDefinition<Input, Output> {
  name: string;
  run(input: Input, context: WorkflowContext): Promise<Output> | Output;
}

function normalizeMetadataText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
