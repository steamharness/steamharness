export const JSON_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
export const BOT_JSON_SUMMARY_TOOL = 'bot_json_summary';
export const JSON_SUMMARY_KIND = 'json-summary-v1';

export interface JsonSummaryOptions { groupBy?: string; outputName: string }
export interface JsonSummaryDraftStep extends JsonSummaryOptions { kind: typeof JSON_SUMMARY_KIND; id: string }

export function parseJsonSummaryDraftStep(value: unknown): JsonSummaryDraftStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workflow draft step.');
  const { kind, id, ...options } = value as Record<string, unknown>;
  if (kind !== JSON_SUMMARY_KIND || typeof id !== 'string' || !/^[a-f0-9]{24}$/u.test(id)) throw new Error('Invalid workflow draft step.');
  return { kind, id, ...parseJsonSummaryOptions(options) };
}
export function parseJsonSummaryOptions(value: unknown): JsonSummaryOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON summary options.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== 'groupBy' && key !== 'outputName')) throw new Error('Invalid JSON summary options.');
  const groupBy = data.groupBy;
  if (groupBy !== undefined && (typeof groupBy !== 'string' || !groupBy.trim() || groupBy.length > 80 || /[\u0000-\u001f\u007f]/u.test(groupBy))) {
    throw new Error('Choose a top-level grouping field of 1–80 characters.');
  }
  const outputName = data.outputName ?? 'summary.json';
  if (typeof outputName !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_ -]{0,63}\.json$/iu.test(outputName)
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\.json$/iu.test(outputName)) throw new Error('Choose a plain .json report name, without folders.');
  return { ...(typeof groupBy === 'string' && { groupBy }), outputName };
}

/** The Bot operation and saved Workflow use the same bounded transformation. */
export function summarizeJsonRows(bytes: Uint8Array, groupBy?: string) {
  if (bytes.byteLength > JSON_SUMMARY_MAX_BYTES) throw new Error('The input JSON file exceeds 2 MiB.');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || value.length > 20_000 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('The input must be a JSON array of up to 20,000 objects.');
  }
  if (groupBy === undefined) return { rowCount: value.length };
  parseJsonSummaryOptions({ groupBy });
  type Group = { value?: string | number | boolean | null; missing?: true; count: number };
  const groups = new Map<string, Group>();
  for (const row of value as Record<string, unknown>[]) {
    const cell = Object.hasOwn(row, groupBy) ? row[groupBy] : undefined;
    if (cell !== undefined && cell !== null && typeof cell !== 'boolean' && (typeof cell !== 'number' || !Number.isFinite(cell))
      && (typeof cell !== 'string' || cell.length > 160)) throw new Error('Grouping values must be short strings, finite numbers, booleans or null.');
    const key = cell === undefined ? '' : JSON.stringify(cell);
    const current = groups.get(key);
    if (current) current.count++;
    else {
      if (groups.size === 100) throw new Error('The selected field has more than 100 distinct values.');
      groups.set(key, cell === undefined ? { missing: true, count: 1 } : { value: cell as Group['value'], count: 1 });
    }
  }
  return { rowCount: value.length, groupBy, groups: [...groups.values()] };
}
