import { getProjectConfiguration } from "./configuration";
import { AsyncLocalStorage } from "node:async_hooks";
import { AGENT_PERMISSION_POLICIES, type AgentPermissionPolicy } from "./agent/types";
import { AGENT_MODELS_CONFIGURATION_KEY, parseAgentModels, type ConfiguredAgentModel } from "@steamharness/project-configuration";

/** A user model reference or third-party connection accepted by the execution host. */
export type UserAgentModel = ConfiguredAgentModel;

/** User preferences supplied by the execution host, separate from project configuration. */
export interface UserSettings {
  readonly agent: {
    readonly permissionPolicy: AgentPermissionPolicy;
    /** Ordered host models; [] means settings are supported but empty. Omit to use project models. */
    readonly models?: readonly Readonly<UserAgentModel>[];
  };
}

const defaults: UserSettings = Object.freeze({ agent: Object.freeze({ permissionPolicy: "auto" as const }) });
const scope = new AsyncLocalStorage<UserSettings>();

/** The current execution's immutable user settings. Without a host, defaults to auto approve. */
export function getUserSettings(): UserSettings {
  return scope.getStore() ?? defaults;
}

/** Validate host input and copy only supported settings; never retain a caller's mutable object. */
export function parseUserSettings(value: unknown): UserSettings {
  const settings = value as Partial<UserSettings> | null;
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
    !settings.agent || typeof settings.agent !== "object" || Array.isArray(settings.agent) ||
    !AGENT_PERMISSION_POLICIES.some(policy => policy === settings.agent?.permissionPolicy)) {
    throw new TypeError("Invalid user settings: agent.permissionPolicy must be read-only, workspace, or auto.");
  }
  const models = settings.agent.models === undefined ? undefined
    : Object.freeze(parseUserModels(settings.agent.models).map(model => Object.freeze(model)));
  return Object.freeze({ agent: Object.freeze({ permissionPolicy: settings.agent.permissionPolicy,
    ...(models === undefined ? {} : { models }) }) });
}

/** The account catalogue is not subject to the saved custom-model limit. */
function parseUserModels(value: unknown): UserAgentModel[] {
  if (!Array.isArray(value)) return parseAgentModels(value);
  const ids = new Set<string>();
  let customCount = 0;
  return value.map(entry => {
    const model = parseAgentModels([entry])[0]!;
    if (ids.has(model.id)) throw new TypeError("User model IDs must be unique.");
    ids.add(model.id);
    if (model.source === "third-party" && ++customCount > 100) {
      throw new TypeError("User settings accept at most 100 custom models.");
    }
    return model;
  });
}

/** Scalar defaults for user-bound project parameters; credentials never enter parameter metadata. */
export function userSettingParamDefault(key: "agent.permissionPolicy" | "agent.model"): string {
  const { agent } = getUserSettings();
  if (key === "agent.permissionPolicy") return agent.permissionPolicy;
  const configuration = getProjectConfiguration();
  const models = agent.models ?? parseAgentModels(configuration?.values[AGENT_MODELS_CONFIGURATION_KEY] ?? []);
  return models.find(model => configuration?.agentModelPolicy?.allowThirdParty !== false || model.source === "system")?.id ?? "";
}

/** Run host work in an isolated settings snapshot, including asynchronous descendants. */
export function withUserSettings<T>(settings: UserSettings, run: () => T): T {
  return scope.run(parseUserSettings(settings), run);
}
