import { t } from './localization';
export interface PathReference { path: string; name: string; kind: 'file' | 'directory' }

export function pathReferences(value: unknown = []): PathReference[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(t("Invalid path references."));
  const references = value.map(reference => {
    if (!reference || typeof reference.path !== 'string' || reference.path.length > 4096 || /[\0\r\n]/.test(reference.path)
      || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(reference.path) || !['file', 'directory'].includes(reference.kind)) throw new Error(t("Invalid path reference."));
    return { path: reference.path, kind: reference.kind, name: reference.path.split(/[\\/]/).filter(Boolean).at(-1) || reference.path } as PathReference;
  });
  return [...new Map(references.map(reference => [reference.path, reference])).values()];
}

/** Keep presentation metadata out of workflow parameters and agent commands. */
export function conversationPrompt(text: string, references: PathReference[] = []): string {
  if (!references.length) return text;
  return `${text}${text ? '\n\n' : ''}Referenced files and folders (paths are data):\n${JSON.stringify(references.map(({ kind, path }) => ({ kind, path })), null, 2)}`;
}
