// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { AGENT_MODELS_CONFIGURATION_FIELD, createConfigurationState } from '@steamharness/project-configuration';
import { ConversationTools } from '../web/ui/conversation-tools';
import { mountProjectConfigurations, type ProjectConfigurationsPanel } from '../web/ui/project-configurations';
import { ProjectDatabases } from '../web/ui/project-databases';
import { projectInfoButton } from '../web/ui/toolbar';
import type { Project } from '../web/workflow-types';

const project: Project = {
  id: 'project', entryId: 'agent', aggregateName: 'Example project', name: 'Agent', defaultEntry: 'agent',
  projectType: 'conversation', entryRoot: '/project', folderPath: '/project', uri: 'file:///project', fields: [], entrypoints: [], databases: [],
  entries: [{ entryId: 'agent', type: 'conversation', name: 'Agent', root: '.', entry: 'index.ts', databases: [] }],
};
const state = createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD, { name: 'title', type: 'string', defaultValue: 'Original' }], () => 'default');
const host = { postMessage: vi.fn() };
let dialogs: ConversationTools, databases: ProjectDatabases, readOnly: boolean, available: boolean;
let configurations: ProjectConfigurationsPanel;
let listener: EventListener | undefined;
const policiesChanged = vi.fn();
const emit = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: null, data }));
const settle = () => vi.advanceTimersByTimeAsync(0);
const tab = (id: string) => document.querySelector<HTMLButtonElement>(`.project-information-tabs [data-tab=${id}]`)!;
const panel = (id: string) => document.querySelector<HTMLElement>(`.project-settings-panel[data-section=${id}]`)!;
const click = (label: string, root: ParentNode = document) => {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.ariaLabel || button.textContent) === label)!;
  expect(button, label).toBeTruthy(); button.click(); return button;
};
beforeEach(() => {
  vi.useFakeTimers(); initI18n({ preference: 'en' }); host.postMessage.mockReset(); policiesChanged.mockReset(); readOnly = false; available = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  const addEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, callback: EventListener, options?: AddEventListenerOptions) => {
    if (type === 'message' && !options?.signal) listener = callback;
    addEventListener(type, callback, options);
  }) as typeof window.addEventListener);
  document.body.innerHTML = `<header class="toolbar"><div class="toolbar-actions">${projectInfoButton()}</div></header>`;
  configurations = mountProjectConfigurations(host, {
    open: () => dialogs.projectInfo(project, 'configurations'), isOpen: () => dialogs.activeSection === 'configurations',
  });
  databases = new ProjectDatabases(host);
  dialogs = new ConversationTools(databases, {
    configurations,
    tools: () => ({ parameters: { fields: [], tools: [{ name: 'read' }, { name: 'skill', description: 'Read SKILL.md' }] }, policies: {}, changed: policiesChanged, readOnly }),
    usage: { available: () => available, load: requestId => host.postMessage({ type: 'usage', requestId }) },
  });
  document.getElementById('project-info')!.onclick = () => dialogs.projectInfo(project);
});
afterEach(() => {
  dialogs.close(); databases.dispose(); if (listener) window.removeEventListener('message', listener); listener = undefined;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); document.body.replaceChildren();
});

it('opens one settings shell with six sections, accessible vertical navigation and no eager requests', () => {
  const trigger = document.getElementById('project-info')!; trigger.focus(); trigger.click();
  const dialog = document.querySelector<HTMLDialogElement>('.project-information-dialog')!;
  expect(dialog.open).toBe(true); expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(document.querySelector('.project-information-tabs')?.getAttribute('aria-orientation')).toBe('vertical');
  expect([...document.querySelectorAll<HTMLButtonElement>('.project-information-tabs button')].map(button => button.dataset.tab)).toEqual(['overview', 'configurations', 'tools', 'skills', 'usage', 'databases']);
  expect(panel('overview').textContent).toContain('Example project'); expect(host.postMessage).not.toHaveBeenCalled();
  for (const button of document.querySelectorAll<HTMLButtonElement>('.project-information-tabs button')) {
    const target = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(target.getAttribute('role')).toBe('tabpanel'); expect(target.getAttribute('aria-labelledby')).toBe(button.id);
  }
  tab('overview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(dialogs.activeSection).toBe('configurations'); expect(document.activeElement).toBe(tab('configurations'));
  expect(document.querySelectorAll('dialog')).toHaveLength(1); expect(host.postMessage.mock.calls.at(-1)?.[0].call.action).toBe('get');
  emit({ type: 'project-configuration-result', requestId: host.postMessage.mock.calls.at(-1)![0].requestId, value: state });
  click('Close'); expect(document.activeElement).toBe(trigger); expect(dialog.open).toBe(false);
});

it('preserves configuration drafts, tool search and section scroll while navigating', async () => {
  dialogs.projectInfo(project, 'configurations');
  emit({ type: 'project-configuration-result', requestId: host.postMessage.mock.calls.at(-1)![0].requestId, value: state }); await settle();
  document.querySelector<HTMLButtonElement>('.configuration-profile-link')!.click();
  const input = document.querySelector<HTMLInputElement>('[aria-label="title"]')!;
  input.value = 'Keep this draft'; input.dispatchEvent(new Event('input'));
  tab('tools').click(); const search = panel('tools').querySelector<HTMLInputElement>('[type=search]')!;
  search.value = 'read'; search.dispatchEvent(new Event('input')); panel('tools').scrollTop = 75;
  tab('skills').click(); expect(panel('skills').querySelector('input, select, button')).toBeNull(); expect(panel('skills').textContent).not.toContain('Auto-approve');
  tab('tools').click(); expect(search.value).toBe('read'); expect(panel('tools').scrollTop).toBe(75);
  tab('configurations').click(); expect(input.value).toBe('Keep this draft'); expect(panel('configurations').contains(input)).toBe(true);
  expect(host.postMessage).toHaveBeenCalledTimes(1); expect(policiesChanged).not.toHaveBeenCalled();
});

it('routes configuration shortcuts into the existing shell and ignores late field focus after navigation', async () => {
  dialogs.projectInfo(project); const dialog = document.querySelector('dialog');
  configurations.openAgentModels();
  expect(dialogs.activeSection).toBe('configurations'); expect(document.querySelectorAll('dialog')).toHaveLength(1); expect(document.querySelector('dialog')).toBe(dialog);
  const requestId = host.postMessage.mock.calls.at(-1)![0].requestId;
  tab('skills').click(); tab('skills').focus();
  emit({ type: 'project-configuration-result', requestId, value: state }); await settle();
  expect(dialogs.activeSection).toBe('skills'); expect(document.activeElement).toBe(tab('skills'));
});

it('keeps usage responses inside their section and rejects stale refresh and closed-dialog results', () => {
  dialogs.projectInfo(project); tab('usage').click();
  const first = host.postMessage.mock.calls.at(-1)![0].requestId;
  tab('overview').click(); dialogs.usageResult(first, { balance: 12, groups: [] });
  expect(dialogs.activeSection).toBe('overview'); expect(panel('usage').textContent).toContain('$12.00'); expect(panel('overview').textContent).not.toContain('$12.00');
  tab('usage').click(); click('Refresh usage'); const second = host.postMessage.mock.calls.at(-1)![0].requestId;
  dialogs.usageResult(first, { balance: 99, groups: [] }); expect(panel('usage').textContent).not.toContain('$99.00');
  dialogs.usageResult(second, undefined, 'Usage failed'); expect(panel('usage').querySelector('[role=alert]')?.textContent).toBe('Usage failed');
  expect(click('Refresh usage').disabled).toBe(true); const third = host.postMessage.mock.calls.at(-1)![0].requestId;
  dialogs.close(); dialogs.projectInfo(project, 'usage'); dialogs.usageResult(third, { balance: 99, groups: [] });
  expect(panel('usage').textContent).toContain('Loading usage'); expect(panel('usage').textContent).not.toContain('$99.00');
});

it('allows retry after a usage timeout and clears account details on authentication changes', async () => {
  dialogs.projectInfo(project, 'usage'); await vi.advanceTimersByTimeAsync(20_000);
  expect(panel('usage').querySelector('[role=alert]')?.textContent).toContain('request timed out');
  const refresh = click('Refresh usage'); expect(refresh.disabled).toBe(true);
  dialogs.closeUsage(); expect(dialogs.open).toBe(false);
  available = false; dialogs.projectInfo(project); expect(tab('usage')).toBeNull();
  expect(dialogs.activeSection).toBe('overview');
});

it('loads databases on demand once per open and retains their view across section changes', () => {
  dialogs.projectInfo(project); expect(host.postMessage).not.toHaveBeenCalled();
  dialogs.projectInfo(project, 'databases'); expect(host.postMessage).toHaveBeenCalledTimes(1);
  const requestId = host.postMessage.mock.calls[0]![0].requestId;
  expect(host.postMessage.mock.calls[0]![0]).toMatchObject({ type: 'databases', action: 'get' });
  tab('overview').click(); tab('databases').click(); expect(host.postMessage).toHaveBeenCalledTimes(1);
  dialogs.close(); dialogs.projectInfo(project, 'databases'); expect(host.postMessage.mock.calls.at(-1)![0].requestId).not.toBe(requestId);
});

it('updates read-only tool controls while keeping skills free of permission controls', () => {
  dialogs.projectInfo(project, 'tools'); const input = panel('tools').querySelector<HTMLInputElement>('[type=checkbox]')!;
  readOnly = true; dialogs.updatePermissions(); expect(input.disabled).toBe(true); input.click(); expect(policiesChanged).not.toHaveBeenCalled();
  tab('skills').click(); expect(panel('skills').querySelector('input, select, button')).toBeNull();
  readOnly = false; dialogs.updatePermissions(); tab('tools').click(); expect(input.disabled).toBe(false); input.click();
  expect(policiesChanged).toHaveBeenCalledWith({ read: { enabled: false, autoApprove: false } });
});
