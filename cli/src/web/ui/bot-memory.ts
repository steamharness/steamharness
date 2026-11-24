import type { BotMemoryChange, BotMemoryEntry, BotMemoryProperties, BotMemorySummary } from 'steamharness/runtime-storage';
import { locale, t } from '../localization';
import { requestAction } from './action-dialog';
import { requestBotMemory } from './connection';
import { iconButton } from './ui';
import './bot-memory.css';

export type MemoryAvailability = 'ready' | 'upgrade' | 'unsupported';
type Relation = { relation: string; memory: BotMemorySummary & { properties: BotMemoryProperties } };
type Change = BotMemoryChange & { sourceAvailable?: boolean };
const displayName = (memory: BotMemorySummary) => memory.title || memory.key;
const date = (iso: string) => new Date(iso).toLocaleString(locale());
const text = <K extends keyof HTMLElementTagNameMap>(tag: K, content: string, className?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag); element.textContent = content; if (className) element.className = className; return element;
};
const command = (title: string, action: () => void, type: 'button' | 'submit' = 'button') => {
  const button = text('button', title, 'prompt-button'); button.type = type; if (type === 'button') button.onclick = action; return button;
};
const grouped = (title: string, input: HTMLInputElement | HTMLTextAreaElement) => {
  const label = text('label', title); label.append(input); return label;
};
const errorLabels: Record<string, string> = {
  BOT_MEMORY_REVISION_CONFLICT: 'Memory changed in another window or run. Refresh before editing again.',
  BOT_MEMORY_REFERENCED: 'Other memories still reference this entry.',
  BOT_MEMORY_STORAGE_BUSY: 'Another process is reading this memory database. Close it and try forgetting again.',
  BOT_MEMORY_UNDO_UNAVAILABLE: 'This change can no longer be undone.',
  BOT_MEMORY_NOT_FOUND: 'This memory no longer exists.',
  BOT_MEMORY_ALREADY_EXISTS: 'This category and key already exist.',
  BOT_MEMORY_RELATION_ALREADY_EXISTS: 'This link already exists.',
  BOT_MEMORY_RELATION_NOT_FOUND: 'This link no longer exists.',
  BOT_MEMORY_INVALID_INPUT: 'Check the memory fields and filters.',
};

export class BotMemoryPanel {
  private readonly dialog = document.createElement('dialog');
  private readonly identity = text('p', '', 'bot-memory-muted');
  private readonly status = text('p', '', 'bot-memory-status');
  private readonly body = document.createElement('div');
  private readonly list = document.createElement('ul');
  private readonly detail = document.createElement('section');
  private readonly more: HTMLButtonElement;
  private readonly reload: HTMLButtonElement;
  private availability?: MemoryAvailability;
  private lifetime?: AbortController;
  private listing?: AbortController;
  private reading?: AbortController;
  private selected?: string;
  private moreOffset?: number;
  private filters: object = {};
  private writing = false;

  constructor(private readonly options: { navigate(id: string): void }) {
    this.dialog.className = 'conversation-dialog bot-memory-dialog';
    const title = text('h2', t('Memory management')); title.id = 'bot-memory-title'; this.dialog.setAttribute('aria-labelledby', title.id);
    const header = document.createElement('header');
    this.reload = iconButton('refresh', t('Refresh'), () => { void this.page(); if (this.selected) void this.openEntry(this.selected); });
    header.append(title, this.reload, iconButton('close', t('Close'), () => this.dialog.close()));
    this.body.className = 'dialog-body'; this.status.setAttribute('role', 'status');
    this.list.className = 'bot-memory-list'; this.detail.className = 'bot-memory-detail';
    this.more = command(t('Load more'), () => { if (this.moreOffset !== undefined) void this.page(this.moreOffset); }); this.more.hidden = true;
    this.dialog.append(header, this.body);
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.stop(); });
    window.addEventListener('pagehide', () => this.stop());
    document.body.append(this.dialog);
  }

  configure(availability: MemoryAvailability | undefined, identity: string) { this.availability = availability; this.identity.textContent = identity; }

  open() {
    this.stop(); this.lifetime = new AbortController(); this.filters = {}; this.selected = undefined;
    this.body.replaceChildren(this.identity, this.status); this.status.textContent = ''; this.reload.disabled = this.availability !== 'ready';
    if (!this.dialog.open) this.dialog.showModal();
    if (this.availability !== 'ready') {
      this.status.textContent = this.availability === 'unsupported' ? t('Structured memory is available for Agent Bots.') : t('Update the project runtime to manage Bot memory.');
      return;
    }
    const filters = document.createElement('form'); filters.className = 'bot-memory-filters';
    const query = document.createElement('input'); query.type = 'search'; query.maxLength = 500;
    const category = document.createElement('input'); category.maxLength = 100; category.setAttribute('list', 'bot-memory-categories');
    const categories = document.createElement('datalist'); categories.id = 'bot-memory-categories';
    const where = document.createElement('input'); where.placeholder = '{"status":"active"}'; where.maxLength = 4000;
    filters.append(grouped(t('Search memories'), query), grouped(t('Memory category'), category), grouped(t('Exact properties (JSON)'), where), categories,
      command(t('Filter memories'), () => {}, 'submit'), command(t('New memory'), () => this.editor()));
    filters.onsubmit = event => {
      event.preventDefault();
      try { this.filters = { query: query.value.trim() || undefined, category: category.value.trim() || undefined, where: where.value.trim() ? JSON.parse(where.value) : undefined }; }
      catch { this.status.textContent = t('Enter a JSON object for properties.'); return; }
      void this.page();
    };
    const grid = document.createElement('div'); grid.className = 'bot-memory-grid';
    const index = document.createElement('aside'); index.append(this.list, this.more); grid.append(index, this.detail);
    this.moreOffset = undefined; this.more.hidden = true;
    this.list.replaceChildren(); this.detail.replaceChildren(text('p', t('Select a memory.'))); this.body.append(filters, grid);
    void this.api<{ categories: { category: string }[] }>({ action: 'get', limit: 20 }, this.lifetime.signal)
      .then(page => { for (const { category: name } of page.categories) { const option = document.createElement('option'); option.value = name; categories.append(option); } }).catch(() => {});
    void this.page();
  }

  private stop() { this.lifetime?.abort(); this.listing?.abort(); this.reading?.abort(); this.writing = false; }

  private async api<T>(request: object, signal?: AbortSignal): Promise<T> {
    const response = await requestBotMemory(request, signal);
    const result = await response.json();
    if (!response.ok) throw new Error(t(errorLabels[result.code] ?? 'Could not load or change Bot memory.'));
    return result as T;
  }

  private async page(offset?: number) {
    if (!this.dialog.open || this.availability !== 'ready') return;
    this.listing?.abort(); const signal = (this.listing = new AbortController()).signal;
    this.more.disabled = true; this.status.textContent = t('Loading memories…');
    try {
      const result = await this.api<{ memories: BotMemorySummary[]; nextOffset?: number }>({ action: 'list', ...this.filters, offset, limit: 20 }, signal);
      if (signal.aborted) return;
      if (offset === undefined) this.list.replaceChildren();
      for (const memory of result.memories) {
        const row = document.createElement('li');
        const button = text('button', displayName(memory), 'bot-memory-result'); button.type = 'button'; button.dataset.memoryId = memory.id;
        button.append(text('small', `${memory.category} / ${memory.key}`)); button.onclick = () => { void this.openEntry(memory.id); };
        row.append(button); this.list.append(row);
      }
      this.markSelected(); this.moreOffset = result.nextOffset; this.more.hidden = result.nextOffset === undefined;
      this.status.textContent = this.list.children.length ? '' : t('No memories match.');
    } catch (error) { if (!signal.aborted) this.error(error); }
    finally { if (!signal.aborted) this.more.disabled = false; }
  }

  private markSelected() { this.list.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.memoryId === this.selected))); }
  private error(error: unknown) { this.status.textContent = error instanceof Error ? error.message : t('Could not load or change Bot memory.'); }

  private async openEntry(id: string) {
    if (!this.dialog.open) return;
    this.reading?.abort(); const signal = (this.reading = new AbortController()).signal;
    this.selected = id; this.markSelected(); this.detail.replaceChildren(text('p', t('Loading memories…')));
    try {
      const result = await this.api<{ memory: BotMemoryEntry | null }>({ action: 'get', id }, signal);
      if (signal.aborted) return;
      const memory = result.memory;
      if (!memory) { this.detail.replaceChildren(text('p', t('This memory no longer exists.'))); return; }
      const header = document.createElement('header');
      header.append(text('h3', displayName(memory)), iconButton('edit', t('Edit memory'), () => this.editor(memory)),
        iconButton('trash', t('Forget memory'), () => { void this.forget(memory); }));
      this.detail.replaceChildren(header, text('p', `${memory.category} / ${memory.key} · ${t('Revision {0}', memory.revision)}`, 'bot-memory-muted'),
        text('code', memory.id, 'bot-memory-muted'));
      if (memory.summary) this.detail.append(text('p', memory.summary));
      const content = document.createElement('section'); content.append(text('h4', t('Memory body')), text('pre', memory.content || t('No memory body.')));
      this.detail.append(content, this.properties(memory.properties), this.relations(memory, 'outgoing', signal), this.relations(memory, 'incoming', signal), this.history(memory, signal));
    } catch (error) { if (!signal.aborted) { this.detail.replaceChildren(); this.error(error); } }
  }

  private properties(values: BotMemoryProperties): HTMLElement {
    const section = document.createElement('section'); section.append(text('h4', t('Structured properties')));
    const list = document.createElement('dl');
    for (const [name, value] of Object.entries(values)) list.append(text('dt', name), text('dd', JSON.stringify(value)));
    section.append(list.children.length ? list : text('p', t('No properties.'))); return section;
  }

  private relations(memory: BotMemoryEntry, direction: 'incoming' | 'outgoing', signal: AbortSignal) {
    const section = document.createElement('section'); const list = document.createElement('ul');
    section.append(text('h4', t(direction === 'incoming' ? 'Incoming links' : 'Outgoing links')), list);
    let offset: number | undefined;
    const more = command(t('Load more'), () => { void load(offset); }); more.hidden = true;
    if (direction === 'outgoing') {
      const form = document.createElement('form'); form.className = 'bot-memory-link-form';
      const target = document.createElement('input'); target.required = true; target.pattern = '[a-f0-9]{32}'; target.maxLength = 32;
      const label = document.createElement('input'); label.required = true; label.maxLength = 64;
      form.append(grouped(t('Target memory ID'), target), grouped(t('Link type'), label), command(t('Add link'), () => {}, 'submit'));
      form.onsubmit = event => { event.preventDefault(); void this.mutate({ action: 'link', sourceId: memory.id, targetId: target.value.trim(), relation: label.value.trim(), expectedRevision: memory.revision }, memory.id); };
      section.append(form);
    }
    section.append(more);
    const load = async (start?: number) => {
      more.disabled = true;
      try {
        const page = await this.api<{ relations: Relation[]; nextOffset?: number }>({ action: 'get', id: memory.id, relations: direction, limit: 5, offset: start }, signal);
        if (signal.aborted) return;
        for (const item of page.relations ?? []) {
          const row = document.createElement('li'); const linked = item.memory;
          const actions = document.createElement('div'); actions.className = 'bot-memory-inline';
          actions.append(command(displayName(linked), () => { void this.openEntry(linked.id); }), text('span', `${item.relation} · ${linked.category} / ${linked.key}`, 'bot-memory-muted'),
            iconButton('close', t('Remove memory link'), () => {
              const [from, to] = direction === 'outgoing' ? [memory, linked] : [linked, memory];
              void this.mutate({ action: 'unlink', sourceId: from.id, targetId: to.id, relation: item.relation, expectedRevision: from.revision }, memory.id);
            }));
          row.append(actions);
          for (const [name, value] of Object.entries(linked.properties)) row.append(text('small', `${name}: ${JSON.stringify(value)}`, 'bot-memory-property'));
          list.append(row);
        }
        if (!list.children.length) list.append(text('li', t('No links.'), 'bot-memory-muted'));
        offset = page.nextOffset; more.hidden = offset === undefined;
      } catch (error) { if (!signal.aborted) this.error(error); }
      finally { more.disabled = false; }
    };
    void load(); return section;
  }

  private history(memory: BotMemoryEntry, signal: AbortSignal) {
    const section = document.createElement('section'), list = document.createElement('ul'); list.className = 'bot-memory-history';
    section.append(text('h4', t('Memory changes')), list);
    let cursor: number | undefined;
    const more = command(t('Load more'), () => { void load(cursor); }); more.hidden = true; section.append(more);
    const load = async (before?: number) => {
      more.disabled = true;
      try {
        const page = await this.api<{ changes: Change[]; nextBefore?: number }>({ action: 'history', id: memory.id, before }, signal);
        if (signal.aborted) return;
        for (const change of page.changes) list.append(this.change(memory, change));
        if (!list.children.length) list.append(text('li', t('No recorded changes.'), 'bot-memory-muted'));
        cursor = page.nextBefore; more.hidden = cursor === undefined;
      } catch (error) { if (!signal.aborted) this.error(error); }
      finally { more.disabled = false; }
    };
    void load(); return section;
  }

  private change(memory: BotMemoryEntry, change: Change) {
    const row = document.createElement('li'), header = document.createElement('div'); header.className = 'bot-memory-inline';
    const names = { save: 'Created', update: 'Edited', link: 'Linked', unlink: 'Unlinked', undo: 'Restored', forget: 'Forgotten' };
    const actors = { user: 'Local user', bot: 'Bot', runtime: 'Runtime' };
    header.append(text('strong', `${t(names[change.action])} · ${t('Revision {0}', change.revision)}`));
    if (change.canUndo && change.revision === memory.revision) header.append(iconButton('discard', t('Undo memory change'), () => { void this.mutate({ action: 'undo', id: memory.id, revision: change.revision, expectedRevision: memory.revision }, memory.id); }));
    const source = change.source;
    row.append(header, text('p', `${t(actors[source.actor])} · ${date(change.changedAt)}`, 'bot-memory-muted'));
    if (source.runId) row.append(text('p', t('Source run: {0}', source.runId), 'bot-memory-muted'));
    if (source.requestId) row.append(text('p', t('Source request: {0}', source.requestId), 'bot-memory-muted'));
    if (source.conversationId && change.sourceAvailable) row.append(command(t('Open source conversation'), () => { this.dialog.close(); this.options.navigate(source.conversationId!); }));
    if (change.delta) {
      const details = document.createElement('details'); details.append(text('summary', t('View changes')));
      if ('fields' in change.delta) {
        const labels = { content: 'Memory body', title: 'Title', summary: 'Memory summary', properties: 'Structured properties' };
        for (const field of change.delta.fields) {
          const show = (value: unknown) => value === null ? t('Not set') : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          details.append(text('strong', t(labels[field.field])), text('pre', `${t('Before')}: ${show(field.before)}\n${t('After')}: ${show(field.after)}`));
        }
      } else {
        const { link } = change.delta;
        details.append(text('p', `${link.relation} · ${link.targetId}`), text('p', `${t(link.before ? 'Linked' : 'Unlinked')} → ${t(link.after ? 'Linked' : 'Unlinked')}`));
      }
      if (change.expiresAt) details.append(text('p', t('Saved until {0}', date(change.expiresAt)), 'bot-memory-muted'));
      row.append(details);
    }
    return row;
  }

  private editor(memory?: BotMemoryEntry) {
    this.reading?.abort(); this.selected = memory?.id; this.markSelected(); this.status.textContent = '';
    const form = document.createElement('form'); form.className = 'bot-memory-editor';
    const field = (value: string, length: number, area = false) => { const input = document.createElement(area ? 'textarea' : 'input'); input.value = value; input.maxLength = length; return input; };
    const category = field('', 100), key = field('', 200); category.required = key.required = true;
    const title = field(memory?.title ?? '', 160), summary = field(memory?.summary ?? '', 320), body = field(memory?.content ?? '', 8000, true);
    const properties = field(JSON.stringify(memory?.properties ?? {}, null, 2), 32_000, true);
    if (!memory) form.append(grouped(t('Memory category'), category), grouped(t('Key'), key));
    form.append(grouped(t('Title'), title), grouped(t('Memory summary'), summary), grouped(t('Memory body'), body), grouped(t('Structured properties (JSON)'), properties));
    const buttons = document.createElement('div'); buttons.className = 'bot-memory-inline';
    buttons.append(command(t('Save'), () => {}, 'submit'), command(t('Cancel'), () => memory ? void this.openEntry(memory.id) : this.detail.replaceChildren(text('p', t('Select a memory.')))));
    form.append(buttons);
    form.onsubmit = event => {
      event.preventDefault(); let parsed: BotMemoryProperties;
      try {
        parsed = JSON.parse(properties.value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      } catch { this.status.textContent = t('Enter a JSON object for properties.'); return; }
      if (!memory) { void this.mutate({ action: 'save', category: category.value.trim(), key: key.value.trim(), title: title.value.trim() || undefined,
        summary: summary.value.trim() || undefined, content: body.value.trim() || undefined, properties: parsed }); return; }
      const patch = Object.fromEntries(Object.entries(parsed).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(memory.properties[name])));
      const removed = Object.keys(memory.properties).filter(name => !Object.hasOwn(parsed, name));
      const fields = { ...(title.value.trim() !== (memory.title ?? '') && { title: title.value.trim() || null }),
        ...(summary.value.trim() !== (memory.summary ?? '') && { summary: summary.value.trim() || null }),
        ...(body.value.trim() !== memory.content && { content: body.value.trim() || null }),
        ...(Object.keys(patch).length && { properties: patch }), ...(removed.length && { removeProperties: removed }) };
      if (!Object.keys(fields).length) { void this.openEntry(memory.id); return; }
      void this.mutate({ action: 'update', id: memory.id, expectedRevision: memory.revision, ...fields }, memory.id);
    };
    this.detail.replaceChildren(text('h3', t(memory ? 'Edit memory' : 'New memory')), form);
  }

  private async forget(memory: BotMemoryEntry) {
    const signal = this.reading?.signal;
    try {
      const { relations } = await this.api<{ relations?: Relation[] }>({ action: 'get', id: memory.id, relations: 'incoming', limit: 1 }, signal);
      if (signal?.aborted || !this.dialog.open) return;
      if (relations?.length) { this.status.textContent = t('Other memories still reference this entry.'); return; }
      const confirmed = await requestAction({ title: t('Forget memory'), confirm: t('Forget memory'), danger: true, signal,
        description: t('Forget {0} and its saved versions? This does not change conversations or external backups.', displayName(memory)) });
      if (confirmed !== undefined && this.dialog.open) await this.mutate({ action: 'forget', id: memory.id, expectedRevision: memory.revision });
    } catch (error) { if (!signal?.aborted) this.error(error); }
  }

  private async mutate(request: object, selected?: string) {
    if (this.writing || !this.lifetime || this.lifetime.signal.aborted) return;
    const { signal } = this.lifetime; const editing = this.selected; this.writing = true;
    try {
      const result = await this.api<{ memory?: BotMemorySummary; deleted?: boolean }>(request, signal);
      if (signal.aborted) return;
      this.status.textContent = '';
      void this.page();
      if (this.selected !== editing) return;
      if (result.deleted) { this.reading?.abort(); this.selected = undefined; this.detail.replaceChildren(text('p', t('Memory forgotten.'))); }
      else if (selected || result.memory?.id) void this.openEntry(selected ?? result.memory!.id);
    } catch (error) { if (!signal.aborted) this.error(error); }
    finally { if (!signal.aborted) this.writing = false; }
  }
}
