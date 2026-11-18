import { HarnessError } from "../workflow/errors";
import { getProjectConfiguration } from "../configuration";
import { agentConfiguredModels } from "./model-settings";
import { readAgentSystemCredentials, resolveAgentBridgeBaseUrl, shouldFallbackFromSystemAI, startAgentSystemLLMRuntime } from "./system-llm";
import type { AgentInput, AgentRuntimeOptions } from "./types";

/** Shared by both Bot engines. Resolving a selection does not open a proxy bridge. */
export async function selectConfiguredConversationModel(
  requested: string | undefined,
  source: AgentRuntimeOptions["modelSource"],
  signal?: AbortSignal,
) {
  const { models: configured, fromUser, systemOnly } = agentConfiguredModels(undefined, source);
  if (getProjectConfiguration() === undefined && !fromUser && source === undefined) return undefined;
  if (systemOnly && configured.some(model => model.id === requested && model.source === "third-party")) {
    throw new HarnessError({ type: "input_validation", message: fromUser ? "This project only allows system AI. Select a system AI model in user settings." : "This project only allows system AI. Select a system AI model in Project configurations." });
  }
  const models = configured.filter(model => !systemOnly || model.source === "system");
  const selected = requested === undefined ? models[0] : models.find(model => model.id === requested);
  if (!selected) throw new HarnessError({ type: "input_validation", message: models.length ? "The selected AI model is no longer configured. Select a model again." : fromUser ? "Add a model in user settings before running this project." : "Add a model in Project configurations before running this project." });
  if (selected.source === "third-party") return { source: selected.source, selected } as const;
  const credentials = await readAgentSystemCredentials(signal);
  const credential = credentials.find(credential => credential.id === selected.credentialId);
  if (!credential || !credential.models.includes(selected.model)) throw new HarnessError({ type: "input_validation", message: fromUser ? "This system AI model is unavailable. Check your account and model settings." : "This system AI model is unavailable. Check your subscription in Project configurations." });
  return { source: selected.source, selected, credential } as const;
}

/**
 * Points a run at the host's system AI when there is one.
 *
 * The SteamHarness Server hands out a loopback bridge rather than the upstream key,
 * and that bridge only lives for one run, so it is started here and closed by
 * the caller's `finally`.
 *
 * Two situations deliberately skip it: a caller that supplied its own endpoint,
 * and one that supplied its own model or provider collection. The second is how
 * a test, an embedding host, or a self-hosted setup says "I already decided
 * where this runs" — probing the host there would make offline runs reach the
 * network.
 */
export async function resolveAgentSystemAIInput(
  input: AgentInput,
  options: AgentRuntimeOptions,
  signal: AbortSignal | undefined,
): Promise<{ input: AgentInput; close: () => Promise<void> }> {
  const passthrough = { input, close: async () => undefined };
  const configuration = getProjectConfiguration();
  const systemOnly = configuration?.agentModelPolicy?.allowThirdParty === false;
  const explicitEndpoint =
    input.baseUrl !== undefined ||
    input.apiKey !== undefined ||
    options.baseUrl !== undefined ||
    options.apiKey !== undefined ||
    options.models !== undefined ||
    options.resolvedModel !== undefined;
  if (explicitEndpoint) {
    if (systemOnly) throw new HarnessError({ type: "input_validation", message: "This project only allows system AI. Custom endpoints and model providers are disabled." });
    return passthrough;
  }

  const selection = await selectConfiguredConversationModel(input.model ?? options.model, options.modelSource, signal);
  if (selection) {
    const { selected } = selection;
    if (selection.source === "third-party") {
      const thirdParty = selection.selected;
      return { input: { ...input, provider: `configured-${thirdParty.id}`, model: thirdParty.model,
        baseUrl: thirdParty.apiKind === "anthropic-messages" ? resolveAgentBridgeBaseUrl("anthropic", thirdParty.baseUrl) : thirdParty.baseUrl,
        apiKey: thirdParty.apiKey, apiKind: thirdParty.apiKind }, close: async () => undefined };
    }
    const { credential } = selection;
    const runtime = await startAgentSystemLLMRuntime({ provider: credential.id, model: selected.model, credentials: [credential], signal });
    return { input: { ...input, provider: runtime.providerId, model: runtime.model, baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey, apiKind: runtime.protocol === "anthropic" ? "anthropic-messages" : "openai-responses",
      modelAttributes: { ...runtime.modelAttributes, ...input.modelAttributes,
        ...(runtime.modelAttributes?.webSearch === undefined ? {} : { webSearch: runtime.modelAttributes.webSearch }) } }, close: runtime.close };
  }

  let credentials;
  try {
    credentials = await readAgentSystemCredentials(signal);
  } catch (error) {
    // An unconfigured host (or an older runtime without this capability) keeps
    // the runtime's own provider resolution. A configured service that cannot
    // be reached must stay an explicit error: silently falling through would
    // turn an internal AI outage into an unrelated provider/model failure.
    if (shouldFallbackFromSystemAI(error)) return passthrough;
    throw error;
  }

  if (credentials.length === 0) {
    return passthrough;
  }

  // The host has system AI, so this run belongs on it. A failure from here on
  // is a real one: swallowing it would send the run to the built-in catalogue
  // instead, where a host credential id and model can never resolve and the
  // caller sees a misleading "unknown model" error.
  const runtime = await startAgentSystemLLMRuntime({
    provider: input.provider ?? options.provider,
    model: input.model ?? options.model,
    credentials,
    signal,
  });

  return {
    input: {
      ...input,
      provider: runtime.providerId,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      apiKind: runtime.protocol === "anthropic" ? "anthropic-messages" : "openai-responses",
      // Keep the caller's attribute overrides while taking native search
      // availability from the endpoint that will execute the request.
      ...(runtime.modelAttributes !== undefined
        ? { modelAttributes: { ...runtime.modelAttributes, ...input.modelAttributes,
          // Search availability belongs to the endpoint; per-run webSearch is the opt-out.
          webSearch: runtime.modelAttributes.webSearch } }
        : {}),
    },
    close: () => runtime.close(),
  };
}
