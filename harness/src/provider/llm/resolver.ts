import { HarnessError } from "../../workflow/errors";
import type {
  LLMProvider,
  LLMProviderBinding,
  LLMProviderBindingInput,
  LLMProviderRef,
  LLMProviderSource,
} from "./types";
import { createLLMProviderModelKey } from "./types";

interface LLMProviderResolutionContext {
  providers: {
    llm?: LLMProvider;
    llmProviders?: Record<string, LLMProvider>;
    llmProviderBindings?: Record<string, LLMProviderBindingInput>;
    defaultLLMProviderBinding?: LLMProviderBinding;
    defaultLLMProviderId?: string;
  };
}

export function createLLMProviderRef(
  id: string,
  fallback?: LLMProviderSource,
): LLMProviderRef {
  return {
    kind: "llm-provider-ref",
    id,
    fallback,
  };
}

export function resolveLLMProvider(
  source: LLMProviderSource | undefined,
  context: LLMProviderResolutionContext,
  nodeName: string,
): LLMProvider {
  const binding = normalizeBinding(context.providers.llmProviderBindings?.[nodeName]);

  if (binding !== undefined) {
    const providerKey = bindingToProviderKey(binding);
    const provider = context.providers.llmProviders?.[providerKey] ??
      context.providers.llmProviders?.[binding.providerId];

    if (provider !== undefined) {
      return provider;
    }

    throw new HarnessError({
      type: "provider_call",
      message: `LLM provider binding "${binding.providerId}/${binding.modelId}" for node "${nodeName}" was not found.`,
      nodeName,
      metadata: {
        providerId: binding.providerId,
        modelId: binding.modelId,
      },
    });
  }

  const resolved = resolveLLMProviderSource(source, context, nodeName, false);

  if (resolved !== undefined) {
    return resolved;
  }

  const defaultProvider = resolveDefaultLLMProvider(context);

  if (defaultProvider !== undefined) {
    return defaultProvider;
  }

  if (context.providers.llm !== undefined) {
    return context.providers.llm;
  }

  const fallback = resolveLLMProviderRefFallback(source, context, nodeName);

  if (fallback !== undefined) {
    return fallback;
  }

  throw new HarnessError({
    type: "provider_call",
    message: `LLM provider is required for node "${nodeName}" but no provider could be resolved.`,
    nodeName,
  });
}

function resolveLLMProviderSource(
  source: LLMProviderSource | undefined,
  context: LLMProviderResolutionContext,
  nodeName: string,
  allowRefFallback: boolean,
): LLMProvider | undefined {
  if (source === undefined) {
    return undefined;
  }

  if (isLLMProvider(source)) {
    return source;
  }

  if (typeof source === "function") {
    return source(context, nodeName);
  }

  if (typeof source === "string") {
    return resolveLLMProviderId(source, context);
  }

  const provider = resolveLLMProviderId(source.id, context);

  if (provider !== undefined) {
    return provider;
  }

  if (!allowRefFallback) {
    return undefined;
  }

  return resolveLLMProviderSource(source.fallback, context, nodeName, true);
}

function resolveLLMProviderRefFallback(
  source: LLMProviderSource | undefined,
  context: LLMProviderResolutionContext,
  nodeName: string,
): LLMProvider | undefined {
  if (!isLLMProviderRef(source)) {
    return undefined;
  }

  return resolveLLMProviderSource(source.fallback, context, nodeName, true);
}

function resolveLLMProviderId(
  providerId: string,
  context: LLMProviderResolutionContext,
): LLMProvider | undefined {
  const normalized = providerId.trim();

  if (normalized === "" || normalized === "default") {
    return resolveDefaultLLMProvider(context);
  }

  return context.providers.llmProviders?.[normalized];
}

function resolveDefaultLLMProvider(
  context: LLMProviderResolutionContext,
): LLMProvider | undefined {
  const defaultBinding = normalizeBinding(context.providers.defaultLLMProviderBinding);
  if (defaultBinding !== undefined) {
    const providerKey = bindingToProviderKey(defaultBinding);
    return context.providers.llmProviders?.[providerKey] ??
      context.providers.llmProviders?.[defaultBinding.providerId];
  }

  const defaultId = context.providers.defaultLLMProviderId?.trim();

  if (defaultId === undefined || defaultId === "") {
    return undefined;
  }

  return context.providers.llmProviders?.[defaultId];
}

function isLLMProvider(value: unknown): value is LLMProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LLMProvider).chat === "function" &&
    typeof (value as LLMProvider).stream === "function"
  );
}

function isLLMProviderRef(value: unknown): value is LLMProviderRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as LLMProviderRef).kind === "llm-provider-ref"
  );
}

function normalizeBinding(
  value: LLMProviderBindingInput | LLMProviderBinding | undefined,
): LLMProviderBinding | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const providerId = value.trim();
    return providerId === "" ? undefined : { providerId, modelId: "" };
  }

  const providerId = value.providerId.trim();
  const modelId = value.modelId.trim();

  if (providerId === "") {
    return undefined;
  }

  return { providerId, modelId };
}

function bindingToProviderKey(binding: LLMProviderBinding): string {
  if (binding.modelId.trim() === "") {
    return binding.providerId;
  }

  return createLLMProviderModelKey(binding.providerId, binding.modelId);
}
