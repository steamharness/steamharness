import { t, locale } from './localization';
import type { AccountSection, AccountSectionState } from '../src/account-section-types';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) { node.textContent = text; }
  return node;
}

function button(label: string, icon: string, action: () => void, iconOnly = false): HTMLButtonElement {
  const node = element('button', iconOnly ? 'icon-button' : 'text-button');
  node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
  node.append(element('span', `codicon codicon-${/^[a-z-]+$/.test(icon) ? icon : 'link-external'}`));
  node.firstElementChild!.setAttribute('aria-hidden', 'true');
  if (!iconOnly) { node.append(element('span', '', label)); }
  node.addEventListener('click', action);
  return node;
}

type PostMessage = (message: unknown) => void;

export function renderAccountSections(root: HTMLElement, states: AccountSectionState[], postMessage: PostMessage): void {
  const ids = new Set(states.map(state => state.id));
  for (const child of [...root.children] as HTMLElement[]) { if (!ids.has(child.dataset.provider!)) { child.remove(); } }
  for (const state of states) {
    let provider = [...root.children].find(child => (child as HTMLElement).dataset.provider === state.id) as HTMLElement | undefined;
    if (!provider) {
      provider = element('section', 'account-extension'); provider.dataset.provider = state.id;
      const header = element('header', 'section-heading');
      header.append(element('h2', '', state.title), element('span', 'section-updated muted'));
      header.append(button(t("Refresh"), 'refresh', () => postMessage({ type: 'refresh-sections' }), true));
      const message = element('div', 'section-message'); message.setAttribute('role', 'status');
      provider.append(header, message, element('div', 'section-content'));
      root.append(provider);
    }
    provider.setAttribute('aria-busy', String(state.loading));
    const refresh = provider.querySelector<HTMLButtonElement>('header button')!;
    refresh.disabled = state.loading;
    refresh.classList.toggle('refreshing', state.loading);
    provider.querySelector('.section-updated')!.textContent = state.updatedAt ? t("Updated {0}", new Date(state.updatedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })) : '';
    const message = provider.querySelector<HTMLElement>('.section-message')!;
    message.textContent = state.failed ? t("Unable to refresh this section. Try again.") : state.loading && !state.sections.length ? t("Loading...") : '';
    message.hidden = !message.textContent;
    message.classList.toggle('warning', state.failed);
    const content = provider.querySelector<HTMLElement>('.section-content')!;
    const sectionIds = new Set(state.sections.map(section => section.id));
    for (const child of [...content.children] as HTMLElement[]) { if (!sectionIds.has(child.dataset.section!)) { child.remove(); } }
    for (const section of state.sections) {
      let node = [...content.children].find(child => (child as HTMLElement).dataset.section === section.id) as HTMLElement | undefined;
      const signature = JSON.stringify(section);
      if (node?.dataset.signature === signature) { continue; }
      const oldInput = node?.querySelector('input');
      const filter = oldInput?.value ?? '';
      const focused = oldInput === document.activeElement;
      const selection = [oldInput?.selectionStart ?? 0, oldInput?.selectionEnd ?? 0];
      const next = renderSection(section, action => postMessage({ type: 'section-action', providerId: state.id, action }), filter);
      next.dataset.section = section.id; next.dataset.signature = signature;
      if (node) { node.replaceWith(next); } else { content.append(next); }
      node = next;
      if (focused) {
        const input = node.querySelector('input'); input?.focus(); input?.setSelectionRange(selection[0], selection[1]);
      }
    }
  }
}

function renderSection(section: AccountSection, onAction: (id: string) => void, filter: string): HTMLElement {
  const node = element('section', 'extension-section');
  const heading = element('div', 'section-heading'); heading.append(element('h3', '', section.title));
  if (section.actions?.length) {
    const actions = element('div', 'section-actions');
    for (const action of section.actions) { actions.append(button(action.label, action.icon ?? 'link-external', () => onAction(action.id))); }
    heading.append(actions);
  }
  node.append(heading);
  if (section.description) { node.append(element('p', 'muted section-description', section.description)); }
  if (section.message) { node.append(element('p', section.warning ? 'section-message warning' : 'section-message muted', section.message)); }
  if (section.metrics?.length) {
    const stats = element('dl', 'metrics');
    for (const metric of section.metrics) {
      const item = element('div'); item.append(element('dt', '', metric.label), element('dd', 'metric-value', metric.value));
      if (metric.detail) { item.append(element('div', 'muted metric-detail', metric.detail)); }
      stats.append(item);
    }
    node.append(stats);
  }
  if (section.rows?.length) {
    const details = element('dl', 'section-details');
    for (const row of section.rows) { details.append(element('dt', '', row.label), element('dd', '', row.value)); }
    node.append(details);
  }
  if (section.meters?.length) {
    const meters = element('div', 'meters');
    for (const meter of section.meters) {
      const item = element('div', 'quota');
      item.append(element('div', 'muted', meter.label), element('div', 'quota-value', meter.text));
      if (meter.max !== null) {
        const progress = element('progress'); progress.max = 100;
        progress.value = meter.max <= 0 ? 100 : Math.min(100, Math.max(0, meter.value / meter.max * 100));
        progress.setAttribute('aria-label', meter.label); progress.setAttribute('aria-valuetext', meter.text);
        if (progress.value >= 90) { item.classList.add('warning'); }
        item.append(progress);
      }
      item.append(element('div', 'muted quota-detail', meter.detail)); meters.append(item);
    }
    node.append(meters);
  }
  if (section.table) {
    const data = section.table;
    const input = element('input', 'table-filter'); input.type = 'search'; input.placeholder = data.filterLabel;
    input.setAttribute('aria-label', data.filterLabel); input.value = filter;
    const viewport = element('div', 'table-viewport'); viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', section.title);
    const table = element('table'); table.setAttribute('aria-label', section.title);
    const head = element('thead'), labels = element('tr'), body = element('tbody');
    for (const column of data.columns) { const th = element('th', '', column); th.scope = 'col'; labels.append(th); }
    head.append(labels); table.append(head, body); viewport.append(table);
    const empty = element('p', 'section-message muted'); empty.setAttribute('role', 'status');
    const renderRows = (): void => {
      const query = input.value.toLocaleLowerCase().trim();
      const rows = data.rows.filter(row => row.some(cell => cell.toLocaleLowerCase().includes(query)));
      body.replaceChildren();
      for (const row of rows) {
        const tr = element('tr');
        row.forEach((value, index) => { const cell = element('td', '', value); cell.dataset.label = data.columns[index]; tr.append(cell); });
        body.append(tr);
      }
      empty.textContent = data.rows.length ? t("No matching results") : data.emptyMessage; empty.hidden = rows.length > 0;
    };
    input.addEventListener('input', renderRows); renderRows();
    node.append(input, viewport, empty);
  }
  return node;
}
