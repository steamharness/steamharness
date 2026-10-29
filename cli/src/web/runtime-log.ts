/** Keep a possible credential suffix until the next chunk, including at EOF. */
export function createSecretStreamRedactor(values: readonly string[]) {
  let pending = '';
  return (chunk: string, final = false): string => {
    const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
    const expression = secrets.length ? new RegExp(secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
    const overlap = Math.max(0, ...secrets.map(value => value.length - 1));
    pending += chunk;
    const boundary = final ? pending.length : Math.max(0, pending.length - overlap);
    let end = boundary, cursor = 0, output = '';
    if (expression) {
      expression.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = expression.exec(pending)) && match.index < boundary) {
        output += pending.slice(cursor, match.index) + '[redacted]';
        cursor = expression.lastIndex;
        end = Math.max(end, cursor);
      }
    }
    output += pending.slice(cursor, end);
    pending = pending.slice(end);
    return output;
  };
}
