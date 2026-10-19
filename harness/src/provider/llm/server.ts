import { readWorkflowCliAuthConfigSync } from "../../auth-config";
import { HarnessError } from "../../workflow/errors";
import { createLLMProvider } from "./factory";
import {
  startLLMProxyBridge,
  startOpenAIProxyBridge,
  type ServerLLMProxyBridge,
  type ServerOpenAIProxyBridge,
} from "./openai-proxy-bridge";
import type { LLMCallSettings, LLMProvider } from "./types";
import type { LLMProviderType } from "./factory";

export type {
  ServerLLMProxyBridge,
  ServerOpenAIProxyBridge,
} from "./openai-proxy-bridge";

const CREDENTIAL_REFRESH_WINDOW_MS = 60_000;
type ServerLLMSupportedProviderType = Extract<
  LLMProviderType,
  "openai-responses" | "anthropic"
>;

export interface ServerLLMCredential {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly providerType: LLMProviderType;
  readonly models: readonly string[];
  readonly modelDetails: readonly ServerLLMModelDetails[];
  readonly defaultModelId: string | null;
  createProvider(options: {
    model: string;
    system?: string;
    defaults?: LLMCallSettings;
    webSearch?: boolean;
  }): LLMProvider;
  startOpenAIProxyBridge(options?: {
    signal?: AbortSignal;
  }): Promise<ServerOpenAIProxyBridge>;
  startLLMProxyBridge(options?: {
    signal?: AbortSignal;
  }): Promise<ServerLLMProxyBridge>;
}

export interface ServerLLMModelCapabilities {
  readonly vision: boolean;
  readonly webSearch: boolean;
  readonly reasoning: boolean;
  readonly toolCalling: boolean;
}

/**
 * Per-million-token prices the Server publishes for a model.
 *
 * Only ever a hint: a run that never prices a call keeps working with the
 * fields absent.
 */
export interface ServerLLMModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * What the Server's model catalogue knows about one model.
 *
 * `capabilities` is the four-boolean summary every consumer already reads.
 * Everything below it is the model's attribute record, which the Server
 * resolves from its own catalogue and lets an administrator edit; a Server
 * that predates the catalogue omits all of it and the runtime falls back to
 * its own defaults.
 */
export interface ServerLLMModelDetails {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ServerLLMModelCapabilities;
  /**
   * The catalogue's own answer, present only when it matched this model.
   *
   * Distinct from `capabilities.reasoning`, which is the display summary and
   * reads `false` for a model nobody recognizes. An absent field means "not
   * known", which is what keeps the runtime's default in place.
   */
  readonly reasoning?: boolean;
  /** Modalities the model accepts; `image` is what makes a run send pictures. */
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: ServerLLMModelCost;
  /** pi thinking level → the value sent upstream, `null` when unsupported. */
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

export interface GetServerLLMCredentialsOptions {
  signal?: AbortSignal;
}

interface ServerLLMCredentialRecord {
  id: string;
  name: string;
  platform: string;
  providerType: ServerLLMSupportedProviderType;
  models: string[];
  modelDetails: ServerLLMModelDetails[];
  defaultModelId?: string | null;
  proxyPath: string;
  credentialToken: string;
  expiresAt: string;
}

interface ServerLLMCredentialCatalog {
  credentials: ServerLLMCredentialRecord[];
  warnings?: Array<{
    id: string;
    name: string;
    code: string;
  }>;
  fetchedAt: string;
}

interface ApiResponse<T> {
  errCode: number;
  errMessage: string;
  data?: T;
  steamHarnessI18n?: SteamHarnessI18nDescriptor;
}

interface SteamHarnessI18nDescriptor {
  namespace: "common";
  key: string;
  values?: Record<string, unknown>;
}

interface ServerLLMConnection {
  serverUrl: string;
  token: string;
}

export async function getServerLLMCredentials(
  options: GetServerLLMCredentialsOptions = {},
): Promise<ServerLLMCredential[]> {
  const manager = new ServerLLMCredentialManager(resolveServerLLMConnection(process.env));
  return manager.list(options.signal);
}

class ServerLLMCredentialManager {
  private catalog?: ServerLLMCredentialCatalog;
  private refreshPromise?: Promise<ServerLLMCredentialCatalog>;

  constructor(
    private readonly connection: ServerLLMConnection,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async list(signal?: AbortSignal): Promise<ServerLLMCredential[]> {
    const catalog = await this.refresh(signal);
    if (catalog.credentials.length === 0) {
      throw new HarnessError({
        type: "input_validation",
        message: "This account has no available server AI credentials. Configure the private AI service before using system AI.",
        metadata: {
          warnings: catalog.warnings?.map((warning) => warning.code) ?? [],
          steamHarnessI18n: createI18nDescriptor("serverAiCredentialsUnavailable"),
        },
      });
    }
    return catalog.credentials.map((record) => this.createCredential(record));
  }

  private createCredential(record: ServerLLMCredentialRecord): ServerLLMCredential {
    const models = Object.freeze([...record.models]);
    const modelDetails = Object.freeze(record.modelDetails.map((detail) => Object.freeze({
      ...detail,
      capabilities: Object.freeze({ ...detail.capabilities }),
    })));
    const modelDetailsById = new Map(modelDetails.map((detail) => [detail.id, detail]));
    // Honor the Server-resolved default model only when it actually exists
    // in the credential's available model list; otherwise fall back to null
    // so the host can apply its own priority chain. The lookup matches the
    // Server's rule case-insensitively and returns the credential's own
    // spelling, so a default that passed Server validation is never dropped
    // here just because the two sides disagree on case.
    const defaultModelId = readDefaultModelId(record.defaultModelId, models);
    return Object.freeze({
      id: record.id,
      name: record.name,
      platform: record.platform,
      providerType: record.providerType,
      models,
      modelDetails,
      defaultModelId,
      createProvider: (options: {
        model: string;
        system?: string;
        defaults?: LLMCallSettings;
        webSearch?: boolean;
      }) => {
        const model = options.model.trim();
        if (!models.includes(model)) {
          throw new HarnessError({
            type: "input_validation",
            message: `Model "${options.model}" does not belong to AI configuration "${record.name}".`,
            metadata: {
              credentialId: record.id,
              model: options.model,
              steamHarnessI18n: createI18nDescriptor("serverAiModelNotInConfiguration", {
                model: options.model,
                configuration: record.name,
              }),
            },
          });
        }
        if (options.webSearch && !modelDetailsById.get(model)?.capabilities.webSearch) {
          throw new HarnessError({
            type: "input_validation",
            message: `Model "${model}" does not support web search.`,
            metadata: {
              credentialId: record.id,
              model,
              steamHarnessI18n: createI18nDescriptor("serverAiModelWebSearchUnsupported", { model }),
            },
          });
        }
        return createLLMProvider({
          type: record.providerType,
          apiKey: "steamharness-server-proxy",
          baseURL: joinServerUrl(this.connection.serverUrl, record.proxyPath),
          model,
          system: options.system,
          defaults: options.defaults,
          webSearch: options.webSearch,
          fetch: this.createCredentialFetch(record.id, record.providerType),
        });
      },
      startOpenAIProxyBridge: async (options: { signal?: AbortSignal } = {}) => {
        if (record.providerType !== "openai-responses") {
          throw new HarnessError({
            type: "input_validation",
            message: `AI configuration "${record.name}" does not support the OpenAI Responses proxy bridge.`,
            metadata: {
              credentialId: record.id,
              providerType: record.providerType,
              steamHarnessI18n: createI18nDescriptor("serverAiResponsesProxyUnsupported", {
                configuration: record.name,
              }),
            },
          });
        }
        return startOpenAIProxyBridge({
          targetUrl: joinServerUrl(
            this.connection.serverUrl,
            `${record.proxyPath.replace(/\/+$/, "")}/responses`,
          ),
          fetchImpl: this.createCredentialFetch(record.id, record.providerType),
          signal: options.signal,
        });
      },
      startLLMProxyBridge: async (options: { signal?: AbortSignal } = {}) => {
        const endpoint = record.providerType === "anthropic" ? "messages" : "responses";
        return startLLMProxyBridge({
          targetUrl: joinServerUrl(
            this.connection.serverUrl,
            `${record.proxyPath.replace(/\/+$/, "")}/${endpoint}`,
          ),
          fetchImpl: this.createCredentialFetch(record.id, record.providerType),
          protocol: record.providerType,
          signal: options.signal,
        });
      },
    });
  }

  private createCredentialFetch(
    credentialId: string,
    providerType: ServerLLMSupportedProviderType,
  ): typeof fetch {
    return async (input, init) => {
      const token = await this.readCredentialToken(credentialId, init?.signal ?? undefined);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.delete("authorization");
      headers.delete("x-api-key");
      if (providerType === "anthropic") {
        headers.set("x-api-key", token);
      } else {
        headers.set("authorization", `Bearer ${token}`);
      }
      return this.fetchImpl(input, { ...init, headers });
    };
  }

  private async readCredentialToken(
    credentialId: string,
    signal?: AbortSignal | null,
  ): Promise<string> {
    const current = this.findCredential(credentialId);
    if (current && readExpiry(current.expiresAt) - this.now() > CREDENTIAL_REFRESH_WINDOW_MS) {
      return current.credentialToken;
    }

    try {
      await this.refresh(signal ?? undefined);
    } catch (error) {
      if (current && readExpiry(current.expiresAt) > this.now()) {
        return current.credentialToken;
      }
      throw error;
    }

    const refreshed = this.findCredential(credentialId);
    if (!refreshed) {
      throw new HarnessError({
        type: "provider_call",
        message: "The selected server AI credential is no longer valid. Select a Provider again.",
        metadata: {
          credentialId,
          steamHarnessI18n: createI18nDescriptor("serverAiCredentialInvalid"),
        },
      });
    }
    if (readExpiry(refreshed.expiresAt) <= this.now()) {
      throw new HarnessError({
        type: "provider_call",
        message: "The server AI credential expired and could not be refreshed.",
        metadata: {
          credentialId,
          steamHarnessI18n: createI18nDescriptor("serverAiCredentialExpired"),
        },
      });
    }
    return refreshed.credentialToken;
  }

  private findCredential(id: string): ServerLLMCredentialRecord | undefined {
    return this.catalog?.credentials.find((credential) => credential.id === id);
  }

  private refresh(signal?: AbortSignal): Promise<ServerLLMCredentialCatalog> {
    if (this.refreshPromise) return this.refreshPromise;
    const request = this.fetchCatalog(signal).finally(() => {
      if (this.refreshPromise === request) this.refreshPromise = undefined;
    });
    this.refreshPromise = request;
    return request;
  }

  private async fetchCatalog(signal?: AbortSignal): Promise<ServerLLMCredentialCatalog> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        joinServerUrl(this.connection.serverUrl, "/api/ai/catalog"),
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.connection.token}`,
          },
          signal,
        },
      );
    } catch (error) {
      throw new HarnessError({
        type: "provider_call",
        message: `Could not connect to the private AI service to load credentials: ${this.connection.serverUrl}`,
        metadata: {
          cause: redactConnectionSecret(error instanceof Error ? error.message : String(error), this.connection.token),
          steamHarnessI18n: createI18nDescriptor("serverAiCredentialsConnectionFailed", {
            url: this.connection.serverUrl,
          }),
        },
      });
    }

    const payload = await readApiResponse<ServerLLMCredentialCatalog>(response);
    if (response.status === 404) {
      throw new HarnessError({
        type: "input_validation",
        message: "System AI is unavailable on this public Server. Configure the private AI service URL and API key.",
        metadata: {
          systemAiConfigured: false,
          steamHarnessI18n: createI18nDescriptor("systemAiUnavailable"),
        },
      });
    }
    if (!response.ok || payload.errCode !== 0 || !payload.data) {
      throw new HarnessError({
        type: "provider_call",
        message: payload.errMessage || `The private AI service credential request failed (HTTP ${response.status}).`,
        metadata: {
          status: response.status,
          errCode: payload.errCode,
          ...(payload.steamHarnessI18n
            ? { steamHarnessI18n: payload.steamHarnessI18n }
            : payload.errMessage
              ? {}
              : {
                  steamHarnessI18n: createI18nDescriptor("serverAiCredentialsRequestFailed", {
                    status: response.status,
                  }),
                }),
        },
      });
    }
    const catalog = validateCatalog(payload.data);
    this.catalog = catalog;
    return catalog;
  }
}

function resolveServerLLMConnection(env: NodeJS.ProcessEnv): ServerLLMConnection {
  const specific = readConnectionPair(
    env.STEAMHARNESS_AI_SERVER_URL,
    env.STEAMHARNESS_AI_API_KEY,
    "STEAMHARNESS_AI_SERVER_URL/STEAMHARNESS_AI_API_KEY",
  );
  if (specific) return specific;

  const saved = readWorkflowCliAuthConfigSync(env);
  if (saved.aiServerUrl?.trim() && saved.aiApiKey?.trim()) {
    return normalizeConnection(saved.aiServerUrl, saved.aiApiKey);
  }

  throw new HarnessError({
    type: "input_validation",
    message: "System AI is unavailable. Configure the private AI service URL and API key.",
    metadata: {
      systemAiConfigured: false,
      steamHarnessI18n: createI18nDescriptor("systemAiUnavailable"),
    },
  });
}

function readConnectionPair(
  rawUrl: string | undefined,
  rawToken: string | undefined,
  names: string,
): ServerLLMConnection | undefined {
  const serverUrl = rawUrl?.trim() ?? "";
  const token = rawToken?.trim() ?? "";
  if (!serverUrl && !token) return undefined;
  if (!serverUrl || !token) {
    throw new HarnessError({
      type: "input_validation",
      message: `${names} must be configured together.`,
      metadata: {
        steamHarnessI18n: createI18nDescriptor("workflowServerConnectionPairRequired", { names }),
      },
    });
  }
  return normalizeConnection(serverUrl, token);
}

function normalizeConnection(serverUrl: string, token: string): ServerLLMConnection {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new HarnessError({
      type: "input_validation",
      message: "The SteamHarness Server URL is invalid.",
      metadata: { steamHarnessI18n: createI18nDescriptor("workflowServerUrlInvalid") },
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HarnessError({
      type: "input_validation",
      message: "The SteamHarness Server URL must use HTTP or HTTPS.",
      metadata: { steamHarnessI18n: createI18nDescriptor("workflowServerUrlProtocolInvalid") },
    });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new HarnessError({
      type: "input_validation",
      message: "The SteamHarness Server URL must not contain credentials, query parameters, or fragments.",
      metadata: { steamHarnessI18n: createI18nDescriptor("workflowServerUrlInvalid") },
    });
  }
  return { serverUrl: parsed.toString().replace(/\/$/, ""), token: token.trim() };
}

function redactConnectionSecret(message: string, token: string): string {
  return token ? message.replaceAll(token, "[redacted]") : message;
}

function validateCatalog(value: unknown): ServerLLMCredentialCatalog {
  if (!isRecord(value) || !Array.isArray(value.credentials) || typeof value.fetchedAt !== "string") {
    throw protocolError();
  }
  const credentials = value.credentials.map((item) => validateCredentialRecord(item));
  return {
    credentials,
    fetchedAt: value.fetchedAt,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.flatMap((warning) => isRecord(warning) && typeof warning.id === "string" &&
          typeof warning.name === "string" && typeof warning.code === "string"
        ? [{ id: warning.id, name: warning.name, code: warning.code }]
        : [])
      : undefined,
  };
}

function validateCredentialRecord(value: unknown): ServerLLMCredentialRecord {
  if (!isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.platform !== "string" ||
    (value.providerType !== "anthropic" && value.providerType !== "openai-responses") ||
    !Array.isArray(value.models) || !value.models.every((model) => typeof model === "string" && model.trim() !== "") ||
    typeof value.proxyPath !== "string" || !value.proxyPath.startsWith("/") ||
    typeof value.credentialToken !== "string" || value.credentialToken.trim() === "" ||
    typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw protocolError();
  }
  const models = [...new Set(value.models)];
  return {
    id: value.id,
    name: value.name,
    platform: value.platform,
    providerType: value.providerType,
    models,
    modelDetails: validateModelDetails(value.modelDetails, models),
    // The Server merges the user's personal default model with the admin's
    // per-group default into this optional field. It must survive catalog
    // validation: dropping it here silently disables the whole configured
    // default-model chain in every built-in project. An absent or non-string
    // value is treated as "no configured default" so older Servers keep
    // working.
    defaultModelId: typeof value.defaultModelId === "string" ? value.defaultModelId : undefined,
    proxyPath: value.proxyPath,
    credentialToken: value.credentialToken,
    expiresAt: value.expiresAt,
  };
}

function validateModelDetails(
  value: unknown,
  models: string[],
): ServerLLMModelDetails[] {
  const details = value === undefined ? [] : value;
  if (!Array.isArray(details)) throw protocolError();
  const availableModels = new Set(models);
  const byId = new Map<string, ServerLLMModelDetails>();
  for (const detail of details) {
    if (!isRecord(detail) || typeof detail.id !== "string" || !availableModels.has(detail.id) ||
      typeof detail.name !== "string" || detail.name.trim() === "" || byId.has(detail.id) ||
      !isRecord(detail.capabilities)) {
      throw protocolError();
    }
    const capabilities = detail.capabilities;
    if (typeof capabilities.vision !== "boolean" || typeof capabilities.webSearch !== "boolean" ||
      typeof capabilities.reasoning !== "boolean" || typeof capabilities.toolCalling !== "boolean") {
      throw protocolError();
    }
    // The four booleans are load-bearing, so a wrong type is a protocol error.
    // The attribute record below is advisory: one field the Server got wrong
    // must not fail every run that names the model, so an unusable value is
    // dropped and the runtime keeps its own default. Unknown keys stay ignored
    // for the same reason — a newer Server may add fields this Core never reads.
    const modelReasoning = typeof detail.reasoning === "boolean" ? detail.reasoning : undefined;
    const input = readOptionalModalities(detail.input);
    const contextWindow = readOptionalPositiveInteger(detail.contextWindow);
    const maxTokens = readOptionalPositiveInteger(detail.maxTokens);
    const cost = readOptionalModelCost(detail.cost);
    const thinkingLevelMap = readOptionalThinkingLevelMap(detail.thinkingLevelMap);
    byId.set(detail.id, {
      id: detail.id,
      name: detail.name,
      capabilities: {
        vision: capabilities.vision,
        webSearch: capabilities.webSearch,
        reasoning: capabilities.reasoning,
        toolCalling: capabilities.toolCalling,
      },
      ...(modelReasoning === undefined ? {} : { reasoning: modelReasoning }),
      ...(input === undefined ? {} : { input }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(cost === undefined ? {} : { cost }),
      ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    });
  }
  return models.map((model) => byId.get(model) ?? {
    id: model,
    name: model,
    capabilities: {
      vision: false,
      webSearch: false,
      reasoning: false,
      toolCalling: false,
    },
  });
}

/** Modalities a model may declare. Anything else is ignored, not rejected. */
const MODEL_INPUT_MODALITIES: ReadonlySet<string> = new Set(["text", "image"]);

/** pi's thinking levels, the only keys a `thinkingLevelMap` may carry. */
const MODEL_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function readOptionalModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modalities = value.filter(
    (entry): entry is string => typeof entry === "string" && MODEL_INPUT_MODALITIES.has(entry),
  );
  return modalities.length === 0 ? undefined : [...new Set(modalities)];
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readOptionalModelCost(value: unknown): ServerLLMModelCost | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [value.input, value.output, value.cacheRead, value.cacheWrite];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field) && field >= 0)) {
    return undefined;
  }
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
  };
}

function readOptionalThinkingLevelMap(value: unknown): Record<string, string | null> | undefined {
  if (!isRecord(value)) return undefined;
  const map: Record<string, string | null> = {};
  for (const [level, target] of Object.entries(value)) {
    if (!MODEL_THINKING_LEVELS.has(level)) continue;
    if (target === null) {
      map[level] = null;
    } else if (typeof target === "string" && target !== "" && target.length <= 64) {
      map[level] = target;
    }
  }
  return Object.keys(map).length === 0 ? undefined : map;
}

async function readApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  try {
    const payload = await response.json() as unknown;
    if (isRecord(payload) && typeof payload.errCode === "number" && typeof payload.errMessage === "string") {
      return payload as unknown as ApiResponse<T>;
    }
  } catch {
    // Converted to a stable protocol error below.
  }
  return {
    errCode: response.status,
    errMessage: `SteamHarness Server returned an invalid response (HTTP ${response.status}).`,
    steamHarnessI18n: createI18nDescriptor("workflowServerInvalidResponse", { status: response.status }),
  };
}

function joinServerUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function readExpiry(value: string): number {
  const expiry = Date.parse(value);
  return Number.isFinite(expiry) ? expiry : 0;
}

/**
 * Resolves the Server-provided default model against the credential's own
 * model list. Matching is case-insensitive to mirror the Server, and the
 * returned id is the credential's spelling so downstream `includes` checks
 * and `defaultModelId` lookups stay consistent.
 */
function readDefaultModelId(
  value: string | null | undefined,
  models: readonly string[],
): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.toLowerCase();
  return models.find((model) => model.toLowerCase() === normalized) ?? null;
}

function protocolError(): HarnessError {
  return new HarnessError({
    type: "provider_call",
    message: "The private AI service returned an invalid AI credential catalog.",
    metadata: {
      steamHarnessI18n: createI18nDescriptor("workflowServerInvalidAiCatalog"),
    },
  });
}

function createI18nDescriptor(
  key: string,
  values?: Record<string, unknown>,
): SteamHarnessI18nDescriptor {
  return {
    namespace: "common",
    key,
    ...(values === undefined ? {} : { values }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
