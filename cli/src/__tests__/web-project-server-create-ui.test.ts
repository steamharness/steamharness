// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { ProjectServerCreateDialog } from '../web/ui/project-server-create';

afterEach(() => {
  vi.restoreAllMocks(); document.body.replaceChildren();
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
});
function fixture(language: 'en' | 'zh-CN' = 'en') {
  initI18n({ preference: language });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  const context = { token: 'confirmation', serverUrl: 'https://project.test', projectId: 'same-local-id', projectType: 'kanban', name: '<Local map>', groups: [{ id: 'team', name: '<Team>' }] };
  const request = vi.fn(async (message: Record<string, unknown>) => message.type === 'project-server-create-prepare'
    ? [{ type: 'project-server-create-context', context }] : message.type === 'project-server-create-confirm' ? [{ type: 'project-server-created' }] : []);
  const dialog = new ProjectServerCreateDialog(request);
  const state = (revision = 1) => dialog.update({ type: 'state', serverInstanceId: 'process', authenticationRevision: revision, account: { status: 'authenticated', serverUrl: context.serverUrl, user: { userId: 'user' } } });
  state(); return { dialog, request, context, state };
}

it.each(['en', 'zh-CN'] as const)('lets the user review and cancel project creation in %s without writing anything', async language => {
  const f = fixture(language); await f.dialog.open();
  expect(document.querySelector('h2')!.textContent).toBe(language === 'en' ? 'Apply for a new application ID' : '重新申请应用 ID');
  expect(document.querySelector('form')!.textContent).toContain(language === 'en' ? 'Existing Server data and access are not transferred' : '现有服务器数据和授权不会转移');
  expect(document.querySelector('dl')!.textContent).toContain(f.context.projectId);
  expect(document.querySelector('select')!.textContent).toContain('<Team>');
  expect(document.querySelector('input')!.value).toBe('<Local map>'); expect(document.querySelector('Team')).toBeNull();
  document.querySelector<HTMLButtonElement>('button[type=button].prompt-button')!.click();
  expect(f.request.mock.calls.map(([message]) => message.type)).toEqual(['project-server-create-prepare', 'project-server-create-cancel']);
  expect(document.querySelector('dialog')).toBeNull();
});

it('submits only after explicit confirmation, preserves edits after failure, and prevents duplicate writes', async () => {
  const f = fixture(); await f.dialog.open();
  const input = document.querySelector('input')!, select = document.querySelector('select')!, form = document.querySelector('form')!;
  input.value = 'Reviewed name'; select.value = 'team';
  let reject!: (error: Error) => void;
  f.request.mockImplementationOnce(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
  form.dispatchEvent(new Event('submit', { cancelable: true })); form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(f.request.mock.calls.filter(([message]) => message.type === 'project-server-create-confirm')).toHaveLength(1);
  reject(new Error('Permission denied')); await vi.waitFor(() => expect(document.querySelector('[role=alert]')!.textContent).toBe('Permission denied'));
  expect(input.value).toBe('Reviewed name'); expect(select.value).toBe('team'); expect(document.querySelector('button[type=submit]')!.hasAttribute('disabled')).toBe(false);
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(f.request).toHaveBeenCalledWith({ type: 'project-server-create-confirm', token: 'confirmation', confirmed: true, name: 'Reviewed name', groupId: 'team' });
  expect(f.request.mock.calls.some(([message]) => ['upload', 'send', 'workflow-run'].includes(String(message.type)))).toBe(false);
});

it('discards late preparation and account changes before confirmation', async () => {
  const f = fixture(); let finish!: (value: { type: string; context: typeof f.context }[]) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.dialog.open(); f.dialog.close(); finish([{ type: 'project-server-create-context', context: f.context }]); await pending;
  expect(document.querySelector('dialog')).toBeNull();
  expect(f.request).toHaveBeenCalledWith({ type: 'project-server-create-cancel', token: 'confirmation' });
  await f.dialog.open(); f.state(2); expect(document.querySelector('dialog')).toBeNull();
  expect(f.request.mock.calls.some(([message]) => message.type === 'project-server-create-confirm')).toBe(false);
});
