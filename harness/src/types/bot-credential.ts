export const BOT_CREDENTIAL_INPUT_VERSION = 1;

export const LEGACY_BOT_CREDENTIAL_KINDS = ["api-key", "password", "ssh-private-key"] as const;
export const BOT_CREDENTIAL_KINDS = [...LEGACY_BOT_CREDENTIAL_KINDS, "structured"] as const;
export type BotCredentialKind = typeof BOT_CREDENTIAL_KINDS[number];
export interface BotCredentialSlot {
  name: string;
  kind: BotCredentialKind;
  /** Optional field names for a structured credential. Never put values here. */
  fields?: readonly string[];
}

export const BOT_CREDENTIAL_MAX_FIELDS = 16;
export const BOT_CREDENTIAL_FIELD_PATTERN = "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$";
const fieldName = new RegExp(BOT_CREDENTIAL_FIELD_PATTERN);
const reservedFieldNames = new Set(["__proto__", "constructor", "prototype"]);

export type BotCredentialStatus = "saved" | "existing" | "declined";

export function parseBotCredentialSlot(value: unknown): BotCredentialSlot {
  const slot = value as Partial<BotCredentialSlot> | undefined;
  if (!slot || typeof slot !== "object" || Array.isArray(slot) || Object.keys(slot).some(key => !["name", "kind", "fields"].includes(key))
    || typeof slot.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slot.name)
    || slot.kind === undefined || !BOT_CREDENTIAL_KINDS.includes(slot.kind)) {
    throw new Error("Invalid Bot credential name or kind.");
  }
  const { name, kind, fields } = slot;
  if (fields === undefined) return { name, kind };
  if (kind !== "structured" || !Array.isArray(fields) || !fields.length || fields.length > BOT_CREDENTIAL_MAX_FIELDS
    || new Set(fields).size !== fields.length
    || [...fields].some(field => typeof field !== "string" || !fieldName.test(field) || reservedFieldNames.has(field))) {
    throw new Error("Invalid Bot credential field names.");
  }
  return { name, kind, fields: [...fields] };
}

export function isBotCredentialStatus(value: unknown): value is BotCredentialStatus {
  return value === "saved" || value === "existing" || value === "declined";
}
