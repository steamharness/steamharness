export const BOT_CREDENTIAL_INPUT_VERSION = 1;

export const LEGACY_BOT_CREDENTIAL_KINDS = ["api-key", "password", "ssh-private-key"] as const;
export const BOT_CREDENTIAL_KINDS = [...LEGACY_BOT_CREDENTIAL_KINDS, "structured"] as const;
export type BotCredentialKind = typeof BOT_CREDENTIAL_KINDS[number];
export interface BotCredentialSlot {
  name: string;
  kind: BotCredentialKind;
  /** Suggested field names for the input placeholder, not a value schema. */
  fields?: readonly string[];
  /** Ask the user to submit a replacement through the secure input. */
  replace?: true;
}

export const BOT_CREDENTIAL_MAX_FIELDS = 16;
export const BOT_CREDENTIAL_FIELD_PATTERN = "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$";
const fieldName = new RegExp(BOT_CREDENTIAL_FIELD_PATTERN);
const reservedFieldNames = new Set(["__proto__", "constructor", "prototype"]);

export type BotCredentialStatus = "saved" | "existing" | "declined";
const fieldTypes = ["string", "number", "boolean", "object", "array", "null"] as const;
export type BotCredentialFieldType = typeof fieldTypes[number];
export type BotCredentialStructure = { format: "hidden" }
  | { format: "object"; fields: { name: string; type: BotCredentialFieldType }[]; partial?: true };
export interface BotCredentialCaptureReceipt { status: BotCredentialStatus; structure?: BotCredentialStructure }

export const isBotCredentialFieldName = (value: unknown): value is string =>
  typeof value === "string" && fieldName.test(value) && !reservedFieldNames.has(value);

export function parseBotCredentialSlot(value: unknown): BotCredentialSlot {
  const slot = value as Partial<BotCredentialSlot> | undefined;
  if (!slot || typeof slot !== "object" || Array.isArray(slot) || Object.keys(slot).some(key => !["name", "kind", "fields", "replace"].includes(key))
    || typeof slot.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slot.name)
    || slot.replace !== undefined && typeof slot.replace !== "boolean"
    || slot.kind === undefined || !BOT_CREDENTIAL_KINDS.includes(slot.kind)) {
    throw new Error("Invalid Bot credential name or kind.");
  }
  const { name, kind, fields, replace } = slot;
  const base = { name, kind, ...(replace === true && { replace }) };
  if (fields === undefined) return base;
  if (kind !== "structured" || !Array.isArray(fields) || !fields.length || fields.length > BOT_CREDENTIAL_MAX_FIELDS
    || new Set(fields).size !== fields.length
    || ![...fields].every(isBotCredentialFieldName)) {
    throw new Error("Invalid Bot credential field names.");
  }
  return { ...base, fields: [...fields] };
}

export function isBotCredentialStatus(value: unknown): value is BotCredentialStatus {
  return value === "saved" || value === "existing" || value === "declined";
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : undefined;
const only = (value: Record<string, unknown>, ...keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** The host may send metadata only; older hosts still return a bare status. */
export function parseBotCredentialCaptureReceipt(value: unknown): BotCredentialCaptureReceipt | undefined {
  if (isBotCredentialStatus(value)) return { status: value };
  const receipt = record(value);
  if (!receipt || !only(receipt, "status", "structure") || !isBotCredentialStatus(receipt.status)) return;
  const { status } = receipt;
  if (receipt.structure === undefined) return { status };
  const structure = record(receipt.structure);
  if (!structure || status === "declined") return;
  if (structure.format === "hidden" && only(structure, "format")) return { status, structure: { format: "hidden" } };
  if (structure.format !== "object" || !only(structure, "format", "fields", "partial") || structure.partial !== undefined && structure.partial !== true
    || !Array.isArray(structure.fields) || structure.fields.length > BOT_CREDENTIAL_MAX_FIELDS) return;
  const fields: Extract<BotCredentialStructure, { format: "object" }>["fields"] = [];
  const names = new Set<string>();
  for (const item of structure.fields) {
    const field = record(item);
    if (!field || !only(field, "name", "type") || !isBotCredentialFieldName(field.name) || names.has(field.name)
      || !fieldTypes.some(type => type === field.type)) return;
    names.add(field.name); fields.push({ name: field.name, type: field.type as BotCredentialFieldType });
  }
  return { status, structure: { format: "object", fields, ...(structure.partial === true && { partial: true }) } };
}
