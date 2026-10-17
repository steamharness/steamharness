import type { LLMProvider } from "../provider/llm/types";
import type { ExecutorProviderName } from "./types";

export function createRequiredProviders(
  _env: NodeJS.ProcessEnv,
  requiredProviders: ExecutorProviderName[] = [],
): {
  llm?: LLMProvider;
} {
  void requiredProviders;
  return {};
}
