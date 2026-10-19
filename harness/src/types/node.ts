import type { NodeContext, RunContext } from "./context";

export interface NodeMetadata {
  type: string;
  title: string;
  version: string;
  [key: string]: unknown;
}

export type NodeMetadataInput = Partial<NodeMetadata>;

export function createProjectNodeMetadata(
  metadata: NodeMetadataInput | undefined,
  fallback: {
    type: string;
    title: string;
    version?: string;
  },
): NodeMetadata {
  return {
    type: normalizeMetadataText(metadata?.type) ?? fallback.type,
    title: normalizeMetadataText(metadata?.title) ?? fallback.title,
    version: normalizeMetadataText(metadata?.version) ?? fallback.version ?? "1.0.0",
  };
}

export interface NodeDefinition<Input, Output> {
  name: string;
  standardName?: string;
  metadata?: NodeMetadata;
  run(input: Input, context: NodeContext): Promise<Output> | Output;
}

export interface StreamNodeDefinition<Input, Chunk, Output = void> {
  name: string;
  standardName?: string;
  metadata?: NodeMetadata;
  stream(input: Input, context: NodeContext): AsyncIterable<Chunk>;
  finalize?: (
    chunks: Chunk[],
    context: NodeContext,
    input?: Input,
  ) => Promise<Output> | Output;
}

export interface Definition<Input, Output> {
  name: string;
  run(input: Input, context: RunContext): Promise<Output> | Output;
}

function normalizeMetadataText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
