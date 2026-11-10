// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
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

it('updates card summaries and routes clicks with the current turn identity', () => {
  const onAction = vi.fn(), cards = new ConversationMessageCards(onAction); document.body.append(cards.root);
  try {
    const first = { id: 'delivery', requestId: 'turn-1', title: '发送给执行员', text: '运行中', action: { label: '查看与执行员的协作对话' } };
    cards.update([first]);
    const root = cards.root.firstElementChild as HTMLElement, preview = root.querySelector('.message-card-text')!;
    const open = root.querySelector<HTMLButtonElement>('button')!;
    expect(preview.textContent).toBe('运行中'); expect(root.querySelector('script,a')).toBeNull();
    root.click(); expect(onAction).toHaveBeenLastCalledWith({ id: 'delivery', requestId: 'turn-1' });
    cards.update([{ ...first, requestId: 'turn-2', text: '最后一句回复。' }]);
    expect(root.querySelector('.message-card-text')).toBe(preview);
    expect(root.querySelector('button')).toBe(open); expect(preview.textContent).toBe('最后一句回复。');
    open.click(); expect(onAction).toHaveBeenLastCalledWith({ id: 'delivery', requestId: 'turn-2' });
    cards.update([]); cards.update([first]); root.click(); expect(onAction).toHaveBeenCalledTimes(2);
    cards.update([{ ...first, action: undefined }]);
    expect(cards.root.querySelector('button')).toBeNull();
    (cards.root.firstElementChild as HTMLElement).click(); expect(onAction).toHaveBeenCalledTimes(2);
  } finally { cards.root.remove(); }
});
