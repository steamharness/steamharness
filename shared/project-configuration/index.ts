/** The portable business configuration contract. This module is browser safe. */
export const PROJECT_CONFIGURATION_FILE = "configuration.json";
export type ConfigurationValue = null | string | number | boolean | ConfigurationValue[] | { [key: string]: ConfigurationValue };
export type ConfigurationValues = Record<string, ConfigurationValue>;
export interface ProjectConfigurationField {
  name: string;
  type: "string" | "number" | "boolean" | "json";
  label?: string;
  description?: string;
  defaultValue?: ConfigurationValue;
  required?: boolean;
  secret?: boolean;
  multiple?: boolean;
  control?: "text" | "textarea" | "select" | "radio" | "checkboxes";
  options?: { value: string; label?: string }[];
}
export interface ProjectConfigurationDefinition { version: 1; fields: ProjectConfigurationField[] }
export interface ProjectConfiguration {
  id: string; name: string; values: ConfigurationValues; createdAt: string; updatedAt: string;
}
export interface ProjectConfigurationState {
  version: 1; revision: number; fields: ProjectConfigurationField[]; customFields: ProjectConfigurationField[];
  /** Custom definitions temporarily hidden by a declaration with the same name. */
  shadowedCustomFields?: ProjectConfigurationField[];
  configurations: ProjectConfiguration[]; activeConfigurationId: string;
}
export interface ProjectConfigurationSnapshot { id: string; name: string; revision: number; values: ConfigurationValues }
export interface ProjectConfigurationExport {
  version: 1; kind: "steamharness-project-configurations"; fields: ProjectConfigurationField[]; configurations: { name: string; values: ConfigurationValues }[];
}
export interface ProjectConfigurationAction {
  action: "get" | "export" | "create" | "duplicate" | "rename" | "save" | "select" | "delete" | "field.save" | "field.delete" | "import";
  revision?: number; id?: string; name?: string; values?: ConfigurationValues; unset?: string[];
  field?: ProjectConfigurationField; key?: string; document?: ProjectConfigurationExport;
}
export class ProjectConfigurationError extends Error {
  constructor(message: string, readonly code = "CONFIGURATION_INVALID") { super(message); this.name = "ProjectConfigurationError"; }
}
const invalid = (message: string): never => { throw new ProjectConfigurationError(message); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
export function configurationKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(value) || unsafe.has(value)) return invalid("Invalid configuration key.");
  return value;
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) return invalid("Configuration name must contain 1-200 characters.");
  return value.trim();
}
export function isConfigurationValue(value: unknown, depth = 0): value is ConfigurationValue {
  if (depth > 24) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isConfigurationValue(item, depth + 1));
  return record(value) && Object.entries(value).every(([key, entry]) => !unsafe.has(key) && isConfigurationValue(entry, depth + 1));
}
export function parseConfigurationField(value: unknown): ProjectConfigurationField {
  if (!record(value) || !["string", "number", "boolean", "json"].includes(String(value.type))) return invalid("Invalid configuration field type.");
  configurationKey(value.name);
  const allowed = ["name", "type", "label", "description", "defaultValue", "required", "secret", "multiple", "control", "options"];
  if (Object.keys(value).some(key => !allowed.includes(key))) return invalid("Unknown configuration field property.");
  for (const key of ["label", "description"]) if (value[key] !== undefined && typeof value[key] !== "string") return invalid(`Invalid field ${key}.`);
  for (const key of ["required", "secret", "multiple"]) if (value[key] !== undefined && typeof value[key] !== "boolean") return invalid(`Invalid field ${key}.`);
  if (value.multiple && value.type !== "string") return invalid("Only string fields support multiple values.");
  if (value.control !== undefined && !["text", "textarea", "select", "radio", "checkboxes"].includes(String(value.control))) return invalid("Invalid configuration control.");
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.some(option => !record(option) || typeof option.value !== "string" || option.label !== undefined && typeof option.label !== "string"))) return invalid("Invalid configuration options.");
  if (value.options !== undefined && (value.type !== "string" || new Set((value.options as {value: string}[]).map(option => option.value)).size !== (value.options as unknown[]).length)) return invalid("Options require unique string values.");
  const field = structuredClone(value) as unknown as ProjectConfigurationField;
  if (field.defaultValue !== undefined) validateConfigurationValue(field, field.defaultValue);
  return field;
}
export function parseConfigurationDefinition(value: unknown): ProjectConfigurationDefinition {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.fields)) return invalid("Invalid configuration.json: expected version 1 and fields.");
  const fields = value.fields.map(parseConfigurationField), keys = fields.map(field => field.name);
  if (new Set(keys).size !== keys.length) return invalid("Duplicate configuration field.");
  return { version: 1, fields };
}
export function validateConfigurationValue(field: ProjectConfigurationField, value: unknown): asserts value is ConfigurationValue {
  const valid = field.multiple ? Array.isArray(value) && value.every(item => typeof item === "string")
    : field.type === "json" ? isConfigurationValue(value) : typeof value === field.type && (field.type !== "number" || Number.isFinite(value));
  if (!valid) invalid(`Invalid value for configuration field: ${field.name}.`);
  if (field.options && (field.multiple ? value as string[] : [value]).some(item => !field.options!.some(option => option.value === String(item)))) invalid(`Invalid option for configuration field: ${field.name}.`);
}
function values(fields: ProjectConfigurationField[], input: unknown): ConfigurationValues {
  if (!record(input)) return invalid("Configuration values must be an object.");
  for (const [key, value] of Object.entries(input)) {
    configurationKey(key);
    const field = fields.find(item => item.name === key);
    if (!field) return invalid(`Unknown configuration field: ${key}.`);
    validateConfigurationValue(field, value);
  }
  if (JSON.stringify(input).length > 1024 * 1024) return invalid("Configuration exceeds 1 MiB.");
  return structuredClone(input) as ConfigurationValues;
}
export function configurationDefaults(fields: ProjectConfigurationField[]): ConfigurationValues {
  return Object.fromEntries(fields.flatMap(field => field.defaultValue === undefined ? [] : [[field.name, structuredClone(field.defaultValue)]]));
}
export function createConfigurationState(fields: ProjectConfigurationField[], id: () => string, now = new Date().toISOString()): ProjectConfigurationState {
  const initialId = id();
  return { version: 1, revision: 0, fields: structuredClone(fields), customFields: [], activeConfigurationId: initialId, configurations: [{ id: initialId, name: "Default", values: configurationDefaults(fields), createdAt: now, updatedAt: now }] };
}
export function readConfigurationState(stored: unknown, declared: ProjectConfigurationField[], id: () => string): ProjectConfigurationState {
  if (stored === undefined) { const state = createConfigurationState(declared, id); state.activeConfigurationId = state.configurations[0]!.id; return state; }
  if (!record(stored) || stored.version !== 1 || !Number.isSafeInteger(stored.revision) || Number(stored.revision) < 0 || !Array.isArray(stored.customFields) || !Array.isArray(stored.configurations) || !stored.configurations.length) return invalid("Invalid project configuration store.");
  if (stored.shadowedCustomFields !== undefined && !Array.isArray(stored.shadowedCustomFields)) return invalid("Invalid shadowed custom configuration fields.");
  const allCustomFields = [...stored.customFields, ...(stored.shadowedCustomFields as unknown[] | undefined ?? [])].map(parseConfigurationField);
  if (new Set(allCustomFields.map(field => field.name)).size !== allCustomFields.length) return invalid("Duplicate custom configuration field.");
  const customFields = allCustomFields.filter(field => !declared.some(item => item.name === field.name));
  const shadowedCustomFields = allCustomFields.filter(field => declared.some(item => item.name === field.name));
  const fields = [...declared, ...customFields];
  if (new Set(fields.map(field => field.name)).size !== fields.length) return invalid("Duplicate configuration field.");
  const configurations = stored.configurations.map(entry => {
    if (!record(entry) || typeof entry.id !== "string" || !entry.id || !record(entry.values) || !isConfigurationValue(entry.values) || typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") return invalid("Invalid stored configuration.");
    Object.keys(entry.values).forEach(configurationKey);
    return { ...entry, name: name(entry.name), values: structuredClone(entry.values) } as ProjectConfiguration;
  });
  if (new Set(configurations.map(item => item.id)).size !== configurations.length) return invalid("Duplicate configuration ID.");
  return { version: 1, revision: Number(stored.revision), fields, customFields, ...(shadowedCustomFields.length ? {shadowedCustomFields} : {}), configurations,
    activeConfigurationId: configurations.some(item => item.id === stored.activeConfigurationId) ? String(stored.activeConfigurationId) : configurations[0]!.id };
}
export function configurationSnapshot(state: ProjectConfigurationState, configurationId = state.activeConfigurationId, required = true): ProjectConfigurationSnapshot {
  const current = state.configurations.find(item => item.id === configurationId);
  if (!current) return invalid("Configuration no longer exists.");
  const resolved = { ...configurationDefaults(state.fields), ...Object.fromEntries(state.fields.flatMap(field => Object.hasOwn(current.values, field.name) ? [[field.name, current.values[field.name]!]] : [])) };
  values(state.fields, resolved);
  if (required) for (const field of state.fields) if (field.required && (!Object.hasOwn(resolved,field.name) || resolved[field.name] === "" || resolved[field.name] === null)) invalid(`Missing required configuration: ${field.name}. Open Project configurations.`);
  return { id: current.id, name: current.name, revision: state.revision, values: resolved };
}
export function exportConfigurations(state: ProjectConfigurationState, id?: string): ProjectConfigurationExport {
  if (id && !state.configurations.some(item => item.id === id)) return invalid("Configuration no longer exists.");
  return { version: 1, kind: "steamharness-project-configurations", fields: structuredClone(state.fields), configurations: state.configurations.filter(item => !id || item.id === id).map(item => ({ name: item.name, values: configurationSnapshot(state, item.id, false).values })) };
}
export function applyConfigurationAction(state: ProjectConfigurationState, call: ProjectConfigurationAction, id: () => string, now = new Date().toISOString()): ProjectConfigurationState {
  validateConfigurationAction(call);
  if (call.revision !== state.revision) throw new ProjectConfigurationError("Configuration changed. Refresh before saving your draft.", "CONFIGURATION_CONFLICT");
  const next = structuredClone(state), item = next.configurations.find(entry => entry.id === call.id);
  const current = (): ProjectConfiguration => item ?? invalid("Configuration no longer exists.");
  switch (call.action) {
    case "create": case "duplicate": {
      const source = call.action === "duplicate" ? current() : undefined;
      const entry = { id: id(), name: name(call.name ?? (source ? `${source.name} (copy)` : `Configuration ${next.configurations.length + 1}`)), values: source ? structuredClone(source.values) : configurationDefaults(next.fields), createdAt: now, updatedAt: now };
      next.configurations.push(entry); next.activeConfigurationId = entry.id; break;
    }
    case "rename": current().name = name(call.name); current().updatedAt = now; break;
    case "save": {
      current().values = { ...current().values, ...values(next.fields, call.values ?? {}) };
      if (call.unset !== undefined && (!Array.isArray(call.unset) || call.unset.some(key => typeof key !== "string"))) return invalid("Invalid cleared fields.");
      for (const key of call.unset ?? []) { configurationKey(key); if (!next.fields.some(field => field.name === key)) return invalid(`Unknown configuration field: ${key}.`); delete current().values[key]; }
      current().updatedAt = now; break;
    }
    case "select": next.activeConfigurationId = current().id; break;
    case "delete": {
      current(); if (next.configurations.length === 1) return invalid("The last configuration cannot be deleted.");
      next.configurations = next.configurations.filter(entry => entry.id !== call.id);
      if (next.activeConfigurationId === call.id) next.activeConfigurationId = next.configurations[0]!.id; break;
    }
    case "field.save": {
      const field = parseConfigurationField(call.field);
      if (call.key !== undefined && call.key !== field.name) {
        const oldKey = configurationKey(call.key);
        if (!next.customFields.some(entry => entry.name === oldKey) || next.fields.some(entry => entry.name === field.name)) return invalid("Custom field rename conflicts with an existing field.");
        next.customFields = next.customFields.filter(entry => entry.name !== oldKey); next.fields = next.fields.filter(entry => entry.name !== oldKey);
        for (const entry of next.configurations) if (Object.hasOwn(entry.values,oldKey)) { entry.values[field.name] = entry.values[oldKey]!; delete entry.values[oldKey]; }
      }
      if (next.fields.some(entry => entry.name === field.name) && !next.customFields.some(entry => entry.name === field.name)) return invalid("Project-declared fields are defined by configuration.json.");
      next.customFields = [...next.customFields.filter(entry => entry.name !== field.name), field];
      next.fields = [...next.fields.filter(entry => entry.name !== field.name), field];
      for (const entry of next.configurations) if (Object.hasOwn(entry.values, field.name)) validateConfigurationValue(field, entry.values[field.name]);
      break;
    }
    case "field.delete": {
      const key = configurationKey(call.key);
      if (!next.customFields.some(field => field.name === key)) return invalid("Only custom configuration fields can be deleted.");
      next.customFields = next.customFields.filter(field => field.name !== key); next.fields = next.fields.filter(field => field.name !== key);
      for (const entry of next.configurations) delete entry.values[key]; break;
    }
    case "import": {
      const document = call.document;
      if (!document || document.version !== 1 || document.kind !== "steamharness-project-configurations" || !Array.isArray(document.configurations) || !document.configurations.length) return invalid("Invalid configuration export.");
      const imported = parseConfigurationDefinition(document).fields;
      for (const field of imported) {
        const existing = next.fields.find(entry => entry.name === field.name);
        if (existing && (existing.type !== field.type || !!existing.multiple !== !!field.multiple || JSON.stringify(existing.options) !== JSON.stringify(field.options))) return invalid(`Conflicting configuration field: ${field.name}.`);
        if (!existing) { next.fields.push(field); next.customFields.push(field); }
      }
      for (const entry of document.configurations) {
        if (!record(entry)) return invalid("Invalid imported configuration.");
        next.configurations.push({ id: id(), name: name(entry.name), values: values(imported, entry.values), createdAt: now, updatedAt: now });
      }
      break;
    }
    default: return invalid("Unsupported configuration action.");
  }
  next.revision++; return next;
}

/** Validate the wire call before accessing it in any host. Mutation versions are mandatory. */
export function validateConfigurationAction(value: unknown): asserts value is ProjectConfigurationAction {
  if (!record(value) || !["get", "export", "create", "duplicate", "rename", "save", "select", "delete", "field.save", "field.delete", "import"].includes(String(value.action))) return invalid("Unsupported configuration action.");
  if (!Object.entries(value).every(([key, entry]) => !unsafe.has(key) && (entry === undefined || isConfigurationValue(entry))) || JSON.stringify(value).length > 1024 * 1024) return invalid("Invalid configuration request or request exceeds 1 MiB.");
  for (const key of ["id", "name", "key"]) if (value[key] !== undefined && typeof value[key] !== "string") return invalid(`Invalid configuration ${key}.`);
  if (!["get", "export"].includes(String(value.action)) && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)) return invalid("A configuration revision is required.");
}
