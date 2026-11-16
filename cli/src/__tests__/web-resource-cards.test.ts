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

  it('extracts a map card from custom tool details with its stable card id', () => {
    const presentation = { action: 'upsert', cardId: 'map-2d', kind: 'project', title: 'Map',
      target: { source: 'local', projectId, entryId: 'map-2d' }, preview: true, pinned: true };
    const output = { content: [{ type: 'text', text: JSON.stringify(presentation) }], details: { resourceCard: presentation } };
    expect(conversationResourceCards([item('map_open_kanban', output)], projectId, 'main', conversationId)).toEqual([
      { id: 'map-2d', kind: 'project', title: 'Map', target: presentation.target, itemId: 'tool-call', preview: true, pinned: true },
    ]);
    expect(conversationResourceCards([item('map_open_kanban', output, 'failed')], projectId, 'main', conversationId)).toEqual([]);
  });

  it('updates a Kanban card without losing its configuration and removes it by id', () => {
    const target = { source: 'current', configurationId: 'named' };
    const first = item('workflow-ui_present_card', { action: 'upsert', cardId: 'map', kind: 'kanban', target, preview: true,
      kanban: { mode: 'preview', values: { title: 'Initial' } } });
    const updated = item('workflow-ui_present_card', { action: 'upsert', cardId: 'map', kind: 'kanban', target, preview: false,
      kanban: { mode: 'preview', values: { title: 'Updated' } } });
    expect(conversationResourceCards([first, updated], projectId, 'main', conversationId)).toMatchObject([
      { id: 'map', preview: false, target: { source: 'local', projectId, entryId: 'main', configurationId: 'named' },
        kanban: { mode: 'preview', values: { title: 'Updated' } } },
    ]);
    expect(conversationResourceCards([first, item('workflow-ui_present_card', { action: 'remove', cardId: 'map' })], projectId, 'main', conversationId)).toEqual([]);
  });

  it.each([
    ['kanban', { configurationId: 'named-map' }], ['project', { configurationId: 'named-map' }],
    ['file', { filePath: 'README.md' }],
  ] as const)('preserves an explicit current %s target', (kind, fields) => {
    const target = { source: 'current', projectId: 'workspace', entryId: 'map-2d', ...fields };
    const presentation = { action: 'upsert', cardId: 'map', kind, target };
    const output = { content: [{ type: 'text', text: JSON.stringify(presentation) }], details: {} };
    expect(conversationResourceCards([item('workflow-ui_present_card', output)], projectId, 'main', conversationId)[0].target)
      .toEqual({ ...target, source: 'local' });
  });

  it('keeps a sibling entry and rejects unsafe file paths', () => {
    const sibling = item('workflow-ui_present_card', { action: 'upsert', cardId: 'map', kind: 'kanban',
      target: { source: 'current', entryId: 'map-2d' } });
    expect(conversationResourceCards([sibling], projectId, 'agent', conversationId)[0].target)
      .toEqual({ source: 'local', projectId, entryId: 'map-2d' });
    const unsafe = item('workflow-ui_present_card', { action: 'upsert', kind: 'file',
      target: { source: 'local', filePath: '../secret.txt' } });
    expect(conversationResourceCards([unsafe], projectId, 'main', conversationId)).toEqual([]);
  });
});
