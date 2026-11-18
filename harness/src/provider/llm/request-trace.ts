import type { LLMChatInput, LLMImagePart, LLMTextPart } from "./types";

type TracePart = LLMTextPart | Pick<LLMImagePart, "type" | "mimeType">;

export interface LLMBotModelRequestSnapshot {
  provider: string;
  model: string;
  api: string;
  systemPrompt?: string;
  messages: { role: "system" | "user" | "assistant"; content: string | TracePart[] }[];
  generation: { temperature?: number; maxOutputTokens?: number; topP?: number };
}

type RequestObserver = {
  provider: string;
  publish: (request: LLMBotModelRequestSnapshot) => Promise<void> | void;
};

// Keep the opt-in observer out of settings, reports, and the wire payload.
const observers = new WeakMap<LLMChatInput, RequestObserver>();

export function observeLLMBotModelRequest(input: LLMChatInput, observer: RequestObserver): void {
  observers.set(input, observer);
}

export function readModelRequestObserver(input: LLMChatInput): RequestObserver | undefined {
  return observers.get(input);
}

export function modelRequestGeneration(body: Record<string, unknown>): LLMBotModelRequestSnapshot["generation"] {
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return { temperature: number(body.temperature), maxOutputTokens: number(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens), topP: number(body.top_p) };
}

export function snapshotLLMBotModelRequest(input: LLMChatInput, options: Omit<LLMBotModelRequestSnapshot, "messages">, apiKey?: string): LLMBotModelRequestSnapshot {
  const text = (value: string) => apiKey ? value.replaceAll(apiKey, "[redacted]") : value;
  return {
    ...options,
    systemPrompt: options.systemPrompt === undefined ? undefined : text(options.systemPrompt),
    messages: (input.messages ?? [{ role: "user" as const, content: input.prompt }]).map(({ role, content }) => ({
      role,
      content: typeof content === "string" ? text(content) : content.map((part): TracePart => part.type === "text"
        ? { type: "text", text: text(part.text) } : { type: "image", mimeType: part.mimeType }),
    })),
  };
}
