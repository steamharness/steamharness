// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerMentionToken, mentionRanges, mentionText } from '../web/conversation-mentions';
import { ConversationMentions } from '../web/ui/conversation-mentions';
import { ConversationComposer } from '../web/ui/conversation-composer';
import type { Project } from '../web/workflow-types';
import type { KanbanConversationMentionGroup } from '@steamharness/kanban-project';

const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren();
});

function fixture() {
  vi.useFakeTimers(); vi.stubGlobal('ResizeObserver', class { observe() {} });
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener, options }); add(type, listener, options);
    });
  }
  document.body.innerHTML = '<div class="composer"><textarea id="message"></textarea></div><div id="slash"></div><div id="footer"></div>';
  const textarea = document.querySelector('textarea')!;
  const project: Project = { id: 'project', uri: 'file:///project', folderPath: '/project', name: 'Project', projectType: 'conversation',
    entryId: 'chat', aggregateName: 'Project', defaultEntry: 'chat', entryRoot: '/project', databases: [], fields: [], entrypoints: [], entries: [
      { entryId: 'chat', name: '对话', type: 'conversation', root: '.', entry: 'index.ts', databases: [] },
      { entryId: 'collect', name: 'Collect data', type: 'workflow', root: 'collector', entry: 'main.ts', databases: [] },
    ] };
  const state = { scope: 'first', project, enabled: true, disabled: false, groups: [] as KanbanConversationMentionGroup[] };
  const load = vi.fn(); const input = vi.fn(); textarea.addEventListener('input', input);
  const composer = new ConversationComposer(textarea, document.querySelector('#slash')!, document.querySelector('#footer')!, {
    current: () => ({ ...state, parameters: { fields: [] }, values: {}, states: {}, loading: false,
      commands: [{ command: 'export', label: 'Export', action: { kind: 'export' } }] }), onChange() {}, onCommand: () => true,
  });
  const mentions = new ConversationMentions(textarea, { current: () => state, load });
  const popup = document.querySelector<HTMLElement>('#mention-menu')!;
  const type = (text: string, caret = text.length) => {
    textarea.value = text; textarea.setSelectionRange(caret, caret); textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true })); composer.update(); mentions.update();
  };
  const key = (key: string, extra = {}) => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, ...extra });
    return { handled: mentions.handleKeydown(event) || composer.handleKeydown(event), event };
  };
  const reply = (type: 'project-skills' | 'project-mention-files', value: unknown) => {
    const request = load.mock.calls.filter(call => call[0] === type).at(-1)!;
    mentions.receive({ type: `${type}-result`, requestId: request[1], value });
  };
  const rows = () => Array.from(popup.querySelectorAll<HTMLButtonElement>('button'));
  return { mentions, composer, state, load, textarea, popup, type, key, reply, rows, input };
}

describe('reference text', () => {
  it('inserts project-defined references with stable values, search and highlights', () => {
    const f = fixture();
    f.state.groups = [{ kind: 'bot', label: 'Bot', items: [{ value: 'researcher', label: '研究员', description: '查证信息' }] }];
    f.type('@'); expect(f.rows()[0]?.textContent).toContain('研究员');
    f.key('Enter'); expect(f.mentions.text()).toBe('@bot:researcher ');
    expect(f.textarea.parentElement?.querySelector('mark')?.textContent).toBe('@bot:researcher');
    f.type('@bot:查证'); expect(f.rows()).toHaveLength(1);
    f.key('Escape'); expect(f.popup.hidden).toBe(true);
    f.type(''); f.type('@bot:查证'); expect(f.popup.hidden).toBe(false);
    f.state.groups = []; f.mentions.update(); expect(f.rows()).toHaveLength(0);
    expect(composerMentionToken('@ticket:abc', 11)).toMatchObject({ kind: 'ticket', query: 'abc' });
    expect(mentionText('ticket', 'a b')).toBe('@ticket:"a b"');
  });
  it('handles caret replacement, quoted paths, Chinese punctuation and ordinary email addresses', () => {
    expect(composerMentionToken('请检查（@file:src/main.ts）', 16)).toMatchObject({ kind: 'file', query: 'src/ma' });
    const text = '请检查 @file:src/main.ts 后续';
    expect(composerMentionToken(text, 16)).toMatchObject({ start: 4, end: 21, kind: 'file', query: 'src/ma' });
    expect(composerMentionToken('@设计', 3)).toMatchObject({ query: '设计' });
    expect(composerMentionToken('说明，@entry:co', 12)).toMatchObject({ kind: 'entry', query: 'co' });
    for (const value of ['user@example.com', 'https://example.com/@user', '@skill:plan ', '@file:"a b.ts"'])
      expect(composerMentionToken(value, value.length)).toBeUndefined();
    expect(composerMentionToken('@skill:plan', 2, 4)).toBeUndefined();
    expect(composerMentionToken('@file:"a b', 10)).toMatchObject({ kind: 'file', query: 'a b' });
    expect(mentionText('file', '/project/a b.ts')).toBe('@file:"/project/a b.ts"');
    expect(mentionText('file', 'C:\\项目\\a b.ts')).toBe('@file:"C:\\\\项目\\\\a b.ts"');
    expect(mentionRanges('请用 @skill:project:plan 读取 @file:"a b.ts"')).toHaveLength(2);
  });
});

describe('Conversation @ menu', () => {
  it('opens the three categories and inserts a project entry without submitting or switching projects', () => {
    const f = fixture(); f.type('@');
    expect(f.rows().map(row => row.dataset.kind)).toEqual(['skill', 'file', 'entry']); expect(f.load).not.toHaveBeenCalled();
    f.key('End'); f.key('Enter'); expect(f.textarea.value).toBe('@entry:');
    f.key('ArrowDown'); f.key('Tab'); expect(f.textarea.value).toBe('@entry:collect '); expect(f.popup.hidden).toBe(true);
    expect(f.textarea.parentElement?.querySelector('mark')?.textContent).toBe('@entry:collect');
    expect(f.input).toHaveBeenCalled(); expect(document.activeElement).toBe(f.textarea);
    expect(f.state.project.entryId).toBe('chat'); expect(f.load).not.toHaveBeenCalled();
  });

  it('searches configured skills and files, inserts quoted paths at the caret and keeps trailing text', () => {
    const f = fixture(); f.type('检查 @mai 后文', 7);
    f.reply('project-skills', [{ id: 'project:maintain', name: 'Maintain', description: 'Project maintenance', source: 'project' }]);
    vi.advanceTimersByTime(150); expect(f.load.mock.calls.at(-1)?.[2]).toBe('mai');
    f.reply('project-mention-files', { files: [{ path: '/project/src/main file.ts', name: 'src/main file.ts' }], truncated: false });
    expect(f.rows()).toHaveLength(3);
    f.rows().find(row => row.dataset.kind === 'file')!.click();
    expect(f.textarea.value).toBe('检查 @file:"main file.ts"  后文');
    expect(f.mentions.text()).toBe('检查 @file:"/project/src/main file.ts"  后文');
    expect(f.textarea.parentElement?.querySelector('mark')?.textContent).toBe('@file:"main file.ts"');
    expect(f.textarea.parentElement?.querySelector('mark')?.title).toBe('/project/src/main file.ts');
    f.type('@skill:maint'); f.key('Enter'); expect(f.textarea.value).toBe('@skill:Maintain ');
  });

  it('debounces file searches and ignores responses for older queries and previous conversations', () => {
    const f = fixture(); f.type('@file:a'); vi.advanceTimersByTime(150);
    const first = f.load.mock.calls.at(-1)![1];
    f.type('@file:ab'); f.type('@file:abc'); vi.advanceTimersByTime(149); expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.mentions.receive({ type: 'project-mention-files-result', requestId: first, value: { files: [{ path: '/old', name: 'old' }] } })).toBe(false);
    vi.advanceTimersByTime(1); expect(f.load.mock.calls.at(-1)?.[2]).toBe('abc');
    const second = f.load.mock.calls.at(-1)![1]; f.state.scope = 'second'; f.type('Restored @entry:chat draft');
    expect(f.mentions.receive({ type: 'project-mention-files-result', requestId: second, value: { files: [] } })).toBe(false);
    expect(f.textarea.parentElement?.querySelector('mark')?.textContent).toBe('@entry:chat'); expect(f.popup.hidden).toBe(true);
  });

  it('keeps Enter from sending while loading or empty and offers retry after errors and timeouts', () => {
    const f = fixture(); f.type('@file:missing'); expect(f.key('Enter').handled).toBe(true);
    vi.advanceTimersByTime(150); f.reply('project-mention-files', { files: [], truncated: false });
    expect(f.popup.textContent).toContain('No matching references'); expect(f.key('Enter').handled).toBe(true);
    f.type('@skill:plan'); const requestId = f.load.mock.calls.at(-1)![1];
    f.mentions.receive({ type: 'error', requestId, message: 'Cannot read skills' });
    expect(f.popup.textContent).toContain('Cannot read skills'); f.rows()[0].click(); expect(f.load).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(40_000); expect(f.popup.textContent).toContain('timed out');
    f.key('Escape'); expect(f.popup.hidden).toBe(true); expect(f.key('Enter').handled).toBe(false);
  });

  it('preserves IME, multiline editing, Escape dismissal, read-only state and ordinary slash commands', () => {
    const f = fixture(); f.type('@entry:');
    expect(f.key('Enter', { isComposing: true }).handled).toBe(false); expect(f.key('Enter', { shiftKey: true }).handled).toBe(false);
    f.textarea.dispatchEvent(new Event('compositionstart')); expect(f.popup.hidden).toBe(true);
    f.textarea.dispatchEvent(new Event('compositionend')); expect(f.popup.hidden).toBe(false);
    f.key('Escape'); f.mentions.update(); expect(f.popup.hidden).toBe(true);
    f.type('@entry:c'); expect(f.popup.hidden).toBe(false);
    f.state.disabled = true; f.rows()[0].click(); expect(f.textarea.value).toBe('@entry:c'); f.mentions.update(); expect(f.popup.hidden).toBe(true);
    f.state.disabled = false; f.type('/exp'); expect(document.querySelector<HTMLElement>('#slash')!.hidden).toBe(false);
    expect(f.textarea.getAttribute('aria-controls')).toBe('slash'); expect(f.key('Enter').handled).toBe(true); expect(f.textarea.value).toBe('');
  });

  it('renders untrusted names and pasted references as text, updates highlighting on edits and follows scrolling', () => {
    const f = fixture(); f.type('@skill:'); f.reply('project-skills', [{ id: 'project:unsafe', name: '<img src=x onerror=alert(1)>', description: '<script>bad</script>', source: 'project' }]);
    expect(f.popup.querySelector('img,script')).toBeNull(); expect(f.popup.textContent).toContain('<img');
    f.type('粘贴 @file:"/project/<img>.ts"\n@entry:chat'); expect(f.textarea.parentElement?.querySelectorAll('mark')).toHaveLength(2);
    expect(f.textarea.parentElement?.querySelector('img')).toBeNull(); f.textarea.scrollTop = 42; f.textarea.dispatchEvent(new Event('scroll'));
    expect(f.textarea.parentElement?.querySelector('.mention-highlights')?.scrollTop).toBe(42);
    f.type('Plain message'); expect(f.textarea.parentElement?.classList.contains('has-mentions')).toBe(false);
    f.state.enabled = false; f.type('@'); expect(f.popup.hidden).toBe(true); expect(f.textarea.parentElement?.classList.contains('has-mentions')).toBe(false);
  });

  it('restores compact file names, shows the path on hover and retains full references when copying or pasting', () => {
    const f = fixture(), source = '@file:"/project/src/main file.ts" ';
    f.mentions.setText(source); f.mentions.update();
    expect(f.textarea.value).toBe('@file:"main file.ts" '); expect(f.mentions.text()).toBe(source);
    const mark = f.textarea.parentElement!.querySelector('mark')!;
    vi.spyOn(mark, 'getClientRects').mockReturnValue([{ left: 10, right: 200, top: 20, bottom: 44 }] as unknown as DOMRectList);
    f.textarea.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 30 })); expect(f.textarea.title).toBe('/project/src/main file.ts');
    f.textarea.dispatchEvent(new Event('pointerleave')); expect(f.textarea.title).toBe('');
    f.textarea.select(); const setData = vi.fn();
    const copy = Object.assign(new Event('copy', { cancelable: true }), { clipboardData: { setData } }); f.textarea.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true); expect(setData).toHaveBeenCalledWith('text/plain', source);
    const paste = Object.assign(new Event('paste', { cancelable: true }), { clipboardData: { getData: () => source } }); f.textarea.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true); expect(f.textarea.value).toBe('@file:"main file.ts" '); expect(f.mentions.text()).toBe(source);
  });
});
