import { mountEntryWindows } from './entry-windows';
import './aggregate.css';

export function mountAggregateToolbar() {
  const toolbar = document.querySelector('.toolbar-actions') ?? document.querySelector('.toolbar');
  if (toolbar) {
    const navigation = document.createElement('div'); navigation.className = 'aggregate-navigation';
    const create = toolbar.querySelector(':scope > #new');
    if (create) create.after(navigation); else toolbar.prepend(navigation);
    mountEntryWindows(navigation);
  }
}
