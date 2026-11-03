// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createKanbanBridgeScript } from '@steamharness/kanban-project';

const root = path.resolve(import.meta.dirname, '../project-templates');
const source = (await readFile(path.join(root, '_shared/board.js'), 'utf8')).replace(/^import .*;\n/, '');
const descriptor = { kind: 'steamharness.database', version: 1, target: 'browser', provider: 'postgresql', alias: 'data', schemaHash: 'a'.repeat(64), metadata: { models: [{ name: 'Task', delegate: 'task' }] } };
const binding = { id: 'binding', alias: 'data', databaseId: 'resource', revision: 1, accessRevision: 1 };
type Row = { values: { id: string; configurationId: string; title: string; status: string }; rowVersion: string };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
afterEach(() => document.body.replaceChildren());

async function board(template: string, options: { language?: string; data?: Map<string, Row>; readError?: string; failWrite?: boolean } = {}) {
  document.body.innerHTML = await readFile(path.join(root, template, 'index.html'), 'utf8');
  const listeners = new Map<string, Array<(event: any) => void>>();
  const data = options.data ?? new Map<string, Row>(), calls: any[] = [];
  const configuration = { id: '', name: '', params: {} as Record<string, unknown> };
  const send = (value: unknown) => listeners.get('message')?.forEach(listener => listener({ source: parent, data: value }));
  const parent = { postMessage(message: any) {
    if (message.type !== 'steamharness:kanban-bridge-request') return;
    calls.push(message);
    queueMicrotask(() => {
      const query = message.input.request;
      let code = message.operation === 'database.resolve' ? options.readError : query && query.operation !== 'rows' && options.failWrite ? 'DATABASE_ACCESS_DENIED' : undefined;
      let value: unknown;
      if (message.operation === 'runtime.getLocale') value = options.language ?? 'en';
      else if (message.operation === 'database.resolve') value = binding;
      else if (query?.operation === 'rows') {
        const items = [...data.values()].filter(row => row.values.configurationId === query.where.configurationId);
        value = { items: structuredClone(items), total: items.length, page: 1, pageSize: 100 };
      } else if (!code) {
        if (query.operation === 'insert') { const row = { values: query.data, rowVersion: '1' }; data.set(row.values.id, row); value = structuredClone(row); }
        else {
          const row = data.get(query.key.id);
          if (!row || query.rowVersion !== row.rowVersion) code = 'DATABASE_CONFLICT';
          else if (query.operation === 'update') { const updated = { values: { ...row.values, ...query.data }, rowVersion: String(Number(row.rowVersion) + 1) }; data.set(query.key.id, updated); value = structuredClone(updated); }
          else { data.delete(query.key.id); value = { deleted: true }; }
        }
      }
      send({ type: 'steamharness:kanban-bridge-response', nonce: 'board-test', requestId: message.requestId, ok: !code,
        ...(code ? { error: { code, message: code } } : { value }) });
    });
  } };
  const page = { parent, setTimeout, clearTimeout,
    addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
    dispatchEvent(event: Event) { listeners.get(event.type)?.forEach(listener => listener(event)); return true; } };
  const script = createKanbanBridgeScript(configuration, 'board-test').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  new Function('window', 'document', 'CustomEvent', script)(page, document, CustomEvent);
  await new AsyncFunction('window', 'document', 'crypto', 'data', source)(page, document, crypto, descriptor);
  return { data, calls,
    add(title: string) { document.querySelector<HTMLInputElement>('#task-title')!.value = title;
      document.querySelector('#new-task')!.dispatchEvent(new Event('submit', { cancelable: true })); },
    configure(id: string, params: Record<string, unknown> = {}) {
      send({ type: 'steamharness:kanban-configuration', nonce: 'board-test', configuration: { id, name: id, params } });
    } };
}

for (const template of ['kanban-default', 'kanban-parameters']) {
  it.each(['en', 'zh-CN'])(`${template} saves, moves and deletes Task rows through the database bridge (%s)`, async language => {
    const f = await board(template, { language });
    f.add('Audit task');
    await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
    expect([...f.data.values()]).toMatchObject([{ values: { title: 'Audit task', status: 'todo', configurationId: 'default' } }]);
    document.querySelector<HTMLButtonElement>('article button')!.click();
    await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
    expect([...f.data.values()]).toMatchObject([{ values: { title: 'Audit task', status: 'doing' }, rowVersion: '2' }]);
    expect(f.calls.filter(call => call.operation === 'database.query').every(call => call.input.database === 'data' && call.input.request.model === 'Task')).toBe(true);
    document.querySelectorAll<HTMLButtonElement>('article button')[1].click();
    await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
    expect(f.data.size).toBe(0);
    await board(template, { data: f.data, language });
    expect(document.querySelectorAll('article')).toHaveLength(0);
  });
}

it.each(['DATABASE_UNBOUND', 'DATABASE_ACCESS_DENIED', 'KANBAN_BRIDGE_SERVER_ERROR'])('blocks edits without writing or falling back when loading fails (%s)', async readError => {
  const f = await board('kanban-default', { readError });
  f.add('Unsaved');
  expect(document.querySelector('#add-task')).toHaveProperty('disabled', true);
  expect(document.querySelector('#status')!.textContent).toMatch(/bind an? relational database|access is not granted|data operation failed/i);
  expect(f.calls.some(call => call.operation === 'database.query' && call.input.request.operation !== 'rows')).toBe(false);
});

it('filters by configuration and restores the title after a view-only change', async () => {
  const f = await board('kanban-parameters'), title = document.querySelector('#title')!.textContent;
  f.add('Default task');
  await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
  f.configure('second', { title: 'Second board' });
  await vi.waitFor(() => expect(document.querySelector('#add-task')).toHaveProperty('disabled', false));
  expect(document.querySelector('#title')!.textContent).toBe('Second board');
  expect(document.querySelector('#board')!.textContent).not.toContain('Default task');
  f.configure('second'); expect(document.querySelector('#title')!.textContent).toBe(title);
  f.configure(''); await vi.waitFor(() => expect(document.querySelector('#board')!.textContent).toContain('Default task'));
});

it('preserves saved rows and the input draft when a write is denied', async () => {
  const row: Row = { values: { id: 'original', title: 'Original', status: 'todo', configurationId: 'default' }, rowVersion: '1' };
  const data = new Map([['original', row]]), f = await board('kanban-default', { data, failWrite: true });
  f.add('Rejected task');
  await vi.waitFor(() => expect(document.querySelector('#status')!.textContent).toContain('Database access is not granted'));
  expect(document.querySelector('#board')!.textContent).not.toContain('Rejected task');
  expect(document.querySelector<HTMLInputElement>('#task-title')!.value).toBe('Rejected task');
  expect([...data.values()]).toEqual([row]);
});
