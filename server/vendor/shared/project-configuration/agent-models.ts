import { ProjectConfigurationError, type ProjectConfigurationField } from "./index";

export const AGENT_MODELS_CONFIGURATION_KEY = "STEAMHARNESS_AGENT_MODELS";
export const AGENT_MODEL_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type AgentModelProtocol = typeof AGENT_MODEL_PROTOCOLS[number];
export type ConfiguredAgentModel = { id: string; name: string; model: string } & (
  | { source: "system"; credentialId: string }
  | { source: "third-party"; apiKind: AgentModelProtocol; baseUrl: string; apiKey: string }
);
export const AGENT_MODELS_CONFIGURATION_FIELD: ProjectConfigurationField = {
  name: AGENT_MODELS_CONFIGURATION_KEY, type: "json", control: "ai-models", label: "AI models",
  secret: true, defaultValue: [], sharing: { publish: true, includeValue: false, editable: true },
};

/** Validated at every write boundary, including imports and direct API requests. */
export function parseAgentModels(value: unknown): ConfiguredAgentModel[] {
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
    if (Object.keys(entry).some(key => !["id", "name", "model", "source", "apiKind", "baseUrl", "apiKey"].includes(key))) return fail("Unknown third-party AI model property.");
    const baseUrl = text("baseUrl", 2048);
    let url: URL;
    try { url = new URL(baseUrl); } catch { return fail("AI Base URL must be an HTTP or HTTPS URL without credentials, query or fragment."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail("AI Base URL must be an HTTP or HTTPS URL without credentials, query or fragment.");
    return { ...common, source: "third-party", apiKind: entry.apiKind, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: text("apiKey", 16384) };
  });
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
