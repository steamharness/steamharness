import { locale, t } from '../localization';
import type { ResultCard } from '../workflow-types';

/** A read-only presentation of structured results, independent of the producer. */
export function renderResultCard(card: ResultCard): HTMLElement {
  const title = t(card.title);
  const number = new Intl.NumberFormat(locale(), { maximumFractionDigits: 20 });
  const format = (value: string | number) => typeof value === 'number' ? number.format(value) : value;
  const root = document.createElement('section');
  root.className = 'result-card';
  root.setAttribute('aria-label', title);

  const header = document.createElement('header');
  const heading = document.createElement('strong'); heading.textContent = title;
  const status = document.createElement('span'); status.className = 'result-card-status';
  status.dataset.tone = card.status.tone; status.textContent = t(card.status.label);
  header.append(heading, status); root.append(header);

  if (card.fields?.length) {
    const fields = document.createElement('dl'); fields.className = 'result-card-fields';
    for (const field of card.fields) {
      const pair = document.createElement('div');
      const label = document.createElement('dt'); label.textContent = t(field.label);
      const value = document.createElement('dd'); value.textContent = format(field.value);
      pair.append(label, value); fields.append(pair);
    }
    root.append(fields);
  }
  if (card.message || card.table && !card.table.rows.length) {
    const message = document.createElement('p'); message.className = 'result-card-message';
    message.textContent = t(card.message ?? 'No rows returned'); root.append(message);
  }
  if (card.table?.rows.length) {
    const scroll = document.createElement('div'); scroll.className = 'result-card-table'; scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', title);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const column of card.table.columns) {
      const th = document.createElement('th'); th.scope = 'col'; th.textContent = t(column); head.append(th);
    }
    const body = table.createTBody();
    for (const row of card.table.rows) {
      const tr = body.insertRow();
      for (const value of row) {
        const cell = tr.insertCell(); cell.textContent = format(value);
      }
    }
    scroll.append(table); root.append(scroll);
  }
  return root;
}
