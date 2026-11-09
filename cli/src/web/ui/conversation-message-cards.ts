import type { KanbanConversationMessageCard } from '@steamharness/kanban-project';
import { updateIcon } from './ui';

interface CardView { root: HTMLElement; icon: HTMLElement; title: HTMLElement; text: HTMLElement; status: HTMLElement; signature?: string }

/** Keep project cards in their assistant message and preserve selection during streaming. */
export class ConversationMessageCards {
  readonly root = document.createElement('div');
  private readonly views = new Map<string, CardView>();
  constructor() { this.root.className = 'conversation-message-cards'; this.root.hidden = true; }
  update(cards: readonly KanbanConversationMessageCard[]): void {
    const active = new Set<string>();
    cards.forEach((card, index) => {
      active.add(card.id);
      let view = this.views.get(card.id);
      if (!view) {
        const root = document.createElement('section'); root.className = 'conversation-message-card'; root.dataset.messageCardId = card.id;
        const header = document.createElement('header'), icon = document.createElement('span'), title = document.createElement('strong'), status = document.createElement('span'), text = document.createElement('div');
        icon.className = 'message-card-icon'; title.className = 'message-card-title'; status.className = 'message-card-status'; text.className = 'message-card-text';
        header.append(icon, title, status); root.append(header, text);
        view = { root, icon, title, text, status }; this.views.set(card.id, view);
      }
      const signature = JSON.stringify(card);
      if (view.signature !== signature) {
        view.signature = signature; view.root.dataset.requestId = card.requestId; view.root.setAttribute('aria-label', card.title);
        if (view.title.textContent !== card.title) view.title.textContent = card.title;
        if (view.text.textContent !== card.text) view.text.textContent = card.text;
        if (view.status.textContent !== (card.status?.label ?? '')) view.status.textContent = card.status?.label ?? '';
        view.status.hidden = !card.status; view.status.dataset.tone = card.status?.tone ?? 'neutral';
        view.icon.style.color = card.iconColor ?? '';
        updateIcon(view.icon, card.icon === 'bot' ? 'hubot' : card.icon === 'send' ? 'send' : 'comment-discussion');
      }
      if (this.root.children[index] !== view.root) this.root.insertBefore(view.root, this.root.children[index] ?? null);
    });
    for (const [id, view] of this.views) if (!active.has(id)) { view.root.remove(); this.views.delete(id); }
    this.root.hidden = !cards.length;
  }
}
