import type { KanbanConversationMessageCard } from '@steamharness/kanban-project';
import { updateIcon } from './ui';

interface CardView {
  root: HTMLElement; header: HTMLElement; icon: HTMLElement; title: HTMLElement; text: HTMLElement; status: HTMLElement;
  action?: HTMLButtonElement;
  card?: KanbanConversationMessageCard; signature?: string;
}

/** Keep project cards in their assistant message and preserve selection during streaming. */
export class ConversationMessageCards {
  readonly root = document.createElement('div');
  private readonly views = new Map<string, CardView>();
  constructor(private readonly onAction?: (event: { id: string; requestId: string }) => void) { this.root.className = 'conversation-message-cards'; this.root.hidden = true; }
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
        view = { root, header, icon, title, text, status }; this.views.set(card.id, view);
        root.addEventListener('click', event => {
          const currentView = this.views.get(card.id);
          if (currentView?.root !== root) return;
          const current = currentView.card;
          if (!current?.action) return;
          const selection = window.getSelection();
          if (!(event.target as Element).closest('button') && selection && !selection.isCollapsed && root.contains(selection.anchorNode)) return;
          this.onAction?.({ id: current.id, requestId: current.requestId });
        });
      }
      view.card = card;
      const signature = JSON.stringify(card);
      if (view.signature !== signature) {
        view.signature = signature; view.root.dataset.requestId = card.requestId; view.root.setAttribute('aria-label', card.title);
        if (view.title.textContent !== card.title) view.title.textContent = card.title;
        if (view.text.textContent !== card.text) view.text.textContent = card.text;
        if (view.status.textContent !== (card.status?.label ?? '')) view.status.textContent = card.status?.label ?? '';
        view.status.hidden = !card.status; view.status.dataset.tone = card.status?.tone ?? 'neutral';
        view.icon.style.color = card.iconColor ?? '';
        updateIcon(view.icon, card.icon === 'bot' ? 'hubot' : card.icon === 'send' ? 'send' : 'comment-discussion');
        view.root.classList.toggle('actionable', !!card.action);
        if (card.action) {
          if (!view.action) {
            view.action = document.createElement('button'); view.action.type = 'button'; view.action.className = 'message-card-open';
            updateIcon(view.action, 'chevron-right'); view.header.append(view.action);
          }
          view.action.setAttribute('aria-label', card.action.label); view.action.title = card.action.label;
        } else { view.action?.remove(); view.action = undefined; }
      }
      if (this.root.children[index] !== view.root) this.root.insertBefore(view.root, this.root.children[index] ?? null);
    });
    for (const [id, view] of this.views) if (!active.has(id)) { view.root.remove(); this.views.delete(id); }
    this.root.hidden = !cards.length;
  }
}
