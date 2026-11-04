import type { AgentSkillGuide } from 'steamharness';
import { t } from '../localization';
import { composerMentionToken, mentionRanges, mentionText, type MentionFiles, type MentionKind, type MentionToken } from '../conversation-mentions';
import type { Project } from '../workflow-types';
import { iconHtml } from './ui';
import { MentionDraft } from './conversation-mention-draft';
import './conversation-mentions.css';

interface MentionState { scope: string; project: Project; enabled: boolean; disabled: boolean }
interface MentionOptions {
  current(): MentionState | undefined;
  load(type: 'project-skills' | 'project-mention-files', requestId: string, query?: string): unknown;
}
interface Choice { id: string; label: string; description?: string; title?: string; kind: MentionKind; value?: string; retry?: boolean }
interface Request { id: string; timer: ReturnType<typeof setTimeout>; query?: string }
const kinds: MentionKind[] = ['skill', 'file', 'entry'];
const label = (kind: MentionKind) => kind === 'skill' ? t('Skills') : kind === 'file' ? t('Files') : t('Project entries');
const glyph = (kind: MentionKind) => kind === 'skill' ? 'book' : kind === 'file' ? 'file' : 'project';

/** Native textarea editing with an inert mirror for colored references. */
export class ConversationMentions {
  private readonly wrapper = document.createElement('div');
  private readonly highlights = document.createElement('div');
  private readonly popup = document.createElement('div');
  private scope?: string;
  private token?: MentionToken;
  private composing = false;
  private dismissed?: string;
  private choices: Choice[] = [];
  private active = 0;
  private skills?: AgentSkillGuide[];
  private files?: MentionFiles;
  private fileQuery?: string;
  private skillsRequest?: Request;
  private filesRequest?: Request;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private skillsError?: string;
  private filesError?: string;
  private renderedText?: string;
  private menuSignature = '';
  private readonly draft = new MentionDraft();

  constructor(private readonly textarea: HTMLTextAreaElement, private readonly options: MentionOptions) {
    this.wrapper.className = 'mention-input';
    this.highlights.className = 'mention-highlights'; this.highlights.setAttribute('aria-hidden', 'true');
    textarea.before(this.wrapper); this.wrapper.append(this.highlights, textarea);
    this.popup.id = 'mention-menu'; this.popup.className = 'mention-menu'; this.popup.hidden = true;
    this.popup.setAttribute('role', 'listbox'); this.popup.ariaLabel = t('References'); document.body.append(this.popup);
    textarea.addEventListener('compositionstart', () => { this.composing = true; this.close(); });
    textarea.addEventListener('compositionend', () => { this.composing = false; this.update(); });
    textarea.addEventListener('beforeinput', event => this.draft.beforeInput(textarea.selectionStart, textarea.selectionEnd, (event as InputEvent).inputType));
    textarea.addEventListener('input', event => { this.draft.sync(textarea.value, (event as InputEvent).inputType); this.update(); });
    for (const event of ['click', 'select', 'keyup', 'focus']) textarea.addEventListener(event, () => this.update());
    textarea.addEventListener('pointermove', event => {
      const mark = Array.from(this.highlights.querySelectorAll<HTMLElement>('mark[data-path]')).find(mark =>
        Array.from(mark.getClientRects()).some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
      if (mark) textarea.title = mark.dataset.path!; else textarea.removeAttribute('title');
    });
    textarea.addEventListener('pointerleave', () => textarea.removeAttribute('title'));
    textarea.addEventListener('copy', event => {
      this.draft.sync(textarea.value);
      const text = this.draft.text(textarea.selectionStart, textarea.selectionEnd);
      if (event.clipboardData && text !== textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)) {
        event.preventDefault(); event.clipboardData.setData('text/plain', text);
      }
    });
    textarea.addEventListener('paste', event => {
      if (!this.options.current()?.enabled || this.options.current()?.disabled || this.composing) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text || !/@file:(?:"?(?:\/|[a-z]:[\\/]|\\\\))/i.test(text)) return;
      event.preventDefault(); this.insert(text, textarea.selectionStart, textarea.selectionEnd);
    });
    textarea.addEventListener('scroll', () => this.syncScroll());
    textarea.addEventListener('blur', () => this.close(true));
    this.popup.addEventListener('pointerdown', event => event.preventDefault());
    document.addEventListener('pointerdown', event => { if (event.target !== textarea && !this.popup.contains(event.target as Node)) this.close(true); });
    window.addEventListener('resize', () => this.layout()); window.addEventListener('scroll', () => this.position(), true);
    new ResizeObserver(() => this.layout()).observe(textarea);
    window.addEventListener('pagehide', () => this.reset());
  }

  private key(): string { return JSON.stringify([this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd]); }

  text(): string { this.draft.sync(this.textarea.value); return this.draft.text(); }
  setText(text: string): void { this.textarea.value = this.draft.setText(text, this.options.current()?.enabled === true); this.renderedText = undefined; }

  update(): void {
    this.draft.sync(this.textarea.value);
    const state = this.options.current();
    if (this.scope !== state?.scope) { this.reset(); this.scope = state?.scope; }
    this.renderHighlights(state?.enabled === true);
    const token = composerMentionToken(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd);
    if (!state?.enabled || state.disabled || this.composing || document.activeElement !== this.textarea || !token || this.dismissed === this.key()) {
      this.close(); return;
    }
    const changed = token.start !== this.token?.start || token.kind !== this.token?.kind || token.query !== this.token?.query;
    if (changed) this.active = 0;
    this.token = token;
    const categories = !token.kind && !token.query;
    const search = token.query.toLocaleLowerCase();
    const choices: Choice[] = [];
    if (categories) choices.push(...kinds.map(kind => ({ id: kind, label: label(kind), kind })));
    else {
      if (!token.kind || token.kind === 'skill') {
        if (!this.skills && !this.skillsRequest && !this.skillsError) this.request('skill');
        choices.push(...(this.skills ?? []).filter(skill => [skill.id, skill.name, skill.description].some(text => text.toLocaleLowerCase().includes(search)))
          .map(skill => ({ id: `skill:${skill.id}`, label: skill.name, description: skill.description, kind: 'skill' as const, value: skill.name })));
      }
      if (!token.kind || token.kind === 'file') {
        if (this.fileQuery !== token.query) {
          clearTimeout(this.searchTimer); clearTimeout(this.filesRequest?.timer); this.filesRequest = undefined;
          this.fileQuery = token.query; this.files = undefined; this.filesError = undefined;
          this.searchTimer = setTimeout(() => { this.searchTimer = undefined; this.request('file', token.query); this.update(); }, 150);
        }
        choices.push(...(this.files?.files ?? []).map(file => ({ id: `file:${file.path}`, label: file.name.split('/').at(-1)!,
          title: file.path, kind: 'file' as const, value: file.path })));
      } else { clearTimeout(this.searchTimer); this.searchTimer = undefined; this.fileQuery = undefined; }
      if (!token.kind || token.kind === 'entry') {
        choices.push(...state.project.entries.filter(entry => [entry.entryId, entry.name, entry.root, entry.entry, entry.type].some(text => text.toLocaleLowerCase().includes(search)))
          .map(entry => ({ id: `entry:${entry.entryId}`, label: entry.name, description: `${entry.entryId} · ${entry.type} · ${entry.root}/${entry.entry}`,
            kind: 'entry' as const, value: entry.entryId })));
      }
      if ((!token.kind || token.kind === 'skill') && this.skillsError) choices.push({ id: 'retry-skill', label: t('Retry loading skills'), description: this.skillsError, kind: 'skill', retry: true });
      if ((!token.kind || token.kind === 'file') && this.filesError) choices.push({ id: 'retry-file', label: t('Retry loading files'), description: this.filesError, kind: 'file', retry: true });
    }
    const loading = !categories && ((!token.kind || token.kind === 'skill') && !!this.skillsRequest || (!token.kind || token.kind === 'file') && (!!this.searchTimer || !!this.filesRequest));
    const status = loading ? t('Loading references...') : !choices.length ? t('No matching references')
      : this.files?.truncated && (!token.kind || token.kind === 'file') ? t('Type more to narrow the file list') : '';
    const signature = JSON.stringify([choices, status]);
    if (signature !== this.menuSignature) {
      const previous = changed ? undefined : this.choices[this.active]?.id;
      this.menuSignature = signature; this.choices = choices;
      this.active = Math.max(0, choices.findIndex(choice => choice.id === previous));
      this.popup.replaceChildren(...choices.map((choice, index) => {
        const row = document.createElement('button'); row.type = 'button'; row.tabIndex = -1; row.className = 'mention-choice';
        row.id = `${this.popup.id}-${index}`; row.setAttribute('role', 'option'); row.dataset.kind = choice.kind;
        row.innerHTML = iconHtml(choice.retry ? 'refresh' : glyph(choice.kind));
        const text = document.createElement('span'); text.className = 'mention-choice-text';
        const title = document.createElement('span'); title.textContent = choice.label; text.append(title);
        if (choice.description) { const detail = document.createElement('small'); detail.textContent = choice.description; text.append(detail); }
        const suffix = document.createElement('small'); suffix.className = 'mention-choice-kind'; suffix.textContent = categories ? '›' : label(choice.kind);
        row.append(text, suffix); row.title = choice.title ?? [choice.label, choice.description].filter(Boolean).join('\n');
        row.addEventListener('pointermove', () => { this.active = index; this.highlight(); });
        row.addEventListener('click', () => this.choose(choice)); return row;
      }));
      if (status) { const message = document.createElement('div'); message.className = 'mention-status'; message.setAttribute('role', 'status'); message.textContent = status; this.popup.append(message); }
    }
    this.popup.hidden = false; this.textarea.setAttribute('aria-controls', this.popup.id); this.textarea.setAttribute('aria-expanded', 'true');
    this.highlight(); this.position();
  }

  private request(kind: 'skill' | 'file', query?: string): void {
    const id = `mention-${crypto.randomUUID()}`;
    const request = { id, query, timer: setTimeout(() => this.receive({ type: 'error', requestId: id, message: t('Reference loading timed out. Retry.') }), 40_000) };
    if (kind === 'skill') this.skillsRequest = request;
    else this.filesRequest = request;
    try {
      void Promise.resolve(this.options.load(kind === 'skill' ? 'project-skills' : 'project-mention-files', id, query)).then(delivered => {
        if (delivered === false) throw new Error(t('Cannot load references. Retry.'));
      }).catch(error => this.receive({ type: 'error', requestId: id, message: String(error?.message ?? error) }));
    } catch (error) { this.receive({ type: 'error', requestId: id, message: String((error as Error).message) }); }
  }

  receive(message: { type?: string; requestId?: string; value?: unknown; message?: string }): boolean {
    const skills = !!this.skillsRequest && message.requestId === this.skillsRequest.id;
    const files = !!this.filesRequest && message.requestId === this.filesRequest.id;
    if (!skills && !files) return false;
    clearTimeout((skills ? this.skillsRequest : this.filesRequest)!.timer);
    if (skills) {
      this.skillsRequest = undefined; this.skillsError = message.type === 'error' ? message.message : undefined;
      if (!this.skillsError) this.skills = message.value as AgentSkillGuide[];
    } else {
      this.filesRequest = undefined; this.filesError = message.type === 'error' ? message.message : undefined;
      if (!this.filesError) this.files = message.value as MentionFiles;
    }
    this.update(); return true;
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229 || this.composing || event.altKey || event.ctrlKey || event.metaKey) return false;
    this.update();
    if (this.popup.hidden) return false;
    if (event.key === 'Escape') this.close(true);
    else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      if (this.choices[this.active]) this.choose(this.choices[this.active]);
      else if (event.key === 'Tab') return false;
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const count = this.choices.length;
      if (count) this.active = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (this.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      this.highlight();
    } else return false;
    event.preventDefault(); event.stopPropagation(); return true;
  }

  private choose(choice: Choice): void {
    const state = this.options.current();
    const token = composerMentionToken(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd);
    if (!state?.enabled || state.disabled || state.scope !== this.scope || this.composing || !token) return;
    if (choice.retry) {
      if (choice.kind === 'skill') this.skillsError = undefined; else this.filesError = undefined;
      this.request(choice.kind as 'skill' | 'file', token.query); this.update(); return;
    }
    const text = choice.value === undefined ? `@${choice.kind}:` : `${mentionText(choice.kind, choice.value)} `;
    this.insert(text, token.start, token.end);
  }

  private insert(source: string, start: number, end: number): void {
    this.draft.sync(this.textarea.value);
    this.textarea.focus(); this.textarea.setSelectionRange(start, end);
    const text = this.draft.replace(start, end, source);
    this.renderedText = undefined;
    // insertText retains browser undo history; setRangeText supports hosts without it.
    if (!document.execCommand?.('insertText', false, text)) this.textarea.setRangeText(text, start, end, 'end');
    this.close(); this.dismissed = undefined;
    this.textarea.dispatchEvent(new Event('input', { bubbles: true })); this.update();
  }

  private highlight(): void {
    for (const [index, row] of Array.from(this.popup.querySelectorAll<HTMLElement>('.mention-choice')).entries()) row.setAttribute('aria-selected', String(index === this.active));
    const row = this.popup.querySelectorAll<HTMLElement>('.mention-choice')[this.active];
    if (!row) { this.textarea.removeAttribute('aria-activedescendant'); return; }
    this.textarea.setAttribute('aria-activedescendant', row.id);
    if (row.offsetTop < this.popup.scrollTop) this.popup.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > this.popup.scrollTop + this.popup.clientHeight) this.popup.scrollTop = row.offsetTop + row.offsetHeight - this.popup.clientHeight;
  }

  private renderHighlights(enabled: boolean): void {
    const value = this.textarea.value;
    const ranges = enabled ? mentionRanges(value).filter(range => range.text.length > 1) : [];
    this.wrapper.classList.toggle('has-mentions', ranges.length > 0);
    const signature = JSON.stringify([value, enabled, this.draft.files]);
    if (signature !== this.renderedText) {
      this.renderedText = signature;
      const parts: Node[] = []; let end = 0;
      for (const range of ranges) {
        parts.push(document.createTextNode(value.slice(end, range.start)));
        const mark = document.createElement('mark'); mark.textContent = range.text;
        const file = this.draft.files.find(file => file.start === range.start && file.end === range.end);
        if (file) { mark.dataset.path = file.path; mark.title = file.path; }
        parts.push(mark); end = range.end;
      }
      parts.push(document.createTextNode(`${value.slice(end)}\n`)); this.highlights.replaceChildren(...parts);
    }
    this.layout();
  }

  private syncScroll(): void { this.highlights.scrollTop = this.textarea.scrollTop; this.highlights.scrollLeft = this.textarea.scrollLeft; }
  private layout(): void { this.highlights.style.width = `${this.textarea.clientWidth}px`; this.highlights.style.height = `${this.textarea.clientHeight}px`; this.syncScroll(); this.position(); }
  private position(): void {
    if (this.popup.hidden) return;
    const rect = (this.textarea.closest('.composer') ?? this.textarea).getBoundingClientRect();
    const width = Math.min(480, rect.width, Math.max(0, window.innerWidth - 24));
    Object.assign(this.popup.style, { width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`, maxHeight: `${Math.min(340, Math.max(0, rect.top - 16))}px` });
  }

  private close(dismiss = false): void {
    if (dismiss) this.dismissed = this.key();
    clearTimeout(this.searchTimer); this.searchTimer = undefined;
    if (!this.files && !this.filesRequest) this.fileQuery = undefined;
    this.popup.hidden = true; this.token = undefined;
    if (this.textarea.getAttribute('aria-controls') === this.popup.id) {
      this.textarea.setAttribute('aria-expanded', 'false'); this.textarea.removeAttribute('aria-activedescendant');
    }
  }
  private reset(): void {
    this.close(); clearTimeout(this.skillsRequest?.timer); clearTimeout(this.filesRequest?.timer);
    this.skillsRequest = this.filesRequest = undefined; this.skills = this.files = undefined;
    this.fileQuery = this.skillsError = this.filesError = this.dismissed = undefined;
  }
}
