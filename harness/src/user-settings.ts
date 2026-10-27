import { AsyncLocalStorage } from "node:async_hooks";
import { AGENT_PERMISSION_POLICIES, type AgentPermissionPolicy } from "./agent/types";

/** User preferences supplied by the execution host, separate from project configuration. */
export interface UserSettings {
  readonly agent: {
    readonly permissionPolicy: AgentPermissionPolicy;
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
  return Object.freeze({ agent: Object.freeze({ permissionPolicy: settings.agent.permissionPolicy }) });
}

/** Run host work in an isolated settings snapshot, including asynchronous descendants. */
export function withUserSettings<T>(settings: UserSettings, run: () => T): T {
  return scope.run(parseUserSettings(settings), run);
}
