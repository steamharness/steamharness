import { describe, expect, it } from 'vitest';
import { conversationResourceCards } from '../web/resource-cards';
import type { OutputItem } from '../web/workflow-types';

describe('custom tool resource cards', () => {
  const projectId = 'agent', conversationId = 'conversation';
  const item = (tool: string, output: unknown, status = 'success'): OutputItem => ({
    id: 'tool-call', contentType: 'application/json', title: tool,
    metadata: { kind: 'agent-part', partType: 'tool' },
    content: { type: 'tool', tool, status, input: {}, output },
  });

  it('keeps related database metadata outside the model content while decoding a tool envelope', () => {
    const payload = { document: { id: 'document', title: 'Guide' } };
    const output = {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      details: { resourceCard: { kind: 'knowledge', target: { source: 'server', projectId: 'database', documentId: 'document' } } },
    };
    expect(conversationResourceCards([item('kb_get_document', output)], projectId, conversationId)).toEqual([
      { id: 'knowledge:{"source":"server","projectId":"database","documentId":"document"}', kind: 'knowledge',
        target: { source: 'server', projectId: 'database', documentId: 'document' }, title: 'Guide', itemId: 'tool-call' },
    ]);
    expect(JSON.parse(output.content[0].text)).toEqual(payload);
  });

  it('extracts a map card from custom tool details with its stable card id', () => {
    const presentation = { action: 'upsert', cardId: 'map-2d', kind: 'project', title: 'Map',
      target: { source: 'local', projectId: 'map-2d' }, preview: true, pinned: true };
    const output = { content: [{ type: 'text', text: JSON.stringify(presentation) }], details: { resourceCard: presentation } };
    expect(conversationResourceCards([item('map_open_kanban', output)], projectId, conversationId)).toEqual([
      { id: 'map-2d', kind: 'project', title: 'Map', target: presentation.target, itemId: 'tool-call', preview: true, pinned: true },
    ]);
    expect(conversationResourceCards([item('map_open_kanban', output, 'failed')], projectId, conversationId)).toEqual([]);
  });

  it('keeps document titles and Kanban parameters through updates and removes stable cards', () => {
    const target = { source: 'current', configurationId: 'named' };
    const first = item('workflow-ui_present_card', { action: 'upsert', cardId: 'map', kind: 'kanban', target, preview: true, kanban: { mode: 'preview', values: { title: 'Initial' } } });
    const updated = item('workflow-ui_present_card', { action: 'upsert', cardId: 'map', kind: 'kanban', target, preview: false, kanban: { mode: 'preview', values: { title: 'Updated' } } });
    expect(conversationResourceCards([first, updated], projectId, conversationId)).toMatchObject([{ id: 'map', preview: false, target: { source: 'local', projectId, configurationId: 'named' }, kanban: { mode: 'preview', values: { title: 'Updated' } } }]);
    expect(conversationResourceCards([first, item('workflow-ui_present_card', { action: 'remove', cardId: 'map' })], projectId, conversationId)).toEqual([]);
    expect(conversationResourceCards([item('kb_get_document', { document: { title: 'Guide' }, details: { resourceCard: { kind: 'knowledge', target: { source: 'server', projectId: 'database', documentId: 'doc' } } } })], projectId, conversationId)[0].title).toBe('Guide');
  });

  it('uses the declared current storage for built-in data tools and current cards while files stay local', () => {
    const automatic = item('workflow-kv_kv_store', { value: 7 });
    const explicit = item('workflow-ui_present_card', { action: 'upsert', kind: 'knowledge', target: { source: 'current', documentId: 'doc' } });
    const file = item('workflow-ui_present_card', { action: 'upsert', kind: 'file', target: { source: 'current', filePath: 'README.md' } });
    expect(conversationResourceCards([automatic], projectId, conversationId, 'server')[0].target.source).toBe('server');
    expect(conversationResourceCards([explicit], projectId, conversationId, 'server')[0].target).toMatchObject({ source: 'server', projectId, documentId: 'doc' });
    expect(conversationResourceCards([file], projectId, conversationId, 'server')[0].target.source).toBe('local');
  });
});
