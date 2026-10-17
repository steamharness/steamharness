import { BaseNode, BaseStreamNode, getLLMProvider } from "../base";
import type { NodeContext, WorkflowNodeMetadataInput } from "../../types/index";
import type {
  LLMChatInput,
  LLMChatOutput,
  LLMProviderSource,
  LLMStreamChunk,
} from "../../provider/llm/types";

export type LLMInputMapper<Input> = (
  input: Input,
  context: NodeContext,
) => Promise<LLMChatInput> | LLMChatInput;

export type LLMOutputMapper<Input, Output> = (
  output: LLMChatOutput,
  input: Input,
  context: NodeContext,
) => Promise<Output> | Output;

export interface LLMNodeOptions<Input, Output = LLMChatOutput> {
  name?: string;
  provider: LLMProviderSource;
  mapInput: LLMInputMapper<Input>;
  mapOutput?: LLMOutputMapper<Input, Output>;
  historyLimit?: number;
  metadata?: WorkflowNodeMetadataInput;
}

export function createLLMNode<Input>(
  options: LLMNodeOptions<Input, LLMChatOutput>,
): BaseNode<Input, LLMChatOutput>;
export function createLLMNode<Input, Output>(
  options: LLMNodeOptions<Input, Output> & {
    mapOutput: LLMOutputMapper<Input, Output>;
  },
): BaseNode<Input, Output>;
export function createLLMNode<Input, Output = LLMChatOutput>(
  options: LLMNodeOptions<Input, Output>,
): BaseNode<Input, Output> {
  return new LLMNode(options);
}

export function createLLMStreamNode<Input>(
  options: Pick<LLMNodeOptions<Input>, "name" | "provider" | "mapInput" | "historyLimit" | "metadata">,
): BaseStreamNode<Input, LLMStreamChunk, string> {
  return new LLMStreamNode(options);
}

class LLMNode<Input, Output> extends BaseNode<Input, Output> {
  private readonly provider: LLMProviderSource;
  private readonly mapInput: LLMInputMapper<Input>;
  private readonly mapOutput?: LLMOutputMapper<Input, Output>;

  constructor(options: LLMNodeOptions<Input, Output>) {
    super({
      name: options.name ?? "llm",
      standardName: "llm",
      historyLimit: options.historyLimit,
      metadata: options.metadata,
    });
    this.provider = options.provider;
    this.mapInput = options.mapInput;
    this.mapOutput = options.mapOutput;
  }

  protected async execute(input: Input, context: NodeContext): Promise<Output> {
    const provider = getLLMProvider(context, this.name, this.provider);
    const llmInput = {
      ...(await this.mapInput(input, context)),
      abortSignal: context.abortSignal,
    };
    const output = await provider.chat(llmInput);

    if (this.mapOutput) {
      return this.mapOutput(output, input, context);
    }

    return output as Output;
  }
}

class LLMStreamNode<Input> extends BaseStreamNode<Input, LLMStreamChunk, string> {
  private readonly provider: LLMProviderSource;
  private readonly mapInput: LLMInputMapper<Input>;

  constructor(options: Pick<LLMNodeOptions<Input>, "name" | "provider" | "mapInput" | "historyLimit" | "metadata">) {
    super({
      name: options.name ?? "llm-stream",
      standardName: "llm-stream",
      historyLimit: options.historyLimit,
      metadata: options.metadata,
    });
    this.provider = options.provider;
    this.mapInput = options.mapInput;
  }

  protected async *createStream(
    input: Input,
    context: NodeContext,
  ): AsyncIterable<LLMStreamChunk> {
    const provider = getLLMProvider(context, this.name, this.provider);
    const llmInput = {
      ...(await this.mapInput(input, context)),
      abortSignal: context.abortSignal,
    };

    yield* provider.stream(llmInput);
  }

  finalize(chunks: LLMStreamChunk[]): string {
    return chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.text)
      .join("");
  }
}
