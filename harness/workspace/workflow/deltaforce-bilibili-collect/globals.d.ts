type OutputItemChunk =
  | {
      type: "output_item_start";
      item: RunOutputItemInput;
    }
  | {
      type: "output_item_delta";
      itemId: string;
      delta: unknown;
      item?: Partial<RunOutputItemInput>;
    }
  | { type: "output_item_end"; itemId: string };

type RunOutputStreamChunk = string | OutputItemChunk;

interface RunOutputItemInput {
  id?: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: "markdown" | "text" | "json";
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

interface OutputPayloadShape {
  errCode: number;
  errMessage: string;
  items: RunOutputItemInput[];
  [key: string]: unknown;
}

interface ExecutorContextShape {
  workflowName: string;
  workflowDir: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
  conversationId?: string;
}

interface RuntimeContextShape {
  storage: {
    local: {
      persistentValue: {
        workflow: {
          getValue(key: string): Promise<unknown | undefined>;
          setValue(key: string, value: unknown): Promise<void>;
          updateValue(key: string, updater: (current: unknown | undefined) => unknown): Promise<unknown>;
        };
      };
    };
  };
  metadata?: Record<string, unknown>;
  conversation?: {
    conversationId?: string;
  };
  abortSignal?: AbortSignal;
}

interface ErrorInput {
  type: string;
  message: string;
  nodeName?: string;
  metadata?: Record<string, unknown>;
  cause?: unknown;
}

declare const workflow: {
  HarnessError: new (input: ErrorInput) => Error;
  createOutputPayload(input?: {
    items?: RunOutputItemInput[];
    errCode?: number;
    errMessage?: string;
    [key: string]: unknown;
  }): OutputPayloadShape;
  createInputNode<Input, Output>(options: {
    name?: string;
    parse(input: Input, context: RuntimeContextShape): Promise<Output> | Output;
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
  defineWorkflow<Input, Output>(definition: {
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
    tokenUsage?: { enabled: boolean; display?: boolean };
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
  ): Promise<{
    chunks: RunOutputStreamChunk[];
    output: Output | undefined;
  }>;
  getKnowledgeDocument(
    storage: RuntimeContextShape["storage"]["local"],
    documentId: string,
  ): Promise<{ id: string } | undefined>;
  createKnowledgeDocument(
    storage: RuntimeContextShape["storage"]["local"],
    input: { id?: string; title: string; markdown: string },
  ): Promise<unknown>;
  editKnowledgeDocument(
    storage: RuntimeContextShape["storage"]["local"],
    input: { id: string; title?: string; markdown?: string },
  ): Promise<unknown>;
};
