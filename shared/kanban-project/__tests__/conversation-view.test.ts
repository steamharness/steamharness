import { describe, expect, it, vi } from 'vitest';
import { assertConversationUi, createKanbanBridgeScript, parseKanbanBridgeCall, type KanbanBrowserApi } from '../index';

describe('embedded Conversation bridge', () => {
  it('accepts declarative project references and rejects reserved or unbounded UI data', () => {
    const ui = { presentation: 'composer', mentions: [{ kind: 'bot', label: 'Bot', items: [{ value: 'researcher', label: '研究员' }] }] };
    expect(() => assertConversationUi(ui)).not.toThrow();
    for (const bad of [{ ...ui, html: '<script>' }, { mentions: [{ ...ui.mentions[0], kind: 'file' }] },
      { mentions: [ui.mentions[0], ui.mentions[0]] }, { mentions: [{ ...ui.mentions[0], items: Array(201).fill(ui.mentions[0]!.items[0]) }] },
      { presentation: 'unknown' }, { presentation: ['conversation'] }, { mentions: [{ ...ui.mentions[0], items: [{ value: 'x', label: 'X', action: 'run' }] }] }])
      expect(() => assertConversationUi(bad)).toThrow();
  });
  it('validates bounded target data and rejects caller-selected identities', () => {
    const parse = (operation: string, input: object) => parseKanbanBridgeCall({ requestId: 'request', operation, input });
    const target = { viewId: 'view-1', entryId: 'agent', conversationId: 'private', locale: 'zh-CN' };
    expect(parse('entries.list', {}).operation).toBe('entries.list');
    expect(parse('conversations.openView', target).input).toEqual(target);
    for (const input of [{ ...target, userId: 'forged' }, { ...target, projectId: 'other' }, { ...target, entryId: '../other' },
      { ...target, viewId: '<script>' }, { ...target, locale: 'unknown' }, { ...target, draft: 'x'.repeat(100_001) },
      { ...target, submit: { entryId: 'api', entrypointId: 'send', payload: {}, sourceEntryId: 'forged' } }])
      expect(() => parse('conversations.openView', input)).toThrow();
    expect(() => parse('conversations.viewMessage', { viewId: 'view-1', message: 'bad' })).toThrow();
  });

  it('mounts a sandboxed native frame, pins its source, and cleans up its host view', async () => {
    const listeners = new Map<string, Set<(event: any) => void>>();
    const posted: any[] = [], parent = { postMessage: (message: any) => posted.push(message) };
    const pageWindow = {
      parent, setTimeout, clearTimeout, dispatchEvent: vi.fn(),
      addEventListener(type: string, listener: (event: any) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
      removeEventListener(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener); },
    } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
    const send = (source: unknown, data: object) => { for (const listener of [...listeners.get('message') ?? []]) listener({ source, data }); };
    const reply = (call: any, value: unknown) => send(parent, { type: 'steamharness:kanban-bridge-response', nonce: 'nonce', requestId: call.requestId, ok: true, value });
    const script = createKanbanBridgeScript({ id: 'workspace', name: 'Workspace', params: {} }, 'nonce').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    new Function('window', 'document', script)(pageWindow, document);
    const container = document.createElement('div'); document.body.append(container);
    try {
      const transcript = document.createElement('div'), submitted = vi.fn(), submission = vi.fn();
      const mounting = pageWindow.steamHarnessKanban.conversations.mount(container, { entryId: 'agent', conversationId: 'private', ui: { presentation: 'composer' } },
        { slots: { transcript }, onSubmitted: submitted, onSubmission: submission });
      const opened = posted.at(-1);
      expect(opened).toMatchObject({ operation: 'conversations.openView', input: { entryId: 'agent', conversationId: 'private', documentId: expect.any(String) } });
      reply(opened, { html: '<html><body>Native</body></html>' });
      const dispose = await mounting;
      const frame = container.querySelector('iframe')!;
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      const viewId = opened.input.viewId;
      expect(container.querySelector('[data-conversation-slot=transcript]')).toBe(transcript);
      expect(container.querySelector('[data-conversation-shell]')?.getAttribute('data-presentation')).toBe('composer');
      const submissionEnvelope = { type: 'steamharness:conversation-request', viewId, message: { type: 'send', requestId: 'submit-1', text: '@bot:researcher 内容' } };
      const beforeSend = posted.length;
      send({}, submissionEnvelope); expect(posted).toHaveLength(beforeSend);
      expect(submission).not.toHaveBeenCalled();
      send(frame.contentWindow, submissionEnvelope);
      await vi.waitFor(() => expect(submission).toHaveBeenCalledWith(expect.objectContaining({ phase: 'sending', requestId: 'submit-1', text: '@bot:researcher 内容' })));
      expect(submitted).not.toHaveBeenCalled();
      const receipts = [{ id: 'receipt', conversationId: 'another-bot', status: 'queued' }];
      reply(posted.at(-1), [{ type: 'sent', requestId: 'submit-1', receiptId: 'receipt', submissionResult: receipts }]);
      await vi.waitFor(() => expect(submission).toHaveBeenCalledWith(expect.objectContaining({ phase: 'accepted', receiptId: 'receipt', result: receipts })));
      expect(submitted).toHaveBeenCalledTimes(1);
      const updating = dispose.update({ presentation: 'conversation' });
      await Promise.resolve(); await Promise.resolve();
      const update = posted.at(-1); expect(update.input.message.type).toBe('view-ui'); reply(update, []); await updating;
      expect(transcript.hidden).toBe(true);
      const envelope = { type: 'steamharness:conversation-request', viewId, message: { type: 'ready' } };
      const count = posted.length;
      send({}, envelope); expect(posted).toHaveLength(count);
      send(frame.contentWindow, envelope);
      const message = posted.at(-1);
      expect(message).toMatchObject({ operation: 'conversations.viewMessage', input: { viewId, message: { type: 'ready' } } });
      reply(message, []); await Promise.resolve();
      send(frame.contentWindow, { ...envelope, message: { type: 'view-ready' } });
      await Promise.resolve(); expect(submitted).toHaveBeenCalledTimes(1); // Backlog playback cannot acknowledge twice.
      const retryDelivery = vi.spyOn(frame.contentWindow!, 'postMessage');
      dispose.retry('submit-1');
      expect(retryDelivery).toHaveBeenCalledWith(expect.objectContaining({ message: { type: 'conversation-retry', requestId: 'submit-1' } }), '*');
      send(frame.contentWindow, { ...submissionEnvelope, message: { ...submissionEnvelope.message, requestId: 'submit-failed' } });
      const failedCall = posted.at(-1);
      send(parent, { type: 'steamharness:kanban-bridge-response', nonce: 'nonce', requestId: failedCall.requestId, ok: false,
        error: { code: 'KANBAN_BRIDGE_UNAVAILABLE', message: 'Request failed' } });
      await vi.waitFor(() => expect(submission).toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed', requestId: 'submit-failed', error: expect.any(String) })));

      const delivered = vi.spyOn(frame.contentWindow!, 'postMessage');
      for (const code of ['KANBAN_BRIDGE_UNAVAILABLE', 'KANBAN_BRIDGE_ERROR']) {
        send(frame.contentWindow, { ...envelope, message: { type: 'navigate', requestId: code } });
        const call = posted.at(-1);
        send(parent, { type: 'steamharness:kanban-bridge-response', nonce: 'nonce', requestId: call.requestId, ok: false,
          error: { code, message: 'Request failed' } });
        await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(expect.objectContaining({
          message: expect.objectContaining({ type: 'error', requestType: 'navigate', requestId: code,
            connectionError: code === 'KANBAN_BRIDGE_UNAVAILABLE', silent: code === 'KANBAN_BRIDGE_UNAVAILABLE' }),
        }), '*'));
      }
      dispose(); expect(container.children).toHaveLength(0);
      expect(posted.at(-1)).toMatchObject({ operation: 'conversations.closeView', input: { viewId } });
      reply(posted.at(-1), {});
      const stopped = posted.length; send(frame.contentWindow, envelope); expect(posted).toHaveLength(stopped);
    } finally { container.remove(); }
  });
});
