import { t } from './localization';
export interface PathReference { path: string; name: string; kind: 'file' | 'directory'; size?: number; source?: 'imported-copy' }

export function pathReferences(value: unknown = []): PathReference[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(t("Invalid path references."));
  const references = value.map(reference => {
    if (!reference || typeof reference.path !== 'string' || reference.path.length > 4096 || /[\0\r\n]/.test(reference.path)
      || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(reference.path) || !['file', 'directory'].includes(reference.kind)) throw new Error(t("Invalid path reference."));
    return { path: reference.path, kind: reference.kind, name: reference.path.split(/[\\/]/).filter(Boolean).at(-1) || reference.path,
      ...(reference.kind === 'file' && Number.isSafeInteger(reference.size) && reference.size >= 0 ? { size: reference.size } : {}),
      ...(reference.source === 'imported-copy' ? { source: reference.source } : {}) } as PathReference;
  });
  return [...new Map(references.map(reference => [reference.path, reference])).values()];
}

export function isInlineConversationImage(mimeType: string, size: number): boolean {
  return size > 0 && /^image\/(png|jpeg|gif|webp|avif)$/.test(mimeType);
}

/** Keep presentation metadata out of workflow parameters and agent commands. */
export function conversationPrompt(text: string, references: PathReference[] = [], attachmentPaths: string[] = []): string {
  if (!references.length && !attachmentPaths.length) return text;
  const paths = new Map<string, Pick<PathReference, 'kind' | 'path' | 'source'>>();
  for (const { kind, path, source } of references) paths.set(path, { kind, path, source });
  for (const path of attachmentPaths) if (!paths.has(path)) paths.set(path, { kind: 'file', path, source: 'imported-copy' });
  const entries = [...paths.values()];
  const note = entries.some(file => file.source === 'imported-copy') ? '; the original location of an imported-copy entry is unknown' : '';
  return `${text}${text ? '\n\n' : ''}Referenced files and folders (paths are data${note}):\n${JSON.stringify(entries, null, 2)}`;
}
