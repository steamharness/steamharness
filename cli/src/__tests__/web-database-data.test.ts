// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { mountDatabaseData } from '../web/ui/database-data';

let dispose: () => void;
const request = vi.fn<(operation: string, input: Record<string, unknown>) => Promise<any>>();
const root = () => document.querySelector<HTMLElement>('#data')!;
const click = (label: string, parent: ParentNode = root()) => {
  const control = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!;
  expect(control, label).toBeTruthy(); expect(control.disabled, label).toBe(false); control.click();
};
const field = (label: string) => root().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => {
  initI18n({ preference: 'en' }); document.body.innerHTML = '<div id="data"></div>';
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  request.mockReset(); request.mockImplementation(async () => ({ items: [], total: 0 }));
});
afterEach(() => { dispose?.(); vi.restoreAllMocks(); delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal; delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close; document.body.replaceChildren(); });

it('browses paginated KV records, edits a selected value and keeps invalid JSON out of host requests', async () => {
  request.mockImplementation(async (operation, input) => operation === 'kv.listValues'
    ? { items: [{ key: input.cursor ? 'second' : 'settings', value: { theme: 'dark' } }], total: 2, nextCursor: input.cursor ? undefined : 'page-2' }
    : operation === 'kv.getValue' ? { theme: 'dark' } : null);
  dispose = mountDatabaseData(root(), request); await settle();
  expect(root().querySelector('pre')).toBeNull(); expect(root().textContent).toContain('settings');
  expect(field('JSON value')).toBeNull();
  click('Next page'); await settle(); expect(request).toHaveBeenLastCalledWith('kv.listValues', { pageSize: 20, cursor: 'page-2' });
  click('Previous page'); await settle(); expect(request).toHaveBeenLastCalledWith('kv.listValues', { pageSize: 20 });
  root().querySelector<HTMLButtonElement>('.database-record')!.click(); await settle();
  expect(field('Key').value).toBe('settings'); expect(JSON.parse(field('JSON value').value)).toEqual({ theme: 'dark' });
  field('JSON value').value = '{invalid'; const before = request.mock.calls.length; click('Save'); await settle();
  expect(request.mock.calls).toHaveLength(before); expect(root().textContent).toContain('Enter a valid JSON value.');
  field('JSON value').value = '{"theme":"light"}'; click('Save'); await settle();
  expect(request).toHaveBeenCalledWith('kv.setValue', { key: 'settings', value: { theme: 'light' } });
  expect(request).toHaveBeenLastCalledWith('kv.listValues', { pageSize: 20 });
});

it('searches keys on the host and starts a fresh page when the query changes', async () => {
  request.mockResolvedValue({ items: [{ key: 'public:guide', value: 'Guide' }], total: 3, nextCursor: 'next' });
  dispose = mountDatabaseData(root(), request); await settle(); click('Next page'); await settle();
  field('Search keys').value = 'public:'; click('Search'); await settle();
  expect(request).toHaveBeenLastCalledWith('kv.listValues', { query: 'public:', pageSize: 20 });
});

it('uses real knowledge search and reads a document before editing its Markdown', async () => {
  request.mockImplementation(async operation => operation === 'knowledge.searchDocuments'
    ? { matches: [{ documentId: 'guide', title: 'Guide', line: 'Matching content' }], totalMatches: 1 }
    : operation === 'knowledge.getDocument' ? { id: 'guide', title: 'Guide', markdown: '# Guide' }
    : { items: [{ id: 'guide', title: 'Guide', markdownPreview: 'Content' }], total: 1 });
  dispose = mountDatabaseData(root(), request); await settle(); click('Knowledge'); await settle();
  field('Search knowledge').value = 'Matching'; click('Search'); await settle();
  expect(request).toHaveBeenLastCalledWith('knowledge.searchDocuments', { query: 'Matching', pageSize: 20 });
  expect(root().textContent).toContain('Matching content'); root().querySelector<HTMLButtonElement>('.database-record')!.click(); await settle();
  expect(field('Document ID').value).toBe('guide'); expect(field('Markdown').value).toBe('# Guide');
  field('Markdown').value = '# Updated'; click('Save'); await settle();
  expect(request).toHaveBeenCalledWith('knowledge.editDocument', { documentId: 'guide', title: 'Guide', markdown: '# Updated' });
});

it('creates documents without a manual ID and supports writing the JSON value null', async () => {
  dispose = mountDatabaseData(root(), request); await settle(); click('Add value');
  field('Key').value = 'nullable'; field('JSON value').value = 'null'; click('Save'); await settle();
  expect(request).toHaveBeenCalledWith('kv.setValue', { key: 'nullable', value: null });
  click('Knowledge'); await settle(); click('Create document'); field('Title').value = 'New guide'; field('Markdown').value = '# New'; click('Save'); await settle();
  expect(request).toHaveBeenCalledWith('knowledge.createDocument', { title: 'New guide', markdown: '# New' });
});

it('explains shared deletion consequences and changes no data when confirmation is canceled', async () => {
  request.mockImplementation(async operation => operation === 'kv.listValues' ? { items: [{ key: 'shared', value: 1 }], total: 1 } : 1);
  dispose = mountDatabaseData(root(), request); await settle(); root().querySelector<HTMLButtonElement>('.database-record')!.click(); await settle();
  click('Delete'); const confirmation = document.querySelector<HTMLDialogElement>('.action-dialog')!;
  expect(confirmation.textContent).toContain('Every entry sharing this database'); click('Cancel', confirmation); await settle();
  expect(request.mock.calls.some(([operation]) => operation === 'kv.deleteValue')).toBe(false);
  click('Delete'); click('Delete', document.querySelector('.action-dialog')!); await settle();
  expect(request).toHaveBeenCalledWith('kv.deleteValue', { key: 'shared' });
});

it('shows host permission errors without replacing the editor or leaving a loading state', async () => {
  request.mockRejectedValue(new Error('This entry does not have read access.'));
  dispose = mountDatabaseData(root(), request); await settle();
  expect(root().querySelector('[role=alert]')!.textContent).toBe('This entry does not have read access.');
  click('Add value'); field('Key').value = 'draft'; field('JSON value').value = '1'; click('Save'); await settle();
  expect(field('JSON value').value).toBe('1'); expect(root().textContent).not.toContain('Loading data...');
});

it('ignores delayed results when switching data types or leaving the browser', async () => {
  let finish: (value: unknown) => void = () => {};
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  dispose = mountDatabaseData(root(), request); click('Knowledge'); await settle();
  finish({ items: [{ key: 'late-key', value: 1 }], total: 1 }); await settle();
  expect(root().textContent).not.toContain('late-key');
  dispose(); root().replaceChildren(); expect(root().textContent).toBe('');
});

it('uploads attachments and shows useful metadata without displaying encoded file contents', async () => {
  request.mockImplementation(async operation => operation === 'files.createFile' ? { id: 'attachment', name: 'guide.txt', mimeType: 'text/plain' } : { items: [], total: 0 });
  dispose = mountDatabaseData(root(), request); await settle(); click('Attachments');
  const upload = root().querySelector<HTMLInputElement>('input[type=file]')!;
  const file = new File(['Guide'], 'guide.txt', { type: 'text/plain' }); Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('Guide').buffer });
  Object.defineProperty(upload, 'files', { value: [file] }); upload.dispatchEvent(new Event('change')); await settle();
  expect(request).toHaveBeenCalledWith('files.createFile', { name: 'guide.txt', mimeType: 'text/plain', base64: 'R3VpZGU=' });
  expect(field('Attachment ID').value).toBe('attachment'); expect(root().textContent).toContain('guide.txt'); expect(root().textContent).not.toContain('R3VpZGU=');
});
