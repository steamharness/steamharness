/** The portable business configuration contract. This module is browser safe. */
export const PROJECT_CONFIGURATION_FILE = "configuration.json";
export type ConfigurationValue = null | string | number | boolean | ConfigurationValue[] | { [key: string]: ConfigurationValue };
export type ConfigurationValues = Record<string, ConfigurationValue>;
export interface ProjectConfigurationField {
  name: string;
  type: "string" | "number" | "boolean" | "json" | "file";
  label?: string;
  description?: string;
  defaultValue?: ConfigurationValue;
  required?: boolean;
  secret?: boolean;
  multiple?: boolean;
  control?: "text" | "textarea" | "select" | "radio" | "checkboxes";
  options?: { value: string; label?: string }[];
  /** File extensions or MIME types, using the HTML file input accept syntax. */
  accept?: string[];
  sharing?: ConfigurationSharingRule;
  /** JSON Pointer rules. Arrays are indivisible. */
  paths?: Record<string, ConfigurationSharingRule>;
  /** Generated deny rules for omitted paths; distributed metadata contains no private key names. */
  omittedPaths?: string[];
}
export const CONFIGURATION_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Portable server metadata only; file bytes and host credentials never enter configuration values. */
export type ProjectConfigurationFile = {
  id: string; name: string; mimeType: string; size: number; storage: "server";
  kind?: "image" | "file"; projectId?: string; createdAt?: string;
};
export interface ProjectConfigurationDefinition { version: 1 | 2; fields: ProjectConfigurationField[] }
export interface ProjectConfiguration {
  /** For distributed projects, values contain personal overrides rather than template defaults. */
  id: string; name: string; values: ConfigurationValues; createdAt: string; updatedAt: string;
  templateId?: string;
  /** JSON deletions are personal overlays, kept separately from version defaults. */
  deletedPaths?: Record<string,string[]>;
}
export interface ProjectConfigurationState {
  version: 1; revision: number; fields: ProjectConfigurationField[]; customFields: ProjectConfigurationField[];
  /** Custom definitions temporarily hidden by a declaration with the same name. */
  shadowedCustomFields?: ProjectConfigurationField[];
  configurations: ProjectConfiguration[]; activeConfigurationId: string;
  template?: ProjectConfigurationTemplate;
  publication?: ConfigurationPublicationDraft;
  canManagePublication?: boolean;
  sourceHash?: string;
  fieldCapabilities?: Record<string,{editable:boolean;reason?:string;paths:Record<string,{editable:boolean;reason?:string}>}>;
  publicationPreview?: ProjectConfigurationTemplate;
  conflicts?: { configurationId: string; key: string; value: ConfigurationValue; reason: string }[];
}
export interface ProjectConfigurationSnapshot { id: string; name: string; revision: number; values: ConfigurationValues }
export interface ProjectConfigurationExport {
  version: 1; kind: "steamharness-project-configurations"; fields: ProjectConfigurationField[]; configurations: { name: string; values: ConfigurationValues; templateId?: string }[];
}
export interface ProjectConfigurationAction {
  action: "get" | "export" | "create" | "duplicate" | "rename" | "save" | "select" | "delete" | "field.save" | "field.delete" | "import" | "publication.save" | "publication.preview";
  revision?: number; id?: string; name?: string; values?: ConfigurationValues; unset?: string[];
  field?: ProjectConfigurationField; key?: string; document?: ProjectConfigurationExport;
  publication?: ConfigurationPublicationDraft;
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
  if (!record(value) || typeof value.type!=='string' || !["string", "number", "boolean", "json", "file"].includes(value.type)) return invalid("Invalid configuration field type.");
  configurationKey(value.name);
  const allowed = ["name", "type", "label", "description", "defaultValue", "required", "secret", "multiple", "control", "options", "accept", "sharing", "paths", "omittedPaths"];
  if (Object.keys(value).some(key => !allowed.includes(key))) return invalid("Unknown configuration field property.");
  for (const key of ["label", "description"]) if (value[key] !== undefined && typeof value[key] !== "string") return invalid(`Invalid field ${key}.`);
  for (const key of ["required", "secret", "multiple"]) if (value[key] !== undefined && typeof value[key] !== "boolean") return invalid(`Invalid field ${key}.`);
  if (value.multiple && value.type !== "string" && value.type !== "file") return invalid("Only string and file fields support multiple values.");
  if (value.accept !== undefined && (value.type !== "file" || !Array.isArray(value.accept) || !value.accept.every(entry => typeof entry === "string" && /^(?:\.[a-zA-Z0-9.+_-]+|[a-zA-Z0-9!#$&^_.+-]+\/(?:[a-zA-Z0-9!#$&^_.+-]+|\*))$/.test(entry)))) return invalid("Invalid configuration file accept types.");
  if (value.type === "file" && value.control !== undefined) return invalid("File fields use the file picker control.");
  if (value.control !== undefined && !["text", "textarea", "select", "radio", "checkboxes"].includes(String(value.control))) return invalid("Invalid configuration control.");
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.some(option => !record(option) || typeof option.value !== "string" || option.label !== undefined && typeof option.label !== "string"))) return invalid("Invalid configuration options.");
  if (value.options !== undefined && (value.type !== "string" || new Set((value.options as {value: string}[]).map(option => option.value)).size !== (value.options as unknown[]).length)) return invalid("Options require unique string values.");
  if (value.sharing !== undefined) validateSharingRule(value.sharing);
  if (value.omittedPaths !== undefined && (value.type !== 'json' || !Array.isArray(value.omittedPaths) || !value.omittedPaths.every(isRuleHash))) return invalid('Invalid omitted JSON paths.');
  if (value.paths !== undefined) {
    if (value.type !== 'json' || !record(value.paths)) return invalid('JSON paths require a JSON field.');
    for (const [pointer, rule] of Object.entries(value.paths)) {
      if (!pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer) || pointer.split('/').slice(1).some(key => unsafe.has(key.replace(/~1/g,'/').replace(/~0/g,'~')))) return invalid('Invalid JSON Pointer.');
      validateSharingRule(rule);
    }
  }
  const field = structuredClone(Object.fromEntries(Object.entries(value).filter(([,entry]) => entry !== undefined))) as unknown as ProjectConfigurationField;
  if (field.defaultValue !== undefined) validateConfigurationValue(field, field.defaultValue);
  return field;
}
export function parseConfigurationDefinition(value: unknown): ProjectConfigurationDefinition {
  if (!record(value) || ![1,2].includes(value.version as number) || !Array.isArray(value.fields)) return invalid("Invalid configuration.json: expected version 1 or 2 and fields.");
  const fields = value.fields.map(parseConfigurationField), keys = fields.map(field => field.name);
  if (new Set(keys).size !== keys.length) return invalid("Duplicate configuration field.");
  return { version: value.version as 1 | 2, fields };
}
function validateSharingRule(value: unknown): void {
  if (!record(value) || Object.entries(value).some(([key,entry]) => !['publish','includeValue','editable'].includes(key) || typeof entry !== 'boolean')) return invalid('Invalid configuration sharing rule.');
}
export function validateConfigurationValue(field: ProjectConfigurationField, value: unknown): asserts value is ConfigurationValue {
  if (field.type === "file") {
    const files = field.multiple ? value : [value];
    if (!Array.isArray(files) || files.length > 32) return invalid(`Invalid value for configuration field: ${field.name}.`);
    for (const file of files) { parseConfigurationFile(file); validateConfigurationFileSelection(field, file as ProjectConfigurationFile); }
    return;
  }
  const valid = field.multiple ? Array.isArray(value) && value.every(item => typeof item === "string")
    : field.type === "json" ? isConfigurationValue(value) : typeof value === field.type && (field.type !== "number" || Number.isFinite(value));
  if (!valid) invalid(`Invalid value for configuration field: ${field.name}.`);
  if(field.type==='json') assertArrayRules(field,value as ConfigurationValue);
  if (field.options && (field.multiple ? value as string[] : [value]).some(item => !field.options!.some(option => option.value === String(item)))) invalid(`Invalid option for configuration field: ${field.name}.`);
}
export function validateConfigurationFileSelection(field: ProjectConfigurationField, file: {name: string; mimeType: string; size: number}): void {
  if (!file.name || file.name.length > 255 || /[/\\\0\r\n]/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > CONFIGURATION_FILE_MAX_BYTES) return invalid("Invalid file or file exceeds 50 MiB.");
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimeType)) return invalid("Invalid file MIME type.");
  if (field.accept?.length && !field.accept.some(type => type.startsWith(".") ? file.name.toLowerCase().endsWith(type.toLowerCase()) : type.endsWith("/*") ? file.mimeType.toLowerCase().startsWith(type.slice(0,-1).toLowerCase()) : file.mimeType.toLowerCase() === type.toLowerCase())) return invalid("This file type is not accepted by the configuration field.");
}
export function parseConfigurationFile(value: unknown): ProjectConfigurationFile {
  if (!record(value) || typeof value.id !== "string" || !/^wf_[a-f0-9]+$/.test(value.id) || value.storage !== "server" || typeof value.name !== "string" || typeof value.mimeType !== "string" || typeof value.size !== "number" || Object.keys(value).some(key => !["id","name","mimeType","size","storage","kind","projectId","createdAt"].includes(key))) return invalid("Invalid server file reference.");
  if (value.kind !== undefined && value.kind !== "image" && value.kind !== "file" || value.projectId !== undefined && typeof value.projectId !== "string" || value.createdAt !== undefined && typeof value.createdAt !== "string") return invalid("Invalid server file reference.");
  validateConfigurationFileSelection({name:"file",type:"file"}, value as ProjectConfigurationFile);
  return structuredClone(value) as ProjectConfigurationFile;
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
    ...(stored.template ? {template: stored.template as ProjectConfigurationTemplate} : {}),
    ...(Array.isArray(stored.conflicts) ? {conflicts: structuredClone(stored.conflicts) as ProjectConfigurationState['conflicts']} : {}),
    activeConfigurationId: configurations.some(item => item.id === stored.activeConfigurationId) ? String(stored.activeConfigurationId) : configurations[0]!.id };
}
export function configurationSnapshot(state: ProjectConfigurationState, configurationId = state.activeConfigurationId, required = true): ProjectConfigurationSnapshot {
  const current = state.configurations.find(item => item.id === configurationId);
  if (!current) return invalid("Configuration no longer exists.");
  const resolved = applyTemplateValues(state, current, { ...configurationDefaults(state.fields), ...Object.fromEntries(state.fields.flatMap(field => Object.hasOwn(current.values, field.name) ? [[field.name, current.values[field.name]!]] : [])) });
  values(state.fields, resolved);
  if (required) for (const field of state.fields) {
    const value = resolved[field.name];
    if (field.required && (!Object.hasOwn(resolved,field.name) || value === "" || value === null || field.multiple && Array.isArray(value) && !value.length)) invalid(`Missing required configuration: ${field.name}. Open Project configurations.`);
  }
  return { id: current.id, name: current.name, revision: state.revision, values: resolved };
}
export function exportConfigurations(state: ProjectConfigurationState, id?: string): ProjectConfigurationExport {
  if (id && !state.configurations.some(item => item.id === id)) return invalid("Configuration no longer exists.");
  return { version: 1, kind: "steamharness-project-configurations", fields: structuredClone(state.fields), configurations: state.configurations.filter(item => !id || item.id === id).map(item => ({ name: item.name, values: configurationSnapshot(state, item.id, false).values, ...(item.templateId ? {templateId:item.templateId}: {}) })) };
}
export function applyConfigurationAction(state: ProjectConfigurationState, call: ProjectConfigurationAction, id: () => string, now = new Date().toISOString()): ProjectConfigurationState {
  validateConfigurationAction(call);
  if (call.revision !== state.revision) throw new ProjectConfigurationError("Configuration changed. Refresh before saving your draft.", "CONFIGURATION_CONFLICT");
  const next = structuredClone(state), item = next.configurations.find(entry => entry.id === call.id);
  const current = (): ProjectConfiguration => item ?? invalid("Configuration no longer exists.");
  switch (call.action) {
    case "create": case "duplicate": {
      const source = call.action === "duplicate" ? current() : undefined;
      const entry = { id: id(), name: name(call.name ?? (source ? `${source.name} (copy)` : `Configuration ${next.configurations.length + 1}`)), values: source ? next.template ? configurationSnapshot(next,source.id,false).values : structuredClone(source.values) : configurationDefaults(next.fields), ...(source?.deletedPaths?{deletedPaths:structuredClone(source.deletedPaths)}:{}), ...(next.template ? {templateId: source?.templateId ?? next.template.defaultConfigurationId} : {}), createdAt: now, updatedAt: now };
      next.configurations.push(entry); next.activeConfigurationId = entry.id; break;
    }
    case "rename": current().name = name(call.name); current().updatedAt = now; break;
    case "save": {
      current().values = { ...current().values, ...values(next.fields, call.values ?? {}) };
      if (call.unset !== undefined && (!Array.isArray(call.unset) || call.unset.some(key => typeof key !== "string"))) return invalid("Invalid cleared fields.");
      for (const key of call.unset ?? []) { configurationKey(key); if (!next.fields.some(field => field.name === key)) return invalid(`Unknown configuration field: ${key}.`); delete current().values[key]; }
      if(next.conflicts) next.conflicts=next.conflicts.filter(conflict=>conflict.configurationId!==current().id || !Object.hasOwn(call.values??{},conflict.key) && !call.unset?.includes(conflict.key));
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
      if (next.template?.reservedFields?.includes(configurationRuleHash(field.name))) return invalid('Custom field conflicts with an author field.');
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
        if (next.template?.reservedFields?.includes(configurationRuleHash(field.name))) return invalid('Imported field conflicts with an author field.');
        const existing = next.fields.find(entry => entry.name === field.name);
        if(next.template?.fields.some(author=>author.name===field.name) && !equal(existing,field)) throw new ProjectConfigurationError('Author field definitions cannot be changed.','CONFIGURATION_FORBIDDEN');
        if (existing && (existing.type !== field.type || !!existing.multiple !== !!field.multiple || JSON.stringify(existing.options) !== JSON.stringify(field.options) || JSON.stringify(existing.accept ?? []) !== JSON.stringify(field.accept ?? []))) return invalid(`Conflicting configuration field: ${field.name}.`);
        if (!existing) { next.fields.push(field); next.customFields.push(field); }
      }
      for (const entry of document.configurations) {
        if (!record(entry)) return invalid("Invalid imported configuration.");
        if(entry.templateId!==undefined && (typeof entry.templateId!=='string' || next.template && !next.template.configurations.some(item=>item.id===entry.templateId))) return invalid('Invalid imported template profile.');
        next.configurations.push({ id: id(), name: name(entry.name), values: values(imported, entry.values), ...(next.template?{templateId:entry.templateId??next.template.defaultConfigurationId}:{}), createdAt: now, updatedAt: now });
      }
      break;
    }
    default: return invalid("Unsupported configuration action.");
  }
  assertConfigurationEdits(state, next, call);
  if (next.template) for (const profile of next.configurations) profile.values = personalConfigurationValues(next,profile,profile.values);
  next.revision++; return next;
}

/** Validate the wire call before accessing it in any host. Mutation versions are mandatory. */
export function validateConfigurationAction(value: unknown): asserts value is ProjectConfigurationAction {
  if (!record(value) || typeof value.action !== 'string' || !["get", "export", "create", "duplicate", "rename", "save", "select", "delete", "field.save", "field.delete", "import", "publication.save", "publication.preview"].includes(value.action)) return invalid("Unsupported configuration action.");
  if (!Object.entries(value).every(([key, entry]) => !unsafe.has(key) && (entry === undefined || isConfigurationValue(entry))) || JSON.stringify(value).length > 1024 * 1024) return invalid("Invalid configuration request or request exceeds 1 MiB.");
  if(value.values!==undefined && !record(value.values) || value.unset!==undefined && (!Array.isArray(value.unset)||value.unset.some(key=>typeof key!=='string'))) return invalid('Invalid configuration values.');
  if(value.document!==undefined) {
    if(!record(value.document)||!Array.isArray(value.document.configurations)||!value.document.configurations.length) return invalid('Invalid configuration export.');
    parseConfigurationDefinition(value.document);
    for(const entry of value.document.configurations) if(!record(entry)||!record(entry.values)) return invalid('Invalid imported configuration.');
  }
  if(value.publication!==undefined) parsePublicationDraft(value.publication);
  for (const key of ["id", "name", "key"]) if (value[key] !== undefined && typeof value[key] !== "string") return invalid(`Invalid configuration ${key}.`);
  if (!["get", "export", "publication.preview"].includes(String(value.action)) && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)) return invalid("A configuration revision is required.");
}

export interface ConfigurationSharingRule { publish?: boolean; includeValue?: boolean; editable?: boolean }
export interface ConfigurationPublicationDraft {
  revision: number;
  /** Revision of the personal profiles from which these immutable values were copied. */
  configurationRevision: number;
  /** Set by Server from the authenticated account; never accepted as authority from clients. */
  configurationAccountId?: string;
  fields: ProjectConfigurationField[];
  configurations: { id: string; name: string; values: ConfigurationValues }[];
  defaultConfigurationId: string;
}
export interface ProjectConfigurationTemplate {
  version: 2;
  kind: 'steamharness-configuration-template';
  projectId: string;
  projectVersion: string;
  /** Hash of the authored source before filtering (the final archive hash is in its manifest). */
  sourceHash: string;
  draftRevision: number;
  fields: ProjectConfigurationField[];
  configurations: { id: string; name: string; values: ConfigurationValues }[];
  defaultConfigurationId: string;
  attachments?: {id:string;path:string;sha256:string}[];
  /** Omitted author fields remain reserved without exposing their names. */
  reservedFields?: string[];
}
export const CONFIGURATION_TEMPLATE_FILE = 'configuration.template.json';
const fail = (message: string, code = 'CONFIGURATION_INVALID'): never => { throw new ProjectConfigurationError(message, code); };
const object = (value: unknown): value is Record<string, ConfigurationValue> => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry,i) => equal(entry,b[i]));
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b,key) && equal(a[key],b[key]));
  return false;
};
const isRuleHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Synchronous SHA-256 for browser-safe rule comparisons (not a source authenticity check). */
export function configurationRuleHash(value: string): string {
  const bytes = new TextEncoder().encode(value), length = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(length); data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer); view.setUint32(length - 4, bytes.length * 8, false);
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], words = new Uint32Array(64);
  const rotate = (v:number,n:number) => (v >>> n) | (v << (32-n));
  for (let offset=0; offset<length; offset+=64) {
    for(let i=0;i<16;i++) words[i]=view.getUint32(offset+i*4,false);
    for(let i=16;i<64;i++) {const a=words[i-15]!,b=words[i-2]!;words[i]=(words[i-16]!+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]!+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=hash as [number,number,number,number,number,number,number,number];
    for(let i=0;i<64;i++) {const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]!+words[i]!)>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    [a,b,c,d,e,f,g,h].forEach((v,i)=>{hash[i]=(hash[i]!+v)>>>0;});
  }
  return hash.map(v=>v.toString(16).padStart(8,'0')).join('');
}
export function configurationPointerPart(key: string): string { return key.replace(/~/g,'~0').replace(/\//g,'~1'); }
export function configurationRule(field: ProjectConfigurationField, pointer = ''): Required<ConfigurationSharingRule> {
  let result = { publish: true, includeValue: false, editable: true, ...field.sharing };
  const parts = pointer.split('/').slice(1); let current = '';
  for (const part of parts) { current += `/${part}`; result = {...result,...field.paths?.[current]}; if(field.omittedPaths?.includes(configurationRuleHash(current))) result = {...result,publish:false}; }
  // An excluded field is never brought back by a descendant rule.
  if (field.sharing?.publish === false) result.publish = false;
  return result;
}
export function configurationCapability(state: ProjectConfigurationState, field: ProjectConfigurationField, pointer = ''): { editable: boolean; reason?: string } {
  const editable = !state.template || state.customFields.some(f=>f.name===field.name) || configurationRule(field,pointer).editable && configurationRule(field,pointer).publish;
  return editable ? {editable:true} : {editable:false,reason:'Locked by the project author for this version.'};
}
function assertArrayRules(field: ProjectConfigurationField, value: ConfigurationValue | undefined, pointer = ''): void {
  if (Array.isArray(value) && Object.keys(field.paths ?? {}).some(key => key.startsWith(`${pointer}/`))) fail(`Arrays are edited as a whole: ${field.name}${pointer}.`);
  if (object(value)) for (const [key,entry] of Object.entries(value)) assertArrayRules(field,entry,`${pointer}/${configurationPointerPart(key)}`);
}
/** Filters values AND defaults; false, zero, empty text and null are real values. */
function publishedValue(field: ProjectConfigurationField, value: ConfigurationValue | undefined, pointer = ''): ConfigurationValue | undefined {
  const rule = configurationRule(field,pointer);
  if (!rule.publish && pointer === '') return undefined;
  if (object(value)) {
    const result: ConfigurationValues = {};
    for (const [key,entry] of Object.entries(value)) {
      const filtered = publishedValue(field,entry,`${pointer}/${configurationPointerPart(key)}`);
      if (filtered !== undefined) result[key] = filtered;
    }
    return Object.keys(result).length || rule.publish && rule.includeValue ? result : undefined;
  }
  return rule.publish && rule.includeValue ? structuredClone(value) : undefined;
}
export function createPublicationDraft(state: ProjectConfigurationState): ConfigurationPublicationDraft {
  return {revision:0,configurationRevision:state.revision,fields:structuredClone(state.fields),
    configurations:state.configurations.map(item=>({id:item.id,name:item.name,values:configurationSnapshot(state,item.id,false).values})),defaultConfigurationId:state.activeConfigurationId};
}
export function parsePublicationDraft(value: unknown): ConfigurationPublicationDraft {
  if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision)<0 || !Number.isSafeInteger(value.configurationRevision) || Number(value.configurationRevision)<0 || !Array.isArray(value.configurations) || !value.configurations.length || typeof value.defaultConfigurationId!=='string') return fail('Invalid publication draft.');
  if(value.configurationAccountId!==undefined && (typeof value.configurationAccountId!=='string'||!value.configurationAccountId.trim())) return fail('Invalid publication configuration account.');
  const fields = parseConfigurationDefinition({version:2,fields:value.fields}).fields;
  const configurations = value.configurations.map(entry => {
    if (!object(entry) || typeof entry.id!=='string' || !entry.id || typeof entry.name!=='string' || !entry.name.trim() || entry.name.length>200 || !object(entry.values) || !isConfigurationValue(entry.values)) return fail('Invalid publication configuration.');
    for (const [key,val] of Object.entries(entry.values)) {
      const field=fields.find(f=>f.name===key); if(!field) return fail(`Unknown publication field: ${key}.`);
      validateConfigurationValue(field,val); assertArrayRules(field,val);
    }
    return {id:entry.id,name:entry.name,values:structuredClone(entry.values)};
  });
  if(new Set(configurations.map(c=>c.id)).size!==configurations.length || !configurations.some(c=>c.id===value.defaultConfigurationId)) return fail('Invalid default publication configuration.');
  if(JSON.stringify(value).length>1024*1024) return fail('Publication exceeds 1 MiB.');
  return {revision:Number(value.revision),configurationRevision:Number(value.configurationRevision),...(value.configurationAccountId?{configurationAccountId:value.configurationAccountId as string}:{}),fields,configurations,defaultConfigurationId:value.defaultConfigurationId};
}
export function freezeConfigurationTemplate(input: ConfigurationPublicationDraft, binding: {projectId:string;projectVersion:string;sourceHash:string}): ProjectConfigurationTemplate {
  const draft=parsePublicationDraft(input);
  const fields=draft.fields.filter(field=>configurationRule(field).publish).map(field=>{
    const result=structuredClone(field);
    delete result.defaultValue;
    const omitted=Object.keys(field.paths??{}).filter(pointer=>!configurationRule(field,pointer).publish);
    if(omitted.length) result.omittedPaths=[...new Set([...(field.omittedPaths??[]),...omitted.map(configurationRuleHash)])];
    if(result.paths) {
      // Omitted ancestors are represented only by hashes; freeze inherited rules before removing them.
      result.paths=Object.fromEntries(Object.keys(result.paths).filter(pointer=>configurationRule(field,pointer).publish).map(pointer=>[pointer,configurationRule(field,pointer)]));
      if(!Object.keys(result.paths).length)delete result.paths;
    }
    result.sharing={...configurationRule(field)};
    return result;
  });
  const configurations=draft.configurations.map(item=>{
    const values:ConfigurationValues={};
    for(const field of draft.fields) {
      const source=Object.hasOwn(item.values,field.name)?item.values[field.name]:field.defaultValue;
      assertArrayRules(field,source);
      const filtered=publishedValue(field,source);
      if(filtered!==undefined) values[field.name]=filtered;
      if(field.required && configurationRule(field).publish && !configurationRule(field).editable && (filtered===undefined || filtered===null || filtered==='' || field.multiple && Array.isArray(filtered) && !filtered.length)) fail(`Required locked field needs a published value: ${field.name}.`);
    }
    return {id:item.id,name:item.name,values};
  });
  const reservedFields=draft.fields.filter(field=>!configurationRule(field).publish).map(field=>configurationRuleHash(field.name));
  return {version:2,kind:'steamharness-configuration-template',...binding,draftRevision:draft.revision,fields,configurations,defaultConfigurationId:draft.defaultConfigurationId,...(reservedFields.length?{reservedFields}:{})};
}
export function parseConfigurationTemplate(value: unknown): ProjectConfigurationTemplate {
  if(!object(value) || value.version!==2 || value.kind!=='steamharness-configuration-template' || typeof value.projectId!=='string' || !value.projectId || typeof value.projectVersion!=='string' || typeof value.sourceHash!=='string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)) return fail('Invalid configuration template.');
  const draft=parsePublicationDraft({...value,revision:value.draftRevision,configurationRevision:0});
  // A template is already filtered. Never re-enable omitted defaults on a client.
  if(draft.fields.some(field=>field.defaultValue!==undefined || !configurationRule(field).publish)) return fail('Invalid template field defaults.');
  const attachments = value.attachments;
  if(value.reservedFields!==undefined && (!Array.isArray(value.reservedFields)||!value.reservedFields.every(isRuleHash))) return fail('Invalid reserved configuration fields.');
  if(attachments!==undefined && (!Array.isArray(attachments) || attachments.some(a=>!object(a)||typeof a.id!=='string'||!/^wf_[a-f0-9]+$/.test(a.id)||a.path!==`configuration-assets/${a.id}`||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)))) return fail('Invalid template attachments.');
  return {...(attachments?{attachments:structuredClone(attachments) as unknown as ProjectConfigurationTemplate['attachments']}:{}),...(value.reservedFields?{reservedFields:[...value.reservedFields] as string[]}:{}),version:2,kind:'steamharness-configuration-template',projectId:value.projectId,projectVersion:value.projectVersion,sourceHash:value.sourceHash,draftRevision:draft.revision,fields:draft.fields,configurations:draft.configurations,defaultConfigurationId:draft.defaultConfigurationId};
}
/** Merge full personal values with the version's authoritative values. Never apply old locked overrides. */
function allowedValue(field:ProjectConfigurationField, base:ConfigurationValue|undefined, personal:ConfigurationValue|undefined, pointer='', deleted:readonly string[]=[]):ConfigurationValue|undefined {
  const rule=configurationRule(field,pointer);
  if(!rule.publish) {
    if(pointer==='' || !object(base)&&!object(personal)) return undefined;
    const result:ConfigurationValues={};
    for(const key of new Set([...Object.keys(object(base)?base:{}),...Object.keys(object(personal)?personal:{})])) {
      const value=allowedValue(field,object(base)?base[key]:undefined,object(personal)?personal[key]:undefined,`${pointer}/${configurationPointerPart(key)}`,deleted);
      if(value!==undefined)result[key]=value;
    }
    return Object.keys(result).length?result:undefined;
  }
  if((object(base) || base===undefined) && (object(personal) || personal===undefined) && (object(base)||object(personal))) {
    const result:ConfigurationValues={};
    for(const key of new Set([...Object.keys(base??{}),...Object.keys(personal??{})])) {
      const value=allowedValue(field,object(base)?base[key]:undefined,object(personal)?personal[key]:undefined,`${pointer}/${configurationPointerPart(key)}`,deleted);
      if(value!==undefined) result[key]=value;
    }
    return !Object.keys(result).length && personal===undefined && rule.editable && deleted.some(path=>pointer===path||pointer.startsWith(`${path}/`)) ? undefined : result;
  }
  if(rule.editable && personal!==undefined) {
    if(object(personal)) {
      const result:ConfigurationValues={};
      for(const key of Object.keys(personal)) {const value=allowedValue(field,undefined,personal[key],`${pointer}/${configurationPointerPart(key)}`,deleted);if(value!==undefined)result[key]=value;}
      return result;
    }
    // Replacing a parent with a scalar must not erase locked descendants.
    if(object(base) && Object.keys(field.paths??{}).some(key=>key.startsWith(`${pointer}/`) && !configurationRule(field,key).editable)) return structuredClone(base);
    return structuredClone(personal);
  }
  if(personal===undefined && rule.editable && deleted.some(path=>pointer===path||pointer.startsWith(`${path}/`))) return undefined;
  return base===undefined?undefined:structuredClone(base);
}
export function applyTemplateValues(state:ProjectConfigurationState, configuration:ProjectConfiguration, input:ConfigurationValues):ConfigurationValues {
  if(!state.template) return input;
  const profile=state.template.configurations.find(item=>item.id===(configuration.templateId??state.template!.defaultConfigurationId)) ?? state.template.configurations.find(item=>item.id===state.template!.defaultConfigurationId)!;
  const result:ConfigurationValues={};
  for(const field of state.fields) {
    const value=state.customFields.some(f=>f.name===field.name)?input[field.name]:allowedValue(field,profile.values[field.name],input[field.name],'',configuration.deletedPaths?.[field.name]);
    if(value!==undefined) result[field.name]=value;
  }
  return result;
}
/** Keep only actual personal overrides, so untouched initial values follow template upgrades. */
function personalConfigurationValues(state:ProjectConfigurationState, configuration:ProjectConfiguration, input:ConfigurationValues):ConfigurationValues {
  const base=applyTemplateValues(state,{...configuration,deletedPaths:undefined},{}),effective=applyTemplateValues(state,configuration,input);
  const difference=(original:ConfigurationValue|undefined,value:ConfigurationValue|undefined):ConfigurationValue|undefined=>{
    if(equal(original,value))return undefined;
    if(object(original)&&object(value)) {
      const result:ConfigurationValues={};
      for(const [key,entry] of Object.entries(value)) {const changed=difference(original[key],entry);if(changed!==undefined)result[key]=changed;}
      return Object.keys(result).length?result:undefined;
    }
    return value===undefined?undefined:structuredClone(value);
  };
  const result:ConfigurationValues={};
  for(const field of state.fields) {
    const value=state.customFields.some(custom=>custom.name===field.name)?input[field.name]:difference(base[field.name],effective[field.name]);
    if(value!==undefined)result[field.name]=value;
  }
  return result;
}
export function bindConfigurationTemplate(state:ProjectConfigurationState, input:ProjectConfigurationTemplate):ProjectConfigurationState {
  const template=parseConfigurationTemplate(input),next=structuredClone(state),previous=next.template;
  next.template=template;
  const custom=[...next.customFields,...next.shadowedCustomFields??[]];
  const reserved=(field:ProjectConfigurationField)=>template.fields.some(t=>t.name===field.name)||!!template.reservedFields?.includes(configurationRuleHash(field.name));
  next.customFields=custom.filter(field=>!reserved(field));
  next.shadowedCustomFields=custom.filter(reserved);if(!next.shadowedCustomFields.length)delete next.shadowedCustomFields;
  next.fields=[...template.fields,...next.customFields];
  if(!previous) {
    const fresh=next.revision===0 && !next.customFields.length && next.configurations.length===1 && !Object.keys(next.configurations[0]!.values).length;
    const imported=template.configurations.map((item,index)=>({id:`template-${index}-${item.id}`,templateId:item.id,name:item.name,values:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
    if(fresh) {
      next.configurations=imported;
      next.activeConfigurationId=next.configurations.find(item=>item.templateId===template.defaultConfigurationId)!.id;
    } else {
      for(const profile of next.configurations) profile.templateId=template.configurations.some(item=>item.id===profile.id)?profile.id:template.defaultConfigurationId;
      next.configurations.push(...imported.filter(item=>!next.configurations.some(profile=>profile.templateId===item.templateId)));
    }
  } else if(!equal(previous,template)) {
    for(const item of template.configurations) if(!previous.configurations.some(old=>old.id===item.id) && !next.configurations.some(profile=>profile.templateId===item.id)) next.configurations.push({id:`template-${item.id}`,templateId:item.id,name:item.name,values:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  }
  if(next.conflicts) next.conflicts=next.conflicts.filter(conflict=>next.fields.some(field=>field.name===conflict.key));
  for(const profile of next.configurations) {
    if(!template.configurations.some(item=>item.id===profile.templateId)) profile.templateId=template.defaultConfigurationId;
    const valid:ConfigurationValues={};
    for(const field of next.fields) if(Object.hasOwn(profile.values,field.name)) {
      try {validateConfigurationValue(field,profile.values[field.name]);valid[field.name]=profile.values[field.name]!;}
      catch {const conflict={configurationId:profile.id,key:field.name,value:profile.values[field.name]!,reason:'Field type changed. Resolve this saved draft.'};next.conflicts=[...(next.conflicts??[]).filter(c=>c.configurationId!==profile.id||c.key!==field.name),conflict];}
    }
    const inactive=Object.fromEntries((next.shadowedCustomFields??[]).filter(field=>!template.fields.some(author=>author.name===field.name)&&Object.hasOwn(profile.values,field.name)).map(field=>[field.name,profile.values[field.name]!]));
    profile.values={...inactive,...personalConfigurationValues(next,profile,valid)};
  }
  if(!equal(previous,template)) next.revision++;
  return next;
}
function assertEditableDifference(field:ProjectConfigurationField,before:ConfigurationValue|undefined,after:ConfigurationValue|undefined,pointer=''):void {
  if(equal(before,after)) return;
  if((object(before)||before===undefined) && (object(after)||after===undefined) && (object(before)||object(after)) && Object.keys({...before as object,...after as object}).length) {
    for(const key of new Set([...Object.keys(before??{}),...Object.keys(after??{})])) assertEditableDifference(field,object(before)?before[key]:undefined,object(after)?after[key]:undefined,`${pointer}/${configurationPointerPart(key)}`);
    return;
  }
  const rule=configurationRule(field,pointer);
  if(!rule.publish||!rule.editable) fail(`Configuration is locked by the author: ${field.name}${pointer}.`,'CONFIGURATION_FORBIDDEN');
  // Descendant deletions/additions must be checked even for whole-object replacements.
  if(object(before)||object(after)) for(const key of new Set([...Object.keys(object(before)?before:{}),...Object.keys(object(after)?after:{})])) assertEditableDifference(field,object(before)?before[key]:undefined,object(after)?after[key]:undefined,`${pointer}/${configurationPointerPart(key)}`);
}
function jsonDeletions(base:ConfigurationValue|undefined,personal:ConfigurationValue|undefined,pointer=''):string[] {
  if(!object(base)||!object(personal))return [];
  return Object.keys(base).flatMap(key=>{const path=`${pointer}/${configurationPointerPart(key)}`;return !Object.hasOwn(personal,key)?[path]:jsonDeletions(base[key],personal[key],path);});
}
export function assertConfigurationEdits(before:ProjectConfigurationState,after:ProjectConfigurationState,call:ProjectConfigurationAction):void {
  if(!before.template) return;
  for(const profile of after.configurations) {
    const old=before.configurations.find(item=>item.id===profile.id);
    const baseline=old?configurationSnapshot(before,old.id,false).values:applyTemplateValues(before,{...profile,values:{}},configurationDefaults(before.fields));
    for(const field of before.template.fields) {
      if(call.action==='save'&&old) {
        if(Object.hasOwn(call.values??{},field.name)) assertEditableDifference(field,baseline[field.name],call.values![field.name]);
        else if(call.unset?.includes(field.name)) assertEditableDifference(field,baseline[field.name],applyTemplateValues(before,{...profile,values:{}},{})[field.name]);
      } else if(!old) assertEditableDifference(field,baseline[field.name],Object.hasOwn(profile.values,field.name)?profile.values[field.name]:baseline[field.name]);
      if(field.type==='json' && (call.action==='save' && (Object.hasOwn(call.values??{},field.name)||call.unset?.includes(field.name)) || !old)) {
        const source=before.template.configurations.find(item=>item.id===(profile.templateId??before.template!.defaultConfigurationId))!;
        const paths=call.action==='save'&&call.unset?.includes(field.name)?[]:jsonDeletions(source.values[field.name],profile.values[field.name]);
        profile.deletedPaths??={};if(paths.length)profile.deletedPaths[field.name]=paths;else delete profile.deletedPaths[field.name];
        if(!Object.keys(profile.deletedPaths).length)delete profile.deletedPaths;
      }
    }
    profile.templateId ??= before.template.defaultConfigurationId;
  }
  // Imported definitions can never change author policy or make a private field a declared field.
  for(const field of after.fields) if(before.template.fields.some(item=>item.name===field.name) && !equal(field,before.fields.find(item=>item.name===field.name))) fail('Author field definitions cannot be changed.','CONFIGURATION_FORBIDDEN');
}
