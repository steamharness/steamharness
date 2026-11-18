export interface LLMTextPart { type: "text"; text: string }
export interface LLMImagePart { type: "image"; data: string; mimeType: string }
export type LLMMessage =
  | { role: "system"; content: string | LLMTextPart[] }
  | { role: "assistant"; content: string | LLMTextPart[] }
  | { role: "user"; content: string | (LLMTextPart | LLMImagePart)[] };

export type LLMFinishReason = "stop" | "length" | "tool-calls";
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails: { textTokens?: number; reasoningTokens?: number };
}

export interface LLMCallSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  maxRetries?: number;
  timeout?: number;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export type LLMChatInput = LLMCallSettings &
  (
    | {
        prompt: string;
        messages?: never;
      }
    | {
        prompt?: never;
        messages: LLMMessage[];
      }
  ) & {
    system?: string;
  };

export interface LLMChatOutput {
  text: string;
  finishReason?: LLMFinishReason;
  usage?: LLMUsage;
}

export type LLMStreamChunk =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "finish";
      finishReason?: LLMFinishReason;
      usage?: LLMUsage;
    };

export interface LLMProvider {
  name: string;
  chat(input: LLMChatInput): Promise<LLMChatOutput>;
  stream(input: LLMChatInput): AsyncIterable<LLMStreamChunk>;
}

export interface LLMProviderRef {
  kind: "llm-provider-ref";
  id: string;
  fallback?: LLMProviderSource;
}

export interface LLMProviderBinding {
  providerId: string;
  modelId: string;
}

export type LLMProviderBindingInput = string | LLMProviderBinding;

export function createLLMProviderModelKey(providerId: string, modelId: string): string {
  return `${providerId.trim()}::${modelId.trim()}`;
}

export type LLMProviderResolver = (
  context: {
    providers: {
      llm?: LLMProvider;
      llmProviders?: Record<string, LLMProvider>;
      llmProviderBindings?: Record<string, LLMProviderBindingInput>;
      defaultLLMProviderBinding?: LLMProviderBinding;
      defaultLLMProviderId?: string;
    };
  },
  nodeName: string,
) => LLMProvider | undefined;

export type LLMProviderSource =
  | LLMProvider
  | string
  | LLMProviderRef
  | LLMProviderResolver;
