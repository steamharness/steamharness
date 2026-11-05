import { defineBot } from "../agent/bot";
import type { AgentProjectOptions } from "../agent/types";

/** Adapt agent engine test options to the public Bot declaration. */
export function createEmbeddedBotExecutor(options: AgentProjectOptions = {}) {
  const { executorName, projectName, outputItemId, collapseIntermediate, params, toolDefinitions, ...agent } = options;
  return defineBot({ name: executorName ?? "agent", agent: { ...agent, ...{ retryDelayMs: 0 }, ...(params?.length === 0 ? { paramOptions: { fields: { provider: false, model: false, effort: false, plan: false, permissionPolicy: false } } } : {}) }, tools: toolDefinitions,
    conversation: { ...(collapseIntermediate === undefined ? {} : { collapseIntermediate }) } });
}
