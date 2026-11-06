export interface WorkflowResourceReader { entrypointId: string; args?: string[] }
export function parseWorkflowResourceReader(value: unknown): WorkflowResourceReader {
  const item = value as WorkflowResourceReader;
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['entrypointId', 'args'].includes(key))
    || typeof item.entrypointId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.entrypointId)
    || item.args !== undefined && (!Array.isArray(item.args) || item.args.length > 256 || !item.args.every(arg => typeof arg === 'string'))
    || JSON.stringify(item).length > 262_144) throw new Error('Invalid local resource reader.');
  return { entrypointId: item.entrypointId, args: [...(item.args ?? [])] };
}

