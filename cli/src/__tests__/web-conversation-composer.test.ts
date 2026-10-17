import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerSlashToken, conversationSlashCommands, conversationFooterTexts, ConversationComposer } from '../web/ui/conversation-composer';
import { mergeWorkflowParamStates } from '../web/workflow-types';
import type { ConversationCommandDefinition, ConversationFooterItem, WorkflowParameters, WorkflowParamState, WorkflowParamValues } from '../web/workflow-types';

const parameters: WorkflowParameters = { fields: [
  { name: 'agent', type: 'string', panel: 'slash', flag: '--agent', defaultValue: 'build', options: [
    { value: 'build', label: 'Build' }, { value: 'plan', label: 'Plan' },
  ] },
  { name: 'search', type: 'boolean', panel: 'slash', flag: '--search', label: 'Search', defaultValue: 'false' },
], paramLayout: { actions: [{ kind: 'slash', name: 'agent' }, { kind: 'slash', name: 'search' }] } };
const footer: ConversationFooterItem[] = [{ text: 'Plan mode', localizedText: { 'zh-CN': 'Plan 模式' }, when: { param: 'agent', value: 'plan' } }];
afterEach(() => vi.unstubAllGlobals());

describe('Conversation composer contract', () => {
  it('recognizes slash commands at the caret without consuming paths, URLs or a text selection', () => {
    expect(composerSlashToken('/pl', 3)).toEqual({ start: 0, end: 3, query: 'pl' });
    expect(composerSlashToken('正文 /plan 后文', 6)).toEqual({ start: 3, end: 8, query: 'pl' });
    for (const text of ['https://host/plan', 'foo/plan', '/tmp/file', '/plan ']) { expect(composerSlashToken(text, text.length)).toBeUndefined(); }
    expect(composerSlashToken('/plan', 2, 4)).toBeUndefined();
    expect(composerSlashToken('正文\n/', 4)).toEqual({ start: 3, end: 4, query: '' });
  });

  it('applies resolver visibility, disabled states, aliases and boolean toggles', () => {
    const values = { agent: 'build', search: 'true' };
    const states = { agent: { options: { build: { visible: false }, plan: { disabled: true } } } };
    expect(conversationSlashCommands(parameters, values, states)).toEqual([
      expect.objectContaining({ command: 'plan', name: 'agent', value: 'plan', disabled: true }),
      expect.objectContaining({ command: 'search', name: 'search', value: 'false', selected: true }),
    ]);
    expect(conversationSlashCommands(parameters, values, { search: { visible: false } })).toHaveLength(2);
    const aliased = { ...parameters, fields: [{ ...parameters.fields[0], options: [{ value: 'planning', command: 'plan' }] }] };
    expect(conversationSlashCommands(aliased, {}, { agent: { resolvedOptions: [{ value: 'planning', label: 'Planning' }] } })[0]).toMatchObject({ command: 'plan', label: 'Planning', value: 'planning' });
  });

  it('displays plain and localized text or selected parameter labels only while their conditions hold', () => {
    expect(conversationFooterTexts(footer, parameters, { agent: 'build' }, {}, 'zh-CN')).toEqual([]);
    expect(conversationFooterTexts(footer, parameters, { agent: 'plan' }, {}, 'zh-cn')).toEqual(['Plan 模式']);
    expect(conversationFooterTexts(footer, parameters, { agent: 'plan' }, {}, 'fr')).toEqual(['Plan mode']);
    expect(conversationFooterTexts([{ param: 'agent' }, { text: '<script>literal</script>' }], parameters, { agent: 'plan' }, {}, 'en')).toEqual(['Plan', '<script>literal</script>']);
    expect(conversationFooterTexts([{ param: 'agent' }, ...footer], parameters, { agent: 'plan' }, { agent: { visible: false } })).toEqual([]);
  });

  it('retains partial parameter updates but clears old option visibility when the list is replaced or restored', () => {
    const previous = { agent: { resolvedOptions: [{ value: 'plan', label: 'Old plan' }], options: { plan: { visible: false } } } };
    const unchanged = structuredClone(previous);
    const retained = mergeWorkflowParamStates(previous, { agent: { disabled: true } });
    expect(conversationSlashCommands(parameters, {}, retained).some(entry => entry.command === 'plan')).toBe(false);
    const replaced = mergeWorkflowParamStates(previous, { agent: { resolvedOptions: [{ value: 'plan', label: 'New plan' }] } });
    expect(conversationSlashCommands(parameters, {}, replaced)[0]).toMatchObject({ command: 'plan', label: 'New plan', disabled: false });
    const restored = mergeWorkflowParamStates(previous, { agent: { resolvedOptions: null, options: { build: { disabled: true } } } });
    expect(conversationSlashCommands(parameters, {}, restored).slice(0, 2)).toEqual([
      expect.objectContaining({ command: 'build', disabled: true }), expect.objectContaining({ command: 'plan', disabled: false }),
    ]);
    expect(previous).toEqual(unchanged);
  });

  it('merges visibility and disabled option patches independently until the options are replaced', () => {
    const previous = { agent: { options: { plan: { visible: false, disabled: true } } } };
    const unchanged = structuredClone(previous);
    const visible = mergeWorkflowParamStates(previous, { agent: { options: { plan: { visible: true } } } });
    expect(conversationSlashCommands(parameters, {}, visible).find(entry => entry.command === 'plan')).toMatchObject({ disabled: true });
    const hidden = mergeWorkflowParamStates(previous, { agent: { options: { plan: { disabled: false } } } });
    expect(conversationSlashCommands(parameters, {}, hidden).some(entry => entry.command === 'plan')).toBe(false);
    const enabled = mergeWorkflowParamStates(visible, { agent: { options: { plan: { disabled: false } } } });
    expect(conversationSlashCommands(parameters, {}, enabled).find(entry => entry.command === 'plan')).toMatchObject({ disabled: false });
    const replaced = mergeWorkflowParamStates(previous, { agent: { resolvedOptions: null, options: { plan: { visible: true } } } });
    expect(conversationSlashCommands(parameters, {}, replaced).find(entry => entry.command === 'plan')).toMatchObject({ disabled: false });
    expect(previous).toEqual(unchanged);
  });
});

function fixture() {
  const documentState = Object.assign(new EventTarget(), { activeElement: undefined as unknown });
  class Element extends EventTarget {
    hidden = false; id = ''; className = ''; textContent = ''; title = ''; type = ''; disabled = false; tabIndex = 0;
    children: Element[] = []; dataset: Record<string, string> = {}; attributes = new Map<string, string>(); style = {};
    offsetTop = 0; offsetHeight = 40; clientHeight = 240; scrollTop = 0;
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.children = children; }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    getBoundingClientRect() { return { top: 400, left: 40, width: 800 }; }
    closest() { return this; }
    focus() { documentState.activeElement = this; }
    click() { this.dispatchEvent(new Event('click')); }
  }
  class Textarea extends Element {
    value = ''; selectionStart = 0; selectionEnd = 0;
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
    setRangeText(text: string, start: number, end: number, selection: string) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = selection === 'end' ? start + text.length : start;
    }
  }
  vi.stubGlobal('document', Object.assign(documentState, { createElement: () => new Element() }));
  const viewport = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal('window', viewport); vi.stubGlobal('ResizeObserver', class { observe() {} });
  const textarea = new Textarea(), popup = new Element(), footerRoot = new Element(); popup.id = 'commands';
  const state = { scope: 'first', enabled: true, parameters, values: { agent: 'build', search: 'false' } as WorkflowParamValues,
    states: {} as Record<string, WorkflowParamState>, footer, commands: [] as ConversationCommandDefinition[], commandDisabled: false, disabled: false, loading: false };
  const changed = vi.fn((name: string, value: string) => { state.values[name] = value; });
  const input = vi.fn(); textarea.addEventListener('input', input);
  const command = vi.fn(() => true);
  const composer = new ConversationComposer(textarea as unknown as HTMLTextAreaElement, popup as unknown as HTMLElement,
    footerRoot as unknown as HTMLElement, { current: () => state, onChange: changed, onCommand: command });
  const type = (text: string, caret = text.length) => { textarea.value = text; textarea.selectionStart = textarea.selectionEnd = caret; textarea.focus(); composer.update(); };
  const key = (key: string, extra = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...extra });
    return { handled: composer.handleKeydown(event as unknown as KeyboardEvent), event };
  };
  return { composer, textarea, popup, footerRoot, state, changed, command, input, type, key, viewport };
}

describe('Conversation menu interactions', () => {
  it('lists every action and parameter for a bare slash, without a left checkmark', () => {
    const f = fixture();
    f.state.commands = [{ command: 'export', label: 'Export conversation', action: { kind: 'export' } },
      { command: 'compact', label: 'Summarize context', action: { kind: 'prompt', text: '/compact' } }];
    f.type('/'); expect(f.popup.children.map(row => row.dataset.command)).toEqual(['build', 'plan', 'search', 'export', 'compact']);
    expect(f.popup.children.every(row => row.children.length === 3 && !row.children.some(child => child.className.includes('check')))).toBe(true);
    f.type('draft /compact rest'); f.textarea.setSelectionRange(14, 14); f.composer.update(); f.key('Enter');
    expect(f.command).toHaveBeenCalledWith('compact'); expect(f.changed).not.toHaveBeenCalled();
    expect(f.textarea.value).toBe('draft rest');
  });

  it('dispatches an exact command on submit and keeps disabled or rejected commands in the draft', () => {
    const f = fixture(); f.state.commands = [{ command: 'export', label: 'Export', action: { kind: 'export' } }];
    f.type('/export'); f.composer.close(true); expect(f.composer.submitCommand()).toBe(true);
    expect(f.command).toHaveBeenCalledOnce(); expect(f.textarea.value).toBe('');
    f.state.commandDisabled = true; f.type('/export'); expect(f.composer.submitCommand()).toBe(true);
    expect(f.command).toHaveBeenCalledOnce(); expect(f.textarea.value).toBe('/export');
    f.state.commandDisabled = false; f.command.mockReturnValueOnce(false); f.type('/export'); f.key('Enter');
    expect(f.textarea.value).toBe('/export');
  });

  it('opens upwards, filters commands, changes Plan with the keyboard and consumes no message beyond the command', () => {
    const f = fixture(); f.type('/'); expect(f.popup.hidden).toBe(false); expect(f.popup.children).toHaveLength(3);
    expect(f.popup.children.every(row => row.tabIndex === -1)).toBe(true);
    expect(f.popup.style).toMatchObject({ bottom: '408px', width: '800px', maxHeight: '320px' });
    f.type('正文 /plan 后文', 6); expect(f.popup.children).toHaveLength(1);
    expect(f.key('Enter').handled).toBe(true); expect(f.changed).toHaveBeenCalledWith('agent', 'plan');
    expect(f.textarea.value).toBe('正文 后文'); expect(f.input).toHaveBeenCalledOnce(); expect(f.popup.hidden).toBe(true);
    expect(f.footerRoot.hidden).toBe(false); expect(f.footerRoot.children[0].textContent).toMatch(/Plan/);
    f.type('/build'); f.key('Tab'); expect(f.state.values.agent).toBe('build'); expect(f.footerRoot.hidden).toBe(true);
  });

  it('toggles boolean commands in both directions without putting slash text into the draft', () => {
    const f = fixture(); f.type('/search'); f.key('Enter'); expect(f.state.values.search).toBe('true'); expect(f.textarea.value).toBe('');
    f.type('/search'); f.key('Tab'); expect(f.state.values.search).toBe('false'); expect(f.textarea.value).toBe('');
  });

  it('supports keyboard navigation and pointer selection while respecting current disabled state', () => {
    const f = fixture(); f.type('/'); f.key('End'); expect(f.textarea.attributes.get('aria-activedescendant')).toBe('commands-2');
    f.key('ArrowDown'); expect(f.textarea.attributes.get('aria-activedescendant')).toBe('commands-0');
    f.key('ArrowUp'); expect(f.textarea.attributes.get('aria-activedescendant')).toBe('commands-2');
    f.key('Home'); expect(f.textarea.attributes.get('aria-activedescendant')).toBe('commands-0');
    const plan = f.popup.children[1]; f.state.states.agent = { disabled: true }; plan.click(); expect(f.changed).not.toHaveBeenCalled();
    f.state.states.agent = {}; f.composer.update(); f.popup.children[1].click(); expect(f.state.values.agent).toBe('plan');
  });

  it('dismisses Escape until the caret or text changes and never commits an IME Enter', () => {
    const f = fixture(); f.type('/pl'); expect(f.key('Escape').handled).toBe(true); f.composer.update(); expect(f.popup.hidden).toBe(true);
    f.type('/plan'); expect(f.popup.hidden).toBe(false); expect(f.key('Enter', { isComposing: true }).handled).toBe(false);
    expect(f.changed).not.toHaveBeenCalled(); expect(f.key('Enter', { shiftKey: true }).handled).toBe(false);
    f.textarea.dispatchEvent(new Event('compositionstart')); f.composer.update(); expect(f.popup.hidden).toBe(true);
    f.textarea.dispatchEvent(new Event('compositionend')); expect(f.popup.hidden).toBe(false);
  });

  it('hides menus while resolving or running and clears scope-specific footer content on switches', () => {
    const f = fixture(); f.type('/pl'); f.state.loading = true; f.composer.update(); expect(f.popup.hidden).toBe(true);
    f.state.loading = false; f.state.disabled = true; f.composer.update(); expect(f.popup.hidden).toBe(true);
    f.state.disabled = false; f.composer.update(); f.key('Enter'); expect(f.footerRoot.hidden).toBe(false);
    f.state.scope = 'second'; f.state.values = { agent: 'build' }; f.composer.update(); expect(f.footerRoot.hidden).toBe(true);
    f.viewport.innerWidth = 375; f.type('/'); expect(f.popup.style).toMatchObject({ width: '351px', left: '12px' });
    f.state.enabled = false; f.composer.update(); expect(f.popup.hidden).toBe(true); expect(f.footerRoot.hidden).toBe(true);
  });
});
