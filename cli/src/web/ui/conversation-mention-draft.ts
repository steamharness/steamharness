import { mentionRanges, mentionText } from '../conversation-mentions';

interface FileMention { start: number; end: number; text: string; source: string; path: string }
interface Snapshot { text: string; files: FileMention[] }

function compact(source: string): Snapshot {
  const files: FileMention[] = []; let text = '', end = 0;
  for (const range of mentionRanges(source)) {
    if (!range.text.startsWith('@file:')) continue;
    const value = range.text.slice(6);
    let path: string;
    try { path = value.startsWith('"') ? JSON.parse(value) : value; } catch { continue; }
    if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) continue;
    const name = path.split(/[\\/]/).filter(Boolean).at(-1);
    if (!name) continue;
    text += source.slice(end, range.start);
    const token = mentionText('file', name), start = text.length;
    text += token; files.push({ start, end: text.length, text: token, source: range.text, path }); end = range.end;
  }
  return { text: text + source.slice(end), files };
}

/** Keep full references in stored messages while editing compact file names natively. */
export class MentionDraft {
  private value = '';
  files: FileMention[] = [];
  private history: Snapshot[] = [{ text: '', files: [] }];
  private historyIndex = 0;
  private pendingEdit?: { start: number; end: number; type: string };

  setText(source: string, compactFiles = true): string {
    const snapshot = compactFiles ? compact(source) : { text: source, files: [] };
    this.value = snapshot.text; this.files = snapshot.files; this.pendingEdit = undefined;
    this.history = [snapshot]; this.historyIndex = 0; return this.value;
  }

  sync(value: string, inputType = ''): void {
    const pending = this.pendingEdit; this.pendingEdit = undefined;
    if (inputType === 'historyUndo' || inputType === 'historyRedo') {
      const step = inputType === 'historyUndo' ? -1 : 1;
      for (let index = this.historyIndex + step; index >= 0 && index < this.history.length; index += step) {
        if (this.history[index].text !== value) continue;
        this.historyIndex = index; this.value = value; this.files = this.history[index].files; return;
      }
    }
    if (pending && !inputType.startsWith('history')) {
      let { start, end } = pending;
      if (start === end && value.length < this.value.length) {
        if (pending.type.endsWith('Backward')) start -= this.value.length - value.length;
        else end += this.value.length - value.length;
      }
      const size = value.length - this.value.length + end - start;
      if (size >= 0 && start >= 0 && value.slice(0, start) === this.value.slice(0, start)
        && value.slice(start + size) === this.value.slice(end)) {
        if (value !== this.value || start !== end) this.edit(start, end, value.slice(start, start + size));
        return;
      }
    }
    if (value === this.value) return;
    let start = 0, suffix = 0;
    while (start < value.length && start < this.value.length && value[start] === this.value[start]) start++;
    while (suffix < value.length - start && suffix < this.value.length - start && value[value.length - 1 - suffix] === this.value[this.value.length - 1 - suffix]) suffix++;
    this.edit(start, this.value.length - suffix, value.slice(start, value.length - suffix));
  }

  beforeInput(start: number, end: number, type: string): void { this.pendingEdit = { start, end, type }; }

  replace(start: number, end: number, source: string): string {
    const replacement = compact(source);
    this.edit(start, end, replacement.text, replacement.files); return replacement.text;
  }

  text(start = 0, end = this.value.length): string {
    let source = '', offset = start;
    for (const file of this.files) {
      if (file.start < start || file.end > end) continue;
      source += this.value.slice(offset, file.start) + file.source; offset = file.end;
    }
    return source + this.value.slice(offset, end);
  }

  private edit(start: number, end: number, text: string, files: FileMention[] = []): void {
    const delta = text.length - (end - start);
    this.files = this.files.flatMap(file => file.end <= start ? [file] : file.start >= end
      ? [{ ...file, start: file.start + delta, end: file.end + delta }] : [])
      .concat(files.map(file => ({ ...file, start: file.start + start, end: file.end + start }))).sort((a, b) => a.start - b.start);
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({ text: this.value, files: this.files });
    if (this.history.length > 200) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }
}
