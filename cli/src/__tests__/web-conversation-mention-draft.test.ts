import { expect, it } from 'vitest';
import { MentionDraft } from '../web/ui/conversation-mention-draft';

it('shows just file names while preserving distinct full paths through edits, serialization and restoration', () => {
  const draft = new MentionDraft();
  const source = '检查 @file:/project/one/package.json 和 @file:/project/two/package.json';
  const visible = draft.setText(source);
  expect(visible).toBe('检查 @file:package.json 和 @file:package.json');
  expect(draft.files.map(file => file.path)).toEqual(['/project/one/package.json', '/project/two/package.json']);
  draft.sync(`先${visible}`); expect(draft.text()).toBe(`先${source}`);
  expect(draft.text(3, draft.files[0].end)).toBe(' @file:/project/one/package.json');
  const restored = new MentionDraft(); expect(restored.setText(draft.text())).toBe(`先${visible}`);
  expect(restored.text()).toBe(`先${source}`);
});

it('preserves quoted and Windows paths, and never rewrites raw workflow input', () => {
  const draft = new MentionDraft();
  const source = '@file:"C:\\\\work\\\\release plan.md" @file:"/project/设计 说明.md"';
  expect(draft.setText(source)).toBe('@file:"release plan.md" @file:"设计 说明.md"');
  expect(draft.text()).toBe(source);
  expect(draft.setText(source, false)).toBe(source); expect(draft.files).toEqual([]);
});

it('keeps paths attached to the correct occurrence after undo, redo and replacing a file with an identically named file', () => {
  const draft = new MentionDraft(); draft.setText('@file:');
  expect(draft.replace(0, 6, '@file:/one/package.json ')).toBe('@file:package.json ');
  draft.sync('@file:', 'historyUndo'); expect(draft.text()).toBe('@file:');
  draft.sync('@file:package.json ', 'historyRedo'); expect(draft.text()).toBe('@file:/one/package.json ');
  draft.replace(0, '@file:package.json '.length, '@file:/two/package.json '); expect(draft.text()).toBe('@file:/two/package.json ');
  draft.sync('@file:package.json ', 'historyUndo'); expect(draft.text()).toBe('@file:/one/package.json ');
  draft.sync('@file:package.json ', 'historyRedo'); expect(draft.text()).toBe('@file:/two/package.json ');
});

it('removes a stale target when its visible reference is changed or deleted', () => {
  const draft = new MentionDraft(); const visible = draft.setText('@file:/project/package.json @file:/project/keep.ts');
  draft.sync(visible.replace('package.json', 'package.js')); expect(draft.text()).toBe('@file:package.js @file:/project/keep.ts');
  draft.sync('Keep only plain text'); expect(draft.files).toEqual([]); expect(draft.text()).toBe('Keep only plain text');
});

it('uses the edit selection to remove the intended occurrence when two files have the same name', () => {
  const draft = new MentionDraft(); draft.setText('@file:/first/package.json @file:/second/package.json');
  draft.beforeInput(0, '@file:package.json '.length, 'deleteContentBackward'); draft.sync('@file:package.json', 'deleteContentBackward');
  expect(draft.text()).toBe('@file:/second/package.json');
  draft.beforeInput(0, '@file:package.json'.length, 'insertFromPaste'); draft.sync('@file:package.json', 'insertFromPaste');
  expect(draft.files).toEqual([]); expect(draft.text()).toBe('@file:package.json');
});
