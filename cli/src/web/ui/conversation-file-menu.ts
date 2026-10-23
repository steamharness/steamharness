import { t } from '../localization';
import { iconHtml } from './ui';

export class ConversationFileMenu {
  private readonly menu = document.createElement('div');

  constructor(trigger: HTMLButtonElement, select: (kind: 'files' | 'folders') => void) {
    this.menu.className = 'session-menu'; this.menu.id = 'conversation-file-menu'; this.menu.popover = 'manual'; this.menu.setAttribute('role', 'menu');
    trigger.title = trigger.ariaLabel = t('Add files or folders');
    this.menu.ariaLabel = trigger.ariaLabel;
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-controls', this.menu.id); trigger.setAttribute('aria-expanded', 'false');
    for (const [kind, icon, label] of [['files', 'file', t('Choose files')], ['folders', 'folder', t('Choose folders')]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'session-action'; button.dataset.kind = kind; button.setAttribute('role', 'menuitem');
      button.innerHTML = `${iconHtml(icon)}<span></span>`; button.lastElementChild!.textContent = label;
      button.addEventListener('click', () => { this.close(); trigger.focus(); select(kind); }); this.menu.append(button);
    }
    this.menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(this.menu.matches(':popover-open'))));
    document.addEventListener('pointerdown', event => {
      if (event.target instanceof Node && !trigger.contains(event.target) && !this.menu.contains(event.target)) this.close();
    });
    this.menu.addEventListener('focusout', event => {
      if (!(event.relatedTarget instanceof Node) || !this.menu.contains(event.relatedTarget) && !trigger.contains(event.relatedTarget)) this.close();
    });
    this.menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); trigger.focus(); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...this.menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    });
    trigger.addEventListener('click', () => {
      if (trigger.disabled) return;
      if (this.menu.matches(':popover-open')) { this.close(); return; }
      this.menu.showPopover();
      const rect = trigger.getBoundingClientRect();
      this.menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - this.menu.offsetWidth - 8))}px`;
      this.menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
      this.menu.querySelector('button')!.focus();
    });
    document.body.append(this.menu);
  }

  close(): void { if (this.menu.matches(':popover-open')) this.menu.hidePopover(); }
}
