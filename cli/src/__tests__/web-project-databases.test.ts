// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import type { DatabasePermissions } from '@steamharness/database-spaces';
import type { DatabaseManagementState } from '../web/database-management';
import type { Project } from '../web/workflow-types';
import { mountAggregateToolbar } from '../web/ui/aggregate';
import { ConversationTools } from '../web/ui/conversation-tools';

const databaseId = '00000000-0000-4000-8000-000000000001', replacementId = '00000000-0000-4000-8000-000000000002';
const all = { mode: 'all' as const }, none = { mode: 'none' as const };
const permissions: DatabasePermissions = { kv: { read: all, write: all }, knowledge: { read: all, write: none } };
const project: Project = {
  id: '00000000-0000-4000-8000-000000000010', entryId: 'agent', aggregateName: 'Aggregate', name: 'Agent', defaultEntry: 'agent',
  projectType: 'conversation', entryRoot: '/project/agent', folderPath: '/project', uri: 'file:///project', fields: [], entrypoints: [],
  databases: [{ alias: 'data', databaseId }], entries: [
    { entryId: 'agent', type: 'conversation', name: 'Agent', root: 'agent', entry: 'index.ts', databases: [{ alias: 'data', databaseId }] },
    { entryId: 'board', type: 'kanban', name: 'Map', root: 'board', entry: 'index.html', databases: [{ alias: 'data', databaseId }] },
  ],
};
let mounted: ReturnType<typeof mountAggregateToolbar>, dialogs: ConversationTools;
const host = { postMessage: vi.fn() };
const emit = (data: unknown, source: MessageEventSource | null = null) => dispatchEvent(new MessageEvent('message', { data, source }));
const requests = () => host.postMessage.mock.calls.map(([message]) => message);
const page = () => document.querySelector<HTMLElement>('.project-databases')!;
const click = (label: string, root: ParentNode = document) => {
  const control = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent) === label)!;
  expect(control, label).toBeTruthy(); expect(control.disabled, label).toBe(false); control.click(); return control;
};
const state = (): DatabaseManagementState => ({ projectId: project.id, entryId: project.entryId, entries: project.entries,
  requirements: [{ alias: 'data', databaseId, status: 'bound', space: { spaceId: databaseId, name: 'Shared memory', host: 'local', ownerId: 'owner', createdAt: '' }, permissions }],
  environmentOverrides: [],
});
const respond = async (value = state(), requestId = requests().at(-1)!.requestId) => {
  emit({ type: 'databases-result', requestId, value }); await vi.advanceTimersByTimeAsync(0);
};
async function open(value = state()) { dialogs.projectInfo(project, 'databases'); await respond(value); }
beforeEach(() => {
  vi.useFakeTimers(); initI18n({ preference: 'en' }); host.postMessage.mockReset();
  document.body.innerHTML = '<header class="toolbar"><div class="toolbar-actions"></div></header>';
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  mounted = mountAggregateToolbar(host); dialogs = new ConversationTools(mounted.databases);
});
afterEach(() => {
  dialogs?.close(); mounted?.databases.dispose(); dispatchEvent(new Event('pagehide'));
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal; delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close; document.body.replaceChildren();
});

it.each(['en', 'zh-CN'] as const)('keeps database management inside Project information, lazy loads and supports keyboard navigation (%s)', async language => {
  initI18n({ preference: language });
  mounted.databases.dispose(); mounted = mountAggregateToolbar(host); dialogs = new ConversationTools(mounted.databases);
  expect(document.querySelector('.aggregate-databases')).toBeNull(); expect(document.querySelector('.database-dialog')).toBeNull();
  dialogs.projectInfo(project);
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.project-information-tabs > button')];
  expect(tabs[0]!.parentElement!.getAttribute('aria-orientation')).toBe('vertical');
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'); expect(requests()).toEqual([]);
  tabs[0]!.focus(); tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(tabs[1]); expect(requests()).toHaveLength(1);
  await respond();
  const card = page().querySelector('[data-alias="data"]')!;
  expect(card.textContent).toContain('Shared memory'); expect(card.textContent).toContain(language === 'en' ? 'Connected' : '已连接');
  expect([...card.querySelectorAll('.database-entry')].map(item => item.textContent)).toEqual(['Agent', 'Map']);
  expect(card.querySelector('.database-entry[data-current=true]')!.textContent).toBe('Agent');
  expect(page().querySelector('input')).toBeNull(); expect(page().querySelector('textarea')).toBeNull();
  tabs[0]!.click(); tabs[1]!.click(); expect(requests()).toHaveLength(1);
});

it('saves one alias mapping for shared entries and preserves a failed edit for correction', async () => {
  await open(); click('Change database');
  const form = page().querySelector<HTMLFormElement>('.database-form')!;
  expect(form.querySelector<HTMLInputElement>('[aria-label="Database alias"]')!.readOnly).toBe(true);
  const id = form.querySelector<HTMLInputElement>('[aria-label="Database ID"]')!; id.value = replacementId;
  click('Save database reference');
  expect(requests().at(-1)).toMatchObject({ action: 'bind', alias: 'data', databaseId: replacementId });
  emit({ type: 'error', requestId: requests().at(-1)!.requestId, message: 'Database ID is already assigned to another alias.' });
  await vi.advanceTimersByTimeAsync(0);
  expect(id.value).toBe(replacementId); expect(id.disabled).toBe(false); expect(page().textContent).toContain('already assigned');
  click('Cancel'); expect(page().querySelector('.database-form')).toBeNull(); expect(requests()).toHaveLength(2);
  const environment = state(); environment.environmentOverrides = ['data'];
  click('Refresh'); await respond(environment);
  expect(page().textContent).toContain('set by the environment'); expect([...page().querySelectorAll('button')].some(control => control.textContent === 'Change database')).toBe(false);
});

it('shows only project references and icon actions, and forwards browsing to the host', async () => {
  await open();
  expect(page().querySelector('.database-permissions')).toBeNull();
  expect(page().querySelector('.database-navigation')).toBeNull();
  const actions = [...page().querySelectorAll<HTMLButtonElement>('.database-icon-button')];
  expect(actions.every(action => !!action.getAttribute('aria-label') && !action.textContent?.trim())).toBe(true);
  click('Browse data in host');
  expect(requests().at(-1)).toMatchObject({ type: 'database-open', alias: 'data', projectUri: project.uri });
  expect(requests().at(-1)).not.toHaveProperty('databaseId');
  emit({ type: 'database-open-result', requestId: requests().at(-1).requestId, error: 'No Web preview' });
  await vi.advanceTimersByTimeAsync(0);
  expect(page().textContent).toContain('No Web preview');
  expect(page().querySelector('.database-data')).toBeNull();
  expect(requests().map(message => message.action).filter(Boolean)).toEqual(['get']);
});

it('recovers from timeout and ignores foreign frames and replies to a closed database view', async () => {
  dialogs.projectInfo(project, 'databases'); const first = requests().at(-1)!.requestId;
  const child = document.createElement('iframe'); document.body.append(child);
  emit({ type: 'databases-result', requestId: first, value: state() }, child.contentWindow); await vi.advanceTimersByTimeAsync(0);
  expect(page().getAttribute('aria-busy')).toBe('true');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(page().textContent).toContain('request timed out'); expect(page().getAttribute('aria-busy')).toBe('false');
  click('Refresh'); const retry = requests().at(-1)!.requestId;
  dialogs.close(); dialogs.projectInfo(project, 'databases'); const latest = requests().at(-1)!.requestId;
  expect(latest).not.toBe(retry);
  await respond(state(), retry); expect(page().querySelector('.database-card')).toBeNull();
  await respond(state(), latest); expect(page().textContent).toContain('Shared memory');
});

it('shows an actionable error when posting fails and allows retrying', async () => {
  host.postMessage.mockRejectedValueOnce(new Error('Host is unavailable'));
  dialogs.projectInfo(project, 'databases'); await vi.advanceTimersByTimeAsync(0);
  expect(page().textContent).toContain('Host is unavailable'); expect(page().getAttribute('aria-busy')).toBe('false');
  expect(page().textContent).not.toContain('Loading databases...'); expect(page().textContent).toContain('Choose Refresh to retry.');
  click('Refresh'); await respond(); expect(page().querySelector('.database-error')!.textContent).toBe('');
});
