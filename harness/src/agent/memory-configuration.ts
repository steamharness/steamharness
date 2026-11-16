import type { ProjectConfigurationField } from "@steamharness/project-configuration";

export const BOT_MEMORY_CONFIGURATION_KEY = "STEAMHARNESS_BOT_MEMORY_ENABLED";

export interface BotMemoryOptions {
  /** Default for the project's memory switch. Saved project configuration takes precedence. */
  enabled?: boolean;
}

export function botMemoryDefault(options?: BotMemoryOptions): boolean {
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => key !== "enabled") || options.enabled !== undefined && typeof options.enabled !== "boolean")) {
    throw new Error("Bot memory must be an object with an optional boolean enabled field.");
  }
  return options?.enabled ?? true;
}

export function botMemoryConfigurationField(enabled = true): ProjectConfigurationField {
  return { name: BOT_MEMORY_CONFIGURATION_KEY, type: "boolean", label: "Bot memory",
    description: "Share categorized memories across conversations in this Bot. Turning memory off preserves saved entries. Changes apply on the next execution.",
    defaultValue: enabled, sharing: { publish: true, includeValue: true, editable: true } };
}
