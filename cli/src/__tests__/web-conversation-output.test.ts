// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { ConversationOutput } from '../web/ui/conversation-output';
import type { ConversationMessage, OutputItem } from '../web/workflow-types';

const outputs: ConversationOutput[] = [];
afterEach(() => { for (const output of outputs.splice(0)) output.dispose(); document.body.replaceChildren(); });

it('keeps the retry at its interruption point through completion, expansion and history replay', () => {
  const items: OutputItem[] = [
    { id: 'before', content: 'Before interruption', contentType: 'markdown', metadata: { kind: 'agent-part', partType: 'text' } },
    { id: 'retry', content: { type: 'retry', status: 'success', attempt: 1, maxAttempts: 10, reason: 'terminated' },
      contentType: 'json', collapsed: true, metadata: { kind: 'agent-part', partType: 'retry', status: 'success' } },
    { id: 'after', content: 'Resumed answer', contentType: 'markdown', metadata: { kind: 'agent-part', partType: 'text' } },
  ];
  const message: ConversationMessage = { role: 'assistant', status: 'running', content: '', items: items.slice(0, 2) };
  for (const replay of [false, true]) {
    const root = document.createElement('div'); document.body.append(root);
    const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
    output.update(message, 'project', 'conversation', []);
    const retry = root.querySelector<HTMLDetailsElement>('[data-kind="retry"]')!;
    retry.open = true; retry.dispatchEvent(new Event('toggle'));
    output.update({ ...message, status: 'success', items }, 'project', 'conversation', []);
    expect(root.querySelectorAll('[data-kind="retry"]')).toHaveLength(1);
    expect(root.querySelector('[data-kind="retry"]')).toBe(retry);
    expect(retry.open).toBe(true);
    expect(retry.querySelector('pre')?.textContent).toContain('terminated');
    expect(Array.from(root.children, child => child.className)).toEqual(['message-content', 'activity-group single-activity', 'message-content']);
    expect(root.firstElementChild?.textContent).toContain('Before interruption');
    expect(root.lastElementChild?.textContent).toContain('Resumed answer');
    if (!replay) { message.status = 'success'; message.items = items; }
  }
});
