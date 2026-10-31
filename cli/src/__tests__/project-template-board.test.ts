// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createKanbanBridgeScript } from '@steamharness/kanban-project';

const root = path.resolve(import.meta.dirname, '../project-templates');
const source = await readFile(path.join(root, '_shared/board.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
afterEach(() => document.body.replaceChildren());

async function board(template: string, options: { language?: string; data?: Map<string, unknown>; readError?: string; failWrite?: boolean } = {}) {
  document.body.innerHTML = await readFile(path.join(root, template, 'index.html'), 'utf8');
  const listeners = new Map<string, Array<(event: any) => void>>();
  const data = options.data ?? new Map<string, unknown>(), calls: any[] = [];
  let configuration = { id: '', name: '', params: {} as Record<string, unknown> };
  const send = (value: unknown) => listeners.get('message')?.forEach(listener => listener({ source: parent, data: value }));
  const parent = { postMessage(message: any) {
    if (message.type !== 'steamharness:kanban-bridge-request') return;
    calls.push(message);
    queueMicrotask(() => {
      const code = message.operation === 'kv.getValue' ? options.readError : message.operation === 'kv.setValue' && options.failWrite ? 'DATABASE_ACCESS_DENIED' : undefined;
      const value = message.operation === 'runtime.getLocale' ? options.language ?? 'en'
        : message.operation === 'kv.getValue' ? structuredClone(data.get(message.input.key) ?? null) : null;
      if (!code && message.operation === 'kv.setValue') data.set(message.input.key, structuredClone(message.input.value));
      send({ type: 'steamharness:kanban-bridge-response', nonce: 'board-test', requestId: message.requestId, ok: !code,
        ...(code ? { error: { code } } : { value }) });
    });
  } };
  const page = { parent, setTimeout, clearTimeout,
    addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
    dispatchEvent(event: Event) { listeners.get(event.type)?.forEach(listener => listener(event)); return true; } };
  const script = createKanbanBridgeScript(configuration, 'board-test').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  new Function('window', 'document', 'CustomEvent', script)(page, document, CustomEvent);
  await new AsyncFunction('window', 'document', 'crypto', 'structuredClone', source)(page, document, crypto, structuredClone);
  return { data, calls,
    add(title: string) { document.querySelector<HTMLInputElement>('#task-title')!.value = title;
      document.querySelector('#new-task')!.dispatchEvent(new Event('submit', { cancelable: true })); },
    configure(id: string, params: Record<string, unknown> = {}) {
      configuration = { id, name: id, params };
      send({ type: 'steamharness:kanban-configuration', nonce: 'board-test', configuration });
    } };
}

for (const template of ['kanban-default', 'kanban-parameters']) {
  it.each(['en', 'zh-CN'])(`${template} saves, moves and deletes tasks through the real database bridge (%s)`, async language => {
    const f = await board(template, { language });
    f.add('Audit task');
    await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
    expect(f.calls.filter(call => call.operation.startsWith('kv.')).every(call => call.input.database === 'data')).toBe(true);
    expect(f.data.get('task-board:tasks:default')).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Audit task', stage: 'todo' })]));
    document.querySelector<HTMLButtonElement>('article button')!.click();
    await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
    expect(f.data.get('task-board:tasks:default')).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Audit task', stage: 'doing' })]));
    const row = [...document.querySelectorAll('article')].find(item => item.textContent?.includes('Audit task'))!;
    row.querySelectorAll<HTMLButtonElement>('button')[1].click();
    await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
    expect((f.data.get('task-board:tasks:default') as any[]).some(task => task.title === 'Audit task')).toBe(false);
    await board(template, { data: f.data, language });
    expect(document.querySelectorAll('article')).toHaveLength(1);
  });
}

it('keeps a new unbound board editable and clearly marks temporary changes', async () => {
  const f = await board('kanban-default', { readError: 'DATABASE_UNBOUND' });
  f.add('Temporary task');
  await vi.waitFor(() => expect(document.querySelectorAll('article')).toHaveLength(2));
  expect(document.querySelector('#status')!.textContent).toContain('Temporary mode');
  expect(f.calls.some(call => call.operation === 'kv.setValue')).toBe(false);
});

it.each(['DATABASE_ACCESS_DENIED', 'KANBAN_BRIDGE_SERVER_ERROR'])('does not overwrite existing tasks when loading fails (%s)', async readError => {
  const f = await board('kanban-default', { readError });
  expect(document.querySelector('#add-task')).toHaveProperty('disabled', true);
  expect(f.calls.some(call => call.operation === 'kv.setValue')).toBe(false);
});

it('keeps configurations separate and restores the original title when a title override is cleared', async () => {
  const f = await board('kanban-parameters');
  const title = document.querySelector('#title')!.textContent;
  f.add('Default task');
  await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
  f.configure('second', { title: 'Second board' });
  await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
  expect(document.querySelector('#title')!.textContent).toBe('Second board');
  expect(document.querySelector('#board')!.textContent).not.toContain('Default task');
  f.configure('second');
  expect(document.querySelector('#title')!.textContent).toBe(title);
  f.configure('');
  await vi.waitFor(() => expect(document.querySelector('#board')!.textContent).toContain('Default task'));
});

it('preserves saved tasks when a write is denied', async () => {
  const data = new Map([['task-board:tasks:default', [{ id: 'original', title: 'Original', stage: 'todo' }]]]);
  const f = await board('kanban-default', { data, failWrite: true });
  f.add('Rejected task');
  await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
  expect(document.querySelector('#board')!.textContent).not.toContain('Rejected task');
  expect(data.get('task-board:tasks:default')).toEqual([{ id: 'original', title: 'Original', stage: 'todo' }]);
});
