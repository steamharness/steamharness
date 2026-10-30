import type { OutputItem } from './workflow-types';

export interface ResourceCard {
  id: string;
  kind: 'kv' | 'knowledge' | 'project' | 'browser' | 'file' | 'kanban';
  title: string;
  target: Record<string, string>;
  itemId?: string;
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

// Core tool results carry the same resourceCard / present_card contract used by Desktop.
export function conversationResourceCards(items: OutputItem[], projectId: string, conversationId: string): ResourceCard[] {
  const cards = new Map<string, ResourceCard>();
  for (const [index, item] of items.entries()) {
    if (!['agent-part', 'opencode-part'].includes(String(item.metadata?.kind)) || item.metadata?.partType !== 'tool') { continue; }
    const content = record(item.content);
    if (content?.status !== 'success') { continue; }
    let output = record(content.output);
    if (Array.isArray(output?.content) && output.content.length === 1) {
      try { output = record(JSON.parse(String(record(output.content[0])?.text))); } catch { /* The raw tool output remains available in details. */ }
    }
    let descriptor = record(record(output?.details)?.resourceCard);
    const input = record(content.input) ?? {};
    const tool = string(content.tool) ?? '';
    if (tool === 'workflow-ui_present_card') {
      const presentation = output?.action ? output : input;
      if (presentation.action === 'remove') { cards.delete(String(presentation.cardId)); continue; }
      if (presentation.action !== 'upsert') { continue; }
      descriptor = presentation;
    }
    if (!descriptor) {
      const target: Record<string, unknown> = { source: 'local', projectId, conversationId };
      let kind: ResourceCard['kind'] | undefined;
      if (tool === 'workflow-kv_kv_store' || /workflow-desktop_(?:read|list|write)_project_kv/.test(tool)) {
        kind = 'kv'; Object.assign(target, { projectId: input.projectId ?? projectId, key: input.key, scope: input.scope ?? 'project', conversationId: input.conversationId ?? conversationId });
      } else if (tool === 'workflow-knowledge_knowledge_documents' || /workflow-desktop_(?:query|mutate)_project_knowledge/.test(tool)) {
        kind = 'knowledge'; Object.assign(target, { projectId: input.projectId ?? projectId, documentId: input.documentId ?? record(output?.document)?.id });
      } else if (tool === 'read' || tool === 'workflow-desktop_open_dock_tool' && input.tool === 'files') {
        kind = 'file'; target.filePath = input.filePath ?? input.path;
      } else if (tool === 'workflow-desktop_open_project' && input.kind === 'project') {
        kind = 'project'; target.projectId = input.targetId;
      } else if (tool === 'workflow-desktop_open_dock_tool') {
        if (input.tool === 'browser') { kind = 'browser'; target.url = input.url; }
        if (input.tool === 'preview') { kind = 'kanban'; }
        if (input.tool === 'open-project' && input.openedProjectKind === 'project') { kind = 'project'; target.projectId = input.openedProjectId; }
      }
      if (!kind) { continue; }
      descriptor = { kind, target, title: record(output?.document)?.title };
    }
    const kind = descriptor.kind as ResourceCard['kind'];
    if (!['kv', 'knowledge', 'project', 'browser', 'file', 'kanban'].includes(kind)) { continue; }
    const target = Object.fromEntries(Object.entries(record(descriptor.target) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length < 8192));
    if (target.source === 'current') { target.source = 'local'; target.projectId ??= projectId; }
    if (target.source && !['local', 'server'].includes(target.source)) { continue; }
    if (kind === 'browser') {
      try { const url = new URL(target.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { continue; } } catch { continue; }
    } else {
      target.source ??= 'local'; target.projectId ??= projectId;
      if (target.scope === 'conversation') { target.conversationId ??= conversationId; }
      if (kind === 'file' && (!target.filePath || /^(?:[\\/]|[a-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(target.filePath))) { continue; }
    }
    const id = string(descriptor.cardId) ?? `${kind}:${JSON.stringify(target)}`;
    const title = (string(descriptor.title) ?? target.key ?? target.documentId ?? target.filePath ?? target.url ?? target.projectId ?? kind).slice(0, 200);
    cards.set(id, { id, kind, title, target, itemId: item.id ?? String(index) });
  }
  return [...cards.values()];
}
