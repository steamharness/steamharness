// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { ConversationOutput } from '../web/ui/conversation-output';
import type { ConversationMessage, ResultCard } from '../web/workflow-types';

it('renders a generic read-only table between output items and keeps it outside the collapsed process', () => {
  const root = document.createElement('div'); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} });
  const value = '<img src=x onerror=example()>';
  const card: ResultCard = { title: 'Inventory', status: { label: 'Completed', tone: 'success' },
    fields: [{ label: 'Page', value: 1 }], table: { columns: ['Name', 'Type'], rows: [[value, 'Box']] } };
  const reply: ConversationMessage = { role: 'assistant', content: '', status: 'running',
    items: [{ id: 'start', content: 'Looking up inventory' }],
    resolvedInputs: [{ requestId: 'lookup', nodeName: 'inventory', submittedAt: '', values: {}, precedingOutputItemIds: ['start'], resultCard: card }],
  };
  const update = () => output.update(reply, 'project', 'main', 'conversation', [], 'local', '', true);
  try {
    update();
    const result = root.querySelector('.result-card')!;
    expect(result.getAttribute('aria-label')).toBe('Inventory');
    expect(result.querySelector('dt')?.textContent).toBe('Page');
    expect(Array.from(result.querySelectorAll('th')).map(cell => cell.textContent)).toEqual(['Name', 'Type']);
    expect(result.querySelector('td')?.textContent).toBe(value);
    expect(result.querySelector('img, script, a')).toBeNull();
    reply.items!.push({ id: 'final', content: 'Inventory is ready' });
    reply.status = 'success'; update();
    expect(root.querySelector('.conversation-process')?.textContent).toContain('Looking up inventory');
    expect(root.querySelectorAll('.result-card')).toHaveLength(1);
    expect(root.querySelector('.result-card')).toBe(result);
    expect(result.closest('.conversation-process')).toBeNull();
    expect(result.parentElement?.nextElementSibling?.textContent).toContain('Inventory is ready');
  } finally { output.dispose(); root.remove(); }
});
