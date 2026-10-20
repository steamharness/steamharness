import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getConfig, currentConfigurationValues, type ConfigurationValues } from "../../configuration";
import { AiSdkLLMProvider } from "./ai-sdk";
import type { LLMCallSettings, LLMProvider } from "./types";
import { HarnessError } from "../../workflow/errors";

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
}

export const DEFAULT_LLM_MODELS = {
  "openai-completion": "gpt-4.1-mini",
  "openai-responses": "gpt-4.1-mini",
  anthropic: "claude-3-haiku-20240307",
} satisfies Record<LLMProviderType, string>;

export function createLLMProvider(
  options: CreateLLMProviderOptions,
): LLMProvider {
  const baseOptions = {
    apiKey: options.apiKey,
    baseURL: normalizeOptionalValue(options.baseURL),
    fetch: options.fetch,
  };
  const model = options.model ?? DEFAULT_LLM_MODELS[options.type];

  switch (options.type) {
    case "openai-completion": {
      if (options.webSearch) {
        throw new HarnessError({
          type: "input_validation",
          message: "Web search requires the OpenAI Responses or Anthropic provider.",
        });
      }
      const openai = createOpenAI(baseOptions);

      return new AiSdkLLMProvider({
        name: options.type,
        model: openai.chat(model),
        system: options.system,
        defaults: options.defaults,
      });
    }

    case "openai-responses": {
      const openai = createOpenAI({
        ...baseOptions,
        fetch: createOpenAIResponsesCompatibilityFetch(options.fetch),
      });

      return new AiSdkLLMProvider({
        name: options.type,
        model: openai.responses(model),
        system: options.system,
        defaults: options.defaults,
        tools: options.webSearch
          ? { web_search: openai.tools.webSearch({ searchContextSize: "medium" }) }
          : undefined,
      });
    }

    case "anthropic": {
      const anthropic = createAnthropic(baseOptions);

      return new AiSdkLLMProvider({
        name: options.type,
        model: anthropic.messages(model),
        system: options.system,
        defaults: options.defaults,
        tools: options.webSearch
          ? { web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }) }
          : undefined,
      });
    }
  }
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

function normalizeOptionalValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value.trim();
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

function createOpenAIResponsesCompatibilityFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const contentType = response.headers.get("content-type");

    if (!contentType?.includes("application/json")) {
      return response;
    }

    const body = await response.clone().text();

    try {
      const data = JSON.parse(body) as unknown;
      const normalized = normalizeOpenAIResponsesBody(data);

      if (normalized === data) {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.delete("content-length");

      return new Response(JSON.stringify(normalized), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return response;
    }
  };
}

function normalizeOpenAIResponsesBody(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    return value;
  }

  let changed = false;
  const responseId = typeof value.id === "string" ? value.id : "response";
  const output = value.output.map((item, itemIndex) => {
    if (!isRecord(item) || item.type !== "message") {
      return item;
    }

    let nextItem = item;

    if (typeof nextItem.id !== "string") {
      nextItem = {
        ...nextItem,
        id: `${responseId}-message-${itemIndex}`,
      };
      changed = true;
    }

    if (Array.isArray(nextItem.content)) {
      const content = nextItem.content.map((part) => {
        if (!isRecord(part) || part.type !== "output_text") {
          return part;
        }

        if (Array.isArray(part.annotations)) {
          return part;
        }

        changed = true;

        return {
          ...part,
          annotations: [],
        };
      });

      if (content !== nextItem.content) {
        nextItem = {
          ...nextItem,
          content,
        };
      }
    }

    return nextItem;
  });

  if (!changed) {
    return value;
  }

  return {
    ...value,
    output,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
