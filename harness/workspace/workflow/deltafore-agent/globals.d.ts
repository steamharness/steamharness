type WorkflowOutputItemChunk =
  | {
      type: "output_item_start";
      item: {
        id?: string;
        title: string;
        content: unknown;
        icon?: string;
        iconPreset?: string;
        contentType?: "markdown" | "text" | "json";
        collapsed?: boolean;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      type: "output_item_delta";
      itemId: string;
      delta: unknown;
      item?: {
        title?: string;
        icon?: string;
        iconPreset?: string;
        contentType?: "markdown" | "text" | "json";
        collapsed?: boolean;
        metadata?: Record<string, unknown>;
      };
    }
  | { type: "output_item_end"; itemId: string };

type WorkflowOutputStreamChunk = string | WorkflowOutputItemChunk;
type WorkflowDetailsOutputStaticContent =
  | string
  | number
  | boolean
  | bigint
  | null
  | readonly unknown[]
  | Record<string, unknown>;

declare const workflow: {
  createOutputPayload(input?: {
    items?: Array<{
      id?: string;
      title: string;
      content: unknown;
      icon?: string;
      iconPreset?: string;
      contentType?: "markdown" | "text" | "json";
      collapsed?: boolean;
      metadata?: Record<string, unknown>;
    }>;
    errCode?: number;
    errMessage?: string;
    [key: string]: unknown;
  }): {
    errCode: number;
    errMessage: string;
    items: unknown[];
    [key: string]: unknown;
  };
  createInputNode<Input, Output>(options: {
    name?: string;
    parse(input: Input, context: unknown): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: unknown): Promise<Output> | Output;
  };
  createLLMNode<Input, Output>(options: {
    name?: string;
    provider: unknown;
    mapInput(input: Input, context: { abortSignal?: AbortSignal }): unknown;
    mapOutput(output: { text: string }, input: Input, context: unknown): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: unknown): Promise<Output> | Output;
  };
  createOutputNode<Input, Output>(options: {
    name?: string;
    format(input: Input, context: unknown): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: unknown): Promise<Output> | Output;
  };
  createOutputNode<Input, Output>(options: {
    name?: string;
    stream(input: Input, context: unknown): AsyncIterable<WorkflowOutputStreamChunk> | Iterable<WorkflowOutputStreamChunk>;
    format(stream: { text: string; items: unknown[]; chunks: unknown[] }, input: Input, context: unknown): Promise<Output> | Output;
  }): {
    name: string;
    stream(input: Input, context: unknown): AsyncIterable<WorkflowOutputStreamChunk>;
    finalize(chunks: WorkflowOutputStreamChunk[], context: unknown, input?: Input): Promise<Output> | Output;
  };
  createOutputNode<Input, Output>(options: {
    name?: string;
    stream?: (input: Input, context: unknown) => AsyncIterable<WorkflowOutputStreamChunk> | Iterable<WorkflowOutputStreamChunk>;
    format: ((input: Input, context: unknown) => Promise<Output> | Output)
      | ((stream: { text: string; items: unknown[]; chunks: unknown[] }, input: Input, context: unknown) => Promise<Output> | Output);
  }): {
    name: string;
    run?: (input: Input, context: unknown) => Promise<Output> | Output;
    stream?: (input: Input, context: unknown) => AsyncIterable<WorkflowOutputStreamChunk>;
    finalize?: (chunks: WorkflowOutputStreamChunk[], context: unknown, input?: Input) => Promise<Output> | Output;
  };
  createDetailsOutputNode<Input, Output>(options?: {
    name?: string;
    title?: string | ((input: Input, context: unknown) => unknown);
    content?: WorkflowDetailsOutputStaticContent | ((input: Input, context: unknown) => unknown);
    icon?: string | ((input: Input, context: unknown) => unknown);
    resolve?: (input: Input, context: unknown) => {
      title: string;
      content: unknown;
      icon?: string;
    };
    format?: (
      payload: {
        errCode: number;
        errMessage: string;
        items: unknown[];
      },
      details: {
        title: string;
        content: unknown;
        contentType: "markdown" | "text" | "json";
        icon: string;
        iconPreset?: string;
      },
      input: Input,
      context: unknown,
    ) => Promise<Output> | Output;
    metadata?: Record<string, unknown>;
  }): {
    name: string;
    run(input: Input, context: unknown): Promise<Output> | Output;
  };
  createLLMProviderRef(id: string, fallback: () => unknown): unknown;
  createLLMProviderFromEnv(): unknown;
  getLLMProvider(context: unknown, nodeName: string, provider: unknown): {
    stream(input: unknown): AsyncIterable<
      | {
          type: "text-delta";
          text: string;
        }
      | {
          type: "finish";
        }
    >;
  };
  defineWorkflow<Input, Output>(definition: {
    name: string;
    run(input: Input, context: unknown): Promise<Output> | Output;
  }): {
    name: string;
    run(input: Input, context: unknown): Promise<Output> | Output;
  };
  defineExecutor<Input, Output>(definition: {
    projectType: "conversation";
    workflow: unknown;
    conversation?: {
      attachments?: { images?: boolean; videos?: boolean; files?: boolean };
      inputQueue?: { enabled: boolean };
    };
    tokenUsage?: {
      enabled: boolean;
      display?: boolean;
    };
    registry?: Array<{
      name: string;
      node: unknown;
      stream?: boolean;
    }>;
    params?: Array<Record<string, unknown>>;
    createInput(context: { args: string[] }): Input;
  }): unknown;
  runNode<Input, Output>(
    node: { run(input: Input, context: unknown): Promise<Output> | Output },
    input: Input,
    context: unknown,
  ): Promise<Output>;
  runStreamNode<Input, Output>(
    node: {
      stream(input: Input, context: unknown): AsyncIterable<WorkflowOutputStreamChunk>;
      finalize(chunks: WorkflowOutputStreamChunk[], context: unknown, input?: Input): Promise<Output> | Output;
    },
    input: Input,
    context: unknown,
  ): Promise<{
    chunks: WorkflowOutputStreamChunk[];
    output: Output | undefined;
  }>;
  runWorkflow<Input, Output>(
    childWorkflow: {
      name: string;
      run(input: Input, context: unknown): Promise<Output> | Output;
    },
    input: Input,
    context: unknown,
    options?: {
      name?: string;
      metadata?: Record<string, unknown>;
      conversationMode?: "shared" | "shared-readonly";
      kvMode?: "shared" | "isolated";
      outputVisibility?: "visible" | "hidden";
      emitNode?: boolean;
      maxDepth?: number;
      onOutputChunk?(chunk: unknown, event: unknown): Promise<void> | void;
      onOutput?(output: Output, event?: unknown): Promise<void> | void;
    },
  ): Promise<Output>;
  runFor<State, Item>(
    input: State,
    context: unknown,
    options: {
      name?: string;
      items(input: State, context: unknown): Iterable<Item> | AsyncIterable<Item> | Promise<Iterable<Item> | AsyncIterable<Item>>;
      run(input: State, item: Item, index: number, context: unknown): Promise<State> | State;
      maxIterations?: number;
    },
  ): Promise<State>;
  runWhile<State>(
    input: State,
    context: unknown,
    options: {
      name?: string;
      condition(state: State, context: unknown): boolean | Promise<boolean>;
      run(state: State, context: unknown, iteration: number): Promise<State> | State;
      maxIterations?: number;
    },
  ): Promise<State>;
};
