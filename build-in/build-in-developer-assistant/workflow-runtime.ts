import type { RuntimeApi } from "steamharness/runtime-api";
import type { OpenAIConversationHostInput } from "./interface";

type OpenAIProjectRuntimeApi = RuntimeApi & {
  readOpenAIConversationHostInput(
    context: unknown,
  ): OpenAIConversationHostInput | undefined;
};

// Hosts inject globalThis.steamharness before loading a project. The proxy keeps
// tests that replace the injected runtime after module evaluation observable.
export const steamharness = new Proxy({} as OpenAIProjectRuntimeApi, {
  get(_target, property) {
    const value = (globalThis.steamharness as OpenAIProjectRuntimeApi | undefined)
      ?.[property as keyof OpenAIProjectRuntimeApi];
    if (property === "readOpenAIConversationHostInput" && typeof value !== "function") {
      return () => undefined;
    }
    return value;
  },
});
