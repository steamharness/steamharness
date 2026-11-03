import { DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN } from "./identity";

export const PROJECT_CONFIG_FILE = "config.json";
export const PROJECT_CONFIG_ENV = "STEAMHARNESS_PROJECT_CONFIG";

/** Project resource mappings. Entries declare aliases; the host maintains permissions. */
export interface ProjectConfig {
  version: 1;
  knowledgeBases?: Record<string, string>;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function section(value: unknown, field: string): Record<string, unknown> {
  return value === undefined ? {} : object(value, field);
}

function document(value: unknown, field: string, partial = false): Record<string, unknown> {
  const input = object(value, field);
  if (Object.keys(input).some(key => !["version", "knowledgeBases"].includes(key))) throw new Error(`${field} contains unsupported fields.`);
  if ((!partial || input.version !== undefined) && input.version !== 1) throw new Error(`${field}.version must be 1.`);
  return input;
}

/** The environment overrides database IDs by alias without changing authored files. */
export function readProjectConfig(value: unknown, env: Record<string, string | undefined> = {}): ProjectConfig {
  const base = value === undefined ? { version: 1 } : document(value, PROJECT_CONFIG_FILE);
  let override: Record<string, unknown> = {};
  if (env[PROJECT_CONFIG_ENV] !== undefined) {
    try { override = document(JSON.parse(env[PROJECT_CONFIG_ENV]!), PROJECT_CONFIG_ENV, true); }
    catch { throw new Error(`${PROJECT_CONFIG_ENV} must be valid project configuration JSON (version 1).`); }
  }
  const knowledgeValues = { ...section(base.knowledgeBases, `${PROJECT_CONFIG_FILE}.knowledgeBases`), ...section(override.knowledgeBases, `${PROJECT_CONFIG_ENV}.knowledgeBases`) };
  const knowledgeBases: Record<string, string> = Object.create(null);
  for (const [alias, id] of Object.entries(knowledgeValues)) {
    if (!DATABASE_IDENTIFIER_PATTERN.test(alias) || typeof id !== 'string' || !DATABASE_UUID_PATTERN.test(id)) throw new Error(`config.knowledgeBases.${alias} must map an alias to a knowledge base UUID.`);
    knowledgeBases[alias] = id.toLowerCase();
  }
  return { version: 1, ...(Object.keys(knowledgeBases).length ? { knowledgeBases } : {}) };
}
