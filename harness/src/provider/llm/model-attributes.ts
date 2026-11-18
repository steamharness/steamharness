import type { AgentModelAttributes } from "../../agent/types";
import type { ServerLLMModelDetails } from "./server";

export function toAgentModelAttributes(details: ServerLLMModelDetails | undefined): AgentModelAttributes | undefined {
  if (!details) return undefined;
  const { reasoning, input, contextWindow, maxTokens, cost, thinkingLevelMap } = details;
  const modalities = input?.filter(value => value === "text" || value === "image");
  return {
    webSearch: details.capabilities.webSearch,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(modalities?.length ? { input: modalities } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(cost === undefined ? {} : { cost: { ...cost } }),
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...thinkingLevelMap } as AgentModelAttributes["thinkingLevelMap"] }),
  };
}
