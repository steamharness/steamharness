import { parseBotCredentialSlot } from "./bot-credential";

export const BOT_CREDENTIAL_USE_VERSION = 1;
export const BOT_CREDENTIAL_HOST_USE_VERSION = 1;
export const BOT_CREDENTIAL_HOST_SCOPES_VERSION = 1;
export const BOT_CREDENTIAL_USE_MAX_DATA_BYTES = 64 * 1024;

export type BotCredentialQueryData = string | number | boolean | null | BotCredentialQueryData[] | BotCredentialQueryObject;
export type BotCredentialQueryObject = { [key: string]: BotCredentialQueryData };
/** Trusted host declarations describe operations. The request cannot register a new operation. */
export interface BotCredentialUseOperation { id: string; description: string; requiresTool?: string }
/** Requests contain only aliases and non-secret arguments. */
export type BotCredentialHostUse = { name?: string; connector: "host"; operation: string; args: BotCredentialQueryObject };
export type BotCredentialUse = BotCredentialHostUse;
export const BOT_CREDENTIAL_USE_FAILURE_REASONS = ["blocked-policy", "storage-unavailable", "invalid-operation", "invalid-credential",
  "target-blocked", "network", "tls", "timeout", "redirect", "http-error", "invalid-response", "response-too-large", "unsafe-response", "command-error", "command-not-found"] as const;
export type BotCredentialUseFailure = { status: "declined" | "missing" | "missing-fields" | "denied" | "failed";
  reason?: typeof BOT_CREDENTIAL_USE_FAILURE_REASONS[number]; httpStatus?: number };
export type BotCredentialHostResult = { status: "ok"; data: BotCredentialQueryData } | BotCredentialUseFailure;
export type BotCredentialUseResult = BotCredentialHostResult;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const only = (value: Record<string, unknown>, ...keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const invalid = () => new Error("Invalid Bot credential use. Supply an advertised host operation and non-secret arguments only.");
const operationId = (id: unknown): id is string => text(id, 96) && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(id);

export function parseBotCredentialUseOperations(value: unknown): BotCredentialUseOperation[] | undefined {
  if (!Array.isArray(value) || value.length > 24) return;
  const ids = new Set<string>(), operations: BotCredentialUseOperation[] = [];
  for (const item of value) {
    const operation = record(item);
    if (!operation || !only(operation, "id", "description", "requiresTool") || !operationId(operation.id) || ids.has(operation.id) || !text(operation.description, 1024)
      || operation.requiresTool !== undefined && (typeof operation.requiresTool !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(operation.requiresTool))) return;
    ids.add(operation.id);
    operations.push({ id: operation.id, description: operation.description, ...(operation.requiresTool !== undefined && { requiresTool: operation.requiresTool }) });
  }
  return operations;
}

export function parseBotCredentialUse(value: unknown): BotCredentialUse {
  const input = record(value);
  const args = record(input?.args);
  if (!input || input.connector !== "host" || !only(input, "name", "connector", "operation", "args") || !operationId(input.operation) || !args || !validQueryData(args, 8192)) throw invalid();
  return { ...(input.name !== undefined && { name: parseBotCredentialSlot({ name: input.name, kind: "api-key" }).name }), connector: "host", operation: input.operation, args };
}

export function validBotCredentialQueryData(value: unknown): value is BotCredentialQueryData {
  return validQueryData(value, BOT_CREDENTIAL_USE_MAX_DATA_BYTES);
}

function validQueryData(value: unknown, maxBytes: number): value is BotCredentialQueryData {
  let remaining = 4096;
  let textBudget = maxBytes;
  const check = (value: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 12) return false;
    if (typeof value === "string") return (textBudget -= value.length) >= 0;
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return true;
    if (Array.isArray(value)) return value.length <= remaining && value.every(item => check(item, depth + 1));
    const item = record(value);
    return !!item && [Object.prototype, null].includes(Object.getPrototypeOf(item)) && Object.entries(item).every(([key, child]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && (textBudget -= key.length) >= 0 && check(child, depth + 1));
  };
  return check(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes;
}

/** Validate receipt data from the private host, never carry raw upstream headers or errors. */
export function parseBotCredentialUseResult(value: unknown, use: BotCredentialUse): BotCredentialUseResult | undefined {
  const result = record(value);
  if (!result || use.connector !== "host") return;
  const { status } = result;
  if (status === "declined" || status === "missing" || status === "missing-fields" || status === "denied" || status === "failed") {
    if (only(result, "status")) return { status };
    if ((status !== "failed" && status !== "denied") || !only(result, "status", "reason", "httpStatus")) return;
    const { reason, httpStatus } = result;
    if (reason !== undefined && !BOT_CREDENTIAL_USE_FAILURE_REASONS.some(value => value === reason) ||
      httpStatus !== undefined && (!integer(httpStatus, 100) || httpStatus > 599)) return;
    return { status, ...(reason !== undefined && { reason: reason as BotCredentialUseFailure["reason"] }), ...(httpStatus !== undefined && { httpStatus }) };
  }
  return status === "ok" && only(result, "status", "data") && validBotCredentialQueryData(result.data) ? { status, data: result.data } : undefined;
}
