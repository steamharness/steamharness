import type { ParamResolveResult } from "../executor/types";
import {
  getServerLLMCredentials,
  type ServerLLMCredential,
  type ServerLLMModelDetails,
} from "../provider/llm/server";
import { HarnessError } from "../workflow/errors";
import type { AgentInputModality, AgentModelAttributes } from "./types";
import { type ConfigurationValues } from "@steamharness/project-configuration";
import { agentConfiguredModels } from "./model-settings";

/**
 * How the agent reaches the host's system AI.
 *
 * The credential service never hands out the upstream key. It hands out a
 * loopback bridge that forwards to the Server, and the bridge speaks exactly
 * one protocol — `anthropic` or `openai-responses` — so the agent has to be
 * told which one rather than guessing from the provider id.
 */
export type AgentSystemLLMProtocol = "anthropic" | "openai-responses";

export const DEFAULT_AGENT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_AGENT_OPENAI_MODEL = "gpt-5.6-terra";

const SYSTEM_AI_UNSUPPORTED_MESSAGE =
  "当前 SteamHarness 运行时版本不支持系统 AI 配置，请更新 Desktop 后重试。";

/**
 * A host without a configured private AI service may still run an agent with
 * its own provider. Once a service was configured, however, connection and
 * authentication failures must reach the caller instead of silently changing
 * the provider selected for that run.
 */
export function shouldFallbackFromSystemAI(error: unknown): boolean {
  if (error instanceof Error && error.message === SYSTEM_AI_UNSUPPORTED_MESSAGE) {
    return true;
  }
  return error instanceof HarnessError && error.metadata?.systemAiConfigured === false;
}

export interface AgentSystemLLMRuntime {
  protocol: AgentSystemLLMProtocol;
  baseUrl: string;
  apiKey: string;
  providerId: string;
  model: string;
  credentialId: string;
  credentialName: string;
  /**
   * What the Server's model catalogue knows about `model`.
   *
   * Absent when the Server predates the catalogue, or knows nothing beyond a
   * display name — in which case the runtime keeps its own defaults, exactly
   * as it did before the catalogue existed.
   */
  modelAttributes?: AgentModelAttributes;
  close(): Promise<void>;
}

export interface AgentSystemLLMSelection {
  credential: ServerLLMCredential;
  protocol: AgentSystemLLMProtocol;
  model: string;
}

/**
 * Credentials the agent can actually run on.
 *
 * A credential whose provider speaks something the bridge cannot forward is
 * dropped rather than surfaced and then failing at request time.
 */
export async function readAgentSystemCredentials(
  signal?: AbortSignal,
): Promise<ServerLLMCredential[]> {
  if (typeof getServerLLMCredentials !== "function") {
    throw new Error(SYSTEM_AI_UNSUPPORTED_MESSAGE);
  }

  const credentials = await getServerLLMCredentials({ signal });
  return credentials.filter((credential) => (
    readAgentSystemProtocol(credential.providerType) !== undefined &&
    listAgentSystemModels(credential).length > 0
  ));
}

export function readAgentSystemProtocol(value: unknown): AgentSystemLLMProtocol | undefined {
  if (value === "anthropic") return "anthropic";
  if (value === "openai-responses") return "openai-responses";
  return undefined;
}

export function listAgentSystemModels(credential: ServerLLMCredential): string[] {
  return [...new Set(credential.models)];
}

/**
 * Picks the credential and model a run should use.
 *
 * Mirrors the Conversation project's rule: an explicit request wins, then the
 * credential's configured default (the Server has already merged the admin
 * system default with the user's personal default), then a known-good model
 * from the credential's own list.
 */
export function selectAgentSystemLLM(
  credentials: readonly ServerLLMCredential[],
  requested: { provider?: string; model?: string },
): AgentSystemLLMSelection {
  if (credentials.length === 0) {
    throw new HarnessError({
      type: "input_validation",
      message: "当前账户没有可供智能体使用的系统 AI 配置。",
    });
  }

  const credential = credentials.find((item) => item.id === requested.provider) ?? credentials[0];
  if (credential === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: "当前账户没有可供智能体使用的系统 AI 配置。",
    });
  }

  const protocol = readAgentSystemProtocol(credential.providerType);
  if (protocol === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `AI 配置 "${credential.name}" 不支持智能体。`,
    });
  }

  const models = listAgentSystemModels(credential);
  const lookup = new Map(models.map((model) => [model.toLowerCase(), model]));
  const model = (requested.model === undefined ? undefined : lookup.get(requested.model.toLowerCase())) ??
    (credential.defaultModelId === null
      ? undefined
      : lookup.get(credential.defaultModelId.toLowerCase())) ??
    readPreferredModel(protocol, models);

  if (model === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `AI 配置 "${credential.name}" 没有可用模型。`,
    });
  }

  return { credential, protocol, model };
}

function readPreferredModel(
  protocol: AgentSystemLLMProtocol,
  models: readonly string[],
): string | undefined {
  const preferred = protocol === "anthropic"
    ? DEFAULT_AGENT_ANTHROPIC_MODEL
    : DEFAULT_AGENT_OPENAI_MODEL;
  return models.includes(preferred) ? preferred : models[0];
}

/**
 * Starts the loopback bridge for one run.
 *
 * The bridge binds a fresh port and path per start, so the caller must use the
 * returned `baseUrl` for this run only and `close()` it afterwards.
 */
export async function startAgentSystemLLMRuntime(options: {
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  /** Credentials to use instead of reading the host's catalogue. */
  credentials?: readonly ServerLLMCredential[];
}): Promise<AgentSystemLLMRuntime> {
  const credentials = options.credentials ?? await readAgentSystemCredentials(options.signal);
  const selection = selectAgentSystemLLM(credentials, {
    provider: options.provider,
    model: options.model,
  });

  if (typeof selection.credential.startLLMProxyBridge !== "function") {
    throw new Error(SYSTEM_AI_UNSUPPORTED_MESSAGE);
  }

  const bridge = await selection.credential.startLLMProxyBridge({ signal: options.signal });

  const details = selection.credential.modelDetails.find((entry) => entry.id === selection.model);
  const modelAttributes = toAgentModelAttributes(details);

  return Object.freeze({
    protocol: selection.protocol,
    baseUrl: resolveAgentBridgeBaseUrl(selection.protocol, bridge.baseUrl),
    apiKey: bridge.apiKey,
    providerId: `workflow-system-${selection.credential.id}`,
    model: selection.model,
    credentialId: selection.credential.id,
    credentialName: selection.credential.name,
    ...(modelAttributes === undefined ? {} : { modelAttributes }),
    close: () => bridge.close(),
  });
}

/**
 * The Server's catalogue record as agent model attributes.
 *
 * Only fields the Server actually carries are copied. Search availability is
 * authoritative even when false; unknown models must not enable a native
 * search tool that the endpoint did not advertise.
 *
 * `capabilities.reasoning` deliberately does not become `attributes.reasoning`:
 * it is the display summary the Server keeps for the model picker, where an
 * unrecognized model reads as "no reasoning". The attribute field is the
 * catalogue's own answer and arrives separately, precisely so an unknown model
 * keeps pi's default instead of losing its effort options.
 */
export function toAgentModelAttributes(
  details: ServerLLMModelDetails | undefined,
): AgentModelAttributes | undefined {
  if (details === undefined) return undefined;

  const attributes: AgentModelAttributes = {};
  attributes.webSearch = details.capabilities.webSearch;
  if (details.reasoning !== undefined) attributes.reasoning = details.reasoning;
  const input = details.input?.filter(isAgentInputModality);
  if (input !== undefined && input.length > 0) attributes.input = input;
  if (details.contextWindow !== undefined) attributes.contextWindow = details.contextWindow;
  if (details.maxTokens !== undefined) attributes.maxTokens = details.maxTokens;
  if (details.cost !== undefined) attributes.cost = { ...details.cost };
  if (details.thinkingLevelMap !== undefined) {
    attributes.thinkingLevelMap = { ...details.thinkingLevelMap } as AgentModelAttributes["thinkingLevelMap"];
  }

  return Object.keys(attributes).length === 0 ? undefined : attributes;
}

function isAgentInputModality(value: string): value is AgentInputModality {
  return value === "text" || value === "image";
}

/**
 * The bridge hands out `http://127.0.0.1:<port>/<token>/v1`, which is the shape
 * the Vercel AI SDK wants: `@ai-sdk/anthropic` and `@ai-sdk/openai` both treat
 * `baseURL` as ending at `/v1` and append `/messages` or `/responses`.
 *
 * The agent SDK does not agree. `@anthropic-ai/sdk` takes the **API root** and
 * appends `/v1/messages` itself, so passing the bridge URL through unchanged
 * requests `/<token>/v1/v1/messages`, which 404s and leaves the run with no
 * output at all. Its OpenAI client already matches the `/v1` shape, so only the
 * Anthropic side needs trimming.
 */
export function resolveAgentBridgeBaseUrl(protocol: AgentSystemLLMProtocol, baseUrl: string): string {
  if (protocol !== "anthropic") {
    return baseUrl;
  }

  return baseUrl.replace(/\/v1\/?$/u, "");
}

/**
 * The `resolveParams` implementation for an agent project.
 *
 * Model choices come from user settings or the project's configuration snapshot. Loading
 * the composer never fetches credentials or the account's subscription catalogue.
 */
export function createAgentProjectParamResolver(options: { modelSource?: "user-settings" | "project" } = {}): (
  context: { paramValues?: Record<string, unknown>; config?: ConfigurationValues; abortSignal?: AbortSignal },
) => Promise<ParamResolveResult> {
  return async (context) => {
    const configured = agentConfiguredModels(context.config, options.modelSource);
    const models = configured.models.filter(model => !configured.systemOnly || model.source !== "third-party");
    const selected = models.find(model => model.id === context.paramValues?.model) ?? models[0];
    const unavailable = models.filter(model => model.source === "unavailable");
    return { params: {
      // Kept as a hidden wire parameter for existing inline Agent declarations.
      provider: { value: null, visible: false, disabled: true, resolvedOptions: [] },
      model: {
        value: configured.fromUser && (!context.paramValues?.model || context.paramValues.model === selected?.id) ? undefined : selected?.id ?? null,
        disabled: false,
        resolvedOptions: models.map(model => ({ value: model.id, label: model.name, description: model.source === "unavailable" ? "Referenced model unavailable in user settings." : model.model,
          ...(configured.hasProjectModels ? { group: model.origin === "project" ? "Project models" : "Settings models" } : {}) })),
        ...(unavailable.length ? { options: Object.fromEntries(unavailable.map(model => [model.id, { disabled: true }])) } : {}),
      },
    } };
  };
}

/**
 * Reads whether a model can accept images, so the agent can refuse an image
 * turn before the provider does.
 */
export function readAgentSystemModelCapabilities(
  credentials: readonly ServerLLMCredential[],
  model: string,
) {
  for (const credential of credentials) {
    const details = credential.modelDetails.find((entry) => entry.id === model);
    if (details !== undefined) {
      return details.capabilities;
    }
  }

  return undefined;
}
