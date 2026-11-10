import { mountEntryWindows } from './entry-windows';
import { ProjectDatabases } from './project-databases';
import './aggregate.css';

/** Entry navigation stays in the toolbar; databases live in Project information. */
export function mountAggregateToolbar(host: { postMessage(message: Record<string, any>): unknown }) {
  const toolbar = document.querySelector('.toolbar-actions') ?? document.querySelector('.toolbar');
  if (toolbar) {
    const navigation = document.createElement('div'); navigation.className = 'aggregate-navigation';
    const create = toolbar.querySelector(':scope > #new');
    if (create) create.after(navigation); else toolbar.prepend(navigation);
    mountEntryWindows(navigation);
  }
  return { databases: new ProjectDatabases(host) };
}
