import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  MutableModels,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getConfig, currentConfigurationValues } from "../configuration";
import type { AgentThinkingLevel } from "./effort";
import type { AgentModelAttributes } from "./types";
import type { TypeboxLike } from "./tools";
import { HarnessError } from "../workflow/errors";
import { withAgentWebSearch, resolveAgentWebSearch } from "./web-search";
import { createAssistantErrorMessage, normalizeAssistantError } from "./stream-error";
import { AGENT_PROVIDER_MAX_RETRIES, waitBeforeRetry } from "./provider-retry";
export { AGENT_PROVIDER_MAX_RETRIES, waitBeforeRetry } from "./provider-retry";

/**
 * How many times a turn that ran out of output tokens is continued.
 *
 * Deliberately its own, much smaller budget, and deliberately not ten.
 *
 * A drop is transient — the same request may simply work — so the connection
 * budget is sized to ride out a proxy restart. An output limit is not: the
 * request is fine and the model will stop at the same place again. Continuing
 * still makes progress, because the answer keeps what it already wrote and
 * needs less room to finish, which is exactly why the manual "继续" worked —
 * one continuation is too few for that.
 *
 * Two is enough to tell "it nearly finished" from "the limit itself is wrong".
 * Spending ten continuations and ten backoffs against a cap that will never fit
 * would re-send the whole context ten times to reach the same cut, and the
 * message after the second one says which of the two happened.
 */
export const AGENT_OUTPUT_LIMIT_MAX_RETRIES = 2;

type PiAiModule = typeof import("@earendil-works/pi-ai");
type PiAllProvidersModule = typeof import("@earendil-works/pi-ai/providers/all");

/** Stream function pi's `Agent` expects; aliased so callers stay SDK-typed. */
export type PiStreamFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
  AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * The SDK is a hard dependency but is imported on demand: `steamharness` is
 * loaded by the CLI, Desktop and Server at startup, and none of them should
 * pay for the provider catalog until a run actually creates an agent.
 */
let aiModule: Promise<PiAiModule> | undefined;
let allProvidersModule: Promise<PiAllProvidersModule> | undefined;

export function loadPiAi(): Promise<PiAiModule> {
  aiModule ??= import("@earendil-works/pi-ai");
  return aiModule;
}

/**
 * The TypeBox runtime pi carries, for callers that build tools of their own.
 *
 * A project cannot import the SDK — it travels inside this package's `dist` —
 * so anything a project calls has to resolve the runtime rather than ask for
 * it. The load is memoized, so resolving it repeatedly is free.
 */
export async function loadTypebox(): Promise<TypeboxLike> {
  return (await loadPiAi()).Type as unknown as TypeboxLike;
}

function loadPiAllProviders(): Promise<PiAllProvidersModule> {
  allProvidersModule ??= import("@earendil-works/pi-ai/providers/all");
  return allProvidersModule;
}

/** Provider authentication reads only the configuration captured for this run. */
async function loadBuiltinModels(): Promise<MutableModels> {
  const providers = await loadPiAllProviders();
  const config = structuredClone(currentConfigurationValues());
  return providers.builtinModels({ authContext: {
    env: async key => typeof config[key] === "string" ? config[key] as string : undefined,
    fileExists: async () => false,
  } });
}

/** `api` id for models this package registers against a caller-supplied endpoint. */
const CUSTOM_API_ID = "steamharness-custom";

export const DEFAULT_AGENT_PROVIDER = "anthropic";
export const DEFAULT_AGENT_MAX_TOKENS = 8_192;

/**
 * Context windows for models reached through a caller-supplied endpoint.
 *
 * A custom provider is absent from pi's catalog, so the model advertises no
 * window and the composer's "used / total" row would divide by a made-up
 * number. These prefixes mirror the values the gateway publishes in its own
 * model manifest, the same table the built-in OpenCode project keeps.
 */
const AGENT_MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ["gpt-6-astra", 1_050_000],
  ["gpt-5.6-", 872_000],
  ["deepseek-", 1_000_000],
  ["grok-build-", 256_000],
  ["grok-", 500_000],
  ["claude-", 200_000],
];

export const DEFAULT_AGENT_CONTEXT_WINDOW = 272_000;

export function resolveAgentModelContextWindow(modelId: unknown): number {
  const id = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (id === "") {
    return DEFAULT_AGENT_CONTEXT_WINDOW;
  }

  // Credential model ids may be namespaced ("vendor/family/model"), so a
  // family prefix is matched against both the whole id and its last segment.
  const candidates = [id, id.slice(id.lastIndexOf("/") + 1)];
  for (const [prefix, limit] of AGENT_MODEL_CONTEXT_WINDOWS) {
    if (candidates.some((candidate) => candidate.startsWith(prefix))) {
      return limit;
    }
  }

  return DEFAULT_AGENT_CONTEXT_WINDOW;
}

/**
 * Wire protocol for a caller-supplied endpoint. The host's AI bridge speaks
 * exactly one of these, so the agent is told which rather than inferring it
 * from the provider id.
 */
export type AgentApiKind = "anthropic-messages" | "openai-responses" | "openai-completions";

export interface PiRuntimeOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKind?: AgentApiKind;
  webSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Collection to resolve against. Tests pass one holding a faux provider. */
  models?: MutableModels;
  /** Already-resolved model; skips the catalog lookup entirely. */
  resolvedModel?: Model<Api>;
  /**
   * What the caller knows about the model behind `baseUrl`.
   *
   * Model records from the catalogue keep their own attributes. The search
   * capability also controls native tools for catalogue models.
   */
  modelAttributes?: AgentModelAttributes;
}

export interface PiRuntime {
  /** TypeBox runtime, handed to the tool factories. */
  Type: unknown;
  /** The collection the stream function belongs to; compaction reuses it. */
  models: MutableModels;
  streamFn: PiStreamFn;
  model: Model<Api>;
  providerId: string;
  modelId: string;
  /** Levels the resolved model accepts, `off` first. */
  supportedThinkingLevels: AgentThinkingLevel[];
  clampThinkingLevel(level: AgentThinkingLevel): AgentThinkingLevel;
}

/**
 * Resolves a provider/model pair into a ready-to-stream pi runtime.
 *
 * Built-in providers come from pi's generated catalog. Anything the catalog
 * cannot answer — a self-hosted gateway, a model id it has never heard of — is
 * registered as a custom provider pointed at `baseUrl`, so one code path
 * serves both.
 */
export async function createPiRuntime(options: PiRuntimeOptions): Promise<PiRuntime> {
  const ai = await loadPiAi();

  const providerId = normalizeId(options.provider) ?? options.resolvedModel?.provider ?? DEFAULT_AGENT_PROVIDER;
  const modelId = normalizeId(options.model);
  const catalog = options.models ?? await loadBuiltinModels();
  let models = catalog;

  let model = options.resolvedModel ??
    (modelId === undefined || options.baseUrl !== undefined
      ? undefined
      : catalog.getModel(providerId, modelId));

  if (model === undefined) {
    if (modelId === undefined) {
      throw new HarnessError({
        type: "input_validation",
        message: `Agent model is required for provider "${providerId}".`,
        metadata: { provider: providerId },
      });
    }
    if (options.baseUrl === undefined) {
      // A model the catalog does not know and no endpoint to reach it on is a
      // typo, not a provider we can synthesize. Failing here beats registering
      // an empty-baseUrl provider whose first request fails confusingly.
      throw new HarnessError({
        type: "input_validation",
        message: `Agent model "${modelId}" is unknown for provider "${providerId}". Pass a baseUrl to use a custom endpoint.`,
        metadata: { provider: providerId, model: modelId },
      });
    }
    model = createCustomModel(providerId, modelId, options);
    // A caller that handed us a collection keeps it: that collection is how a
    // test or an embedding host registers the provider it wants used. Anything
    // else gets a collection of its own rather than registering into the
    // process-wide catalog, where the provider id is the key: two runs on the
    // same id would overwrite each other's endpoint and credentials, and a
    // custom endpoint registered under a built-in provider id (say
    // "anthropic") would displace the real catalog for every other run.
    if (options.models === undefined) {
      models = ai.createModels();
    }
    models.setProvider(await createCustomProvider(ai, providerId, model, options));
  }

  const apiKind = model.api === CUSTOM_API_ID
    ? options.apiKind ?? (providerId === "anthropic" ? "anthropic-messages" : "openai-completions")
    : model.api;
  const webSearch = resolveAgentWebSearch(apiKind, options.webSearch, options.modelAttributes?.webSearch);
  models = withAgentWebSearch(ai, models, { model, apiKind, enabled: webSearch });

  return {
    Type: ai.Type,
    models,
    streamFn: createRetryingStreamFn(ai, models, options.apiKey),
    model,
    providerId,
    modelId: model.id,
    supportedThinkingLevels: readSupportedThinkingLevels(ai, model),
    clampThinkingLevel(level) {
      return ai.clampThinkingLevel(model, level as never) as AgentThinkingLevel;
    },
  };
}

/**
 * `models.streamSimple` with a retry budget this wrapper spends itself.
 *
 * Every model error uses the same fallback, whether returned by the provider
 * or thrown during setup, iteration or result retrieval. Error text and HTTP
 * status do not decide whether to retry. Caller cancellation stays terminal.
 *
 * The budget is spent in exactly one place.
 * pi is handed `maxRetries: 0`, so every attempt is a single request: letting
 * both layers retry would multiply them (a ten-attempt budget became a hundred
 * requests, each waiting out its own backoff). The cost is that a `retry-after`
 * the provider asked for is no longer honoured — this backoff is the whole
 * wait — which is the right trade for a budget the user asked to be ten.
 *
 * A retry is only safe while no content has been produced: once a token reached
 * the consumer, pi's agent loop holds half an answer for this call, and
 * replaying the request would leave both versions in the transcript. A failure
 * after that point is returned to the durable runtime for continuation.
 */
function createRetryingStreamFn(ai: PiAiModule, models: MutableModels, apiKey?: string): PiStreamFn {
  const streamFn = async (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const requestOptions: SimpleStreamOptions = { ...options, ...(apiKey === undefined ? {} : { apiKey }), maxRetries: 0 };
    const budget = options?.maxRetries ?? AGENT_PROVIDER_MAX_RETRIES;
    const requestContext = ai.normalizeContext(context);
    let first: AssistantMessageEventStream;
    try {
      options?.signal?.throwIfAborted();
      first = models.streamSimple(model, requestContext, requestOptions);
    } catch (cause) {
      const error = createAssistantErrorMessage(model, cause, options?.signal);
      first = ai.createAssistantMessageEventStream();
      first.push({ type: "error", reason: error.stopReason as "error" | "aborted", error }); first.end(error);
    }
    const stream = ai.createAssistantMessageEventStream();
    void pumpAssistantStream({
      ai,
      models,
      model,
      context: requestContext,
      requestOptions,
      stream,
      first,
      budget,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return stream;
  };

  return streamFn as PiStreamFn;
}

interface AssistantStreamPumpOptions {
  ai: PiAiModule;
  models: MutableModels;
  model: Model<Api>;
  context: Context;
  requestOptions: SimpleStreamOptions;
  /** The stream the consumer is reading; this wrapper owns its lifecycle. */
  stream: AssistantMessageEventStream;
  first: AssistantMessageEventStream;
  /** Retries this call may still spend; every attempt after the first costs one. */
  budget: number;
  signal?: AbortSignal;
}

/**
 * Forwards one assistant stream, re-issuing the request while that is safe.
 *
 * Every path ends with a terminal event: the consumer resolves its final
 * assistant message from one, and a stream that just stops would leave it
 * waiting forever.
 */
async function pumpAssistantStream(options: AssistantStreamPumpOptions): Promise<void> {
  const { ai, models, model, context, requestOptions, stream, budget, signal } = options;
  // What the consumer has already been told about this call. `start` alone does
  // not count as content — the adapters push it as soon as the response headers
  // land, so a stream that dies before its first token leaves the consumer with
  // an empty partial message and nothing else, which is replayable. That
  // message has to stay the one the consumer sees, so a replayed attempt does
  // not announce a second start: pi's loop would push a second partial message
  // into the transcript beside the first.
  let startSent = false;
  let contentSent = false;
  // The last partial the consumer was shown. A stream that stops without a
  // verdict is reported as an error, and this is what keeps the text already on
  // the user's screen (and the tokens already billed) attached to it.
  let lastPartial: AssistantMessage | undefined;

  for (let attempt = 0; ; attempt += 1) {
    let message: AssistantMessage | undefined;
    try {
      signal?.throwIfAborted();
      const attemptStream = attempt === 0 ? options.first : models.streamSimple(model, context, requestOptions);
      for await (const event of attemptStream) {
        if (event.type === "done" || event.type === "error") {
          message = event.type === "done" ? event.message : event.error;
          break;
        }
        lastPartial = event.partial;
        if (event.type === "start") {
          if (startSent) continue;
          startSent = true;
        } else contentSent = true;
        stream.push(event);
      }
      // An adapter may supply only end(result). Never await an unset result:
      // end() alone otherwise strands the consumer indefinitely.
      message ??= await Promise.race([attemptStream.result(), Promise.resolve(undefined)])
        ?? createAssistantErrorMessage(model, `The model stream ended without a terminal event (${model.provider}).`, signal, lastPartial);
      message = normalizeAssistantError(message, signal);
    } catch (cause) {
      // This includes both iterator/result failures and construction failures on
      // subsequent attempts. Always settle a terminal event or spend one retry.
      message = normalizeAssistantError(message ?? createAssistantErrorMessage(model, cause, signal, lastPartial), signal);
    }
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred", message });
      stream.end(message); return;
    }
    if (contentSent || attempt >= budget || message.stopReason === "aborted" || signal?.aborted) {
      stream.push({ type: "error", reason: message.stopReason, error: message });
      stream.end(message); return;
    }

    if (!(await waitBeforeRetry(attempt + 1, signal))) {
      stream.push({
        type: "error",
        reason: "aborted",
        error: { ...message, stopReason: "aborted", errorMessage: "Request aborted" },
      });
      stream.end();
      return;
    }

  }
}

/**
 * The model record for a caller-supplied endpoint.
 *
 * Anything the caller told us about the model wins over the defaults below.
 * Without that the runtime would be describing a model it has never seen:
 * `reasoning: true`, images accepted, zero cost, and a window off a name-prefix
 * table — which is how a model with a 1M window ended up divided by 272k.
 * An explicit `contextWindow`/`maxTokens` option outranks the attributes,
 * because that is the per-run override the caller passed on purpose.
 */
function createCustomModel(
  providerId: string,
  modelId: string,
  options: PiRuntimeOptions,
): Model<Api> {
  const attributes = options.modelAttributes;

  return {
    id: modelId,
    name: attributes?.name ?? modelId,
    api: CUSTOM_API_ID,
    provider: providerId,
    baseUrl: options.baseUrl ?? "",
    reasoning: attributes?.reasoning ?? true,
    input: attributes?.input === undefined ? ["text", "image"] : [...attributes.input],
    cost: attributes?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? attributes?.contextWindow ?? resolveAgentModelContextWindow(modelId),
    maxTokens: options.maxTokens ?? attributes?.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS,
    ...(attributes?.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: { ...attributes.thinkingLevelMap } }),
  };
}

async function createCustomProvider(
  ai: PiAiModule,
  providerId: string,
  model: Model<Api>,
  options: PiRuntimeOptions,
) {
  const api = await createApiAdapter(options.apiKind ?? (providerId === "anthropic"
    ? "anthropic-messages"
    : "openai-completions"));

  const apiKey = options.apiKey ?? readProviderConfigApiKey(providerId);

  return ai.createProvider({
    id: providerId,
    name: providerId,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    auth: {
      apiKey: {
        name: `${providerId} API key`,
        resolve: async () =>
          apiKey === undefined ? undefined : { auth: { apiKey }, source: "configured api key" },
      },
    },
    models: [model],
    api,
  });
}

async function createApiAdapter(kind: AgentApiKind) {
  if (kind === "anthropic-messages") {
    return (await import("@earendil-works/pi-ai/api/anthropic-messages.lazy")).anthropicMessagesApi();
  }
  if (kind === "openai-responses") {
    return (await import("@earendil-works/pi-ai/api/openai-responses.lazy")).openAIResponsesApi();
  }
  return (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi();
}

function readSupportedThinkingLevels(ai: PiAiModule, model: Model<Api>): AgentThinkingLevel[] {
  const levels = ai.getSupportedThinkingLevels(model) as AgentThinkingLevel[];
  return levels.length === 0 ? ["off"] : levels;
}

export function readProviderConfigApiKey(providerId: string): string | undefined {
  const candidates = providerId === "anthropic"
    ? ["ANTHROPIC_API_KEY", "PI_ANTHROPIC_API_KEY", "PI_API_KEY"]
    : ["OPENAI_API_KEY", "PI_OPENAI_API_KEY", "PI_API_KEY"];

  for (const name of candidates) {
    const value = getConfig(name);
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

