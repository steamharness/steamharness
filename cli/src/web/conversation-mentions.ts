export type MentionKind = string;
export interface MentionFile { path: string; name: string }
export interface MentionFiles { files: MentionFile[]; truncated: boolean }
export interface MentionRange { start: number; end: number; text: string }
export interface MentionToken extends MentionRange { kind?: MentionKind; query: string }

/** Quoting keeps file names with spaces and Windows paths in a single reference. */
export function mentionText(kind: MentionKind, value: string): string {
  return `@${kind}:${/^[\p{L}\p{N}_./:\\-]+$/u.test(value) ? value : JSON.stringify(value)}`;
}

export function mentionRanges(text: string): MentionRange[] {
  return [...text.matchAll(/(?:^|[\s(*_~\[{'"“‘【（，。！？：；])(@(?:[a-z][a-z0-9_-]*:)?(?:"(?:[^"\\\r\n]|\\.)*"?|[^\s@"，。！？；）\])}]*))/gu)]
    .map(match => ({ start: match.index! + match[0].length - match[1].length, end: match.index! + match[0].length, text: match[1] }));
}

export function composerMentionToken(text: string, start: number, end = start): MentionToken | undefined {
  if (start !== end) return;
  const range = mentionRanges(text).find(range => range.start < start && range.end >= start);
  if (!range) return;
  const before = text.slice(range.start + 1, start);
  // A finished quoted reference must not reopen when its trailing space is deleted.
  if (/^[a-z][a-z0-9_-]*:"(?:[^"\\]|\\.)*"$/.test(before)) return;
  const match = /^([a-z][a-z0-9_-]*):/.exec(before);
  const query = before.slice(match?.[0].length ?? 0).replace(/^"/, '').replace(/\\(["\\])/g, '$1');
  return { ...range, kind: match?.[1] as MentionKind | undefined, query };
}
