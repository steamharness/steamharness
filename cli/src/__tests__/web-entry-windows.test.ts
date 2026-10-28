// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { mountEntryWindows } from '../web/ui/entry-windows';

const projectId = '3bd18168-f4f6-486b-842c-ab9f8098d9d4';
const entries = [
  { entryId: 'agent', name: 'Agent', type: 'conversation', status: 'running', href: '/entries/agent/', projectCard: { icon: 'bot', iconColor: '#112233', iconBackgroundColor: '#aabbcc' } },
  { entryId: 'database', name: 'Database', type: 'workflow', status: 'idle', href: '/entries/database/' },
  { entryId: 'board', name: 'Board', type: 'kanban', status: 'idle', href: '/entries/board/' },
];
let mounted: ReturnType<typeof mountEntryWindows>;
const emit = (data: unknown, source: MessageEventSource | null = null) => dispatchEvent(new MessageEvent('message', { data, source }));
const state = (values = entries) => emit({ type: 'state', project: { id: projectId, entryId: 'agent' }, aggregate: { projectId, name: 'Aggregate', defaultEntry: 'agent', entries: values } });
const open = (id: string) => document.querySelector<HTMLButtonElement>(`[data-entry-id="${id}"] [data-action="open"]`)!;
function mount(language: 'en' | 'zh-CN' = 'en') {
  initI18n({ preference: language });
  mounted = mountEntryWindows(document.querySelector('.toolbar-actions')!);
  const dialog = document.querySelector('dialog')!;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
  state();
}
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  document.body.innerHTML = '<div id="app"><header class="toolbar"><div class="toolbar-actions"></div></header><textarea id="draft">Keep my draft</textarea></div>';
  mount();
});
afterEach(() => { mounted.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); document.body.replaceChildren(); });

it.each(['en', 'zh-CN'] as const)('uses accessible icon actions and compact entry details in %s', language => {
  mounted.dispose(); mount(language);
  const title = language === 'en' ? 'Project windows' : '项目窗口';
  expect(mounted.trigger.textContent).toBe('');
  expect(mounted.trigger.getAttribute('aria-label')).toBe(title);
  expect(mounted.trigger.title).toBe(title);
  mounted.trigger.click();
  expect(document.querySelector('dialog')!.open).toBe(true);
  expect(mounted.trigger.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('.entry-windows-project')!.textContent).toBe('Aggregate');
  const current = document.querySelector('[data-entry-id="agent"]')!;
  expect(decodeURIComponent(current.querySelector<HTMLImageElement>('img')!.src)).toContain('stroke="#112233"');
  expect(current.querySelector('.entry-window-current')!.textContent).toBe(language === 'en' ? 'Current window' : '当前窗口');
  expect(current.querySelector('.entry-window-default')!.textContent).toBe(language === 'en' ? 'Default window' : '默认入口');
  expect(current.querySelector('.entry-window-status')!.textContent).toBe(language === 'en' ? 'running' : '运行中');
  expect(current.querySelectorAll('button')).toHaveLength(1);
  expect(document.querySelector('[data-action="split"]')).toBeNull();
  expect(open('agent').textContent).toBe('');
  expect(open('agent').getAttribute('aria-label')).toContain('Agent');
  expect(open('agent').title).toBe(language === 'en' ? 'Open in new browser tab' : '在新的浏览器标签页中打开');
});

it.each(['agent', 'database', 'board'])('opens %s repeatedly in independent browser pages without changing the current view', id => {
  history.replaceState(null, '', '/entries/agent/?projectLocale=zh-CN&projectView=original');
  const app = document.querySelector('#app'), draft = document.querySelector('#draft');
  const browser = vi.spyOn(window, 'open').mockReturnValue(null);
  for (let index = 0; index < 2; index++) { mounted.trigger.click(); open(id).click(); }
  expect(browser).toHaveBeenCalledTimes(2);
  const urls = browser.mock.calls.map(call => new URL(call[0] as string));
  for (const url of urls) {
    expect(url.pathname).toBe(`/entries/${id}/`);
    expect(url.searchParams.get('projectLocale')).toBe('zh-CN');
    expect(url.searchParams.get('projectView')).not.toBe('original');
    expect(url.searchParams.has('projectPane')).toBe(false);
  }
  expect(urls[0].searchParams.get('projectView')).not.toBe(urls[1].searchParams.get('projectView'));
  expect(browser.mock.calls[0].slice(1)).toEqual(['_blank', 'noopener']);
  expect(document.querySelector('#app')).toBe(app); expect(document.querySelector('#draft')).toBe(draft);
  expect(document.querySelector<HTMLTextAreaElement>('#draft')!.value).toBe('Keep my draft');
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('dialog')!.open).toBe(false);
  expect(mounted.trigger.getAttribute('aria-expanded')).toBe('false');
});

it('asks Studio to create a fresh native tab for every click, including repeated current entries', () => {
  const parent = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const browser = vi.spyOn(window, 'open').mockReturnValue(null);
  emit({ type: 'workflow-host', entryWindowVersion: 1 }, window);
  for (const id of ['agent', 'agent', 'database', 'board']) {
    mounted.trigger.click(); expect(open(id).disabled).toBe(false); open(id).click();
  }
  expect(parent.mock.calls.map(([message]) => message)).toEqual(['agent', 'agent', 'database', 'board'].map(entryId => ({ type: 'workflow-open-entry', version: 1, projectId, entryId })));
  expect(open('agent').title).toBe('Open in new Studio tab');
  expect(browser).not.toHaveBeenCalled();
});

it('updates runtime status in place, retaining keyboard focus and ignoring foreign frame state', () => {
  mounted.trigger.click();
  const action = open('database'); action.focus();
  state(entries.map(entry => ({ ...entry, status: entry.entryId === 'database' ? 'running' : entry.status })));
  expect(open('database')).toBe(action); expect(document.activeElement).toBe(action);
  expect(document.querySelector('[data-entry-id="database"] .entry-window-status')!.textContent).toBe('running');
  const child = document.createElement('iframe'); document.body.append(child);
  emit({ type: 'state', aggregate: { projectId, name: 'Foreign', entries: [] } }, child.contentWindow);
  emit({ type: 'workflow-host', entryWindowVersion: 1 }, child.contentWindow);
  expect(document.querySelector('.entry-windows-project')!.textContent).toBe('Aggregate');
  expect(open('database').title).toBe('Open in new browser tab');
});
