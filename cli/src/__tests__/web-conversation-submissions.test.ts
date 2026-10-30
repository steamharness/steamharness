import { describe, expect, it } from 'vitest';
import { ConversationSubmissions, type ConversationSubmission } from '../web/ui/conversation-submissions';
import type { ConversationSession } from '../web/workflow-types';

function session(id = 'chat'): ConversationSession {
  return { id, title: 'Chat', messages: [], queuedInputs: [], draft: { text: 'Next draft', attachments: [] } };
}
function submission(queued = false, id = 'request'): ConversationSubmission {
  return { projectUri: 'project', sessionId: 'chat', queued, phase: 'pending',
    input: { id, text: 'Inspect file', params: { model: 'chosen' }, createdAt: 100,
      attachments: [{ id: 'file', kind: 'image', name: 'image.png', mimeType: 'image/png', size: 1, storage: 'local', createdAt: '' }] } };
}

describe('Immediate conversation submission', () => {
  it('keeps the model display name in pending replies after restore and retry while retaining the selected ID', () => {
    const pending = new ConversationSubmissions();
    pending.add({ ...submission(), modelName: 'Configured model' });
    const restored = new ConversationSubmissions(JSON.parse(JSON.stringify(pending.list())), 'Interrupted');
    expect(restored.project('project', session(), false).messages[1].model).toBe('Configured model');
    restored.retry('request');
    expect(restored.project('project', session(), false).messages[1].model).toBe('Configured model');
    expect(restored.get('request')?.input.params.model).toBe('chosen');
  });

  it('shows text, attachments and a sending response before any backend snapshot, retaining the next draft', () => {
    const pending = new ConversationSubmissions(); pending.add(submission());
    const original = session(), displayed = pending.project('project', original, false);
    expect(displayed.messages).toMatchObject([{ role: 'user', content: 'Inspect file', attachments: [{ id: 'file' }] },
      { role: 'assistant', content: '', status: 'sending', model: 'chosen' }]);
    expect(displayed.draft).toEqual(original.draft); expect(displayed.activeRunId).toBeUndefined();
    expect(original.messages).toEqual([]); expect(pending.busy('project', 'chat')).toBe(true);
    expect(pending.project('project', displayed, false).messages).toEqual(displayed.messages);
    expect(pending.project('project', session(), true).messages).toEqual(displayed.messages);
  });

  it.each(['initial', 'durable', 'edited-queue'] as const)('replaces the %s preview once by request identity rather than text', kind => {
    const pending = new ConversationSubmissions(); pending.add(submission());
    pending.accept('request');
    expect(pending.project('project', session(), true).messages).toHaveLength(2);
    const stored = session();
    stored.messages = [{ role: 'user', content: 'Inspect file' }, { role: 'assistant', content: 'Actual response',
      ...(kind === 'initial' ? { id: 'request' } : kind === 'durable' ? { sessionRequestId: 'request' } : { input: { requestId: 'request', text: '', params: {}, attachments: [] } }) }];
    const result = pending.project('project', stored, true);
    expect(result.messages).toEqual(stored.messages); expect(pending.list()).toEqual([]);
    expect(pending.busy('project', 'chat')).toBe(false);
  });

  it('previews the next-turn queue without adding a premature reply or duplicate queue item', () => {
    const pending = new ConversationSubmissions(); const entry = pending.add(submission(true));
    const displayed = pending.project('project', session(), false);
    expect(displayed.messages).toEqual([]); expect(displayed.queuedInputs).toEqual([entry.input]);
    expect(pending.project('project', displayed, false).queuedInputs).toEqual([entry.input]);
    const accepted = { ...session(), queuedInputs: [structuredClone(entry.input)] };
    expect(pending.project('project', accepted, true).queuedInputs).toEqual(accepted.queuedInputs);
    expect(pending.list()).toEqual([]);
  });

  it('withdraws only unsent local input and removes its preview without waiting for a server snapshot', () => {
    const pending = new ConversationSubmissions(); pending.add(submission(true));
    const displayed = pending.project('project', session(), false);
    expect(pending.discardPending('request')).toBe(true);
    expect(pending.project('project', displayed, false).queuedInputs).toEqual([]);
    expect(pending.busy('project', 'chat')).toBe(false);
    pending.add({ ...submission(true), phase: 'sending' });
    expect(pending.discardPending('request')).toBe(false); expect(pending.list()).toHaveLength(1);
  });

  it('reconciles edited queue submissions even though their queue row retains its original identity', () => {
    const pending = new ConversationSubmissions(); const entry = pending.add({ ...submission(true), replacesId: 'old-queue-id' });
    const stored = { ...session(), queuedInputs: [{ ...entry.input, id: 'old-queue-id', text: 'Original text' }] };
    expect(pending.project('project', stored, true).queuedInputs).toEqual([entry.input]);
    stored.queuedInputs[0] = { ...entry.input, id: 'old-queue-id', requestId: 'request' };
    expect(pending.project('project', stored, true).queuedInputs).toEqual(stored.queuedInputs);
    expect(pending.list()).toEqual([]);
  });

  it('retains failed delivery and its attachments, retries the same identity, and accepts a late committed snapshot', () => {
    const pending = new ConversationSubmissions(); const entry = pending.add(submission(true));
    pending.fail('request', 'Connection interrupted');
    const displayed = pending.project('project', session(), true);
    expect(displayed.queuedInputs).toEqual([]);
    expect(displayed.messages[1]).toMatchObject({ status: 'failed', error: 'Connection interrupted' });
    expect(pending.forMessage(displayed.messages[1])).toBe(entry);
    pending.retry('request'); expect(entry.phase).toBe('pending'); expect(entry.input.id).toBe('request');
    expect(pending.project('project', displayed, false).queuedInputs).toEqual([entry.input]);
    pending.fail('request', 'Lost response');
    expect(pending.project('project', { ...session(), queuedInputs: [structuredClone(entry.input)] }, true).messages).toEqual([]);
    expect(pending.list()).toEqual([]);
  });

  it('keeps pending work scoped, preserves message order and discards a deleted conversation', () => {
    const pending = new ConversationSubmissions(); pending.add(submission());
    expect(pending.project('other-project', session(), true).messages).toEqual([]);
    expect(pending.project('project', session('other-chat'), true).messages).toEqual([]);
    pending.fail('request', 'Rejected');
    const next = { ...session(), messages: [{ role: 'user' as const, content: 'Next message', createdAt: 200 }] };
    expect(pending.project('project', next, true).messages.map(message => message.content)).toEqual(['Inspect file', '', 'Next message']);
    pending.retain('other-project', new Set()); expect(pending.list()).toHaveLength(1);
    pending.retain('project', new Set()); expect(pending.list()).toEqual([]);
  });

  it('restores unconfirmed sends for inspection and explicit retry, without automatic dispatch', () => {
    const previous = new ConversationSubmissions(); previous.add({ ...submission(), phase: 'sending' });
    const restored = new ConversationSubmissions(JSON.parse(JSON.stringify(previous.list())), 'Delivery unconfirmed');
    expect(restored.list()[0]).toMatchObject({ phase: 'failed', error: 'Delivery unconfirmed', input: { id: 'request' } });
    expect(restored.busy('project', 'chat')).toBe(false);
    expect(restored.project('project', session(), true).messages[1]).toMatchObject({ status: 'failed', error: 'Delivery unconfirmed' });
    expect(restored.project('project', { ...session(), messages: [{ id: 'request', role: 'assistant', content: 'Already accepted' }] }, true).messages).toHaveLength(1);
    expect(restored.list()).toEqual([]);
  });
});
