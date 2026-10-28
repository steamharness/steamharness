// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { mountEntryWindows } from '../web/ui/entry-windows';

const projectId = '3bd18168-f4f6-486b-842c-ab9f8098d9d4';
const entries = [
  { entryId: 'agent', name: 'Agent', type: 'conversation', status: 'running', href: '/entries/agent/', projectCard: { icon: 'bot', iconColor: '#112233', iconBackgroundColor: '#aabbcc' } },
  { entryId: 'database', name: 'Database', type: 'workflow', status: 'idle', href: '/entries/database/' },
  { entryId: 'second', name: 'Second workflow', type: 'workflow', status: 'idle', href: '/entries/second/' },
];
let mounted: ReturnType<typeof mountEntryWindows>;
const emit = (data: unknown, source: MessageEventSource | null = null, origin = location.origin) => dispatchEvent(new MessageEvent('message', { data, source, origin }));
const split = (id: string) => document.querySelector<HTMLButtonElement>(`[data-entry-id="${id}"] [data-action="split"]`)!.click();
beforeEach(() => {
  initI18n({ preference: 'en' });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  document.body.innerHTML = '<div id="app"><header class="toolbar"><div class="toolbar-actions"></div></header><textarea id="draft">Keep my draft</textarea></div>';
  mounted = mountEntryWindows(document.querySelector('.toolbar-actions')!);
  const dialog = document.querySelector('dialog')!;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
  emit({ type: 'state', project: { id: projectId, entryId: 'agent' }, aggregate: { projectId, name: 'Aggregate', defaultEntry: 'agent', entries } });
});
afterEach(() => { mounted.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('keeps one primary UI, uses entry icons, and retains split drafts when switching windows', () => {
  const app = document.querySelector('#app'), draft = document.querySelector('#draft');
  mounted.trigger.click();
  expect(document.querySelector('dialog')!.open).toBe(true);
  expect(decodeURIComponent(document.querySelector<HTMLImageElement>('[data-entry-id="agent"] img')!.src)).toContain('stroke="#112233"');
  expect(document.querySelector('[data-entry-id="agent"]')!.textContent).toContain('Default window');
  split('database');
  const database = document.querySelector<HTMLIFrameElement>('.entry-pane-frame')!;
  expect(new URL(database.src).pathname).toBe('/entries/database/');
  expect(document.querySelector('#app')).toBe(app); expect(document.querySelector('#draft')).toBe(draft);
  split('second');
  expect(database.hidden).toBe(true); expect(document.querySelectorAll('.entry-pane-frame')).toHaveLength(2);
  split('database');
  expect(document.querySelectorAll('.entry-pane-frame')).toHaveLength(2); expect(database.hidden).toBe(false);
  document.querySelector<HTMLButtonElement>('.entry-pane-close')!.click();
  expect(document.querySelectorAll('.entry-pane-frame')).toHaveLength(1);
  expect(document.querySelector<HTMLTextAreaElement>('#draft')!.value).toBe('Keep my draft');
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  document.querySelector<HTMLButtonElement>('[data-entry-id="database"] .entry-window-actions button')!.click();
  expect(new URL(open.mock.calls[0][0] as string).pathname).toBe('/entries/database/');
  expect(open.mock.calls[0].slice(1)).toEqual(['_blank', 'noopener']);
});

it('routes Studio host requests and replies to the owning entry and rejects foreign iframe messages', () => {
  const parent = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  emit({ type: 'workflow-host', entryWindowVersion: 1, clipboardVersion: 1 }, window);
  split('database'); split('second');
  const [database, second] = [...document.querySelectorAll<HTMLIFrameElement>('.entry-pane-frame')];
  const firstReply = vi.spyOn(database.contentWindow!, 'postMessage').mockImplementation(() => {});
  const secondReply = vi.spyOn(second.contentWindow!, 'postMessage').mockImplementation(() => {});
  const request = { type: 'workflow-path-picker', version: 1, requestId: 'pick', kind: 'files', target: 'entry-file' };
  emit(request, database.contentWindow, 'https://unrelated.example'); expect(parent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'workflow-entry-message' }), '*');
  emit(request, database.contentWindow);
  const envelope = parent.mock.calls.find(([message]) => message.type === 'workflow-entry-message')![0];
  expect(envelope).toMatchObject({ entryId: 'database', projectId, message: request });
  const reply = { type: 'workflow-host', pathSelection: { version: 1, requestId: 'pick', paths: ['/data'] } };
  emit({ type: 'workflow-entry-host', version: 1, frameId: envelope.frameId, message: reply }, window);
  expect(firstReply).toHaveBeenCalledWith(reply, location.origin); expect(secondReply).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('[data-entry-id="database"] .entry-window-actions button')!.click();
  expect(parent).toHaveBeenCalledWith({ type: 'workflow-open-entry', version: 1, projectId, entryId: 'database' }, '*');
});
