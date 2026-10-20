import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Context, Model, MutableModels, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { HarnessError } from "../workflow/errors";
import type { AgentSearchSource, AgentWebSearch } from "./types";

type RecordValue = Record<string, unknown>;
type SearchApi = "openai-responses" | "anthropic-messages";
type PiAi = typeof import("@earendil-works/pi-ai");

export const AGENT_SEARCH_RESUME_PROMPT = "Continue the paused provider web search.";

/** Kept on the committed assistant message, including opaque Anthropic search results. */
export interface AgentSearchMessage extends AssistantMessage {
  projectWebSearch?: {
    api: SearchApi;
    searches: AgentWebSearch[];
    sources: AgentSearchSource[];
    native: RecordValue[];
  };
}

/** Installed after Durable restores serializable stream options. */
export interface AgentSearchStreamOptions extends SimpleStreamOptions {
  onAgentWebSearch?(search: AgentWebSearch): void | Promise<void>;
}

export function parseAgentWebSearch(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new HarnessError({ type: "input_validation", message: "webSearch must be a boolean." });
}

export function resolveAgentWebSearch(api: string, requested: boolean | undefined, capability: boolean | undefined): boolean {
  const enabled = parseAgentWebSearch(requested) ?? capability === true;
  if (!enabled) return false;
  if (capability === false) {
    throw new HarnessError({ type: "input_validation", message: "The selected model does not support web search." });
  }
  if (api !== "openai-responses" && api !== "anthropic-messages") {
    throw new HarnessError({ type: "input_validation", message: "Agent web search requires OpenAI Responses or Anthropic Messages." });
  }
  return true;
}

/** Wrap the per-agent collection, never the process-wide provider catalogue. */
export function withAgentWebSearch(ai: PiAi, models: MutableModels, settings: {
  model: Model<Api>; apiKind: string; enabled: boolean;
}): MutableModels {
  return new Proxy(models, {
    get(target, key) {
      if (key !== "streamSimple") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (model: Model<Api>, context: Context, options?: AgentSearchStreamOptions) => {
        const sameModel = model.provider === settings.model.provider && model.id === settings.model.id;
        const api = sameModel ? settings.apiKind : model.api;
        if (api !== "openai-responses" && api !== "anthropic-messages") return target.streamSimple(model, context, options);
        const requestContext = api === "anthropic-messages" ? withSearchPlaceholders(context, model) : context;
        const collector = new SearchCollector(api, options?.onAgentWebSearch, context, model);
        const source = target.streamSimple(model, requestContext, {
          ...options,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(payload, requestModel);
            if (!record(replacement ?? payload)) return replacement;
            const body = structuredClone((replacement ?? payload) as RecordValue);
            replaySearch(requestContext, model, api, body);
            if (settings.enabled && sameModel) {
              const tools = records(body.tools);
              if (!tools.some(tool => typeof tool.type === "string" && tool.type.startsWith("web_search"))) {
                tools.push(api === "openai-responses" ? { type: "web_search" }
                  : { type: "web_search_20250305", name: "web_search", max_uses: 5 });
              }
              body.tools = tools;
              if (api === "openai-responses") {
                body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), "web_search_call.action.sources"])];
              }
            }
            return body;
          },
          onProviderStreamEvent: async (event, requestModel) => {
            await collector.observe(event);
            await options?.onProviderStreamEvent?.(event, requestModel);
          },
        });
        const stream = ai.createAssistantMessageEventStream();
        void (async () => {
          let last: AssistantMessage | undefined;
          try {
            for await (const event of source) {
              const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
              last = message;
              if (event.type === "done" || event.type === "error") await collector.finish(message);
              collector.attach(message);
              stream.push(event);
              if (event.type === "done" || event.type === "error") { stream.end(message); return; }
            }
            throw new Error(`The model stream ended without a terminal event (${model.provider}).`);
          } catch (error) {
            const message: AssistantMessage = { ...(last ?? { role: "assistant", api: model.api, provider: model.provider, model: model.id,
              content: [], timestamp: Date.now(), stopReason: options?.signal?.aborted ? "aborted" : "error",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
              stopReason: options?.signal?.aborted ? "aborted" : "error",
              errorMessage: error instanceof Error ? error.message : String(error) };
            // An observer failure must still resolve the consumer's stream.
            await collector.finish(message).catch(() => undefined);
            collector.attach(message);
            stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
            stream.end(message);
          }
        })();
        return stream;
      };
    },
  });
}

class SearchCollector {
  private scope = randomUUID() as string;
  private readonly searches = new Map<string, AgentWebSearch>();
  private readonly sources = new Map<string, AgentSearchSource>();
  private readonly native = new Map<string | number, RecordValue>();
  private readonly openAIItems = new Map<number, string>();
  private readonly input = new Map<number, string>();
  private readonly completed = new Set<number>();
  constructor(private readonly api: SearchApi, private readonly update: AgentSearchStreamOptions["onAgentWebSearch"], context: Context, model: Model<Api>) {
    const previous = [...(context?.messages ?? [])].reverse().find(message => message.role === "assistant") as AgentSearchMessage | undefined;
    if (api === "anthropic-messages" && previous?.rawStopReason === "pause_turn" && previous.projectWebSearch?.api === api &&
      previous.provider === model.provider && previous.model === model.id) {
      for (const block of previous.projectWebSearch.native) if (block.type === "server_tool_use" && typeof block.id === "string") {
        const pending = previous.projectWebSearch.searches.find(search => search.id.endsWith(`:${block.id}`) && search.status === "running");
        if (pending) this.searches.set(block.id, structuredClone(pending));
      }
    }
  }

  async finish(message: AssistantMessage): Promise<void> {
    if (message.rawStopReason === "pause_turn" && message.stopReason === "stop") return;
    for (const [id, search] of this.searches) if (search.status === "running") {
      await this.search(id, { status: "failed", error: message.errorMessage ?? "Web search ended before completion." });
    }
  }

  attach(message: AssistantMessage): void {
    if (!this.searches.size && !this.sources.size) return;
    if (this.api === "openai-responses") {
      const nativeMessages = [...this.native.values()].filter(item => item.type === "message");
      let index = 0;
      for (const block of message.content) if (block.type === "text") {
        const item = nativeMessages[index++];
        if (!block.textSignature && item) block.textSignature = JSON.stringify({ v: 1, id: item.id,
          ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}) });
      }
    }
    const native = [...this.native.entries()].filter(([index, block]) => this.api !== "anthropic-messages" ||
      block.type === "text" || (block.type === "thinking" ? !!block.signature : this.completed.has(index as number))).map(([, block]) => block);
    (message as AgentSearchMessage).projectWebSearch = structuredClone({ api: this.api,
      searches: [...this.searches.values()], sources: [...this.sources.values()], native });
  }

  private source(value: unknown): void {
    if (!record(value) || typeof value.url !== "string") return;
    try { if (!["https:", "http:"].includes(new URL(value.url).protocol)) return; } catch { return; }
    const previous = this.sources.get(value.url);
    this.sources.set(value.url, { ...previous, url: value.url,
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.cited_text === "string" ? { citedText: value.cited_text } : {}) });
  }

  private async search(id: string, patch: Partial<AgentWebSearch>): Promise<void> {
    const previous = this.searches.get(id);
    const search: AgentWebSearch = { id: `${this.scope}:${id}`, status: "running", sources: [], ...previous, ...patch };
    this.searches.set(id, search);
    if (JSON.stringify(previous) !== JSON.stringify(search)) await this.update?.(structuredClone(search));
  }

  async observe(value: unknown): Promise<void> {
    if (!record(value)) return;
    const event = value;
    if (this.api === "openai-responses") {
      if (event.type === "response.created" && record(event.response) && typeof event.response.id === "string") this.scope = event.response.id;
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        if (typeof event.output_index === "number" && record(event.item) && typeof event.item.id === "string") this.openAIItems.set(event.output_index, event.item.id);
        await this.openAIItem(event.item);
      }
      if (event.type === "response.output_text.delta" || event.type === "response.output_text.annotation.added") {
        const item = this.native.get(this.openAIItems.get(Number(event.output_index)) ?? "");
        if (item?.type === "message") {
          const content = Array.isArray(item.content) ? item.content as RecordValue[] : [];
          const index = Number(event.content_index ?? 0);
          const block = content[index] ??= { type: "output_text", text: "", annotations: [] };
          if (typeof event.delta === "string") block.text = String(block.text ?? "") + event.delta;
          if (record(event.annotation)) block.annotations = [...records(block.annotations), structuredClone(event.annotation)];
          item.content = content;
        }
        if (event.type === "response.output_text.annotation.added") this.source(event.annotation);
      }
      if ((event.type === "response.completed" || event.type === "response.incomplete") && record(event.response)) {
        for (const item of records(event.response.output)) await this.openAIItem(item);
      }
      return;
    }
    if (event.type === "message_start" && record(event.message) && typeof event.message.id === "string") this.scope = event.message.id;
    if (event.type === "content_block_start" && typeof event.index === "number" && record(event.content_block)) {
      const block = structuredClone(event.content_block);
      this.native.set(event.index, block);
      if (block.type === "server_tool_use" && block.name === "web_search" && typeof block.id === "string") {
        await this.search(block.id, { ...(record(block.input) && typeof block.input.query === "string" ? { query: block.input.query } : {}) });
      }
      if (block.type === "web_search_tool_result" && typeof block.tool_use_id === "string") {
        const results = records(block.content);
        for (const result of results) this.source(result);
        const failure = record(block.content) && block.content.type === "web_search_tool_result_error" ? block.content : undefined;
        await this.search(block.tool_use_id, { status: failure ? "failed" : "success",
          sources: results.flatMap(result => typeof result.url === "string" && this.sources.has(result.url) ? [this.sources.get(result.url)!] : []),
          ...(failure ? { error: String(failure.error_code ?? "Web search failed") } : {}) });
      }
    }
    if (event.type === "content_block_delta" && typeof event.index === "number" && record(event.delta)) {
      const block = this.native.get(event.index);
      if (!block) return;
      const delta = event.delta;
      for (const key of ["text", "thinking", "signature"] as const) {
        if (typeof delta[key] === "string") block[key] = String(block[key] ?? "") + delta[key];
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        this.input.set(event.index, (this.input.get(event.index) ?? "") + delta.partial_json);
      }
      if (delta.type === "citations_delta" && record(delta.citation)) {
        block.citations = [...(Array.isArray(block.citations) ? block.citations : []), structuredClone(delta.citation)];
        this.source(delta.citation);
      }
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      this.completed.add(event.index);
      const block = this.native.get(event.index);
      const input = this.input.get(event.index);
      if (block && input) {
        try { block.input = JSON.parse(input); } catch { /* Incomplete input is not replayable. */ }
        if (block.type === "server_tool_use" && typeof block.id === "string" && record(block.input) && typeof block.input.query === "string") {
          await this.search(block.id, { query: block.input.query });
        }
      }
    }
  }

  private async openAIItem(value: unknown): Promise<void> {
    if (!record(value) || typeof value.id !== "string") return;
    this.native.set(value.id, structuredClone(value));
    if (value.type === "web_search_call") {
      const action = record(value.action) ? value.action : {};
      for (const source of records(action.sources)) this.source(source);
      const query = typeof action.query === "string" ? action.query
        : Array.isArray(action.queries) ? action.queries.filter(item => typeof item === "string").join("; ") : undefined;
      await this.search(value.id, { status: value.status === "completed" ? "success" : value.status === "failed" ? "failed" : "running",
        ...(query ? { query } : {}), sources: records(action.sources).flatMap(source => typeof source.url === "string" && this.sources.has(source.url) ? [this.sources.get(source.url)!] : []),
        ...(value.status === "failed" ? { error: "Web search failed" } : {}) });
    }
    for (const block of records(value.content)) for (const citation of records(block.annotations)) this.source(citation);
  }
}

/** Restore the provider-managed blocks Pi's portable message format does not represent. */
function replaySearch(context: Context, model: Model<Api>, api: SearchApi, body: RecordValue): void {
  const assistants = context.messages.filter((message): message is AgentSearchMessage => message.role === "assistant" &&
    message.stopReason !== "error" && message.stopReason !== "aborted");
  if (api === "openai-responses") {
    const input = records(body.input);
    for (const message of assistants) {
      const saved = message.projectWebSearch;
      if (!saved || saved.api !== api || message.provider !== model.provider || message.model !== model.id) continue;
      let pending: RecordValue[] = [];
      for (const item of saved.native) {
        if (item.type === "web_search_call") { if (item.status === "completed") pending.push(structuredClone(item)); continue; }
        const index = input.findIndex(existing => existing.id === item.id && existing.type === item.type);
        if (index < 0) continue;
        if (item.type === "message" && records(item.content).length &&
          outputText(item.content) === outputText(input[index]!.content)) input[index] = { ...input[index], content: structuredClone(item.content) };
        if (pending.length) { input.splice(index, 0, ...pending); pending = []; }
      }
    }
    body.input = input;
    return;
  }
  const converted = records(body.messages);
  let cursor = 0;
  for (const message of assistants) {
    const expected = messageFingerprint(message);
    if (!expected) continue;
    const index = converted.findIndex((item, i) => i >= cursor && item.role === "assistant" && fingerprint(records(item.content)) === expected);
    if (index < 0) continue;
    cursor = index + 1;
    const saved = message.projectWebSearch;
    if (saved?.api === api && message.provider === model.provider && message.model === model.id) {
      const native = anthropicReplayBlocks(message);
      if (native.length) converted[index]!.content = structuredClone(native);
      const next = converted[index + 1];
      if (message.rawStopReason === "pause_turn" && next?.role === "user" && fingerprint(records(next.content)) === `text:${AGENT_SEARCH_RESUME_PROMPT}`) {
        converted.splice(index + 1, 1);
      }
    }
  }
  body.messages = converted;
}

/** Pi omits assistant messages containing only provider-managed blocks. */
function withSearchPlaceholders(context: Context, model: Model<Api>): Context {
  return { ...context, messages: context.messages.map((message, index) => {
    if (message.role !== "assistant" || message.provider !== model.provider || message.model !== model.id ||
      !anthropicReplayBlocks(message).length || messageFingerprint(message)) return message;
    return { ...message, content: [...message.content, { type: "text", text: `[provider-search:${index}:${message.timestamp}]` }] };
  }) };
}

function anthropicReplayBlocks(message: AgentSearchMessage): RecordValue[] {
  const saved = message.projectWebSearch;
  if (saved?.api !== "anthropic-messages") return [];
  const localCalls = new Set(message.content.flatMap(block => block.type === "toolCall" ? [block.id] : []));
  const results = new Set(saved.native.filter(block => block.type === "web_search_tool_result").map(block => block.tool_use_id));
  return saved.native.filter(block => block.type === "tool_use" ? localCalls.has(String(block.id))
    : block.type !== "server_tool_use" || results.has(block.id) || message.rawStopReason === "pause_turn");
}

function messageFingerprint(message: AssistantMessage): string {
  return message.content.flatMap(block => block.type === "text" ? [block.text.trim() ? `text:${block.text}` : ""]
    : block.type === "toolCall" ? [`tool:${block.id}`]
    : block.type === "thinking" && !block.thinkingSignature && block.thinking.trim() ? [`text:${block.thinking}`] : []).filter(Boolean).join("\n");
}

function fingerprint(blocks: RecordValue[]): string {
  return blocks.flatMap(block => block.type === "text" && typeof block.text === "string" ? [`text:${block.text}`]
    : block.type === "tool_use" ? [`tool:${block.id}`] : []).join("\n");
}
function outputText(content: unknown): string {
  return records(content).flatMap(block => block.type === "output_text" && typeof block.text === "string" ? [block.text] : []).join("");
}
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function records(value: unknown): RecordValue[] { return Array.isArray(value) ? value.filter(record) : []; }
