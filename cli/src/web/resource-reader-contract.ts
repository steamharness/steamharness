export interface WorkflowResourceReader { entrypointId: string; args?: string[] }
export function parseWorkflowResourceReader(value: unknown): WorkflowResourceReader {
  const item = value as WorkflowResourceReader;
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['entrypointId', 'args'].includes(key))
    || typeof item.entrypointId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.entrypointId)
    || item.args !== undefined && (!Array.isArray(item.args) || item.args.length > 256 || !item.args.every(arg => typeof arg === 'string'))
    || JSON.stringify(item).length > 262_144) throw new Error('Invalid local resource reader.');
  return { entrypointId: item.entrypointId, args: [...(item.args ?? [])] };
}


/** Knowledge readers accept resource selection separately from their saved arguments. */
export function selectedKnowledgeReader(reader: WorkflowResourceReader, target: Record<string, string>): WorkflowResourceReader {
  const args = [...(reader.args ?? [])];
  if (Object.hasOwn(target, 'documentId')) args.push('--document-id', target.documentId);
  if (target.query) args.push('--query', target.query);
  return parseWorkflowResourceReader({ entrypointId: reader.entrypointId, args });
}
