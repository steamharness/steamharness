import { locale, t } from '../localization';
import type { ConversationCommandDefinition, ConversationFooterItem, WorkflowParameters, WorkflowParamState, WorkflowParamValues } from '../workflow-types';

export interface SlashToken { start: number; end: number; query: string }
export type SlashCommand = { command: string; label: string; description?: string; disabled: boolean } & (
  | { kind: 'param'; name: string; value: string; selected: boolean }
  | { kind: 'action' }
);
interface ComposerState {
  scope: string;
  enabled: boolean;
  parameters: WorkflowParameters;
  values: WorkflowParamValues;
  states: Record<string, WorkflowParamState>;
  footer?: ConversationFooterItem[];
  commands?: ConversationCommandDefinition[];
  commandDisabled?: boolean;
  disabled: boolean;
  loading: boolean;
}
interface ComposerOptions { current(): ComposerState | undefined; onChange(name: string, value: string): void; onCommand(command: string): boolean }

function localizedText(fallback: string, translations?: Record<string, string>, language: string = locale()): string {
  const normalized = language.toLowerCase().replaceAll('_', '-');
  return Object.entries(translations ?? {}).find(([key]) => key.toLowerCase().replaceAll('_', '-') === normalized)?.[1]
    ?? Object.entries(translations ?? {}).find(([key]) => key.toLowerCase() === normalized.split('-')[0])?.[1] ?? fallback;
}

export function composerSlashToken(text: string, start: number, end = start): SlashToken | undefined {
  if (start !== end) { return; }
  const match = /(?:^|\s)\/([a-z0-9_-]*)$/i.exec(text.slice(0, start));
  if (!match) { return; }
  return { start: start - match[1].length - 1, end: start + (/^[a-z0-9_-]*/i.exec(text.slice(start))?.[0].length ?? 0), query: match[1].toLowerCase() };
}

export function conversationSlashCommands(parameters: WorkflowParameters, values: WorkflowParamValues, states: Record<string, WorkflowParamState>,
  definitions: ConversationCommandDefinition[] = [], commandDisabled = false): SlashCommand[] {
  const commands: SlashCommand[] = [];
  for (const action of parameters.paramLayout?.actions ?? []) {
    if (action.kind !== 'slash') { continue; }
    const field = parameters.fields.find(field => field.name === action.name);
    const state = states[action.name];
    if (!field || state?.visible === false) { continue; }
    const value = values[field.name] ?? field.defaultValue ?? (field.type === 'boolean' ? 'false' : '');
    if (field.type === 'boolean') {
      commands.push({ kind: 'param', command: field.command ?? field.name, name: field.name, value: value === 'true' ? 'false' : 'true',
        label: field.label || field.name, description: field.description, selected: value === 'true', disabled: state?.disabled === true });
    } else {
      for (const option of state?.resolvedOptions ?? field.options ?? []) {
        if (state?.options?.[option.value]?.visible === false) { continue; }
        const command = option.command ?? field.options?.find(original => original.value === option.value)?.command ?? option.value;
        commands.push({ kind: 'param', command, name: field.name, value: option.value, label: option.label || option.value, description: option.description,
          selected: value === option.value, disabled: state?.disabled === true || state?.options?.[option.value]?.disabled === true });
      }
    }
  }
  for (const definition of definitions) {
    commands.push({ kind: 'action', command: definition.command, label: localizedText(definition.label, definition.localizedLabel),
      description: localizedText(definition.description ?? '', definition.localizedDescription), disabled: commandDisabled });
  }
  return commands.filter(entry => /^[a-z][a-z0-9_-]*$/.test(entry.command) && commands.filter(other => other.command === entry.command).length === 1);
}

export function conversationFooterTexts(items: ConversationFooterItem[] | undefined, parameters: WorkflowParameters,
  values: WorkflowParamValues, states: Record<string, WorkflowParamState>, language: string = locale()): string[] {
  const fieldValue = (name: string) => values[name] ?? parameters.fields.find(field => field.name === name)?.defaultValue ?? '';
  const texts: string[] = [];
  for (const item of items ?? []) {
    if (item.when && (states[item.when.param]?.visible === false || fieldValue(item.when.param) !== item.when.value)) { continue; }
    let text = item.text;
    if (text !== undefined && item.localizedText) {
      text = localizedText(text, item.localizedText, language);
    }
    if (item.param !== undefined && states[item.param]?.visible !== false) {
      const field = parameters.fields.find(field => field.name === item.param);
      if (!field) { continue; }
      const value = fieldValue(item.param);
      const options = states[item.param]?.resolvedOptions ?? field.options ?? [];
      text = (Array.isArray(value) ? value : [value]).map(value => options.find(option => option.value === value)?.label || value).join(', ');
    }
    if (text) { texts.push(text); }
  }
  return texts;
}

export class ConversationComposer {
  private entries: SlashCommand[] = [];
  private active = -1;
  private token?: SlashToken;
  private dismissed?: string;
  private scope?: string;
  private menuSignature = '';
  private footerSignature = '';
  private composing = false;

  constructor(private readonly textarea: HTMLTextAreaElement, private readonly popup: HTMLElement,
    private readonly footer: HTMLElement, private readonly options: ComposerOptions) {
    popup.setAttribute('role', 'listbox'); popup.ariaLabel = t("Commands"); popup.hidden = true;
    textarea.setAttribute('aria-controls', popup.id); textarea.setAttribute('aria-autocomplete', 'list'); textarea.setAttribute('aria-haspopup', 'listbox');
    textarea.setAttribute('aria-expanded', 'false');
    textarea.addEventListener('compositionstart', () => { this.composing = true; this.close(); });
    textarea.addEventListener('compositionend', () => { this.composing = false; this.update(); });
    for (const event of ['click', 'select', 'keyup', 'focus']) { textarea.addEventListener(event, () => this.update()); }
    popup.addEventListener('pointerdown', event => event.preventDefault());
    document.addEventListener('pointerdown', event => { if (event.target !== textarea && !popup.contains(event.target as Node)) { this.close(true); } });
    textarea.addEventListener('blur', () => this.close(true));
    window.addEventListener('resize', () => this.position());
    window.addEventListener('scroll', () => this.position(), true);
    new ResizeObserver(() => this.position()).observe(textarea.closest('.composer') ?? textarea);
  }

  private tokenKey(): string { return JSON.stringify([this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd]); }

  update(): void {
    const state = this.options.current();
    if (this.scope !== state?.scope) { this.close(); this.dismissed = undefined; this.scope = state?.scope; }
    const texts = state?.enabled ? conversationFooterTexts(state.footer, state.parameters, state.values, state.states) : [];
    const footerSignature = JSON.stringify(texts);
    if (footerSignature !== this.footerSignature) {
      this.footerSignature = footerSignature;
      this.footer.replaceChildren(...texts.map(text => { const span = document.createElement('span'); span.textContent = text; return span; }));
    }
    this.footer.hidden = texts.length === 0;
    const token = composerSlashToken(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd);
    if (!state?.enabled || state.disabled || state.loading || this.composing || document.activeElement !== this.textarea || !token || this.dismissed === this.tokenKey()) { this.close(); return; }
    const entries = conversationSlashCommands(state.parameters, state.values, state.states, state.commands, state.commandDisabled).filter(entry =>
      entry.command.includes(token.query) || entry.label.toLowerCase().includes(token.query));
    if (!entries.length) { this.close(); return; }
    const signature = JSON.stringify(entries);
    const previous = this.entries[this.active]?.command;
    if (!this.token || token.start !== this.token.start || token.query !== this.token.query) { this.active = -1; }
    this.token = token;
    this.entries = entries;
    if (signature !== this.menuSignature || this.popup.hidden) {
      this.menuSignature = signature;
      this.active = this.active >= 0 ? entries.findIndex(entry => entry.command === previous && !entry.disabled) : -1;
      this.popup.replaceChildren(...entries.map((entry, index) => {
        const row = document.createElement('button'); row.type = 'button'; row.tabIndex = -1; row.className = 'slash-command'; row.id = `${this.popup.id}-${index}`;
        row.setAttribute('role', 'option'); row.disabled = entry.disabled;
        row.dataset.command = entry.command;
        const label = document.createElement('span'); label.className = 'slash-command-label'; label.textContent = entry.label;
        const description = document.createElement('span'); description.className = 'slash-command-description'; description.textContent = entry.description ?? '';
        const command = document.createElement('small'); command.className = 'slash-command-name'; command.textContent = `/${entry.command}`;
        row.append(label, description, command);
        row.title = [entry.label, entry.description, `/${entry.command}`].filter(Boolean).join(' - ');
        row.addEventListener('pointermove', () => { if (!entry.disabled) { this.active = index; this.highlight(); } });
        row.addEventListener('click', () => this.choose(entry.command));
        return row;
      }));
    }
    if (this.active < 0 || entries[this.active]?.disabled) { this.active = entries.findIndex(entry => !entry.disabled); }
    this.popup.hidden = false;
    this.textarea.setAttribute('aria-expanded', 'true');
    this.highlight(); this.position();
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) { return false; }
    this.update();
    if (this.popup.hidden) { return false; }
    if (event.key === 'Escape') { this.close(true); }
    else if (event.key === 'Enter' && !event.shiftKey || event.key === 'Tab' && !event.shiftKey) {
      const entry = this.entries[this.active];
      if (entry) { this.choose(entry.command); }
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const choices = this.entries.map((entry, index) => entry.disabled ? -1 : index).filter(index => index >= 0);
      if (choices.length) {
        const index = choices.indexOf(this.active);
        this.active = event.key === 'Home' ? choices[0] : event.key === 'End' ? choices[choices.length - 1]
          : choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length];
        this.highlight();
      }
    } else { return false; }
    event.preventDefault(); event.stopPropagation(); return true;
  }

  submitCommand(): boolean {
    const match = /^\/([a-z][a-z0-9_-]*)$/i.exec(this.textarea.value.trim());
    const state = this.options.current();
    if (!match || !state?.enabled) { return false; }
    const entry = conversationSlashCommands(state.parameters, state.values, state.states, state.commands, state.commandDisabled)
      .find(entry => entry.command === match[1].toLowerCase());
    if (!entry) { return false; }
    if (!entry.disabled && !state.disabled && !state.loading) {
      this.textarea.focus();
      const end = this.textarea.value.trimEnd().length;
      this.textarea.setSelectionRange(end, end);
      this.choose(entry.command);
    }
    return true;
  }

  private choose(command: string): void {
    const state = this.options.current();
    const token = composerSlashToken(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd);
    const entry = state && conversationSlashCommands(state.parameters, state.values, state.states, state.commands, state.commandDisabled).find(entry => entry.command === command);
    if (!state?.enabled || state.scope !== this.scope || state.disabled || state.loading || this.composing || !token || !entry || entry.disabled) { return; }
    const end = token.end + (this.textarea.value[token.end] === ' ' ? 1 : 0);
    const original = this.textarea.value;
    this.textarea.setRangeText('', token.start, end, 'start');
    if (entry.kind === 'action' && !this.options.onCommand(entry.command)) {
      this.textarea.value = original; this.textarea.setSelectionRange(token.end, token.end); return;
    }
    this.close();
    if (entry.kind === 'param') { this.options.onChange(entry.name, entry.value); }
    this.textarea.focus();
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    this.update();
  }

  openForField(name: string): boolean {
    const state = this.options.current();
    const entry = state && conversationSlashCommands(state.parameters, state.values, state.states).find(entry => entry.kind === 'param' && entry.name === name && !entry.disabled);
    if (!entry) { return false; }
    this.textarea.focus();
    const caret = this.textarea.selectionStart;
    const prefix = caret > 0 && !/\s/.test(this.textarea.value[caret - 1]) ? ' ' : '';
    this.textarea.setRangeText(`${prefix}/${entry.command}`, caret, this.textarea.selectionEnd, 'end');
    this.dismissed = undefined;
    this.textarea.dispatchEvent(new Event('input', { bubbles: true })); this.update(); return true;
  }

  private highlight(): void {
    Array.from(this.popup.children).forEach((row, index) => { row.setAttribute('aria-selected', String(index === this.active)); });
    const row = this.popup.children[this.active] as HTMLElement | undefined;
    if (row) {
      this.textarea.setAttribute('aria-activedescendant', row.id);
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < this.popup.scrollTop) { this.popup.scrollTop = top; }
      else if (bottom > this.popup.scrollTop + this.popup.clientHeight) { this.popup.scrollTop = bottom - this.popup.clientHeight; }
    } else { this.textarea.removeAttribute('aria-activedescendant'); }
  }

  close(dismiss = false): void {
    if (dismiss) { this.dismissed = this.tokenKey(); }
    this.popup.hidden = true; this.token = undefined; this.active = -1;
    this.textarea.setAttribute('aria-expanded', 'false'); this.textarea.removeAttribute('aria-activedescendant');
  }

  private position(): void {
    if (this.popup.hidden) { return; }
    const rect = (this.textarea.closest('.composer') ?? this.textarea).getBoundingClientRect();
    const width = Math.min(rect.width, Math.max(0, window.innerWidth - 24));
    Object.assign(this.popup.style, { width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`, maxHeight: `${Math.min(320, Math.max(0, rect.top - 16))}px` });
  }
}
