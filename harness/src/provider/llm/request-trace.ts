import type { LLMChatInput, LLMImagePart, LLMTextPart } from "./types";
import type { LLMBotToolRound } from "./pi-ai";

type TracePart = LLMTextPart | Pick<LLMImagePart, "type" | "mimeType">;
type TraceToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface LLMBotModelRequestSnapshot {
  provider: string;
  model: string;
  api: string;
  systemPrompt?: string;
  messages: ({ role: "system" | "user" | "assistant"; content: string | (TracePart | TraceToolCall)[] }
    | { role: "toolResult"; toolCallId: string; toolName: string; isError: boolean; content: TracePart[] })[];
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
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

export function snapshotLLMBotModelRequest(input: LLMChatInput, options: Omit<LLMBotModelRequestSnapshot, "messages" | "tools">, apiKey?: string, round?: LLMBotToolRound): LLMBotModelRequestSnapshot {
  const text = (value: string) => apiKey ? value.replaceAll(apiKey, "[redacted]") : value;
  const json = (value: unknown): Record<string, unknown> => {
    const redact = (item: unknown): unknown => typeof item === "string" ? text(item)
      : Array.isArray(item) ? item.map(redact)
      : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, child]) => [text(key), redact(child)])) : item;
    return redact(value) as Record<string, unknown>;
  };
  const part = (p: LLMTextPart | LLMImagePart): TracePart => p.type === "text"
    ? { type: "text", text: text(p.text) } : { type: "image", mimeType: text(p.mimeType) };
  const messages: LLMBotModelRequestSnapshot["messages"] = (input.messages ?? [{ role: "user" as const, content: input.prompt }]).map(({ role, content }) => ({
    role, content: typeof content === "string" ? text(content) : content.map(part),
  }));
  for (const message of round?.transcript ?? []) {
    if (message.role === "toolResult") {
      messages.push({ role: "toolResult", toolCallId: text(message.toolCallId), toolName: text(message.toolName), isError: message.isError, content: message.content.map(part) });
    } else {
      const content: (TracePart | TraceToolCall)[] = [];
      for (const p of message.content) {
        if (p.type === "toolCall") content.push({ type: p.type, id: text(p.id), name: text(p.name), arguments: json(p.arguments) });
        if (p.type === "text") content.push(part(p));
      }
      messages.push({ role: "assistant", content });
    }
  }
  return {
    ...options,
    systemPrompt: options.systemPrompt === undefined ? undefined : text(options.systemPrompt),
    messages,
    ...(round?.tools.length ? { tools: round.tools.map(tool => ({ name: text(tool.name), description: text(tool.description), parameters: json(tool.parameters) })) } : {}),
  };
}
