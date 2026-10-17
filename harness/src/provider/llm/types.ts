import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ProviderMetadata,
  JSONValue,
} from "ai";

export type LLMModel = LanguageModel;
export type LLMMessage = ModelMessage;
export type LLMProviderOptions = Record<
  string,
  {
    [key: string]: JSONValue | undefined;
  }
>;

export interface LLMCallSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  maxRetries?: number;
  timeout?: number;
  headers?: Record<string, string>;
  providerOptions?: LLMProviderOptions;
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
        messages: ModelMessage[];
      }
  ) & {
    system?: string;
  };

export interface LLMChatOutput {
  text: string;
  finishReason?: FinishReason;
  usage?: LanguageModelUsage;
  providerMetadata?: ProviderMetadata;
}

export type LLMStreamChunk =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "finish";
      finishReason?: FinishReason;
      usage?: LanguageModelUsage;
      providerMetadata?: ProviderMetadata;
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
