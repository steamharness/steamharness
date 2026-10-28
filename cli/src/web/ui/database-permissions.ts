import type { DatabaseAccessRule, DatabasePermissions } from '@steamharness/database-spaces';
import { t } from '../localization';

const resources = ['kv', 'knowledge'] as const;
const operations = ['read', 'write'] as const;
const resourceName = (resource: typeof resources[number]) => resource === 'kv' ? t('Key-value data') : t('Knowledge');
const operationName = (operation: typeof operations[number]) => operation === 'read' ? t('Read') : t('Write');
const ruleName = (rule: DatabaseAccessRule) => rule.mode === 'all' ? t('All data') : rule.mode === 'none' ? t('No access') : t('Selected prefixes');

export function databasePermissionsView(permissions: DatabasePermissions): HTMLElement {
  const list = document.createElement('dl'); list.className = 'database-permission-summary';
  for (const resource of resources) {
    const label = document.createElement('dt'); label.textContent = resourceName(resource);
    const value = document.createElement('dd');
    for (const operation of operations) {
      const rule = permissions[resource][operation];
      const line = document.createElement('span');
      line.textContent = `${operationName(operation)}: ${ruleName(rule)}${rule.mode === 'prefixes' ? ` (${rule.prefixes.join(', ')})` : ''}`;
      value.append(line);
    }
    list.append(label, value);
  }
  return list;
}

/** The host validates every change, including approval and narrowing. */
export function databasePermissionsEditor(container: HTMLElement, initial: DatabasePermissions, title: string, narrowing = false) {
  const fieldset = document.createElement('fieldset'); fieldset.className = 'database-permissions';
  const legend = document.createElement('legend'); legend.textContent = title; fieldset.append(legend);
  const values = new Map<string, { select: HTMLSelectElement; prefixes: HTMLTextAreaElement }>();
  for (const resource of resources) {
    const group = document.createElement('div'); group.className = 'database-permission-resource';
    const heading = document.createElement('strong'); heading.textContent = resourceName(resource); group.append(heading);
    for (const operation of operations) {
      const label = document.createElement('label'); label.textContent = operationName(operation);
      const select = document.createElement('select'); select.setAttribute('aria-label', `${resourceName(resource)} · ${operationName(operation)}`);
      for (const [value, text] of [['none', t('No access')], ['all', t('All data')], ['prefixes', t('Selected prefixes')]]) {
        const option = document.createElement('option'); option.value = value!; option.textContent = text!;
        const rule = initial[resource][operation];
        option.disabled = narrowing && (rule.mode === 'none' && value !== 'none' || rule.mode === 'prefixes' && value === 'all'); select.append(option);
      }
      const rule = initial[resource][operation]; select.value = rule.mode;
      const prefixes = document.createElement('textarea'); prefixes.rows = 2; prefixes.placeholder = t('One prefix per line');
      prefixes.setAttribute('aria-label', `${resourceName(resource)} · ${operationName(operation)} · ${t('Prefixes')}`);
      prefixes.value = rule.mode === 'prefixes' ? rule.prefixes.join('\n') : '';
      const update = () => { prefixes.hidden = select.value !== 'prefixes'; prefixes.required = !prefixes.hidden; };
      select.onchange = update; update(); label.append(select, prefixes); group.append(label);
      values.set(`${resource}.${operation}`, { select, prefixes });
    }
    fieldset.append(group);
  }
  container.append(fieldset);
  return (): DatabasePermissions => {
    const result: DatabasePermissions = { kv: { read: { mode: 'none' }, write: { mode: 'none' } }, knowledge: { read: { mode: 'none' }, write: { mode: 'none' } } };
    for (const resource of resources) for (const operation of operations) {
      const { select, prefixes } = values.get(`${resource}.${operation}`)!;
      result[resource][operation] = select.value === 'prefixes'
        ? { mode: 'prefixes', prefixes: prefixes.value.split(/\r?\n/).filter(prefix => prefix.length > 0) }
        : { mode: select.value === 'all' ? 'all' : 'none' };
    }
    return result;
  };
}
