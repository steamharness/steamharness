import type { WebviewMenuAction } from '../src/webview-context-menu-types';
import type { ResourceKind, ResourceRow, ResourceSource } from '../src/workflow-resources-types';

export function sameResource(kind: ResourceKind, left?: ResourceRow, right?: ResourceRow): boolean {
  if (!left || !right) { return false; }
  return kind === 'knowledge' ? (left.documentId ?? left.id) === (right.documentId ?? right.id) : left.id === right.id;
}

export function resourceMenuActions(state: {
  kind: ResourceKind; source?: ResourceSource; readOnly: boolean; authenticated: boolean; saving: boolean;
  hasProject: boolean; target: 'row' | 'detail' | 'list'; editing: boolean;
}): WebviewMenuAction[] {
  if (!state.hasProject) { return []; }
  const knowledge = state.kind === 'knowledge';
  const writable = !state.readOnly && !state.saving && (state.source === 'local' || state.source === 'server' && state.authenticated);
  if (state.target === 'list') {
    return [...(writable ? [knowledge ? 'newDocument' as const : 'newKey' as const] : []), ...(!state.saving ? ['refresh' as const] : [])];
  }
  if (state.editing && state.target === 'detail') { return []; }
  return [...(state.target === 'row' && !state.saving ? ['open' as const] : []),
    ...(writable ? ['edit' as const] : []),
    knowledge ? 'copyId' : 'copyKey', 'copyContent', ...(writable ? ['delete' as const] : [])];
}
