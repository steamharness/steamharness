import type { AgentEffort } from "./types";
import { AGENT_EFFORT_LEVELS, DEFAULT_AGENT_EFFORT } from "./types";

/**
 * The reasoning level handed to pi. Kept as a local union (rather than an
 * import from the SDK) so this module stays free of pi values — the package
 * loads the SDK on demand and only its types are used at compile time.
 */
export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * `ultra` is not a pi level. OpenCode exposes it as an extension of the same
 * scale, so it folds onto `max` rather than being rejected — a project that
 * accepts both spellings can pass either through unchanged.
 */
export function toThinkingLevel(effort: AgentEffort): AgentThinkingLevel {
  return effort === "ultra" ? "max" : effort;
}

export function parseAgentEffort(value: unknown): AgentEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "ultra") {
    return "ultra";
  }

  return AGENT_EFFORT_LEVELS.find((level) => level === normalized);
}

export function resolveAgentEffort(
  value: unknown,
  fallback: AgentEffort = DEFAULT_AGENT_EFFORT,
): AgentEffort {
  return parseAgentEffort(value) ?? fallback;
}

export function formatAgentEffortLabel(value: string): string {
  switch (value) {
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
    case "ultra":
      return "Max";
    default:
      return value;
  }
}

export const AGENT_EFFORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  AGENT_EFFORT_LEVELS.map((level) => ({ value: level, label: formatAgentEffortLabel(level) }));
