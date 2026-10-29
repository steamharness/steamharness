import { AGENT_MODELS_CONFIGURATION_KEY, parseAgentModels, type ConfigurationValues } from "@steamharness/project-configuration";
import { getUserSettings } from "../user-settings";
import { currentConfigurationValues, getProjectConfiguration } from "../configuration";

/** Keep user preferences separate from published project configuration and its source restrictions. */
export function agentConfiguredModels(values?: ConfigurationValues, source?: "user-settings" | "project") {
  const user = getUserSettings().agent.models;
  // An empty host catalogue still supports settings. Standalone CLI hosts omit it.
  const fromUser = source !== "project" && user !== undefined;
  const models = fromUser ? [...(user ?? [])] : parseAgentModels((values ?? currentConfigurationValues())[AGENT_MODELS_CONFIGURATION_KEY] ?? []);
  return { models, fromUser, systemOnly: getProjectConfiguration()?.agentModelPolicy?.allowThirdParty === false };
}
