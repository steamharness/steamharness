export interface BotMemoryAddress { category: string; key: string }
type BotMemorySelector = (BotMemoryAddress & { id?: never }) | { id: string; category?: never; key?: never };
type BotMemoryScalar = string | number | boolean | null;
type BotMemoryValue = BotMemoryScalar | BotMemoryProperties | BotMemoryValue[];
export interface BotMemoryProperties { [name: string]: BotMemoryValue }
type BotMemoryFilters = { category?: string; where?: Record<string, BotMemoryScalar>; limit?: number; offset?: number };

export interface BotMemorySummary extends BotMemoryAddress {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  title?: string;
  summary?: string;
}
export interface BotMemoryEntry extends BotMemorySummary { content: string; properties: BotMemoryProperties }
export type BotMemoryRequest =
  | ({ action: "save"; content?: string; title?: string; summary?: string; properties?: BotMemoryProperties } & BotMemoryAddress)
  | ({ action: "get"; id?: string; key?: string; query?: string; relations?: "outgoing" | "incoming" } & BotMemoryFilters)
  | ({ action: "search"; keywords: string[]; match?: "any" | "all" } & BotMemoryFilters)
  | ({ action: "update"; content?: string | null; title?: string | null; summary?: string | null;
       properties?: BotMemoryProperties; removeProperties?: string[]; expectedRevision: number } & BotMemorySelector)
  | ({ action: "delete"; expectedRevision: number } & BotMemorySelector)
  | { action: "link" | "unlink"; sourceId: string; targetId: string; relation: string; expectedRevision: number };

export class BotMemoryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BotMemoryError"; }
}
export const fail = (code: string, message: string): never => { throw new BotMemoryError(code, message); };
const invalid = (message: string): never => fail("BOT_MEMORY_INVALID_INPUT", message);
export const BOT_MEMORY_LIMITS = { title: 160, summary: 320, content: 8_000, properties: 4_000, propertyName: 80, relation: 64 } as const;

function isObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function propertyName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > BOT_MEMORY_LIMITS.propertyName || value.includes("\0")) {
    return invalid(`Memory property names must contain 1-${BOT_MEMORY_LIMITS.propertyName} characters without NUL.`);
  }
  return value;
}

function isScalar(value: unknown): value is BotMemoryScalar {
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= BOT_MEMORY_LIMITS.properties && !value.includes("\0"));
}

export function validateBotMemoryProperties(value: unknown): BotMemoryProperties {
  if (!isObject(value)) return invalid("Memory properties must be a JSON object.");
  let remaining = 256;
  const normalize = (item: unknown, depth: number): BotMemoryValue => {
    if (--remaining < 0 || depth > 6) return invalid("Memory properties have too many values or are nested too deeply.");
    if (isScalar(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > remaining) return invalid("Memory properties have too many values.");
      return Array.from(item, child => normalize(child, depth + 1));
    }
    if (isObject(item)) {
      const keys = Object.keys(item).sort();
      if (keys.length > remaining) return invalid("Memory properties have too many values.");
      return Object.fromEntries(keys.map(key => [propertyName(key), normalize(item[key], depth + 1)]));
    }
    return invalid("Memory properties must contain JSON values.");
  };
  const normalized = normalize(value, 0) as BotMemoryProperties;
  if (JSON.stringify(normalized).length > BOT_MEMORY_LIMITS.properties) {
    return invalid(`Memory properties must fit in ${BOT_MEMORY_LIMITS.properties} serialized characters.`);
  }
  return normalized;
}

function propertyFilters(value: unknown): Record<string, BotMemoryScalar> {
  if (!isObject(value) || Object.keys(value).length < 1 || Object.keys(value).length > 8) {
    return invalid("Memory where must contain 1-8 property names and their exact scalar values.");
  }
  const filters = validateBotMemoryProperties(value);
  if (!Object.values(filters).every(isScalar)) return invalid("Memory where values must be strings, numbers, booleans or null.");
  return filters as Record<string, BotMemoryScalar>;
}

export function validateBotMemoryRequest(input: unknown): BotMemoryRequest {
  if (!isObject(input)) return invalid("Memory arguments must be an object.");
  const value = input;
  const text = (name: string, limit: number) => {
    const item = value[name];
    if (typeof item !== "string" || !item.trim() || item.length > limit || item.includes("\0")) return invalid(`Memory ${name} must contain 1-${limit} characters without NUL.`);
    return item.trim();
  };
  const stableId = (name: string) => {
    const item = value[name];
    if (typeof item !== "string" || !/^[0-9a-f]{32}$/.test(item)) return invalid(`Use a memory ID returned by the memory tools for ${name}.`);
    return item;
  };
  const integer = (name: string, min: number, max: number) => {
    const item = value[name];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < min || item > max) return invalid(`Memory ${name} must be an integer between ${min} and ${max}.`);
    return item;
  };
  const { action } = value;
  const allowed = action === "get" ? ["id", "category", "key", "query", "where", "relations", "limit", "offset"]
    : action === "search" ? ["keywords", "match", "category", "where", "limit", "offset"]
    : action === "save" ? ["category", "key", "content", "title", "summary", "properties"]
    : action === "update" ? ["id", "category", "key", "content", "title", "summary", "properties", "removeProperties", "expectedRevision"]
    : action === "delete" ? ["id", "category", "key", "expectedRevision"]
    : action === "link" || action === "unlink" ? ["sourceId", "targetId", "relation", "expectedRevision"] : undefined;
  if (!allowed || Object.keys(value).some(key => key !== "action" && !allowed.includes(key))) return invalid("Unknown memory action or argument.");
  if (action === "search" || action === "get") {
    const paging = {
      ...(value.limit === undefined ? {} : { limit: integer("limit", 1, action === "search" || value.relations !== undefined ? 10 : 20) }),
      ...(value.offset === undefined ? {} : { offset: integer("offset", 0, 1_000_000) }),
    };
    const filters = { ...paging, ...(value.category === undefined ? {} : { category: text("category", 100) }),
      ...(value.where === undefined ? {} : { where: propertyFilters(value.where) }) };
    if (action === "search") {
      const { keywords, match } = value;
      if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 12
        || [...keywords].some(word => typeof word !== "string" || !word.trim() || word.length > 80 || word.includes("\0"))
        || keywords.join(" ").length > 500) return invalid("Memory search requires 1-12 keywords, each 1-80 characters, totaling at most 500 characters.");
      if (match !== undefined && match !== "any" && match !== "all") return invalid("Memory search match must be any or all.");
      return { action, keywords: [...new Set((keywords as string[]).map(word => word.trim().toLowerCase()))], match, ...filters };
    }
    const { relations } = value;
    const exact = value.id !== undefined || value.key !== undefined;
    if ((value.id !== undefined && (value.category !== undefined || value.key !== undefined))
      || (value.key !== undefined && value.category === undefined) || (exact && (value.query !== undefined || value.where !== undefined))) {
      return invalid("Read one memory by ID or by category and key, without query or where.");
    }
    if (relations !== undefined && (!exact || (relations !== "incoming" && relations !== "outgoing"))) {
      return invalid("Read a single memory with relations set to outgoing or incoming.");
    }
    if (typeof value.query === "string" && value.query.trim().split(/\s+/u).length > 12) return invalid("Memory queries support at most 12 search terms.");
    return { action, ...filters, relations, ...(value.id === undefined ? {} : { id: stableId("id") }),
      ...(value.key === undefined ? {} : { key: text("key", 200) }), ...(value.query === undefined ? {} : { query: text("query", 500) }) };
  }
  const address = () => ({ category: text("category", 100), key: text("key", 200) });
  type TextField = "content" | "title" | "summary";
  const optionalText = (name: TextField) => value[name] === undefined ? undefined : text(name, BOT_MEMORY_LIMITS[name]);
  const fields = <T>(read: (name: TextField) => T) => ({ content: read("content"), title: read("title"), summary: read("summary"),
    ...(value.properties === undefined ? {} : { properties: validateBotMemoryProperties(value.properties) }) });
  if (action === "save") {
    const data = fields(optionalText);
    if (data.content === undefined && data.title === undefined && data.summary === undefined && !Object.keys(data.properties ?? {}).length) {
      return invalid("Save memory with content, title, summary or at least one property.");
    }
    return { action, ...address(), ...data };
  }
  const expectedRevision = integer("expectedRevision", 1, Number.MAX_SAFE_INTEGER);
  if (action === "link" || action === "unlink") {
    const sourceId = stableId("sourceId"), targetId = stableId("targetId");
    if (sourceId === targetId) return invalid("A memory cannot link to itself.");
    return { action, sourceId, targetId, relation: text("relation", BOT_MEMORY_LIMITS.relation), expectedRevision };
  }
  if (value.id !== undefined && (value.category !== undefined || value.key !== undefined)) return invalid("Use either id or category and key.");
  const selector: BotMemorySelector = value.id === undefined ? address() : { id: stableId("id") };
  if (action === "update") {
    const data = fields(name => value[name] === null ? null : optionalText(name));
    let removeProperties: string[] | undefined;
    if (value.removeProperties !== undefined) {
      if (!Array.isArray(value.removeProperties) || value.removeProperties.length < 1 || value.removeProperties.length > 64) {
        return invalid("Memory removeProperties must list 1-64 property names.");
      }
      removeProperties = [...new Set(Array.from(value.removeProperties, propertyName))].sort();
      if (removeProperties.some(name => data.properties && Object.hasOwn(data.properties, name))) return invalid("Do not set and remove the same memory property.");
    }
    if (data.content === undefined && data.title === undefined && data.summary === undefined
      && !Object.keys(data.properties ?? {}).length && removeProperties === undefined) return invalid("Specify what to update in this memory.");
    return { action, ...selector, ...data, ...(removeProperties === undefined ? {} : { removeProperties }), expectedRevision };
  }
  return { action: "delete", ...selector, expectedRevision };
}
