// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationOutput } from '../web/ui/conversation-output';
import type { Attachment, ConversationMessage, OutputItem } from '../web/workflow-types';

const outputs: ConversationOutput[] = [];
afterEach(() => { for (const output of outputs.splice(0)) output.dispose(); document.body.replaceChildren(); });

it('signs a shared attachment list once per update and invalidates unchanged Markdown when a preview changes', () => {
  const root = document.createElement('div'); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
  const files: Attachment[] = [{ id: 'file', name: 'image.png', path: '/image.png', size: 1, previewUrl: '/old.png', mimeType: 'image/png', kind: 'image', storage: 'local', createdAt: '2026-10-22T00:00:00Z' }];
  const map = vi.spyOn(files, 'map');
  const message: ConversationMessage = { role: 'assistant', content: '', status: 'success', items: Array.from({ length: 100 }, (_, index) => ({
    id: `text-${index}`, content: '[image](/image.png)', contentType: 'markdown',
  })) };
  output.update(message, 'project', "main", 'session', files);
  expect(map).toHaveBeenCalledOnce();
  const first = root.firstElementChild; expect(first!.querySelector('a')!.getAttribute('href')).toBe('/old.png');
  output.update(message, 'project', "main", 'session', files); expect(root.firstElementChild).toBe(first);
  files[0].previewUrl = '/new.png'; output.update(message, 'project', "main", 'session', files);
  expect(root.firstElementChild).not.toBe(first); expect(root.firstElementChild!.querySelector('a')!.getAttribute('href')).toBe('/new.png');
});

it.each(['recovery', 'length', 'lost-call'])('silently continues %s while preserving network retry feedback and answer text', kind => {
  const root = document.createElement('div'); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
  const retry = (id: string, kind: string): OutputItem => ({ id, content: { type: 'retry', kind, attempt: 1, maxAttempts: 10, reason: 'fixture' },
    contentType: 'json', metadata: { kind: 'agent-part', partType: 'retry', status: 'success' } });
  const items = [{ id: 'body', content: 'Partial answer', contentType: 'markdown' }, retry('internal', kind), retry('network', 'dropped')];
  output.update({ role: 'assistant', status: 'running', content: '', items }, 'project', "main", 'conversation', []);
  expect(root.querySelectorAll('[data-kind="retry"]')).toHaveLength(1);
  expect(root.querySelector('[data-item-id="internal"]')).toBeNull();
  expect(root.querySelector('[data-item-id="network"]')).not.toBeNull();
  expect(root.querySelector('.pending')?.textContent).toBe('Responding...');
  expect(root.textContent).toContain('Partial answer');
  output.update({ role: 'assistant', status: 'success', content: '', items }, 'project', "main", 'conversation', []);
  expect(root.querySelectorAll('[data-kind="retry"]')).toHaveLength(1);
  expect(root.querySelector('.pending')).toBeNull();
});

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
    output.update(message, 'project', "main", 'conversation', []);
    const retry = root.querySelector<HTMLDetailsElement>('[data-kind="retry"]')!;
    retry.open = true; retry.dispatchEvent(new Event('toggle'));
    output.update({ ...message, status: 'success', items }, 'project', "main", 'conversation', []);
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
