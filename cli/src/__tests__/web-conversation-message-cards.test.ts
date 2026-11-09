// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { ConversationMessageCards } from '../web/ui/conversation-message-cards';

it('renders plain cards without navigation and reuses their DOM on status updates', () => {
  const cards = new ConversationMessageCards(); document.body.append(cards.root);
  try {
    const first = { id: 'send-1', requestId: 'turn-1', title: '发送给执行员', text: '<img src=x onerror=run()>\n你好', icon: 'bot' as const, status: { label: '等待发送', tone: 'warning' as const } };
    cards.update([first]);
    const root = cards.root.firstElementChild!;
    const text = root.querySelector('.message-card-text')!;
    expect(root.getAttribute('aria-label')).toBe('发送给执行员');
    expect(text.textContent).toBe(first.text);
    expect(root.querySelector('img,a,button')).toBeNull();
    const textNode = text.firstChild;
    cards.update([{ ...first, status: { label: '已发送', tone: 'success' } }]);
    expect(cards.root.firstElementChild).toBe(root);
    expect(text.firstChild).toBe(textNode);
    expect(root.querySelector('.message-card-status')?.textContent).toBe('已发送');
    cards.update([{ ...first, id: 'send-2', requestId: 'turn-2', text: '另一轮发送' }, first]);
    expect(cards.root.children[1]).toBe(root);
    cards.update([]); expect(cards.root.hidden).toBe(true); expect(cards.root.children).toHaveLength(0);
  } finally { cards.root.remove(); }
});
