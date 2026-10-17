import { WorkflowError } from "../workflow/errors";
import type { AgentInputModality, AgentModelAttributes, AgentModelCost } from "./types";

/**
 * Attributes a caller may declare for a custom-endpoint model.
 *
 * Kept as a whitelist rather than "anything goes": these values decide what the
 * runtime tells the provider about the model, and a typo silently dropped is
 * worse than one rejected, because the run then looks like the model ignored
 * the setting.
 */
const MODEL_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "thinkingLevelMap",
]);

const INPUT_MODALITIES: ReadonlySet<string> = new Set(["text", "image"]);

/** pi's thinking levels; `ultra` is not one — it folds onto `max` upstream. */
const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const MAX_NAME_LENGTH = 200;
const MAX_THINKING_TARGET_LENGTH = 64;
const MAX_CONTEXT_WINDOW = 100_000_000;

/**
 * Reads model attributes from a caller-supplied JSON string or object.
 *
 * The string form is what a project param carries; the object form is what a
 * programmatic caller passes. Both go through the same validation so a project
 * and an embedding host cannot disagree about what a valid record is.
 */
export function parseAgentModelAttributes(value: unknown): AgentModelAttributes {
  const record = typeof value === "string" ? parseJsonObject(value) : readObject(value);
  const attributes: AgentModelAttributes = {};

  for (const key of Object.keys(record)) {
    if (!MODEL_ATTRIBUTE_KEYS.has(key)) {
      throw invalid(`未知的模型属性字段 "${key}"。`);
    }
  }

  if ("name" in record) {
    attributes.name = readName(record.name);
  }
  if ("reasoning" in record) {
    attributes.reasoning = readBoolean(record.reasoning, "reasoning");
  }
  if ("input" in record) {
    attributes.input = readInputModalities(record.input);
  }
  if ("cost" in record) {
    attributes.cost = readCost(record.cost);
  }
  if ("contextWindow" in record) {
    attributes.contextWindow = readPositiveInteger(record.contextWindow, "contextWindow");
  }
  if ("maxTokens" in record) {
    attributes.maxTokens = readPositiveInteger(record.maxTokens, "maxTokens");
  }
  if ("thinkingLevelMap" in record) {
    attributes.thinkingLevelMap = readThinkingLevelMap(record.thinkingLevelMap);
  }

  return attributes;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const text = value.trim();
  if (text === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid("模型属性不是合法的 JSON。", error);
  }

  return readObject(parsed);
}

function readObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("模型属性必须是一个 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function readName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_NAME_LENGTH) {
    throw invalid("模型属性 name 必须是不超过 200 个字符的非空字符串。");
  }
  return value;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`模型属性 ${field} 必须是布尔值。`);
  }
  return value;
}

function readInputModalities(value: unknown): AgentInputModality[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('模型属性 input 必须是非空数组，取值只能是 "text" 或 "image"。');
  }
  const modalities = value.filter(
    (entry): entry is AgentInputModality => typeof entry === "string" && INPUT_MODALITIES.has(entry),
  );
  if (modalities.length !== value.length) {
    throw invalid('模型属性 input 只能包含 "text" 或 "image"。');
  }
  return [...new Set(modalities)];
}

function readCost(value: unknown): AgentModelCost {
  const record = readObject(value);
  const fields: ReadonlyArray<readonly [keyof AgentModelCost, unknown]> = [
    ["input", record.input],
    ["output", record.output],
    ["cacheRead", record.cacheRead],
    ["cacheWrite", record.cacheWrite],
  ];
  const cost = {} as AgentModelCost;
  for (const [key, field] of fields) {
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
      throw invalid(`模型属性 cost.${key} 必须是非负数字。`);
    }
    cost[key] = field;
  }
  return cost;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_CONTEXT_WINDOW) {
    throw invalid(`模型属性 ${field} 必须是正整数（不超过 ${MAX_CONTEXT_WINDOW}）。`);
  }
  return value;
}

function readThinkingLevelMap(value: unknown): AgentModelAttributes["thinkingLevelMap"] {
  const record = readObject(value);
  const map: Record<string, string | null> = {};
  for (const [level, target] of Object.entries(record)) {
    if (!THINKING_LEVELS.has(level)) {
      throw invalid(`模型属性 thinkingLevelMap 含有未知档位 "${level}"。`);
    }
    if (target === null) {
      map[level] = null;
      continue;
    }
    if (typeof target !== "string" || target === "" || target.length > MAX_THINKING_TARGET_LENGTH) {
      throw invalid(`模型属性 thinkingLevelMap.${level} 必须是不超过 64 个字符的字符串或 null。`);
    }
    map[level] = target;
  }
  return map;
}

function invalid(message: string, cause?: unknown): WorkflowError {
  return new WorkflowError({
    type: "input_validation",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}
