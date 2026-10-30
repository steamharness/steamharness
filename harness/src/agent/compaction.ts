import type { Api, AssistantMessage, Context, Message, Model, MutableModels, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentContextUsage } from "./types";
import { createAssistantErrorMessage, normalizeAssistantError } from "./stream-error";
import { retryAssistantResponse } from "./provider-retry";

/**
 * Core checks context before each model request, including tool continuations.
 * Durable compaction keeps committed history while replacing model context.
 */
export interface AgentCompactionSettings {
  enabled: boolean;
  /** Fraction of the context window that triggers compaction. */
  threshold: number;
  /** Head-room left for the model's own reply after compaction. */
  reserveTokens: number;
  /** Approximate tokens of recent turns kept verbatim. */
  keepRecentTokens: number;
}

export const DEFAULT_AGENT_COMPACTION_SETTINGS: AgentCompactionSettings = {
  enabled: true,
  threshold: 0.9,
  reserveTokens: 16_000,
  keepRecentTokens: 8_000,
};

export const AGENT_SUMMARIZATION_SYSTEM_PROMPT = [
  "You summarize an agent conversation so the agent can keep working with a smaller context.",
  "Preserve: the user's goal, decisions already made, files created or modified, commands run and their outcomes, and anything still unresolved.",
  "Drop: greetings, restated instructions, and reasoning that did not change the outcome.",
  "Reply with the summary only.",
].join("\n");

/** Only a failed provider response, never a host accounting/observer failure. */
export class AgentCompactionResponseError extends Error {
  constructor(readonly response: AssistantMessage) {
    super(response.errorMessage?.trim() || `The model returned an incomplete compaction summary (${response.stopReason}).`);
  }
}

export function shouldCompactAgent(
  usage: AgentContextUsage | undefined,
  settings: AgentCompactionSettings = DEFAULT_AGENT_COMPACTION_SETTINGS,
): boolean {
  if (!settings.enabled || usage === undefined || usage.total <= 0) {
    return false;
  }

  return usage.used / usage.total >= settings.threshold;
}

/**
 * Rough token estimate used before the provider reports real usage.
 *
 * Characters over four is the usual rule of thumb for latin text, but it
 * undercounts CJK — where a character is often a token of its own — by about
 * three times, and this number is shown to the user as the context they have
 * used. Full-width code points are therefore charged a token each.
 */
export function estimateAgentTokens(value: string): number {
  const normalized = value.trim();
  if (normalized === "") {
    return 0;
  }

  let wide = 0;
  let total = 0;
  for (const character of normalized) {
    total += 1;
    if (isWideCodePoint(character.codePointAt(0) ?? 0)) {
      wide += 1;
    }
  }

  return Math.max(1, Math.ceil((total - wide) / 4) + wide);
}

/** Pi's usage-plus-trailing-messages approach, retaining Core's CJK estimate. */
export function estimateAgentContextTokens(messages: readonly AgentMessage[]): number {
  let usageStart = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const reset = (messages[index] as AgentMessage & { projectContextUsageReset?: number }).projectContextUsageReset;
    if (typeof reset === "number" && Number.isInteger(reset) && reset >= 0) {
      usageStart = index + 1 + reset;
    }
  }
  for (let index = messages.length - 1; index >= usageStart; index -= 1) {
    const message = messages[index] as Message;
    if (message.role !== "assistant" || message.stopReason === "error" ||
        message.stopReason === "aborted" || message.stopReason === "pending" ||
        (message as AgentMessage & { projectContextUsageInvalid?: boolean }).projectContextUsageInvalid === true) continue;
    const tokens = readAgentUsageTokens(message.usage);
    if (tokens > 0) {
      return tokens + estimateContextMessages(messages.slice(index + 1));
    }
  }
  return estimateContextMessages(messages);
}

function estimateContextMessages(messages: readonly AgentMessage[]): number {
  let imageTokens = 0;
  for (const message of messages) {
    const content = (message as Message).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "image") imageTokens += 1_200;
      }
    }
  }
  return estimateAgentTokens(serializeAgentMessages(messages)) + imageTokens;
}

function readAgentUsageTokens(usage: Usage | undefined): number {
  if (usage === undefined) return 0;
  const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
}

/** CJK, kana, hangul and the full-width forms that tokenize near one-for-one. */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export interface AgentCompactionResult {
  /** The summary that replaced the compacted head, or undefined when nothing was dropped. */
  summary?: string;
  messages: AgentMessage[];
  removed: number;
  tokensBefore: number;
}

/**
 * Compacts a transcript by replacing its oldest turns with a model-written
 * summary. Returns the input unchanged when the transcript is already small
 * enough, so callers can invoke it unconditionally.
 */
export async function compactAgentMessages(options: {
  models: MutableModels;
  model: Model<Api>;
  messages: AgentMessage[];
  settings?: AgentCompactionSettings;
  instructions?: string;
  signal?: AbortSignal;
  /** Reports the summary response's usage even when it is incomplete or cancelled. */
  onUsage?: (usage: Usage) => void | Promise<void>;
  /** Summarize all existing messages even when they fit in the recent context budget. */
  force?: boolean;
  /** Base retry backoff; each summary request retains the ten-retry budget. */
  retryDelayMs?: number;
}): Promise<AgentCompactionResult> {
  options.signal?.throwIfAborted();
  const settings = options.settings ?? DEFAULT_AGENT_COMPACTION_SETTINGS;
  const tokensBefore = estimateAgentContextTokens(options.messages);
  const splitIndex = options.force ? options.messages.length : findCompactionSplitIndex(options.messages, settings.keepRecentTokens);

  if (splitIndex <= 0) {
    return { messages: options.messages, removed: 0, tokensBefore };
  }

  const head = options.messages.slice(0, splitIndex);
  const tail = options.messages.slice(splitIndex);
  const summary = await summarizeAgentMessages({
    models: { completeSimple: (...args) => retryAssistantResponse(async () => {
      let message: AssistantMessage;
      try { message = normalizeAssistantError(await options.models.completeSimple(...args), args[2]?.signal); }
      catch (cause) { message = createAssistantErrorMessage(args[0], cause, args[2]?.signal); }
      // Accounting failures are host failures, outside the provider catch.
      await options.onUsage?.(message.usage);
      return message;
    }, options.signal, options.retryDelayMs) },
    model: options.model,
    messages: head,
    instructions: options.instructions,
    signal: options.signal,
    reserveTokens: settings.reserveTokens,
  });

  const summaryMessage: AgentMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Summary of the earlier conversation (compacted by the agent runtime):\n\n${summary}`,
      },
    ],
    timestamp: readLastTimestamp(options.messages),
    // Retained responses measured the old context; this marker survives transcript persistence.
    projectContextUsageReset: tail.length,
  } as unknown as AgentMessage;

  return {
    summary,
    messages: [summaryMessage, ...tail],
    removed: head.length,
    tokensBefore,
  };
}

export async function summarizeAgentMessages(options: {
  models: Pick<MutableModels, "completeSimple">;
  model: Model<Api>;
  messages: AgentMessage[];
  instructions?: string;
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void | Promise<void>;
  reserveTokens?: number;
}): Promise<string> {
  const systemPrompt = options.instructions === undefined || options.instructions.trim() === ""
    ? AGENT_SUMMARIZATION_SYSTEM_PROMPT
    : `${AGENT_SUMMARIZATION_SYSTEM_PROMPT}\n\nAdditional instructions:\n${options.instructions.trim()}`;

  const window = options.model.contextWindow;
  const maxTokens = Math.max(1, Math.min(options.model.maxTokens,
    options.reserveTokens ?? DEFAULT_AGENT_COMPACTION_SETTINGS.reserveTokens, Math.floor(window / 5)));
  // Bound the summarizer too: restored histories and one large tool result can
  // already exceed the window. Keep room for framing and the summary response.
  const budget = Math.floor(window - maxTokens - estimateAgentTokens(systemPrompt) - 64);
  if (budget <= 0) throw new Error("The model context window is too small for context compaction.");
  let source = serializeAgentMessages(options.messages);
  while (true) {
    const chunks = splitSummarySource(source, budget);
    const summaries: string[] = [];
    for (const chunk of chunks) {
      options.signal?.throwIfAborted();
      const context: Context = { systemPrompt, messages: [{ role: "user",
        content: [{ type: "text", text: chunk }], timestamp: readLastTimestamp(options.messages) }] };
      const message: AssistantMessage = await options.models.completeSimple(options.model, context, {
        maxTokens, maxRetries: 0, ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await options.onUsage?.(message.usage);
      options.signal?.throwIfAborted();
      if (message.stopReason !== "stop" || message.content.some(block => block.type === "toolCall")) {
        throw new AgentCompactionResponseError(message);
      }
      const text = message.content.filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map(block => block.text).join("\n").trim();
      if (!text) throw new Error("The model returned an empty compaction summary.");
      summaries.push(text);
    }
    if (summaries.length === 1) return summaries[0]!;
    const merged = summaries.join("\n\n");
    if (estimateAgentTokens(merged) >= estimateAgentTokens(source)) {
      throw new Error("Context compaction summaries did not reduce the conversation size.");
    }
    source = merged;
  }
}

/** Split without losing text or splitting a Unicode code point. */
function splitSummarySource(source: string, budget: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let quarters = 0;
  for (const character of source) {
    const cost = isWideCodePoint(character.codePointAt(0) ?? 0) ? 4 : 1;
    if (quarters + cost > budget * 4 && chunk) {
      chunks.push(chunk); chunk = ""; quarters = 0;
    }
    chunk += character; quarters += cost;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

/**
 * Index of the first message kept verbatim: everything before it is summarized.
 *
 * The tail is measured from the end and then aligned to a turn boundary. A user
 * turn is the boundary a transcript reads best from, so the next one wins when
 * the kept window holds it. It often does not — a long tool-heavy turn since the
 * user's request can sit entirely inside the window — and walking forward from
 * there used to run off the end of the transcript, which summarized *everything*
 * and left the run with no recent context at all. The fallback is therefore the
 * nearest assistant turn, and never a tool result, whose requesting message
 * would have been summarized away.
 */
export function findCompactionSplitIndex(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
): number {
  if (messages.length === 0) {
    return 0;
  }

  let tokens = 0;
  let index = messages.length;

  while (index > 0) {
    const candidate = messages[index - 1] as unknown as Message;
    const cost = estimateAgentTokens(serializeMessage(candidate));
    if (tokens + cost > keepRecentTokens) {
      break;
    }
    tokens += cost;
    index -= 1;
  }

  // The newest message is never summarized: dropping it would leave the run
  // with nothing of the turn it was asked about.
  index = Math.min(index, messages.length - 1);

  return findIndexAtOrAfter(messages, index, "user")
    ?? findLastIndexUpTo(messages, index, "assistant")
    ?? index;
}

function findIndexAtOrAfter(
  messages: readonly AgentMessage[],
  start: number,
  role: Message["role"],
): number | undefined {
  for (let index = Math.max(0, start); index < messages.length; index += 1) {
    if (readRole(messages[index]) === role) {
      return index;
    }
  }

  return undefined;
}

function findLastIndexUpTo(
  messages: readonly AgentMessage[],
  start: number,
  role: Message["role"],
): number | undefined {
  for (let index = Math.min(start, messages.length - 1); index >= 0; index -= 1) {
    if (readRole(messages[index]) === role) {
      return index;
    }
  }

  return undefined;
}

function readRole(message: AgentMessage | undefined): Message["role"] | undefined {
  return (message as unknown as Message | undefined)?.role;
}

export function serializeAgentMessages(messages: readonly AgentMessage[]): string {
  return messages.map((message) => serializeMessage(message as unknown as Message)).join("\n\n");
}

function serializeMessage(message: Message): string {
  const role = message.role;
  if (role === "system") {
    return `[system] ${readContentText(message.content)}\n${JSON.stringify({ sections: message.sections,
      toolsAdded: message.toolsAdded, toolsRemoved: message.toolsRemoved })}`;
  }
  if (role === "user") {
    return `[user] ${readContentText(message.content)}`;
  }
  if (role === "assistant") {
    const text = message.content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return `(thinking) ${block.thinking}`;
      return `(tool call) ${block.name} ${JSON.stringify(block.arguments)}`;
    }).join("\n");
    return `[assistant] ${text}`;
  }
  return `[tool result] ${readContentText(message.content)}`;
}

function readContentText(content: Message["content"] | AssistantMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "image") return "[image]";
      return JSON.stringify(block);
    })
    .join("\n");
}

function readLastTimestamp(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const timestamp = (messages[index] as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number") {
      return timestamp;
    }
  }

  return 0;
}

/**
 * Reads the context usage the runtime reports: tokens already in the transcript
 * plus the window the model was configured with.
 */
export function readAgentContextUsage(options: {
  used: number;
  contextWindow: number | undefined;
}): AgentContextUsage | undefined {
  const total = options.contextWindow;
  if (total === undefined || !Number.isFinite(total) || total <= 0 || !Number.isFinite(options.used)) {
    return undefined;
  }

  return { used: Math.max(0, Math.round(options.used)), total };
}
