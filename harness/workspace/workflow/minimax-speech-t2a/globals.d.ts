interface WorkflowRuntimeContextShape {
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

interface WorkflowExecutorContextShape {
  workflowName: string;
  workflowDir: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
}

interface WorkflowErrorInput {
  type: string;
  message: string;
  nodeName?: string;
  metadata?: Record<string, unknown>;
  cause?: unknown;
}

interface WorkflowOutputItemInput {
  id?: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: "markdown" | "text" | "json" | "audio";
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

interface WorkflowOutputPayloadShape {
  errCode: number;
  errMessage: string;
  items: WorkflowOutputItemInput[];
  [key: string]: unknown;
}

type WorkflowOutputItemChunk =
  | { type: "output_item_start"; item: WorkflowOutputItemInput }
  | { type: "output_item_delta"; itemId: string; delta: unknown; item?: Partial<WorkflowOutputItemInput> }
  | { type: "output_item_end"; itemId: string };

type WorkflowOutputStreamChunk = string | WorkflowOutputItemChunk;

declare const workflow: {
  WorkflowError: new (input: WorkflowErrorInput) => Error;
  createInputNode<Input, Output>(options: {
    name?: string;
    parse(input: Input, context: WorkflowRuntimeContextShape): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: WorkflowRuntimeContextShape): Promise<Output> | Output;
  };
  createOutputNode<Input, Output>(options: {
    name?: string;
    format(input: Input, context: WorkflowRuntimeContextShape): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: WorkflowRuntimeContextShape): Promise<Output> | Output;
  };
  createOutputNode<Input, Output>(options: {
    name?: string;
    stream(input: Input, context: WorkflowRuntimeContextShape): AsyncIterable<WorkflowOutputStreamChunk> | Iterable<WorkflowOutputStreamChunk>;
    format(
      stream: { text: string; items: WorkflowOutputItemInput[]; chunks: WorkflowOutputStreamChunk[] },
      input: Input,
      context: WorkflowRuntimeContextShape,
    ): Promise<Output> | Output;
  }): {
    name: string;
    stream(input: Input, context: WorkflowRuntimeContextShape): AsyncIterable<WorkflowOutputStreamChunk>;
    finalize(chunks: WorkflowOutputStreamChunk[], context: WorkflowRuntimeContextShape, input?: Input): Promise<Output> | Output;
  };
  createOutputPayload(input?: {
    items?: WorkflowOutputItemInput[];
    errCode?: number;
    errMessage?: string;
    [key: string]: unknown;
  }): WorkflowOutputPayloadShape;
  createOutputItemChunk(chunk: WorkflowOutputItemChunk): WorkflowOutputItemChunk;
  defineWorkflow<Input, Output>(definition: {
    name: string;
    run(input: Input, context: WorkflowRuntimeContextShape): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: WorkflowRuntimeContextShape): Promise<Output> | Output;
  };
  defineEntrypoint<Input, Output>(definition: {
    id: string;
    title: string;
    description?: string;
    workflow: unknown;
    registry?: Array<{ name: string; node: unknown; stream?: boolean }>;
    params?: Array<Record<string, unknown>>;
    createInput(context: WorkflowExecutorContextShape): Input;
    createContext?(context: WorkflowExecutorContextShape): Partial<WorkflowRuntimeContextShape> | Promise<Partial<WorkflowRuntimeContextShape>>;
  }): unknown;
  defineExecutor<Input, Output>(definition: {
    projectType: "workflow";
    defaultEntrypoint: string;
    entrypoints: unknown[];
  }): unknown;
  runNode<Input, Output>(
    node: { run(input: Input, context: WorkflowRuntimeContextShape): Promise<Output> | Output },
    input: Input,
    context: WorkflowRuntimeContextShape,
  ): Promise<Output>;
  runStreamNode<Input, Output>(
    node: {
      stream(input: Input, context: WorkflowRuntimeContextShape): AsyncIterable<WorkflowOutputStreamChunk>;
      finalize(chunks: WorkflowOutputStreamChunk[], context: WorkflowRuntimeContextShape, input?: Input): Promise<Output> | Output;
    },
    input: Input,
    context: WorkflowRuntimeContextShape,
  ): Promise<{ chunks: WorkflowOutputStreamChunk[]; output: Output | undefined }>;
  getEnv(name: string): string | undefined;
};
