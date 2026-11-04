import { describe, expect, it, vi } from 'vitest';
import { KanbanController } from '../web/kanban-controller';
import { parseKanbanBridgeCall } from '@steamharness/kanban-project';
import type { Project, Runtime } from '../web/workflow-types';
import type { ConversationView } from '../web/conversation-view';

function fixture() {
  const views: ConversationView[] = [];
  const open = vi.fn(async (): Promise<ConversationView> => {
    const view = { html: '<html></html>', close: vi.fn(), request: vi.fn(async () => []) };
    views.push(view); return view;
  });
  const unsubscribe = vi.fn(), subscribe = vi.fn(() => unsubscribe);
  const controller = new KanbanController({ id: 'project', entryId: 'board' } as Project,
    { openConversationView: open, subscribeConversation: subscribe } as unknown as Runtime, '/unused', { changed() {}, emit: vi.fn(), connection() { return undefined; }, log() {} });
  controller.preview = { nonce: 'preview' } as typeof controller.preview;
  const call = (operation: string, input: object, clientId = 'page') => controller.bridge(parseKanbanBridgeCall({ requestId: 'request', operation, input }), clientId);
  const mount = (viewId: string, documentId = 'document', clientId = 'page') => call('conversations.openView', { viewId, documentId, entryId: 'agent', conversationId: 'conversation' }, clientId);
  return { controller, open, views, call, mount, subscribe, unsubscribe };
}

describe('Kanban Conversation view lifecycle', () => {
  it('releases only disconnected clients and permits their views and subscriptions to reconnect', async () => {
    const f = fixture();
    await f.mount('mine'); await f.mount('theirs', 'document', 'other');
    const subscription = { entryId: 'agent', conversationId: 'conversation', subscriptionId: 'subscription' };
    await f.call('conversations.subscribe', subscription);
    f.controller.disconnectClient('page');
    expect(f.views[0]!.close).toHaveBeenCalledOnce(); expect(f.views[1]!.close).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await f.mount('mine'); await f.call('conversations.subscribe', subscription);
    expect(f.subscribe).toHaveBeenCalledTimes(2);
    await f.controller.close();
  });
  it('binds views to a page client and releases old document views on reload', async () => {
    const f = fixture();
    await f.mount('first');
    await expect(f.call('conversations.viewMessage', { viewId: 'first', message: { type: 'ready' } }, 'other')).rejects.toThrow('expired');
    await expect(f.call('conversations.closeView', { viewId: 'first' }, 'other')).rejects.toThrow('expired');
    expect(f.views[0]!.close).not.toHaveBeenCalled();
    for (let index = 0; index < 12; index++) await f.mount(`reload-${index}`, `document-${index}`);
    expect(f.views.slice(0, -1).every(view => vi.mocked(view.close).mock.calls.length === 1)).toBe(true);
    await expect(f.call('conversations.viewMessage', { viewId: 'first', message: { type: 'ready' } })).rejects.toThrow('expired');
    await f.controller.close();
    expect(f.views.at(-1)!.close).toHaveBeenCalledOnce();
  });

  it('closes a late open after explicit disposal or an authentication change', async () => {
    for (const invalidate of ['close', 'authentication'] as const) {
      const f = fixture();
      let finish!: (view: ConversationView) => void;
      f.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = f.mount('pending');
      const rejected = expect(pending).rejects.toThrow('preview changed');
      if (invalidate === 'close') await f.call('conversations.closeView', { viewId: 'pending' });
      else f.controller.authenticationChanged();
      const view = { html: '', request: vi.fn(), close: vi.fn() };
      finish(view); await rejected;
      expect(view.close).toHaveBeenCalledOnce();
      await f.controller.close();
    }
  });
});
