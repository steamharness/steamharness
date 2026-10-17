import { t } from '../localization';
import { iconButton } from './ui';

export class ContentSearch {
  private readonly root = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly count = document.createElement('span');
  private matches: HTMLElement[] = [];
  private index = 0;
  constructor(private readonly content: HTMLElement) {
    this.root.className = 'content-search'; this.root.hidden = true; this.root.setAttribute('role', 'search');
    this.input.type = 'search'; this.input.placeholder = this.input.ariaLabel = t("Search conversation content");
    this.root.append(this.input, this.count, iconButton('chevron-up', t("Previous"), () => this.next(-1)), iconButton('chevron-down', t("Next"), () => this.next(1)), iconButton('close', t("Close search"), () => this.close()));
    content.parentElement!.append(this.root);
    this.input.addEventListener('input', () => { this.index = 0; this.refresh(); this.scroll(); });
    this.input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); this.next(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') { event.stopPropagation(); this.close(); } });
  }
  open(): void { this.root.hidden = false; this.refresh(); this.input.focus(); this.input.select(); }
  close(): void { this.root.hidden = true; this.clear(); }
  private clear(): void {
    for (const match of this.matches) { const parent = match.parentElement; match.replaceWith(document.createTextNode(match.textContent ?? '')); parent?.normalize(); }
    this.matches = [];
  }
  refresh(): void {
    this.clear();
    if (this.root.hidden || !this.input.value) { this.count.textContent = ''; return; }
    const query = this.input.value.toLocaleLowerCase();
    const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest('.message-content, .resolved-inputs') && !node.parentElement.closest('button, summary') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    const nodes: Text[] = []; while (walker.nextNode()) { nodes.push(walker.currentNode as Text); }
    for (const node of nodes) {
      const text = node.data; const lower = text.toLocaleLowerCase(); let start = 0; let found = lower.indexOf(query);
      if (found < 0) { continue; }
      const fragment = document.createDocumentFragment();
      while (found >= 0) {
        fragment.append(document.createTextNode(text.slice(start, found)));
        const mark = document.createElement('mark'); mark.textContent = text.slice(found, found + query.length); fragment.append(mark); this.matches.push(mark);
        start = found + query.length; found = lower.indexOf(query, start);
      }
      fragment.append(document.createTextNode(text.slice(start))); node.replaceWith(fragment);
    }
    this.index = Math.min(this.index, Math.max(0, this.matches.length - 1)); this.count.textContent = this.matches.length ? `${this.index + 1}/${this.matches.length}` : '0/0';
    this.matches[this.index]?.classList.add('current-match');
  }
  private scroll(): void { this.matches[this.index]?.scrollIntoView({ block: 'center' }); }
  private next(direction: number): void {
    if (!this.matches.length) { return; }
    this.index = (this.index + direction + this.matches.length) % this.matches.length; this.refresh(); this.scroll();
  }
}
