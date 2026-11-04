import { describe, expect, it } from 'vitest';
import { scopeConversationViewMessage } from '../web/conversation-view';

describe('Embedded Conversation scope', () => {
  it('pins the host client identity and rejects access to another session, project or host capability', () => {
    expect(scopeConversationViewMessage({ type: 'send', sessionId: 'bot-private', text: 'Hello', clientId: 'forged' }, 'bot-private', '/project', 'trusted'))
      .toMatchObject({ clientId: 'trusted', projectUri: '/project', sessionId: 'bot-private' });
    for (const message of [{ type: 'send', sessionId: 'other' }, { type: 'send', projectUri: '/other' },
      { type: 'project-configuration', call: { action: 'save' } }, { type: 'databases' }, { type: 'login' },
      { type: 'navigate', id: 'other', updates: [] }, { type: 'navigate', id: 'bot-private', updates: [{ id: 'other' }] },
      { type: 'navigate', id: 'bot-private', updates: [{ id: 'bot-private', create: true }] }])
      expect(() => scopeConversationViewMessage(message, 'bot-private', '/project', 'trusted')).toThrow();
    expect(scopeConversationViewMessage({ type: 'navigate', id: 'bot-private', updates: [{ id: 'bot-private', draft: { text: 'Keep' } }] }, 'bot-private', '/project', 'trusted')).toMatchObject({ id: 'bot-private' });
    expect(scopeConversationViewMessage({ type: 'agent-command', command: { type: 'cancel', scope: 'all' } }, 'bot-private', '/project', 'trusted')).toMatchObject({ sessionId: 'bot-private' });
    for (const command of [{ type: 'fork' }, { type: 'cancel', scope: 'other' }, { type: 'steer' }])
      expect(() => scopeConversationViewMessage({ type: 'agent-command', command }, 'bot-private', '/project', 'trusted')).toThrow();
  });
});
