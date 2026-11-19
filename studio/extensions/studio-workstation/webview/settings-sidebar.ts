import { t } from './localization';
import type { SidebarEdit, SidebarItem } from '../src/project-sidebar-types';
import type { SettingsState } from '../src/settings-types';

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const icon = (name: string) => {
  const node = element('span', `codicon codicon-${name}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
};

export class SettingsSidebar {
  private state?: SettingsState['sidebar'];
  private busy = false;
  private pendingVisibility?: { id: string; checked: boolean };
  private signature = '';
  private focus?: { id: string; action: string };
  private readonly rows = element('ol', 'settings-card settings-sidebar-projects');
  private readonly error = element('div', 'settings-error');
  private readonly add = element('button', 'primary');

  constructor(private readonly root: HTMLElement, private readonly post: (message: unknown) => void) {
    const group = element('section', 'settings-group');
    const heading = element('div', 'section-heading settings-sidebar-heading');
    this.add.type = 'button';
    this.add.append(icon('add'), element('span', '', t('Add from History')));
    this.add.addEventListener('click', () => this.edit({ action: 'add' }));
    this.add.disabled = true;
    heading.append(element('h2', '', t('Project Tabs')), this.add);
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    this.rows.setAttribute('role', 'list');
    group.append(heading, this.error, this.rows);
    root.append(group);
  }

  update(state: SettingsState['sidebar'], done = false, error = ''): void {
    if (done) {
      this.busy = false;
      this.pendingVisibility = undefined;
    }
    this.state = state;
    this.error.textContent = error;
    this.error.hidden = !error;
    const signature = JSON.stringify([state, this.busy]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.add.disabled = this.busy || !state?.canAdd;
    const active = document.activeElement as HTMLElement | null;
    const restore = this.root.contains(active) || done && active === document.body;
    if (active?.dataset.sidebarId && active.dataset.sidebarAction) this.focus = { id: active.dataset.sidebarId, action: active.dataset.sidebarAction };
    this.rows.replaceChildren(...(state?.items ?? []).map((item, index, items) => this.row(item, index, items.length)));
    if (restore && !this.busy && this.focus) {
      const controls = [...this.rows.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-sidebar-action]')];
      (controls.find(control => !control.disabled && control.dataset.sidebarId === this.focus?.id && control.dataset.sidebarAction === this.focus?.action) ??
        controls.find(control => !control.disabled && control.dataset.sidebarId === this.focus?.id) ?? this.add).focus();
    }
    if (done) this.focus = undefined;
  }

  private edit(edit: SidebarEdit, checked?: boolean): void {
    if (this.busy) return;
    if (edit.action === 'toggle' && checked !== undefined) this.pendingVisibility = { id: edit.id, checked };
    this.busy = true;
    this.update(this.state);
    this.post({ type: 'settings-sidebar', ...edit });
  }

  private row(item: SidebarItem, index: number, count: number): HTMLLIElement {
    const row = element('li', 'setting-row');
    const kind = item.type === 'bot' ? t('Bot') : item.type === 'kanban' ? t('Kanban') : t('Workflow');
    const copy = element('div', 'setting-copy');
    copy.append(element('strong', 'setting-label', item.title), element('p', 'muted setting-description', item.builtin ? t('{0} · Built-in', kind) : kind));
    if (item.directory) copy.append(element('p', 'muted setting-description', item.directory));
    const controls = element('div', 'setting-controls settings-sidebar-controls');
    const button = (action: 'up' | 'down' | 'remove', label: string, symbol: string, disabled = false) => {
      const target = element('button', 'icon-button');
      target.type = 'button'; target.disabled = this.busy || disabled;
      target.title = label; target.setAttribute('aria-label', t('{0}: {1}', label, item.title));
      target.dataset.sidebarId = item.id; target.dataset.sidebarAction = action;
      target.append(icon(symbol)); target.addEventListener('click', () => this.edit({ action, id: item.id }));
      return target;
    };
    if (item.builtin) {
      const pinned = element('span', 'settings-sidebar-visibility muted');
      pinned.title = t('Built-in projects cannot be hidden.');
      pinned.append(icon('lock'), document.createTextNode(t('Always visible')));
      controls.append(pinned);
    } else {
      const label = element('label', 'settings-sidebar-visibility');
      const visible = element('input', '');
      visible.type = 'checkbox';
      visible.checked = this.pendingVisibility?.id === item.id ? this.pendingVisibility.checked : item.visible;
      visible.disabled = this.busy;
      visible.dataset.sidebarId = item.id; visible.dataset.sidebarAction = 'toggle';
      visible.setAttribute('role', 'switch');
      visible.setAttribute('aria-label', t('Show {0} in the sidebar', item.title));
      visible.addEventListener('change', () => this.edit({ action: 'toggle', id: item.id }, visible.checked));
      label.append(visible, document.createTextNode(t('Visible')));
      controls.append(label);
    }
    const actions = element('div', 'settings-sidebar-actions');
    actions.append(button('up', t('Move up'), 'arrow-up', index === 0), button('down', t('Move down'), 'arrow-down', index === count - 1));
    if (!item.builtin) actions.append(button('remove', t('Remove from sidebar'), 'trash'));
    controls.append(actions);
    row.append(copy, controls);
    return row;
  }
}
