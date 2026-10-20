interface RuntimeContextShape {
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

interface ExecutorContextShape {
  projectName: string;
  projectDir: string;
  args: string[];
  config: Record<string, unknown>;
  abortSignal: AbortSignal;
}

interface ErrorInput {
  type: string;
  message: string;
  nodeName?: string;
  metadata?: Record<string, unknown>;
  cause?: unknown;
}

interface RunOutputItemInput {
  id?: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: "markdown" | "text" | "json" | "audio";
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

interface OutputPayloadShape {
  errCode: number;
  errMessage: string;
  items: RunOutputItemInput[];
  [key: string]: unknown;
}

type OutputItemChunk =
  | { type: "output_item_start"; item: RunOutputItemInput }
  | { type: "output_item_delta"; itemId: string; delta: unknown; item?: Partial<RunOutputItemInput> }
  | { type: "output_item_end"; itemId: string };

type RunOutputStreamChunk = string | OutputItemChunk;

declare const steamharness: {
  HarnessError: new (input: ErrorInput) => Error;
  createInputNode<Input, Output>(options: {
    name?: string;
    parse(input: Input, context: RuntimeContextShape): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: RuntimeContextShape): Promise<Output> | Output;
  };
  createOutputNode<Input, Output>(options: {
    name?: string;
    format(input: Input, context: RuntimeContextShape): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: RuntimeContextShape): Promise<Output> | Output;
  };
  createOutputNode<Input, Output>(options: {
    name?: string;
    stream(input: Input, context: RuntimeContextShape): AsyncIterable<RunOutputStreamChunk> | Iterable<RunOutputStreamChunk>;
    format(
      stream: { text: string; items: RunOutputItemInput[]; chunks: RunOutputStreamChunk[] },
      input: Input,
      context: RuntimeContextShape,
    ): Promise<Output> | Output;
  }): {
    name: string;
    stream(input: Input, context: RuntimeContextShape): AsyncIterable<RunOutputStreamChunk>;
    finalize(chunks: RunOutputStreamChunk[], context: RuntimeContextShape, input?: Input): Promise<Output> | Output;
  };
  createOutputPayload(input?: {
    items?: RunOutputItemInput[];
    errCode?: number;
    errMessage?: string;
    [key: string]: unknown;
  }): OutputPayloadShape;
  createOutputItemChunk(chunk: OutputItemChunk): OutputItemChunk;
  defineProject<Input, Output>(definition: {
    name: string;
    run(input: Input, context: RuntimeContextShape): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: RuntimeContextShape): Promise<Output> | Output;
  };
  defineEntrypoint<Input, Output>(definition: {
    id: string;
    title: string;
    description?: string;
    workflow: unknown;
    registry?: Array<{ name: string; node: unknown; stream?: boolean }>;
    params?: Array<Record<string, unknown>>;
    createInput(context: ExecutorContextShape): Input;
    createContext?(context: ExecutorContextShape): Partial<RuntimeContextShape> | Promise<Partial<RuntimeContextShape>>;
  }): unknown;
  defineExecutor<Input, Output>(definition: {
    projectType: "workflow";
    defaultEntrypoint: string;
    entrypoints: unknown[];
  }): unknown;
  runNode<Input, Output>(
    node: { run(input: Input, context: RuntimeContextShape): Promise<Output> | Output },
    input: Input,
    context: RuntimeContextShape,
  ): Promise<Output>;
  runStreamNode<Input, Output>(
    node: {
      stream(input: Input, context: RuntimeContextShape): AsyncIterable<RunOutputStreamChunk>;
      finalize(chunks: RunOutputStreamChunk[], context: RuntimeContextShape, input?: Input): Promise<Output> | Output;
    },
    input: Input,
    context: RuntimeContextShape,
  ): Promise<{ chunks: RunOutputStreamChunk[]; output: Output | undefined }>;
  getConfig<T = string>(name: string): T | undefined;
};
