import type { LLMChatInput, LLMChatOutput, LLMProvider, LLMStreamChunk } from "./types";

export interface MockLLMProviderOptions {
  text?: string | ((input: LLMChatInput) => string | Promise<string>);
  chunkSize?: number;
}

export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";
  private readonly text: NonNullable<MockLLMProviderOptions["text"]>;
  private readonly chunkSize: number;

  constructor(options: MockLLMProviderOptions = {}) {
    this.text = options.text ?? ((input) => `Mock response: ${renderInput(input)}`);
    this.chunkSize = options.chunkSize ?? 12;
  }

  async chat(input: LLMChatInput): Promise<LLMChatOutput> {
    const text = await this.resolveText(input);

    return {
      text,
      finishReason: "stop",
      usage: createMockUsage(input, text),
    };
  }

  async *stream(input: LLMChatInput): AsyncIterable<LLMStreamChunk> {
    const text = await this.resolveText(input);

    for (let index = 0; index < text.length; index += this.chunkSize) {
      yield {
        type: "text-delta",
        text: text.slice(index, index + this.chunkSize),
      };
    }

    yield {
      type: "finish",
      finishReason: "stop",
      usage: createMockUsage(input, text),
    };
  }

  private async resolveText(input: LLMChatInput): Promise<string> {
    if (typeof this.text === "function") {
      return this.text(input);
    }

    return this.text;
  }
}

function renderInput(input: LLMChatInput): string {
  if (input.prompt !== undefined) {
    return input.prompt;
  }

  return input.messages.map((message) => String(message.content)).join("\n");
}

function createMockUsage(input: LLMChatInput, output: string): NonNullable<LLMChatOutput["usage"]> {
  const inputTokens = estimateTokenCount(renderInput(input));
  const outputTokens = estimateTokenCount(output);

  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: 0,
    },
    totalTokens: inputTokens + outputTokens,
  };
}

function estimateTokenCount(value: string): number {
  const normalized = value.trim();

  if (normalized === "") {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}
