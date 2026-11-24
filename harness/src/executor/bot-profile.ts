/** Data-only contract shared by the desktop host, CLI Web, and project SDK. */
export const LOCAL_BOT_PROFILE_PROTOCOL_VERSION = 1;
export interface FolderBotProfile {
  responsibility?: string;
  modelId?: string;
  /** Only already declared project skills can be selected. */
  skills?: 'off' | string[];
  tools?: { ceiling?: 'read-only' | 'workspace'; disabled?: string[] };
}

const invalid = (): never => { throw new Error('Invalid local Bot profile.'); };
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![null, Object.prototype].includes(Object.getPrototypeOf(input))
    || Object.keys(input).some(key => !keys.includes(key))) return invalid();
  return input as Record<string, unknown>;
}
const identifier = /^[\p{L}\p{N}_][\p{L}\p{N}_.:/-]{0,127}$/u;
const toolName = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u;
function names(input: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(input) || input.length > 64 || [...input].some(value => typeof value !== 'string' || !pattern.test(value))) return invalid();
  return [...new Set(input as string[])].sort();
}

export function parseFolderBotProfile(input: unknown): FolderBotProfile {
  if (input === undefined) return {};
  const value = record(input, ['responsibility', 'modelId', 'skills', 'tools']);
  const profile: FolderBotProfile = {};
  if (value.responsibility !== undefined) {
    if (typeof value.responsibility !== 'string' || !value.responsibility.trim() || value.responsibility.length > 4_000 || value.responsibility.includes('\0')) return invalid();
    profile.responsibility = value.responsibility.trim();
  }
  if (value.modelId !== undefined) {
    if (typeof value.modelId !== 'string' || !identifier.test(value.modelId) || value.modelId.includes('://')) return invalid();
    profile.modelId = value.modelId;
  }
  if (value.skills !== undefined) {
    const selected = value.skills === 'off' ? 'off' : names(value.skills, identifier);
    if (!selected.length || Array.isArray(selected) && selected.some(name => /[/\\:]/u.test(name))) return invalid();
    profile.skills = selected;
  }
  if (value.tools !== undefined) {
    const { ceiling, disabled } = record(value.tools, ['ceiling', 'disabled']);
    if (ceiling !== undefined && ceiling !== 'read-only' && ceiling !== 'workspace') return invalid();
    const denied = disabled === undefined ? undefined : names(disabled, toolName);
    if (ceiling || denied?.length) profile.tools = { ...(ceiling && { ceiling }), ...(denied?.length && { disabled: denied }) };
  }
  return profile;
}
