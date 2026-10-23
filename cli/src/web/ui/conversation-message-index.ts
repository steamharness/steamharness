import { t } from '../localization';
import type { ConversationMessage } from '../workflow-types';

export interface IndexedUserMessage { root: HTMLElement; message: ConversationMessage }
interface Marker extends IndexedUserMessage { button: HTMLButtonElement; number: number }

/** A compact index of the user messages actually rendered in the transcript. */
export class ConversationMessageIndex {
  readonly root = document.createElement('nav');
  private readonly count = document.createElement('span');
  private readonly list = document.createElement('div');
  private readonly preview = document.createElement('div');
  private readonly heading = document.createElement('div');
  private readonly content = document.createElement('div');
  private readonly narrow = window.matchMedia('(max-width: 680px)');
  private markers: Marker[] = [];
  private current?: Marker;
  private previewed?: Marker;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private listHeight = 0;

  constructor(private readonly transcript: HTMLElement, jump: (target: HTMLElement) => void) {
    this.root.className = 'conversation-message-index'; this.root.hidden = true;
    this.count.className = 'message-index-count'; this.count.setAttribute('aria-hidden', 'true');
    this.list.className = 'message-index-list';
    this.preview.className = 'message-index-preview'; this.preview.id = 'message-index-preview';
    this.preview.setAttribute('role', 'tooltip'); this.preview.hidden = true;
    this.heading.className = 'message-index-heading'; this.content.className = 'message-index-content';
    this.preview.append(this.heading, this.content); this.root.append(this.count, this.list);
    transcript.parentElement!.append(this.root, this.preview);

    const leave = (event: MouseEvent): void => {
      if (event.relatedTarget instanceof Node && (this.root.contains(event.relatedTarget) || this.preview.contains(event.relatedTarget))) return;
      if (!this.root.contains(document.activeElement)) {
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.closePreview(), 100);
      }
    };
    this.root.addEventListener('pointerleave', leave);
    this.preview.addEventListener('pointerleave', leave);
    this.preview.addEventListener('pointerenter', () => clearTimeout(this.closeTimer));
    this.root.addEventListener('focusout', event => {
      if (!(event.relatedTarget instanceof Node) || !this.root.contains(event.relatedTarget)) this.closePreview();
    });
    this.list.addEventListener('scroll', () => this.positionPreview(), { passive: true });
    this.list.addEventListener('click', event => {
      const marker = this.markerFor(event.target);
      if (marker) { jump(marker.root); this.closePreview(); }
    });
    this.list.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closePreview(); return; }
      const marker = this.markerFor(event.target);
      if (!marker || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? this.markers.length - 1
        : Math.max(0, Math.min(this.markers.length - 1, marker.number - 1 + (event.key === 'ArrowDown' ? 1 : -1)));
      const next = this.markers[index];
      this.reveal(next); next.button.focus({ preventScroll: true });
    });
  }

  update(messages: readonly IndexedUserMessage[]): void {
    const previous = new Map(this.markers.map(marker => [marker.root, marker]));
    this.markers = messages.map(({ root, message }, index) => {
      let marker = previous.get(root);
      if (!marker) {
        const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1; button.className = 'message-index-marker';
        marker = { root, message, button, number: index + 1 };
        const created = marker;
        button.addEventListener('pointerenter', () => this.showPreview(created));
        button.addEventListener('focus', () => this.showPreview(created));
      }
      marker.message = message; marker.number = index + 1;
      marker.button.setAttribute('aria-label', t('User message {0} of {1}', index + 1, messages.length));
      if (this.list.children[index] !== marker.button) this.list.insertBefore(marker.button, this.list.children[index] ?? null);
      previous.delete(root);
      return marker;
    });
    for (const marker of previous.values()) marker.button.remove();
    this.count.textContent = String(messages.length);
    this.root.setAttribute('aria-label', t('User messages ({0})', messages.length));
    if (this.previewed && !this.markers.includes(this.previewed)) this.closePreview();
    else if (this.previewed) this.refreshPreview();
    if (messages.length < 3) this.hide();
  }

  syncLayout(): void {
    if (this.narrow.matches || this.markers.length < 3 || this.transcript.clientHeight === 0 || this.transcript.scrollHeight <= this.transcript.clientHeight + 1) {
      this.hide(); return;
    }
    this.root.hidden = false; this.transcript.parentElement!.classList.add('has-message-index');
    const readingTop = this.transcript.getBoundingClientRect().top + 32;
    let low = 0, high = this.markers.length - 1;
    // Message positions stay ordered, even as streamed replies and cards grow.
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.markers[middle].root.getBoundingClientRect().top <= readingTop) low = middle;
      else high = middle - 1;
    }
    const atBottom = this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight <= 1;
    const current = this.markers[atBottom ? this.markers.length - 1 : low];
    const changed = this.current !== current;
    if (changed) {
      if (this.current) { this.current.button.removeAttribute('aria-current'); this.current.button.tabIndex = -1; }
      current.button.setAttribute('aria-current', 'location'); current.button.tabIndex = 0;
      this.current = current;
    }
    if ((changed || this.listHeight !== this.list.clientHeight) && !this.root.contains(document.activeElement) && !this.root.matches(':hover')) this.reveal(current);
    this.listHeight = this.list.clientHeight;
    this.positionPreview();
  }

  closePreview(): void {
    clearTimeout(this.closeTimer); this.closeTimer = undefined;
    this.previewed?.button.removeAttribute('aria-describedby');
    this.previewed = undefined; this.preview.hidden = true;
  }

  private hide(): void {
    this.root.hidden = true; this.transcript.parentElement!.classList.remove('has-message-index'); this.closePreview();
  }

  private markerFor(target: EventTarget | null): Marker | undefined {
    const button = target instanceof Element ? target.closest('button') : undefined;
    return this.markers.find(marker => marker.button === button);
  }

  private showPreview(marker: Marker): void {
    if (this.root.hidden) return;
    clearTimeout(this.closeTimer);
    this.previewed?.button.removeAttribute('aria-describedby');
    this.previewed = marker; marker.button.setAttribute('aria-describedby', this.preview.id);
    this.refreshPreview();
  }

  private refreshPreview(): void {
    const marker = this.previewed!;
    this.heading.textContent = t('User message {0} of {1}', marker.number, this.markers.length);
    const message = marker.message;
    const text = [message.content.trim() || message.args?.join(' '), ...(message.attachments ?? []).map(file => file.name)].filter(Boolean).join('\n');
    this.content.textContent = text ? text.slice(0, 2000) + (text.length > 2000 ? '…' : '') : t('Message without text');
    this.preview.hidden = false; this.positionPreview();
  }

  private positionPreview(): void {
    if (!this.previewed || this.preview.hidden) return;
    const marker = this.previewed.button.getBoundingClientRect(), list = this.list.getBoundingClientRect();
    if (marker.bottom < list.top || marker.top > list.bottom) { this.closePreview(); return; }
    const area = this.transcript.parentElement!.getBoundingClientRect();
    const top = marker.top - area.top + (marker.height - this.preview.offsetHeight) / 2;
    this.preview.style.top = `${Math.max(8, Math.min(top, area.height - this.preview.offsetHeight - 8))}px`;
  }

  private reveal(marker: Marker): void {
    const button = marker.button, top = button.offsetTop, bottom = top + button.offsetHeight;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight;
  }
}
