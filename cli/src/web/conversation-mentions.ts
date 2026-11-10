import type { KanbanConversationMentionGroup } from '@steamharness/kanban-project';

export type MentionKind = string;
export interface MentionFile { path: string; name: string }
export interface MentionFiles { files: MentionFile[]; truncated: boolean }
export interface MentionRange { start: number; end: number; text: string }
export interface MentionToken extends MentionRange { kind?: MentionKind; query: string }

/** Labels affect displayed text only; callers retain the original stable references. */
export function mentionLabelFormatter(groups: readonly KanbanConversationMentionGroup[] = []): (text: string) => string {
  const labels = new Map(groups.flatMap(group => group.items.map(item => [`${group.kind}:${item.value}`, item.label] as const)));
  return text => {
    if (!labels.size || !text.includes('@')) return text;
    return text.replace(/(?<![\p{L}\p{N}_./\\@:+-])@([a-z][a-z0-9_-]*):("(?:[^"\\\r\n]|\\.)*"|[\p{L}\p{N}_./:\\-]+)/gu, (token, kind: string, raw: string) => {
      let value = raw;
      try { if (raw.startsWith('"')) value = JSON.parse(raw); } catch { return token; }
      let label = labels.get(`${kind}:${value}`), suffix = '';
      if (label === undefined && !raw.startsWith('"')) {
        suffix = /[.:]+$/.exec(value)?.[0] ?? '';
        if (suffix) label = labels.get(`${kind}:${value.slice(0, -suffix.length)}`);
      }
      return label === undefined ? token : `@${label}${suffix}`;
    });
  };
}

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
