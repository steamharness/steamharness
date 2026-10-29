import { AGENT_MODELS_CONFIGURATION_KEY, parseProjectAgentModels, resolveProjectAgentModels, type ConfigurationValues } from "@steamharness/project-configuration";
import { getUserSettings } from "../user-settings";
import { currentConfigurationValues, getProjectConfiguration } from "../configuration";

/** Keep user preferences separate from published project configuration and its source restrictions. */
export function agentConfiguredModels(values?: ConfigurationValues, source?: "user-settings" | "project") {
  const user = getUserSettings().agent.models;
  const fromUser = source === "user-settings" || source !== "project" && !!user?.length;
  const project = parseProjectAgentModels((values ?? currentConfigurationValues())[AGENT_MODELS_CONFIGURATION_KEY] ?? []);
  const models = resolveProjectAgentModels(project, user ?? [], source !== "project");
  return { models, fromUser, hasProjectModels: project.length > 0, systemOnly: getProjectConfiguration()?.agentModelPolicy?.allowThirdParty === false };
}
