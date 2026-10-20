import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  MutableModels,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentThinkingLevel } from "./effort";
import type { AgentModelAttributes } from "./types";
import type { TypeboxLike } from "./tools";
import { HarnessError } from "../workflow/errors";
import { withAgentWebSearch, resolveAgentWebSearch } from "./web-search";

/**
 * How many times one model call may be retried before the run fails.
 *
 * The budget covers the whole call, not just getting a response back: a
 * connection that never lands and a response that dies halfway both count
 * against it, and both are re-issued by the stream wrapper below. Each retry
 * waits out a doubling backoff capped at 8s, so ten of them ride out roughly a
 * minute of trouble — a Server AI proxy restart, a dropped stream — before the
 * run gives up.
 *
 * Only transient failures are replayed: pi classifies the error, and an auth,
 * validation or quota failure still ends the run on the first response instead
 * of being sent ten times. An abort is never retried either.
 */
export const AGENT_PROVIDER_MAX_RETRIES = 10;

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

/**
 * One provider collection per process.
 *
 * Building the catalog is the expensive part of resolving a model, and a
 * conversation project resolves one every turn. Sharing the collection also
 * means a custom endpoint registered by one run is reusable by the next.
 */
let modelsCollection: MutableModels | undefined;

async function loadBuiltinModels(): Promise<MutableModels> {
  if (modelsCollection === undefined) {
    const providers = await loadPiAllProviders();
    modelsCollection = providers.builtinModels();
  }

  return modelsCollection;
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
    streamFn: createRetryingStreamFn(ai, models),
    model,
    providerId,
    modelId: model.id,
    supportedThinkingLevels: readSupportedThinkingLevels(ai, model),
    clampThinkingLevel(level) {
      return ai.clampThinkingLevel(model, level as never) as AgentThinkingLevel;
    },
  };
}

/** Backoff before a retried attempt: doubling, capped at 8s, with jitter. */
const AGENT_RETRY_BASE_DELAY_MS = 500;
const AGENT_RETRY_MAX_DELAY_MS = 8_000;

/**
 * `models.streamSimple` with a retry budget this wrapper spends itself.
 *
 * A model call fails in two ways, and only the second one is visible as a
 * stream event:
 *
 * 1. **The request never gets a response** — a dropped connection, `408`/`409`/
 *    `429`, any 5xx from the AI proxy bridge.
 * 2. **The response starts and then dies** — a mid-stream
 *    `TypeError: terminated` when the bridge or the Server is cut off while the
 *    model is answering. pi cannot retry this one: its own budget only covers
 *    getting the response headers back, which is how a run used to end on a
 *    failure a second attempt would have fixed.
 *
 * Both are retried here instead, and the budget is spent in exactly one place.
 * pi is handed `maxRetries: 0`, so every attempt is a single request: letting
 * both layers retry would multiply them (a ten-attempt budget became a hundred
 * requests, each waiting out its own backoff). The cost is that a `retry-after`
 * the provider asked for is no longer honoured — this backoff is the whole
 * wait — which is the right trade for a budget the user asked to be ten.
 *
 * A retry is only safe while no content has been produced: once a token reached
 * the consumer, pi's agent loop holds half an answer for this call, and
 * replaying the request would leave both versions in the transcript. A failure
 * after that point stays fatal, exactly as before.
 */
function createRetryingStreamFn(ai: PiAiModule, models: MutableModels): PiStreamFn {
  const streamFn = async (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const requestOptions: SimpleStreamOptions = { ...options, maxRetries: 0 };
    const budget = options?.maxRetries ?? AGENT_PROVIDER_MAX_RETRIES;
    // The first call stays on the synchronous path: `streamSimple` throws
    // outright when the request cannot even be built (missing auth), and pi's
    // loop relies on that rejection to fail the turn.
    const first = models.streamSimple(model, ai.normalizeContext(context), requestOptions);
    const stream = ai.createAssistantMessageEventStream();
    void pumpAssistantStream({
      ai,
      models,
      model,
      context,
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
 * The emptiest assistant message a terminal event can carry for a model.
 *
 * Only used when a stream died before the consumer was ever shown a partial,
 * so there is no text, no usage and nothing already on screen to preserve —
 * the error itself is the whole message.
 */
function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "error",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
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
  let attemptStream = options.first;
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
    let failed: AssistantMessage | undefined;

    for await (const event of attemptStream) {
      if (
        event.type === "error" &&
        !contentSent &&
        attempt < budget &&
        event.reason !== "aborted" &&
        ai.isRetryableAssistantError(event.error)
      ) {
        failed = event.error;
        break;
      }
      if (event.type === "start") {
        if (startSent) continue;
        startSent = true;
      } else {
        contentSent = true;
      }
      if (event.type !== "done" && event.type !== "error") {
        lastPartial = (event as { partial?: AssistantMessage }).partial ?? lastPartial;
      }
      stream.push(event);
      if (event.type === "done" || event.type === "error") {
        stream.end();
        return;
      }
    }

    if (failed === undefined) {
      // The stream stopped without saying anything. The adapters are supposed
      // to always end with `done` or `error`, so this is a transport that ended
      // the body without a verdict — and ending the consumer's stream on it is
      // not "nothing to report": `result()` would never resolve, and pi awaits
      // that, so the run would hang instead of ending.
      //
      // It is treated the way the same cut would be if the adapter had labelled
      // it: a retryable failure. The text the consumer already saw rides on the
      // message, so a turn that has to be carried on keeps what the user read.
      const noVerdict = {
        ...(lastPartial ?? createEmptyAssistantMessage(model)),
        stopReason: "error",
        errorMessage: `The model stream ended without a terminal event (${model.provider}).`,
      } as AssistantMessage;

      if (!contentSent && attempt < budget) {
        // Nothing reached the consumer, so this attempt is replayable: spend the
        // wrapper's own budget rather than hand a half-empty answer on.
        failed = noVerdict;
      } else {
        stream.push({ type: "error", reason: "error", error: noVerdict });
        stream.end();
        return;
      }
    }

    if (!(await waitBeforeRetry(attempt + 1, signal))) {
      stream.push({
        type: "error",
        reason: "aborted",
        error: { ...failed, stopReason: "aborted", errorMessage: "Request aborted" },
      });
      stream.end();
      return;
    }

    try {
      attemptStream = models.streamSimple(model, ai.normalizeContext(context), requestOptions);
    } catch (error) {
      // A later attempt can fail before it produces a stream — an expired token
      // is the usual reason. The previous error message is what the consumer
      // ends up seeing, with this failure named.
      stream.push({
        type: "error",
        reason: "error",
        error: {
          ...failed,
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      stream.end();
      return;
    }
  }
}

/**
 * Waits out the backoff for a retry; false means the run was cancelled.
 *
 * Exported because the runtime spends the same budget on a second kind of
 * retry: a turn whose model call died *after* it had produced content cannot be
 * replayed by the stream wrapper above, so it is resumed as a fresh
 * continuation, and that wait has to look the same to a user watching it.
 */
export function waitBeforeRetry(attempt: number, signal: AbortSignal | undefined): Promise<boolean> {
  const delayMs = Math.min(
    AGENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    AGENT_RETRY_MAX_DELAY_MS,
  ) * (1 - Math.random() * 0.25);

  if (signal === undefined) {
    return new Promise((resolve) => {
      setTimeout(() => resolve(true), delayMs);
    });
  }
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

  const apiKey = options.apiKey ?? readProviderEnvApiKey(providerId);

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

export function readProviderEnvApiKey(providerId: string): string | undefined {
  const candidates = providerId === "anthropic"
    ? ["ANTHROPIC_API_KEY", "PI_ANTHROPIC_API_KEY", "PI_API_KEY"]
    : ["OPENAI_API_KEY", "PI_OPENAI_API_KEY", "PI_API_KEY"];

  for (const name of candidates) {
    const value = process.env[name];
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

