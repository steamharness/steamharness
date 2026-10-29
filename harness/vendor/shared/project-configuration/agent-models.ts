import { ProjectConfigurationError, type ProjectConfigurationField } from "./index";

export const AGENT_MODELS_CONFIGURATION_KEY = "STEAMHARNESS_AGENT_MODELS";
export const AGENT_MODEL_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type AgentModelProtocol = typeof AGENT_MODEL_PROTOCOLS[number];
/** Project-declared policy; omitted means both model sources are available. */
export interface AgentModelPolicy { allowThirdParty?: boolean }
export type ConfiguredAgentModel = { id: string; name: string; model: string } & (
  | { source: "system"; credentialId: string }
  | { source: "third-party"; apiKind: AgentModelProtocol; baseUrl: string; apiKey: string }
);
/** A project keeps only the host model identity, never a copy of its connection. */
export interface UserAgentModelReference { id: string; name: string; source: "user-settings"; modelId: string }
export type ProjectAgentModel = ConfiguredAgentModel | UserAgentModelReference;
export type UserAgentModelSummary = Pick<ConfiguredAgentModel, "id" | "name" | "model" | "source">;
export type ResolvedProjectAgentModel = (ConfiguredAgentModel & { origin: "settings" | "project" })
  | { id: string; name: string; model: string; source: "unavailable"; origin: "settings" };
export const AGENT_MODELS_CONFIGURATION_FIELD: ProjectConfigurationField = {
  name: AGENT_MODELS_CONFIGURATION_KEY, type: "json", control: "ai-models", label: "AI models",
  secret: true, defaultValue: [], sharing: { publish: true, includeValue: false, editable: true },
};

/** Validated at every write boundary, including imports and direct API requests. */
export function parseAgentModels(value: unknown, policy: AgentModelPolicy = {}): ConfiguredAgentModel[] {
  const fail = (message: string): never => { throw new ProjectConfigurationError(message); };
  if (!Array.isArray(value) || value.length > 100) return fail("AI models must be a list of at most 100 entries.");
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("Invalid AI model entry.");
    const text = (key: string, limit = 200): string => {
      const v = entry[key];
      if (typeof v !== "string" || !v.trim() || v.length > limit || /[\0\r\n]/.test(v)) return fail(`Invalid AI model ${key}.`);
      return v.trim();
    };
    const id = text("id");
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) return fail("AI model IDs must be unique.");
    ids.add(id);
    const common = { id, name: text("name"), model: text("model") };
    if (entry.source === "system") {
      if (Object.keys(entry).some(key => !["id", "name", "model", "source", "credentialId"].includes(key))) return fail("Unknown system AI model property.");
      return { ...common, source: "system", credentialId: text("credentialId") };
    }
    if (entry.source !== "third-party" || !AGENT_MODEL_PROTOCOLS.includes(entry.apiKind)) return fail("Invalid third-party AI protocol.");
    if (policy.allowThirdParty === false) throw new ProjectConfigurationError("This project only allows system AI. Remove third-party models before saving.", "CONFIGURATION_AI_SOURCE_FORBIDDEN");
    if (Object.keys(entry).some(key => !["id", "name", "model", "source", "apiKind", "baseUrl", "apiKey"].includes(key))) return fail("Unknown third-party AI model property.");
    const baseUrl = text("baseUrl", 2048);
    let url: URL;
    try { url = new URL(baseUrl); } catch { return fail("AI Base URL must be an HTTP or HTTPS URL without credentials, query or fragment."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail("AI Base URL must be an HTTP or HTTPS URL without credentials, query or fragment.");
    return { ...common, source: "third-party", apiKind: entry.apiKind, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: text("apiKey", 16384) };
  });
}

/** Project lists accept host references in addition to project-owned connections. */
export function parseProjectAgentModels(value: unknown, policy: AgentModelPolicy = {}): ProjectAgentModel[] {
  if (!Array.isArray(value) || value.length > 100) throw new ProjectConfigurationError("AI models must be a list of at most 100 entries.");
  const ids = new Set<string>();
  return value.map(entry => {
    let model: ProjectAgentModel;
    if (entry?.source === "user-settings") {
      if (Object.keys(entry).some(key => !["id", "name", "source", "modelId"].includes(key))) throw new ProjectConfigurationError("Unknown user settings model reference property.");
      const text = (key: string) => {
        const value = entry[key];
        if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\0\r\n]/.test(value)) throw new ProjectConfigurationError(`Invalid AI model ${key}.`);
        return value.trim();
      };
      model = { id: text("id"), name: text("name"), source: "user-settings", modelId: text("modelId") };
      if (!/^[A-Za-z0-9_-]+$/.test(model.id) || !/^[A-Za-z0-9_-]+$/.test(model.modelId)) throw new ProjectConfigurationError("Invalid user settings model reference ID.");
    } else model = parseAgentModels([entry], policy)[0]!;
    if (ids.has(model.id)) throw new ProjectConfigurationError("AI model IDs must be unique.");
    ids.add(model.id);
    return model;
  });
}

/** The ordered project list supplies the default; inherited host models supplement it. */
export function resolveProjectAgentModels(project: readonly ProjectAgentModel[], user: readonly ConfiguredAgentModel[], inheritUserModels: boolean): ResolvedProjectAgentModel[] {
  const userById = new Map(user.map(model => [model.id, model]));
  const references = new Set(project.flatMap(model => model.source === "user-settings" ? [model.modelId] : []));
  const models: ResolvedProjectAgentModel[] = project.map(entry => {
    // User IDs cannot contain ':', so a project collision has an unambiguous identity.
    const id = inheritUserModels && userById.has(entry.id) ? `project:${entry.id}` : entry.id;
    if (entry.source !== "user-settings") return { ...entry, id, origin: "project" };
    const model = userById.get(entry.modelId);
    return model ? { ...model, id, name: entry.name, origin: "settings" }
      : { id, name: entry.name, model: entry.modelId, source: "unavailable", origin: "settings" };
  });
  if (inheritUserModels) for (const model of user) {
    if (!references.has(model.id)) models.push({ ...model, origin: "settings" });
  }
  return models;
}

/** Public account catalogue only. No upstream key or proxy token is retained. */
export interface AgentModelCatalogEntry { id: string; name: string; models: { id: string; name: string }[] }
export function parseAgentModelCatalog(value: unknown): AgentModelCatalogEntry[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as {credentials?: unknown}).credentials)) throw new ProjectConfigurationError("Invalid system AI catalogue.");
  const seen = new Set<string>();
  return (value as { credentials: unknown[] }).credentials.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    if (entry.providerType !== "anthropic" && entry.providerType !== "openai-responses" || typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id) || typeof entry.name !== "string" || !Array.isArray(entry.models)) return [];
    seen.add(entry.id);
    const models = [...new Set(entry.models.filter((id): id is string => typeof id === "string" && !!id.trim()))];
    return models.length ? [{ id: entry.id, name: entry.name, models: models.map(id => ({ id, name: id })) }] : [];
  });
}
