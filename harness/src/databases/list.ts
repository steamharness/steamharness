import type { DatabaseAccessRule } from '@steamharness/database-spaces';
/** Intersection of host grant and declared key ranges; undefined means all. */
export function databaseReadPrefixes(...rules: DatabaseAccessRule[]): string[] | undefined {
  let prefixes: string[] | undefined;
  for (const rule of rules) {
    if (rule.mode === 'none') return [];
    if (rule.mode === 'all') continue;
    prefixes = prefixes === undefined ? [...rule.prefixes] : prefixes.flatMap(a => rule.prefixes.flatMap(b => a.startsWith(b) ? [a] : b.startsWith(a) ? [b] : []));
  }
  return prefixes && [...new Set(prefixes)];
}
