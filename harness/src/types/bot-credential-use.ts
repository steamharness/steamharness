import { parseBotCredentialSlot } from "./bot-credential";

export const BOT_CREDENTIAL_USE_VERSION = 1;
export const ALIBABA_DNS_HOST = "alidns.aliyuncs.com";
export const BOT_CREDENTIAL_DNS_PAGE_SIZE = 20;
export const BOT_CREDENTIAL_DNS_MAX_PAGE = 1000;

/** Alias and field names only. The native connector owns the endpoint and request. */
export type BotCredentialUse = {
  name: string;
  connector: "alibaba-cloud-dns";
  fields: { accessKeyId: string; accessKeySecret: string; securityToken?: string };
  page: number;
} & ({ operation: "list-domains" } | { operation: "list-records"; domain: string });

export type BotCredentialDnsRow = { domain: string } | { name: string; type: string; value: string; ttl: number };
export type BotCredentialUseResult = { status: "ok"; page: number; total: number; rows: BotCredentialDnsRow[] }
  | { status: "declined" | "missing" | "missing-fields" | "denied" | "failed" };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const only = (value: Record<string, unknown>, ...keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const domainName = (value: unknown): value is string => text(value, 253) && value.split(".").length > 1
  && value.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));

export function parseBotCredentialUse(value: unknown): BotCredentialUse {
  const input = record(value), fields = record(input?.fields);
  const invalid = () => new Error("Invalid Bot credential use. Supply an alias, supported operation and field names only.");
  if (!input || !only(input, "name", "connector", "operation", "fields", "domain", "page") || input.connector !== "alibaba-cloud-dns"
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

/** Validate receipt data from the private host, never carry raw upstream headers or errors. */
export function parseBotCredentialUseResult(value: unknown, use: BotCredentialUse): BotCredentialUseResult | undefined {
  const result = record(value);
  if (!result) return;
  const { status, page, total, rows } = result;
  if (status === "declined" || status === "missing" || status === "missing-fields" || status === "denied" || status === "failed") {
    return only(result, "status") ? { status } : undefined;
  }
  if (status !== "ok" || !only(result, "status", "page", "total", "rows") || page !== use.page || !integer(total)
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
