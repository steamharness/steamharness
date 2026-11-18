import { getConfig, currentConfigurationValues, type ConfigurationValues } from "../../configuration";
import { PiAiLLMProvider } from "./pi-ai";
import type { LLMCallSettings, LLMProvider } from "./types";
import { HarnessError } from "../../workflow/errors";
import type { AgentModelAttributes } from "../../agent/types";

export const LLM_PROVIDER_TYPES = [
  "openai-completion",
  "openai-responses",
  "anthropic",
] as const;

export type LLMProviderType = (typeof LLM_PROVIDER_TYPES)[number];

export interface CreateLLMProviderOptions {
  type: LLMProviderType;
  apiKey: string;
  baseURL?: string;
  model?: string;
  system?: string;
  defaults?: LLMCallSettings;
  fetch?: typeof fetch;
  webSearch?: boolean;
  modelAttributes?: AgentModelAttributes;
}

export const DEFAULT_LLM_MODELS = {
  "openai-completion": "gpt-4.1-mini",
  "openai-responses": "gpt-4.1-mini",
  anthropic: "claude-3-haiku-20240307",
} satisfies Record<LLMProviderType, string>;

export function createLLMProvider(
  options: CreateLLMProviderOptions,
): LLMProvider {
  if (options.type === "openai-completion" && options.webSearch) {
    throw new HarnessError({ type: "input_validation", message: "Web search requires the OpenAI Responses or Anthropic provider." });
  }
  return new PiAiLLMProvider({ ...options, model: options.model ?? DEFAULT_LLM_MODELS[options.type] });
}

export function createLLMProviderFromConfig(
  config: ConfigurationValues = currentConfigurationValues(),
): LLMProvider {
  const env = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value === "string" ? value : undefined]));
  const type = parseLLMProviderType(readRequiredProviderConfig(env, "LLM_TYPE", ["TYPE"]));

  return createLLMProvider({
    type,
    apiKey: readRequiredProviderConfig(env, "LLM_API_KEY", ["API_KEY", "APIKEY"]),
    baseURL: readOptionalProviderConfig(env, "LLM_BASE_URL", ["BASE_URL"]),
    model: readOptionalProviderConfig(env, "LLM_MODEL", ["MODEL"]),
    defaults: {
      maxRetries: 1,
    },
  });
}

export function createLLMProviderFromProjectConfig(): LLMProvider {
  const type = parseLLMProviderType(readRequiredProjectConfig("LLM_TYPE", ["TYPE"]));

  return createLLMProvider({
    type,
    apiKey: readRequiredProjectConfig("LLM_API_KEY", ["API_KEY", "APIKEY"]),
    baseURL: readOptionalProjectConfig("LLM_BASE_URL", ["BASE_URL"]),
    model: readOptionalProjectConfig("LLM_MODEL", ["MODEL"]),
    defaults: {
      maxRetries: 1,
    },
  });
}

export function parseLLMProviderType(value: string): LLMProviderType {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");

  switch (normalized) {
    case "openai-completion":
    case "openai-chat":
    case "openai completion":
    case "openai chat":
    case "chat":
    case "completion":
      return "openai-completion";

    case "openai-responses":
    case "openai-response":
    case "openai responses":
    case "openai response":
    case "responses":
    case "response":
      return "openai-responses";

    case "anthropic":
    case "claude":
      return "anthropic";

    default:
      throw new HarnessError({
        type: "input_validation",
        message: `Unsupported LLM provider type "${value}". Expected one of: ${LLM_PROVIDER_TYPES.join(", ")}.`,
        metadata: {
          providerType: value,
        },
      });
  }
}

function readRequiredProviderConfig(
  env: NodeJS.ProcessEnv,
  name: string,
  aliases: string[] = [],
): string {
  const value = readOptionalProviderConfig(env, name, aliases);

  if (value === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Missing required configuration: ${name}.`,
      metadata: {
        configuration: name,
        aliases,
      },
    });
  }

  return value;
}

function readOptionalProviderConfig(
  env: NodeJS.ProcessEnv,
  name: string,
  aliases: string[] = [],
): string | undefined {
  for (const key of [name, ...aliases]) {
    const value = env[key];

    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }

  return undefined;
}

function readRequiredProjectConfig(name: string, aliases: string[] = []): string {
  const value = readOptionalProjectConfig(name, aliases);

  if (value === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Missing required configuration: ${name}.`,
      metadata: {
        configuration: name,
        aliases,
      },
    });
  }

  return value;
}

function readOptionalProjectConfig(name: string, aliases: string[] = []): string | undefined {
  for (const key of [name, ...aliases]) {
    const value = typeof getConfig(key) === "string" ? getConfig(key) as string : undefined;

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}
