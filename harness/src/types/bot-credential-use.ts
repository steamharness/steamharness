import { parseBotCredentialSlot } from "./bot-credential";

export const BOT_CREDENTIAL_USE_VERSION = 1;
export const BOT_CREDENTIAL_HOST_USE_VERSION = 1;
export const BOT_CREDENTIAL_HOST_SCOPES_VERSION = 1;
export const ALIBABA_DNS_HOST = "alidns.aliyuncs.com";
export const BOT_CREDENTIAL_DNS_PAGE_SIZE = 20;
export const BOT_CREDENTIAL_DNS_MAX_PAGE = 1000;
export const BOT_CREDENTIAL_USE_MAX_DATA_BYTES = 64 * 1024;

/** Requests contain only aliases, field names, and non-secret target details. */
export type BotCredentialDnsUse = {
  name: string;
  connector: "alibaba-cloud-dns";
  fields: { accessKeyId: string; accessKeySecret: string; securityToken?: string };
  page: number;
} & ({ operation: "list-domains" } | { operation: "list-records"; domain: string });

export type BotCredentialDnsRow = { domain: string } | { name: string; type: string; value: string; ttl: number };
export type BotCredentialQueryData = string | number | boolean | null | BotCredentialQueryData[] | BotCredentialQueryObject;
export type BotCredentialQueryObject = { [key: string]: BotCredentialQueryData };
/** Trusted host declarations describe operations. The request cannot register a new operation. */
export interface BotCredentialUseOperation { id: string; description: string; requiresTool?: string }
export type BotCredentialHostUse = { name?: string; connector: "host"; operation: string; args: BotCredentialQueryObject };
export type BotCredentialUse = BotCredentialDnsUse | BotCredentialHostUse;
export const BOT_CREDENTIAL_USE_FAILURE_REASONS = ["blocked-policy", "storage-unavailable", "invalid-operation", "invalid-credential",
  "target-blocked", "network", "tls", "timeout", "redirect", "http-error", "invalid-response", "response-too-large", "unsafe-response", "command-error"] as const;
export type BotCredentialUseFailure = { status: "declined" | "missing" | "missing-fields" | "denied" | "failed";
  reason?: typeof BOT_CREDENTIAL_USE_FAILURE_REASONS[number]; httpStatus?: number };
export type BotCredentialDnsResult = { status: "ok"; page: number; total: number; rows: BotCredentialDnsRow[] } | BotCredentialUseFailure;
export type BotCredentialHostResult = { status: "ok"; data: BotCredentialQueryData } | BotCredentialUseFailure;
export type BotCredentialUseResult = BotCredentialDnsResult | BotCredentialHostResult;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const only = (value: Record<string, unknown>, ...keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const domainName = (value: unknown): value is string => text(value, 253) && value.split(".").length > 1
  && value.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
const invalid = () => new Error("Invalid Bot credential use. Supply an alias, supported operation, non-secret target, and field names only.");
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
  if (!input) throw invalid();
  if (input.connector === "host") {
    const args = record(input.args);
    if (!only(input, "name", "connector", "operation", "args") || !operationId(input.operation) || !args || !validQueryData(args, 8192)) throw invalid();
    return { ...(input.name !== undefined && { name: parseBotCredentialSlot({ name: input.name, kind: "api-key" }).name }), connector: "host", operation: input.operation, args };
  }
  const fields = record(input.fields);
  if (!only(input, "name", "connector", "operation", "fields", "domain", "page") || input.connector !== "alibaba-cloud-dns"
    || !fields || !only(fields, "accessKeyId", "accessKeySecret", "securityToken")) throw invalid();
  const { accessKeyId, accessKeySecret, securityToken } = fields;
  if (typeof accessKeyId !== "string" || typeof accessKeySecret !== "string" || securityToken !== undefined && typeof securityToken !== "string") throw invalid();
  const { name } = parseBotCredentialSlot({ name: input.name, kind: "structured", fields: [accessKeyId, accessKeySecret, ...(securityToken === undefined ? [] : [securityToken])] });
  const page = input.page === undefined ? 1 : input.page;
  if (!integer(page, 1) || page > BOT_CREDENTIAL_DNS_MAX_PAGE) throw invalid();
  const common = { name, connector: input.connector, fields: { accessKeyId, accessKeySecret, ...(securityToken === undefined ? {} : { securityToken }) }, page } as const;
  if (input.operation === "list-domains" && input.domain === undefined) return { ...common, operation: input.operation };
  if (input.operation === "list-records" && domainName(input.domain)) return { ...common, operation: input.operation, domain: input.domain.toLowerCase() };
  throw invalid();
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
  if (!result) return;
  const { status, page, total, rows } = result;
  if (status === "declined" || status === "missing" || status === "missing-fields" || status === "denied" || status === "failed") {
    if (only(result, "status")) return { status };
    if (use.connector !== "host" || (status !== "failed" && status !== "denied") || !only(result, "status", "reason", "httpStatus")) return;
    const { reason, httpStatus } = result;
    if (reason !== undefined && !BOT_CREDENTIAL_USE_FAILURE_REASONS.some(value => value === reason) ||
      httpStatus !== undefined && (!integer(httpStatus, 100) || httpStatus > 599)) return;
    return { status, ...(reason !== undefined && { reason: reason as BotCredentialUseFailure["reason"] }), ...(httpStatus !== undefined && { httpStatus }) };
  }
  if (status !== "ok") return;
  if (use.connector === "host") return only(result, "status", "data") && validBotCredentialQueryData(result.data) ? { status, data: result.data } : undefined;
  if (!only(result, "status", "page", "total", "rows") || page !== use.page || !integer(total)
    || !Array.isArray(rows) || rows.length > BOT_CREDENTIAL_DNS_PAGE_SIZE || rows.length > total) return;
  const safe: BotCredentialDnsRow[] = [];
  for (const value of rows) {
    const row = record(value);
    if (!row) return;
    if (use.operation === "list-domains") {
      if (!only(row, "domain") || !domainName(row.domain)) return;
      safe.push({ domain: row.domain });
    } else {
      const { name, type, value, ttl } = row;
      if (!only(row, "name", "type", "value", "ttl") || !text(name, 253) || !text(type, 16) || !/^[A-Z][A-Z0-9_]*$/.test(type)
        || !text(value, 4096) || !integer(ttl)) return;
      safe.push({ name, type, value, ttl });
    }
  }
  return { status, page: use.page, total, rows: safe };
}
