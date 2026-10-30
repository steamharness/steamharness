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

  it('keeps approved database metadata outside the model content while decoding a tool envelope', () => {
    const payload = { document: { id: 'document', title: 'Guide' } };
    const output = {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      details: { resourceCard: { kind: 'knowledge', target: { source: 'server', projectId: 'agent',entryId:'main',database:'data', documentId: 'document' } } },
    };
    expect(conversationResourceCards([item('kb_get_document', output)], projectId, "main", conversationId)).toEqual([
      { id: 'knowledge:'+JSON.stringify({source:'server',projectId:'agent',entryId:'main',database:'data',documentId:'document'}), kind: 'knowledge',
        target: { source: 'server', projectId: 'agent',entryId:'main',database:'data', documentId: 'document' }, title: 'Guide', itemId: 'tool-call' },
    ]);
    expect(JSON.parse(output.content[0].text)).toEqual(payload);
  });

  it('extracts a map card from custom tool details with its stable card id', () => {
    const presentation = { action: 'upsert', cardId: 'map-2d', kind: 'project', title: 'Map',
      target: { source: 'local', projectId,entryId:'map-2d' }, preview: true, pinned: true };
    const output = { content: [{ type: 'text', text: JSON.stringify(presentation) }], details: { resourceCard: presentation } };
    expect(conversationResourceCards([item('map_open_kanban', output)], projectId, "main", conversationId)).toEqual([
      { id: 'map-2d', kind: 'project', title: 'Map', target: presentation.target, itemId: 'tool-call', preview: true, pinned: true },
    ]);
    expect(conversationResourceCards([item('map_open_kanban', output, 'failed')], projectId, "main", conversationId)).toEqual([]);
  });

  it('keeps document titles and Kanban parameters through updates and removes stable cards', () => {
    const target = { source: 'current', configurationId: 'named' };
    const first = item('workflow-ui_present_card', { action: 'upsert', cardId: 'map', kind: 'kanban', target, preview: true, kanban: { mode: 'preview', values: { title: 'Initial' } } });
    const updated = item('workflow-ui_present_card', { action: 'upsert', cardId: 'map', kind: 'kanban', target, preview: false, kanban: { mode: 'preview', values: { title: 'Updated' } } });
    expect(conversationResourceCards([first, updated], projectId, "main", conversationId)).toMatchObject([{ id: 'map', preview: false, target: { source: 'local', projectId,entryId:'main', configurationId: 'named' }, kanban: { mode: 'preview', values: { title: 'Updated' } } }]);
    expect(conversationResourceCards([first, item('workflow-ui_present_card', { action: 'remove', cardId: 'map' })], projectId, "main", conversationId)).toEqual([]);
    expect(conversationResourceCards([item('kb_get_document', { document: { title: 'Guide' }, details: { resourceCard: { kind: 'knowledge', target: { source: 'server', projectId: 'agent',entryId:'main',database:'data', documentId: 'doc' } } } })], projectId, "main", conversationId)[0].title).toBe('Guide');
  });

  it('uses the declared current storage for built-in data tools and current cards while files stay local', () => {
    const automatic = item('workflow-kv_kv_store', { value: 7 }); (automatic.content as any).input={database:'data'};
    const explicit = item('workflow-ui_present_card', { action: 'upsert', kind: 'knowledge', target: { source: 'current',database:'data', documentId: 'doc' } });
    const file = item('workflow-ui_present_card', { action: 'upsert', kind: 'file', target: { source: 'current', filePath: 'README.md' } });
    expect(conversationResourceCards([automatic], projectId, "main", conversationId, 'server')[0].target.source).toBe('server');
    expect(conversationResourceCards([explicit], projectId, "main", conversationId, 'server')[0].target).toMatchObject({ source: 'server', projectId, documentId: 'doc' });
    expect(conversationResourceCards([file], projectId, "main", conversationId, 'server')[0].target.source).toBe('local');
  });

  it.each([
    ['kanban', { configurationId: 'named-map' }], ['project', { configurationId: 'named-map' }],
    ['file', { filePath: 'README.md' }], ['kv', { database: 'data', key: 'map', scope: 'project' }],
    ['knowledge', { database: 'data', documentId: 'doc' }],
  ] as const)('preserves an explicit current %s target instead of replacing it with the conversation owner', (kind, fields) => {
    const target = { source: 'current', projectId: 'workspace', entryId: 'map-2d', ...fields };
    const presentation = { action: 'upsert', cardId: 'map', kind, target };
    const output = { content: [{ type: 'text', text: JSON.stringify(presentation) }], details: {} };
    expect(conversationResourceCards([item('workflow-ui_present_card', output)], projectId, 'main', conversationId, 'server')[0].target)
      .toEqual({ ...target, source: kind === 'kv' || kind === 'knowledge' ? 'server' : 'local' });
    expect(target.source).toBe('current');
  });

  it('fills only missing current target identifiers and keeps a sibling entry', () => {
    const presentation = { action: 'upsert', cardId: 'map', kind: 'kanban', target: { source: 'current', entryId: 'map-2d' } };
    expect(conversationResourceCards([item('workflow-ui_present_card', presentation)], projectId, 'agent', conversationId)[0].target)
      .toEqual({ source: 'local', projectId, entryId: 'map-2d' });
  });
});
