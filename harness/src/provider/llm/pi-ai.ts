import { createModels, createProvider, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { HarnessError } from "../../workflow/errors";
import type { CreateLLMProviderOptions } from "./factory";
import type { LLMChatInput, LLMChatOutput, LLMProvider, LLMStreamChunk, LLMUsage } from "./types";

const APIS = {
  "openai-completion": { create: openAICompletionsApi, api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
  "openai-responses": { create: openAIResponsesApi, api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  anthropic: { create: anthropicMessagesApi, api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
} as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_USAGE: Usage = { ...ZERO_COST, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } };

export class PiAiLLMProvider implements LLMProvider {
  readonly name: string;
  private readonly models = createModels();
  private readonly model: Model<Api>;

  constructor(private readonly options: CreateLLMProviderOptions & { model: string }) {
    this.name = options.type;
    const adapter = APIS[options.type];
    const attributes = options.modelAttributes;
    let baseUrl = options.baseURL?.trim().replace(/\/+$/u, "") || adapter.baseUrl;
    // The Anthropic client itself adds /v1/messages.
    if (options.type === "anthropic") baseUrl = baseUrl.replace(/\/v1$/u, "");
    this.model = {
      id: options.model, name: attributes?.name ?? options.model,
      provider: "steamharness-llm", api: adapter.api, baseUrl,
      input: attributes?.input ? [...attributes.input] : ["text", "image"],
      reasoning: attributes?.reasoning ?? false,
      thinkingLevelMap: attributes?.thinkingLevelMap,
      contextWindow: attributes?.contextWindow ?? 128_000, maxTokens: attributes?.maxTokens ?? 4_096,
      cost: attributes?.cost ?? ZERO_COST,
    };
    this.models.setProvider(createProvider({
      id: this.model.provider, name: this.name, models: [this.model], api: adapter.create(),
      auth: { apiKey: { name: "Configured API key", resolve: async () => ({ auth: { apiKey: options.apiKey }, source: "configured" }) } },
    }));
  }

  async chat(input: LLMChatInput): Promise<LLMChatOutput> {
    const call = this.prepare(input);
    try {
      const message = await this.models.completeSimple(this.model, call.context, call.options);
      return this.finish(message, call);
    } catch {
      throw this.failure(call);
    }
  }

  async *stream(input: LLMChatInput): AsyncIterable<LLMStreamChunk> {
    const call = this.prepare(input);
    try {
      const stream = this.models.streamSimple(this.model, call.context, call.options);
      for await (const event of stream) {
        call.options.signal?.throwIfAborted();
        if (event.type === "text_delta") yield { type: "text-delta", text: event.delta };
      }
      const { finishReason, usage } = this.finish(await stream.result(), call);
      yield { type: "finish", finishReason, usage };
    } catch {
      throw this.failure(call);
    }
  }

  private prepare(input: LLMChatInput) {
    const settings = { ...this.options.defaults, ...input };
    const timestamp = Date.now();
    const context: Context = { systemPrompt: input.system ?? this.options.system, messages: [] };
    for (const message of input.messages ?? [{ role: "user" as const, content: input.prompt }]) {
      if (message.role === "assistant") {
        context.messages.push({ role: "assistant", content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
          api: this.model.api, model: this.model.id, provider: this.model.provider, timestamp, stopReason: "stop", usage: ZERO_USAGE });
      } else if (message.role === "system") {
        context.messages.push({ role: "system", content: message.content, timestamp });
      } else {
        const content = message.content;
        if (Array.isArray(content) && content.some(part => part.type === "image") && !this.model.input.includes("image")) {
          throw new HarnessError({ type: "input_validation", message: "The selected model does not accept images." });
        }
        context.messages.push({ role: "user", content, timestamp });
      }
    }
    const state: { status?: number; credentialError?: HarnessError; finished?: boolean } = {};
    const options: SimpleStreamOptions = {
      signal: settings.abortSignal, temperature: settings.temperature, maxTokens: settings.maxOutputTokens,
      maxRetries: settings.maxRetries ?? 0, timeoutMs: settings.timeout, headers: settings.headers,
      fetch: async (input, init) => {
        state.credentialError = undefined;
        state.status = undefined;
        try {
          const response = await (this.options.fetch ?? fetch)(input, init);
          state.status = response.status;
          return response;
        } catch (error) {
          if (error instanceof HarnessError) state.credentialError = error;
          throw error;
        }
      },
      onProviderStreamEvent: event => {
        // Some compatible Chat APIs let pi-ai synthesize a finish reason at EOF.
        // Only an explicit terminal chunk is safe to save as conversation history.
        if (this.options.type !== "openai-completion") return;
        const choices = (event as { choices?: { finish_reason?: string }[] })?.choices;
        if (choices?.some(choice => choice.finish_reason)) state.finished = true;
      },
      onPayload: payload => {
        const body = { ...(payload as Record<string, unknown>) };
        if (settings.topP !== undefined && this.options.type !== "openai-responses") body.top_p = settings.topP;
        if (settings.stopSequences?.length && this.options.type === "anthropic") body.stop_sequences = settings.stopSequences;
        if (this.options.type === "openai-completion") {
          if (settings.stopSequences?.length) body.stop = settings.stopSequences;
          if (settings.seed !== undefined) body.seed = settings.seed;
          if (settings.presencePenalty !== undefined) body.presence_penalty = settings.presencePenalty;
          if (settings.frequencyPenalty !== undefined) body.frequency_penalty = settings.frequencyPenalty;
        }
        if (this.options.webSearch) {
          body.tools = this.options.type === "anthropic" ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
            : [{ type: "web_search", search_context_size: "medium" }];
        }
        return body;
      },
    };
    return { context, options, state };
  }

  private finish(message: AssistantMessage, call: ReturnType<PiAiLLMProvider["prepare"]>): LLMChatOutput {
    call.options.signal?.throwIfAborted();
    if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") {
      throw this.failure(call);
    }
    if (this.options.type === "openai-completion" && !call.state.finished) throw this.failure(call);
    return {
      text: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join(""),
      finishReason: message.stopReason === "toolUse" ? "tool-calls" : message.stopReason,
      usage: toLLMUsage(message.usage),
    };
  }

  private failure(call: ReturnType<PiAiLLMProvider["prepare"]>): unknown {
    if (call.options.signal?.aborted) return call.options.signal.reason;
    const { status, credentialError } = call.state;
    if (credentialError) return credentialError;
    // SDK errors can embed an upstream response body, headers or the endpoint.
    // Keep authentication errors actionable without saving any of that material.
    const message = status === 401 || status === 403 ? `LLM authentication failed (HTTP ${status}). Check the selected AI credential.`
      : status !== undefined && status >= 400 ? `LLM request failed (HTTP ${status}).`
      : "LLM stream did not complete. Check that the selected endpoint supports streaming and try again.";
    return new HarnessError({ type: "provider_call", message, metadata: { provider: this.name, status } });
  }
}

function toLLMUsage(usage: Usage): LLMUsage {
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, totalTokens: usage.totalTokens,
    inputTokenDetails: { noCacheTokens: usage.input, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite },
    outputTokenDetails: usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning, textTokens: usage.output - usage.reasoning },
  };
}
