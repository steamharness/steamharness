import { generateText, streamText, type ProviderMetadata, type ToolSet } from "ai";
import type {
  LLMCallSettings,
  LLMChatInput,
  LLMChatOutput,
  LLMModel,
  LLMProvider,
  LLMStreamChunk,
} from "./types";
import { HarnessError } from "../../workflow/errors";

export interface AiSdkLLMProviderOptions {
  model: LLMModel;
  name?: string;
  system?: string;
  defaults?: LLMCallSettings;
  tools?: ToolSet;
}

export class AiSdkLLMProvider implements LLMProvider {
  readonly name: string;
  private readonly model: LLMModel;
  private readonly system?: string;
  private readonly defaults: LLMCallSettings;
  private readonly tools?: ToolSet;

  constructor(options: AiSdkLLMProviderOptions) {
    this.name = options.name ?? "ai-sdk";
    this.model = options.model;
    this.system = options.system;
    this.defaults = options.defaults ?? {};
    this.tools = options.tools;
  }

  async chat(input: LLMChatInput): Promise<LLMChatOutput> {
    try {
      const common = this.toAiSdkCommonInput(input);
      const result =
        input.messages !== undefined
          ? await generateText({
              ...common,
              model: this.model,
              messages: input.messages,
            })
          : await generateText({
              ...common,
              model: this.model,
              prompt: input.prompt,
            });
      const warnings = [
        ...(result.warnings ?? []),
        ...result.steps.flatMap((step) => step.warnings ?? []),
      ];
      return {
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
        providerMetadata: withProviderWarnings(result.providerMetadata, warnings),
      };
    } catch (error) {
      throw new HarnessError({
        type: "provider_call",
        message: "LLM provider chat call failed.",
        cause: error,
        metadata: {
          provider: this.name,
        },
      });
    }
  }

  async *stream(input: LLMChatInput): AsyncIterable<LLMStreamChunk> {
    try {
      const common = this.toAiSdkCommonInput(input);
      const result =
        input.messages !== undefined
          ? streamText({
              ...common,
              model: this.model,
              messages: input.messages,
            })
          : streamText({
              ...common,
              model: this.model,
              prompt: input.prompt,
            });

      let providerMetadata;
      const warnings: unknown[] = [];
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step":
            warnings.push(...(part.warnings ?? []));
            break;
          case "text-delta":
            yield { type: "text-delta", text: part.text };
            break;
          case "finish-step":
            providerMetadata = part.providerMetadata;
            break;
          case "finish":
            yield {
              type: "finish",
              finishReason: part.finishReason,
              usage: part.totalUsage,
              providerMetadata: withProviderWarnings(providerMetadata, warnings),
            };
            break;
          case "error":
            throw part.error;
          case "abort":
            throw new Error(part.reason ?? "LLM provider stream was aborted.");
          default:
            break;
        }
      }
    } catch (error) {
      throw new HarnessError({
        type: "stream_interrupted",
        message: "LLM provider stream call failed.",
        cause: error,
        metadata: {
          provider: this.name,
        },
      });
    }
  }

  private toAiSdkCommonInput(input: LLMChatInput) {
    const settings: LLMCallSettings = {
      ...this.defaults,
      ...input,
    };

    return {
      system: input.system ?? this.system,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxOutputTokens,
      topP: settings.topP,
      topK: settings.topK,
      presencePenalty: settings.presencePenalty,
      frequencyPenalty: settings.frequencyPenalty,
      stopSequences: settings.stopSequences,
      seed: settings.seed,
      maxRetries: settings.maxRetries,
      timeout: settings.timeout,
      headers: settings.headers,
      providerOptions: settings.providerOptions,
      abortSignal: settings.abortSignal,
      tools: this.tools,
    };
  }
}

function withProviderWarnings(
  providerMetadata: ProviderMetadata | undefined,
  warnings: readonly unknown[] | undefined,
): ProviderMetadata | undefined {
  if (!warnings?.length) return providerMetadata;
  const formatted = [...new Set(warnings.map(formatProviderWarning))];
  const projectMetadata = providerMetadata?.["steamharness"];
  const existingWarnings = Array.isArray(projectMetadata?.["warnings"])
    ? projectMetadata["warnings"].filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...providerMetadata,
    "steamharness": {
      ...projectMetadata,
      warnings: [...new Set([...existingWarnings, ...formatted])],
    },
  };
}

function formatProviderWarning(value: unknown): string {
  if (!isRecord(value)) return "unsupported request option";
  if (
    (value.type === "unsupported" || value.type === "compatibility")
    && typeof value.feature === "string"
  ) {
    return typeof value.details === "string" && value.details.trim() !== ""
      ? `${value.feature} (${value.details})`
      : value.feature;
  }
  if (typeof value.message === "string" && value.message.trim() !== "") return value.message;
  return typeof value.type === "string" ? value.type : "unsupported request option";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
