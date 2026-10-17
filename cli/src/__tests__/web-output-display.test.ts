import { afterEach, describe, expect, it } from 'vitest';
import { initI18n } from '@workflow-code/i18n';
import { composerOutputItems, isComposerOutputItem, ringOutputContent, ringOutputText } from '../web/ui/output-display';
import { applyOutputChunk, outputText, type ConversationMessage, type WorkflowOutputItem } from '../web/workflow-types';

afterEach(() => initI18n({ preference: 'zh-CN' }));

function ring(value: number, total?: number, id = 'quota'): WorkflowOutputItem {
  return { id, title: 'Storage quota', content: { value, total, unit: 'MB' }, contentType: 'json', display: { type: 'ring', placement: 'composer-right' } };
}

describe('Output presentation', () => {
  it('uses output declarations for arbitrary metrics and keeps the latest value per item', () => {
    const latest = ring(57, 100);
    const messages: ConversationMessage[] = [
      { role: 'assistant', content: '', items: [ring(25, 100), ring(4, 10, 'requests')] },
      { role: 'user', content: '', items: [ring(99, 100)] },
      { role: 'assistant', content: 'Answer', items: [latest] },
      { role: 'assistant', content: '', status: 'running', items: [] },
    ];
    expect(composerOutputItems(messages)).toEqual([latest, ring(4, 10, 'requests')]);
    expect(composerOutputItems([])).toEqual([]);
    messages.at(-1)!.items = [ring(0, 100)];
    expect(composerOutputItems(messages)[0].content).toEqual({ value: 0, total: 100, unit: 'MB' });
  });

  it('restores standard output items from saved reports and releases an item moved back inline', () => {
    const pinned = ring(57, 100);
    const messages: ConversationMessage[] = [{ role: 'assistant', content: '', report: { status: 'success', output: { items: [pinned] } } }];
    expect(composerOutputItems(messages)).toEqual([pinned]);
    messages.push({ role: 'assistant', content: '', items: [{ ...pinned, display: { type: 'ring', placement: 'inline' } }] });
    expect(composerOutputItems(messages)).toEqual([]);
    expect(isComposerOutputItem({ ...pinned, id: undefined })).toBe(false);
  });

  it('uses the selected conversation live outputs after follow-up, fork, compaction and reset', () => {
    const messages: ConversationMessage[] = [{ role: 'assistant', content: 'Hello', items: [ring(3755, 1_000_000)] }];
    for (const used of [13645, 8000, 500, 0]) {
      expect(composerOutputItems(messages, [ring(used, 1_000_000)])).toEqual([ring(used, 1_000_000)]);
    }
    expect(composerOutputItems(messages, [{ ...ring(0), display: { type: 'ring', placement: 'inline' } }])).toEqual([]);
    expect(messages[0].items).toEqual([ring(3755, 1_000_000)]);
  });

  it('does not describe nonzero context below one percent as empty', () => {
    initI18n({ preference: 'en' });
    expect(ringOutputText(ring(3755, 1_000_000))?.fullness).toBe('Less than 1% full');
    expect(ringOutputText(ring(0, 1_000_000))?.fullness).toBe('0% full');
    initI18n({ preference: 'zh-CN' });
    expect(ringOutputText(ring(3755, 1_000_000))?.fullness).toBe('已用不足 1%');
  });

  it.each([undefined, null, [], { used: 100 }, { value: '100' }, { value: -1 }, { value: Infinity }, { value: NaN },
    { value: 100, total: 0 }, { value: 100, total: '1_000' }, { value: 100, total: Infinity }, { value: 100, unit: 1 }])('leaves malformed ring content in ordinary output: %j', content => {
    const item = { ...ring(0), content };
    expect(ringOutputContent(item)).toBeUndefined();
    expect(isComposerOutputItem(item)).toBe(false);
    expect(ringOutputText(item)).toBeUndefined();
  });

  it('preserves declarations through streaming updates without adding JSON to the answer', () => {
    const items: WorkflowOutputItem[] = [];
    applyOutputChunk(items, { type: 'output_item_start', item: { ...ring(25, 100), display: { type: 'ring' } } });
    applyOutputChunk(items, { type: 'output_item_delta', itemId: 'quota', delta: { value: 57, total: 100, unit: 'MB' }, item: { display: { type: 'ring', placement: 'composer-right' } } });
    applyOutputChunk(items, { type: 'output_item_start', item: { id: 'answer', title: 'Output', content: 'The answer', contentType: 'markdown' } });
    expect(composerOutputItems([{ role: 'assistant', content: '', items }])).toMatchObject([ring(57, 100)]);
    expect(outputText(items)).toBe('The answer');
  });

  it('merges partial numeric updates without losing the limit or unit', () => {
    const items: WorkflowOutputItem[] = [];
    applyOutputChunk(items, { type: 'output_item_start', item: ring(25, 100) });
    applyOutputChunk(items, { type: 'output_item_delta', itemId: 'quota', delta: { value: 75 } });
    expect(items[0].content).toEqual({ value: 75, total: 100, unit: 'MB' });
    expect(ringOutputText(items[0])?.percentage).toBe(75);
    applyOutputChunk(items, { type: 'output_item_delta', itemId: 'quota', delta: { total: 200 } });
    expect(ringOutputText(items[0])?.percentage).toBe(38);
  });

  it('appends array deltas and preserves metadata when only presentation is patched', () => {
    const items: WorkflowOutputItem[] = [{ id: 'rows', content: [1], contentType: 'json' }, ring(25, 100)];
    applyOutputChunk(items, { type: 'output_item_delta', itemId: 'rows', delta: [2, 3] });
    expect(items[0].content).toEqual([1, 2, 3]);
    applyOutputChunk(items, { type: 'output_item_delta', itemId: 'quota', delta: { value: 75 }, item: { display: { type: 'ring' } } });
    expect(items[1].metadata).toBeUndefined();
  });

  it.each(['en', 'zh-CN'] as const)('formats generic values and units in %s', language => {
    initI18n({ preference: language });
    const text = ringOutputText(ring(148_000, 258_000))!;
    expect(text.percentage).toBe(57);
    expect(text.heading).toBe('Storage quota');
    expect(text.fullness).toBe(language === 'en' ? '57% full' : '已使用 57%');
    expect(text.value).toBe(language === 'en' ? '148,000 / 258,000 MB used' : '已使用 148,000 / 258,000 MB');
    expect(ringOutputText(ring(0, 100))?.percentage).toBe(0);
    expect(ringOutputText(ring(150, 100))?.percentage).toBe(150);
    const unknown = ringOutputText(ring(456))!;
    expect(unknown.percentage).toBeUndefined();
    expect(unknown.fullness).toBe(language === 'en' ? 'Total unavailable' : '上限未知');
    expect(unknown.value).toBe(language === 'en' ? '456 MB used' : '已使用 456 MB');
    expect(ringOutputText({ ...ring(3.5), content: { value: 3.5 } })?.value).toBe(language === 'en' ? '3.5 used' : '已使用 3.5');
  });
});
