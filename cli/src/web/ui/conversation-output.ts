import { t, locale } from '../localization';
import type { ConversationMessage, Attachment, OutputItem, ResolvedInput, TimerRecord } from '../workflow-types';
import { conversationResourceCards, type ResourceCard } from '../resource-cards';
import { escapeHtml, iconHtml, iconButton, markdownHtml, mediaUrl, updateIcon } from './ui';
import { agentActivity, activeAgentActivity, activityGroupSummary, activityValueText, isSilentAgentRetry, type AgentActivity } from './agent-activity';
import { RingOutput, isComposerOutputItem, ringOutputContent } from './output-display';
import { attachmentSignature } from './attachment-state';

interface OutputOptions {
  composer?: boolean;
  copy(text: string, button: HTMLButtonElement): void;
  plan(text: string): void;
  file(id: string): void;
  image(src: string, title: string): void;
  resource(card: ResourceCard, action?: 'open' | 'inline' | 'window' | 'project', requestId?: string): void;
}
interface OutputView { root: HTMLElement; signature: string; filesSignature: string }
interface OutputEntry { key: string; item?: OutputItem; answer?: ResolvedInput; card?: ResourceCard; text?: string; timer?: TimerRecord; activity?: AgentActivity }
interface ActivityGroup { root: HTMLDetailsElement; list: HTMLDivElement }
type OutputBlock = OutputEntry | { key: string; entries: OutputEntry[] };

export class ConversationOutput {
  readonly processToggle: HTMLButtonElement;
  private readonly views = new Map<string, OutputView>();
  private readonly groups = new Map<string, ActivityGroup>();
  private readonly activities = new Map<string, AgentActivity>();
  private readonly displays = new Map<HTMLElement, RingOutput>();
  private pending?: HTMLDivElement;
  private process?: { root: HTMLDetailsElement; list: HTMLDivElement };
  private readonly resourceTheme = new MutationObserver(() => this.syncResourceTheme());
  private syncResourceTheme(): void {
    for (const frame of this.root.querySelectorAll<HTMLIFrameElement>('.resource-inline > iframe')) {
      frame.contentWindow?.postMessage({ type: 'workflow-host', theme: document.documentElement.dataset.theme }, location.origin);
    }
  }
  private readonly resourceReply = (event: MessageEvent) => {
    const reply = event.data;
    if (event.source !== null || !reply?.requestId) { return; }
    const card = Array.from(this.root.querySelectorAll<HTMLElement>('.resource-card')).find(card => card.dataset.requestId === reply.requestId);
    if (!card) { return; }
    const preview = card.querySelector<HTMLElement>('.resource-inline')!;
    if (reply.type === 'error') { preview.textContent = reply.message; preview.setAttribute('role', 'alert'); }
    if (reply.type === 'resource-preview' && reply.action === 'inline') {
      const frame = document.createElement('iframe'); frame.title = card.querySelector('.resource-title')!.textContent ?? '';
      const address = new URL(reply.url, location.href); address.searchParams.set('resourcePresentation', 'card');
      frame.src = address.href; frame.sandbox.add('allow-scripts', 'allow-same-origin');
      frame.addEventListener('load', () => this.syncResourceTheme());
      preview.replaceChildren(frame); preview.removeAttribute('role');
    }
  };
  constructor(private readonly root: HTMLElement, private readonly options: OutputOptions) {
    root.className = 'message-output'; window.addEventListener('message', this.resourceReply);
    this.resourceTheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.processToggle = document.createElement('button'); this.processToggle.type = 'button';
    this.processToggle.className = 'icon-button conversation-process-toggle'; this.processToggle.hidden = true;
    this.processToggle.innerHTML = iconHtml('chevron-right');
    this.processToggle.addEventListener('click', () => {
      if (!this.process || this.processToggle.hidden) return;
      this.process.root.open = !this.process.root.open; this.syncProcessToggle();
    });
    this.syncProcessToggle();
  }
  dispose(): void {
    window.removeEventListener('message', this.resourceReply); this.resourceTheme.disconnect();
    this.processToggle.remove();
    for (const display of this.displays.values()) { display.dispose(); } this.displays.clear();
  }

  private syncProcessToggle(): void {
    const open = this.process?.root.open ?? false;
    this.processToggle.setAttribute('aria-expanded', String(open));
    this.processToggle.title = this.processToggle.ariaLabel = open ? t('Hide intermediate steps') : t('Show intermediate steps');
  }

  private release(root: HTMLElement): void { this.displays.get(root)?.dispose(); this.displays.delete(root); }

  update(message: ConversationMessage, projectId: string, conversationId: string, files: Attachment[], storageSource: 'local' | 'server' = 'local', filesSignature = attachmentSignature(files), collapseIntermediate = false): void {
    const items = (message.items ?? []).filter(item => item.metadata?.kind !== 'agent-session' && !isSilentAgentRetry(item) && (!this.options.composer || !isComposerOutputItem(item)));
    const cards = conversationResourceCards(items, projectId, conversationId, storageSource);
    const cardByItem = new Map(cards.map((card) => [card.itemId, card]));
    const answers = [...new Map([...(message.resolvedInputs ?? []), ...(message.submittingInput ? [message.submittingInput] : [])].map((answer) => [answer.requestId, answer])).values()];
    const ordered: OutputEntry[] =
      (message.timers ?? []).map((timer) => ({ key: `timer:${timer.timerId}`, timer }));
    let remaining = items.map((item, index) => ({ key: item.id ?? String(index), item, card: cardByItem.get(item.id ?? String(index)) }));
    if (!items.length && message.content) { ordered.push({ key: 'fallback', text: message.content }); }
    for (const answer of answers) {
      const preceding = answer.precedingOutputItemIds && new Set(answer.precedingOutputItemIds);
      ordered.push(...remaining.filter((entry) => preceding === undefined || preceding.has(entry.key)));
      remaining = remaining.filter((entry) => preceding !== undefined && !preceding.has(entry.key));
      ordered.push({ key: `answer:${answer.requestId}`, answer });
    }
    ordered.push(...remaining);
    const active = new Set<string>();
    const blocks: OutputBlock[] = [];
    for (const entry of ordered) {
      const content = entry.item?.content as { tool?: string; status?: string } | undefined;
      if (content?.tool === 'workflow-ui_present_card' && content.status === 'success' && !entry.card) { continue; }
      if (entry.item && (content?.tool !== 'workflow-ui_present_card' || content.status !== 'success')) { entry.activity = agentActivity(entry.item, message); }
      if (entry.item && content?.tool !== 'workflow-ui_present_card' && !entry.card) { entry.card = conversationResourceCards([entry.item], projectId, conversationId, storageSource)[0]; }
      if (entry.card && entry.card.kind !== 'file') { blocks.push({ key: `resource:${entry.key}`, card: entry.card, item: entry.item }); continue; }
      if (entry.activity) {
        const last = blocks.at(-1);
        if (last && 'entries' in last) { last.entries.push(entry); }
        else { blocks.push({ key: `activity:${entry.key}`, entries: [entry] }); }
        if (entry.card && !(entry.activity.kind === 'read' && entry.card.kind === 'file')) {
          blocks.push({ key: `resource:${entry.key}`, card: entry.card });
        }
      } else { blocks.push(entry); }
    }
    const renderEntry = (entry: OutputEntry): HTMLElement => {
      active.add(entry.key);
      const { activity, ...content } = entry;
      const signature = JSON.stringify([content, activity?.status, message.submittingInput?.requestId === entry.answer?.requestId]);
      let view = this.views.get(entry.key);
      const changed = !view || view.signature !== signature || view.filesSignature !== filesSignature;
      const display = view && this.displays.get(view.root);
      if (view && display && entry.item && !activity && !entry.card && ringOutputContent(entry.item)) {
        if (changed) { display.update(entry.item); view.signature = signature; }
      } else if (view?.root instanceof HTMLDetailsElement && view.root.classList.contains('agent-activity-item') && activity) {
        if (changed) { this.updateActivity(view.root, activity, entry.card); view.signature = signature; }
      } else if (!view || changed) {
        const root = entry.answer ? this.answer(entry.answer, message.submittingInput?.requestId === entry.answer.requestId)
          : entry.timer ? this.timer(entry.timer) : activity ? this.activity(activity, entry.key, entry.card) : entry.card ? this.card(entry.card, entry.item) : entry.item ? this.item(entry.item, files) : this.markdown(entry.text ?? '', files);
        if (view?.root instanceof HTMLDetailsElement && root instanceof HTMLDetailsElement) { root.open = view.root.open; }
        if (view) { this.release(view.root); view.root.replaceWith(root); }
        view = { root, signature, filesSignature }; this.views.set(entry.key, view);
      }
      view.filesSignature = filesSignature;
      return view.root;
    };
    // Keep final prose/plans and deliverable cards visible. A trailing tool or usage
    // item is not a final answer. Without a result, leave the full output accessible.
    const isFinal = (block: OutputBlock): boolean => !('entries' in block) && !block.card && !block.activity && !!(
      block.text?.trim() || block.item && typeof block.item.content === 'string' && block.item.content.trim()
      && (block.item.metadata?.plan === true || !block.item.collapsed && ['markdown', 'text', undefined].includes(block.item.contentType))
    );
    let finalIndex = -1, lastCardIndex = -1;
    for (const [index, block] of blocks.entries()) {
      if (isFinal(block)) finalIndex = index;
      if (!('entries' in block) && block.card) lastCardIndex = index;
    }
    if (finalIndex < 0) finalIndex = lastCardIndex;
    // A failed turn keeps its separate error message visible; all prior output
    // belongs to its process. Without an error, keep the available diagnostics.
    const failed = (message.status === 'failed' || message.status === 'timed_out') && !!message.error?.trim();
    const intermediate = new Set(blocks.filter((block, index) => {
      if (failed) return true;
      if (!('entries' in block) && (block.card || block.item && ringOutputContent(block.item))) return false;
      return index < finalIndex || 'entries' in block || !!block.answer || !!block.timer;
    }));
    const hasFinal = finalIndex >= 0 && !blocks.slice(finalIndex + 1).some(block => 'entries' in block);
    const fold = collapseIntermediate && !message.pendingInput && !message.submittingInput && !message.cancelRequested
      && (failed || message.status === 'success' && !message.error && hasFinal) && intermediate.size > 0;
    if (fold && !this.process) {
      const root = document.createElement('details'); root.className = 'conversation-process';
      root.id = `conversation-process-${crypto.randomUUID()}`;
      // Keep native details semantics for search, with the visible control in the header.
      const summary = document.createElement('summary'); summary.hidden = true; summary.textContent = t('Intermediate steps');
      const list = document.createElement('div'); list.className = 'conversation-process-content';
      root.append(summary, list); this.process = { root, list };
      root.addEventListener('toggle', () => this.syncProcessToggle());
      this.processToggle.setAttribute('aria-controls', root.id);
    }
    this.processToggle.hidden = !fold;
    const activeGroups = new Set<string>();
    const visibleRoots: HTMLElement[] = [], processRoots: HTMLElement[] = [];
    for (const block of blocks) {
      let root: HTMLElement;
      let followList: HTMLDivElement | undefined;
      if ('entries' in block) {
        activeGroups.add(block.key);
        let group = this.groups.get(block.key);
        if (!group) {
          const root = document.createElement('details'); root.className = 'activity-group'; root.open = true;
          root.innerHTML = `<summary class="activity-group-summary">${iconHtml('search')}<span class="activity-group-title"></span>${iconHtml('chevron-down')}</summary>`;
          const list = document.createElement('div'); list.className = 'activity-list'; root.append(list);
          group = { root, list }; this.groups.set(block.key, group);
        }
        const summary = activityGroupSummary(block.entries.map((entry) => entry.activity!));
        group.root.dataset.state = summary.status;
        group.root.classList.toggle('single-activity', block.entries.length === 1);
        if (block.entries.length === 1) { group.root.open = true; }
        const title = group.root.querySelector<HTMLSpanElement>('.activity-group-title')!;
        title.textContent = title.title = summary.title;
        group.root.querySelector('summary')!.setAttribute('aria-label', summary.title);
        const follow = message.status === 'running' && group.list.scrollHeight - group.list.scrollTop - group.list.clientHeight <= 24;
        const keep = new Set<HTMLElement>();
        for (const [index, entry] of block.entries.entries()) {
          const row = renderEntry(entry); keep.add(row);
          const current = group.list.children[index] ?? null;
          if (current !== row) { group.list.insertBefore(row, current); }
        }
        for (const child of Array.from(group.list.children)) { if (!keep.has(child as HTMLElement)) { child.remove(); } }
        if (follow) { followList = group.list; }
        root = group.root;
      } else { root = renderEntry(block); }
      if (fold && intermediate.has(block)) {
        processRoots.push(root);
        if (!visibleRoots.includes(this.process!.root)) visibleRoots.push(this.process!.root);
      } else { visibleRoots.push(root); }
      if (followList) { followList.scrollTop = followList.scrollHeight; }
    }
    const move = (parent: HTMLElement, root: HTMLElement, before: Element | null): void => {
      // Preserve live previews when a failed turn moves them into/out of its process.
      if (parent.moveBefore && parent.isConnected && root.isConnected) parent.moveBefore(root, before);
      else parent.insertBefore(root, before);
    };
    const place = (parent: HTMLElement, roots: HTMLElement[]): void => {
      let index = 0;
      for (const root of roots) {
        let current = parent.children[index] ?? null;
        if (!fold && current && current === this.process?.root) current = parent.children[++index] ?? null;
        if (current !== root) move(parent, root, current);
        index++;
      }
    };
    for (const [key, view] of this.views) { if (!active.has(key)) { this.release(view.root); view.root.remove(); this.views.delete(key); this.activities.delete(key); } }
    for (const [key, group] of this.groups) { if (!activeGroups.has(key)) { group.root.remove(); this.groups.delete(key); } }
    if (fold) {
      if (this.process!.root.parentElement !== this.root) {
        this.root.insertBefore(this.process!.root, processRoots.find(root => root.parentElement === this.root) ?? null);
      }
      place(this.process!.list, processRoots);
    }
    place(this.root, visibleRoots);
    if (!fold && this.process) { this.process.root.remove(); this.process.root.open = false; }
    this.syncProcessToggle();
    if ((message.status === 'running' || message.status === 'sending') && !message.pendingInput) {
      if (!this.pending) {
        this.pending = document.createElement('div'); this.pending.className = 'pending';
        this.pending.innerHTML = `${iconHtml('loading')}<span></span>`;
      }
      const label = this.pending.lastElementChild!;
      const text = message.status === 'sending' ? t('Sending message...') : activeAgentActivity(message)?.title ?? t("Responding...");
      if (label.textContent !== text) { label.textContent = text; }
      if (this.pending.parentElement !== this.root) { this.root.append(this.pending); }
    } else { this.pending?.remove(); }
    this.tick();
  }

  tick(): void {
    for (const label of Array.from(this.root.querySelectorAll<HTMLElement>('.timer-duration[data-started]'))) {
      const duration = Math.max(0, Date.now() - new Date(label.dataset.started!).getTime());
      label.textContent = `${(duration / 1000).toFixed(1)}s`;
    }
  }

  private activity(activity: AgentActivity, key: string, card?: ResourceCard): HTMLDetailsElement {
    const root = document.createElement('details'); root.className = 'agent-activity-item'; root.dataset.itemId = key;
    root.innerHTML = '<summary><span class="activity-icon" aria-hidden="true"></span><span class="activity-title"></span><span class="activity-chevron" aria-hidden="true"></span><span class="activity-state" aria-hidden="true"></span></summary><div class="activity-body"></div>';
    root.querySelector('.activity-chevron')!.innerHTML = iconHtml('chevron-right');
    root.addEventListener('toggle', () => { if (root.open) { this.activityDetails(root, root.dataset.itemId!); } });
    this.updateActivity(root, activity, card); return root;
  }

  private updateActivity(root: HTMLDetailsElement, activity: AgentActivity, card?: ResourceCard): void {
    this.activities.set(root.dataset.itemId!, activity);
    root.dataset.kind = activity.kind; root.dataset.state = activity.status;
    updateIcon(root.querySelector<HTMLElement>('.activity-icon')!, activity.icon);
    const summary = root.querySelector('summary')!;
    summary.title = activity.title; summary.setAttribute('aria-label', activity.title);
    const title = root.querySelector<HTMLElement>('.activity-title')!;
    if (activity.kind === 'read' && card?.kind === 'file') {
      if (!title.querySelector('button')) {
        title.replaceChildren(document.createElement('span'));
        const file = document.createElement('button'); file.type = 'button'; file.className = 'activity-file';
        title.append(file);
      }
      title.querySelector('span')!.textContent = activity.label;
      const file = title.querySelector('button')!; file.textContent = activity.target ?? card.title; file.title = t("Open {0}", card.title);
      file.onclick = (event) => { event.preventDefault(); event.stopPropagation(); this.options.resource(card); };
    } else { title.textContent = activity.title; }
    updateIcon(root.querySelector<HTMLElement>('.activity-state')!, activity.status === 'running' ? 'loading' : activity.status === 'failed' ? 'error' : activity.status === 'waiting' ? 'question' : activity.status === 'stopped' ? 'circle-slash' : undefined);
    if (root.open) { this.activityDetails(root, root.dataset.itemId!); }
  }

  private activityDetails(root: HTMLDetailsElement, key: string): void {
    const activity = this.activities.get(key);
    if (!activity) { return; }
    const body = root.querySelector<HTMLElement>('.activity-body')!;
    const scroll = body.scrollTop;
    if (activity.sections.length && !body.querySelector('section')) { body.replaceChildren(); }
    for (const [index, section] of activity.sections.entries()) {
      let content = body.children[index] as HTMLElement | undefined;
      if (!content || content.dataset.label !== section.label) {
        const replacement = document.createElement('section'); replacement.dataset.label = section.label;
        const header = document.createElement('header'); const label = document.createElement('span'); label.textContent = section.label;
        const pre = document.createElement('pre');
        const copy = iconButton('copy', t("Copy {0}", section.label), () => this.options.copy(pre.textContent ?? '', copy));
        header.append(label, copy); replacement.append(header, pre);
        if (content) { content.replaceWith(replacement); } else { body.append(replacement); }
        content = replacement;
      }
      content.className = `activity-section${section.error ? ' activity-error' : ''}`;
      const pre = content.querySelector('pre')!; const text = activityValueText(section.value);
      if (pre.textContent !== text) { pre.textContent = text; }
    }
    while (body.children.length > activity.sections.length) { body.lastElementChild!.remove(); }
    if (!activity.sections.length) { body.textContent = activity.status === 'running' ? t("Waiting for tool results...") : t("No additional details"); }
    body.scrollTop = scroll;
  }

  private timer(timer: TimerRecord): HTMLElement {
    const root = document.createElement('details'); root.className = 'output-detail timer-record';
    const summary = document.createElement('summary'); const title = document.createElement('span'); title.textContent = timer.title;
    const duration = document.createElement('span'); duration.className = 'timer-duration'; duration.textContent = `${((timer.durationMs ?? 0) / 1000).toFixed(1)}s`;
    if (timer.status === 'running') { duration.dataset.started = timer.startedAt; }
    summary.innerHTML = iconHtml(timer.status === 'running' ? 'loading' : timer.status === 'failed' ? 'error' : 'watch'); summary.append(title, duration); root.append(summary);
    const details = document.createElement('p'); details.className = 'timer-details';
    details.textContent = [t("Started: {0}", new Date(timer.startedAt).toLocaleString(locale())), timer.endedAt ? t("Ended: {0}", new Date(timer.endedAt).toLocaleString(locale())) : '', timer.message ?? ''].filter(Boolean).join('\n');
    root.append(details); return root;
  }

  private markdown(text: string, files: Attachment[]): HTMLDivElement {
    const root = document.createElement('div'); root.className = 'message-content'; root.innerHTML = markdownHtml(text, files);
    for (const link of Array.from(root.querySelectorAll('a'))) {
      if (link.dataset.projectFile) { link.addEventListener('click', (event) => { event.preventDefault(); this.options.file(link.dataset.projectFile!); }); }
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    }
    for (const image of Array.from(root.querySelectorAll('img'))) {
      image.loading = 'lazy'; image.tabIndex = 0; image.classList.add('preview-image');
      const open = () => this.options.image(image.src, image.alt);
      image.addEventListener('click', open); image.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    }
    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      const block = document.createElement('div'); block.className = 'code-block';
      const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar';
      const language = document.createElement('span'); language.textContent = pre.querySelector('code')?.className.replace('language-', '') || t("Code");
      const button = iconButton('copy', t("Copy code"), () => this.options.copy(pre.textContent || '', button));
      toolbar.append(language, button); pre.replaceWith(block); block.append(toolbar, pre);
    }
    return root;
  }

  private item(item: OutputItem, files: Attachment[]): HTMLElement {
    if (ringOutputContent(item)) {
      const display = new RingOutput(item); this.displays.set(display.root, display); return display.root;
    }
    const text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2) ?? '';
    if (item.metadata?.plan === true) {
      const root = document.createElement('details'); root.className = 'output-detail plan-card';
      const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml('notebook')}<span>${t("Plan")}</span><p class="plan-preview">${escapeHtml(text.slice(0, 180))}</p>`;
      summary.addEventListener('click', (event) => { event.preventDefault(); this.options.plan(text); }); root.append(summary); return root;
    }
    if (!item.collapsed && ['markdown', 'text', undefined].includes(item.contentType)) {
      if (item.contentType === 'text') { const root = document.createElement('div'); root.className = 'message-content plain-output'; root.textContent = text; return root; }
      return this.markdown(text, files);
    }
    const root = document.createElement('details'); root.className = 'output-detail'; root.open = !item.collapsed;
    const content = item.content && typeof item.content === 'object' ? item.content as { tool?: string; status?: string; src?: string; name?: string } : undefined;
    const status = String(content?.status ?? item.metadata?.status ?? '');
    const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml(status === 'running' ? 'loading' : status === 'failed' ? 'error' : status === 'success' ? 'check' : 'chevron-right')}<span>${escapeHtml(content?.tool ?? item.title ?? t("Details"))}</span>`;
    root.append(summary);
    if (['audio', 'video'].includes(item.contentType ?? '') && typeof content?.src === 'string') {
      const src = mediaUrl(content.src, item.contentType === 'audio' ? 'audio' : 'video', files, location.href);
      if (src) {
        const media = document.createElement(item.contentType === 'audio' ? 'audio' : 'video'); media.controls = true; media.preload = 'metadata'; media.src = src;
        const label = document.createElement('p'); label.textContent = content.name ?? item.title ?? ''; root.append(media, label); return root;
      }
    }
    if (item.contentType === 'markdown') { root.append(this.markdown(text, files)); }
    else { const pre = document.createElement('pre'); pre.textContent = text; root.append(pre); }
    return root;
  }

  private answer(answer: ResolvedInput, submitting: boolean): HTMLElement {
    const root = document.createElement('div'); root.className = 'resolved-inputs'; root.dataset.requestId = answer.requestId;
    const entry = document.createElement('div'); entry.className = 'resolved-input';
    for (const field of answer.request?.params ?? []) {
      const value = answer.values[field.name]; if (value === undefined || value === '' || value === null || Array.isArray(value) && !value.length) { continue; }
      const label = document.createElement('strong'); label.textContent = field.label || field.name;
      const text = document.createElement('p');
      text.textContent = (Array.isArray(value) ? value : [value]).map((entry) => {
        if (entry && typeof entry === 'object') { return field.type === 'file' && 'name' in entry ? String(entry.name) : JSON.stringify(entry); }
        return field.options?.find((option) => option.value === String(entry))?.label ?? (typeof entry === 'boolean' ? entry ? t("Yes") : t("No") : String(entry));
      }).join(', ');
      entry.append(label, text);
    }
    if (submitting) { const status = document.createElement('span'); status.className = 'pending'; status.innerHTML = `${iconHtml('loading')}<span>${t("Submitting...")}</span>`; entry.append(status); }
    root.append(entry); return root;
  }

  private card(card: ResourceCard, item?: OutputItem): HTMLElement {
    const root = document.createElement('section'); root.className = 'resource-card'; root.dataset.cardId = card.id;
    const row = document.createElement('div'); row.className = 'resource-card-row';
    const button = document.createElement('button'); button.className = 'resource-target'; button.title = t('Open resource');
    button.innerHTML = `${iconHtml(card.kind === 'browser' ? 'globe' : card.kind === 'file' ? 'file' : card.kind === 'kv' ? 'database' : card.kind === 'knowledge' ? 'book' : card.kind === 'kanban' ? 'layout' : 'folder')}<span class="resource-title">${escapeHtml(card.title)}</span>`;
    button.addEventListener('click', () => this.options.resource(card, 'open'));
    const preview = document.createElement('div'); preview.className = 'resource-inline'; preview.hidden = true;
    const toggle = iconButton('eye', t('Show in conversation'), () => {
      preview.hidden = !preview.hidden; toggle.setAttribute('aria-expanded', String(!preview.hidden)); toggle.title = preview.hidden ? t('Show in conversation') : t('Hide preview');
      if (preview.hidden) { preview.replaceChildren(); delete root.dataset.requestId; return; }
      const requestId = crypto.randomUUID(); root.dataset.requestId = requestId; preview.textContent = t('Loading...'); preview.setAttribute('role', 'status');
      this.options.resource(card, 'inline', requestId);
    });
    toggle.setAttribute('aria-expanded', 'false'); toggle.dataset.action = 'inline';
    const separate = iconButton('open-preview', t('Open in new window'), () => this.options.resource(card, 'window'));
    separate.dataset.action = 'window'; row.append(button, toggle, separate); root.append(row, preview);
    if (card.kind === 'project' || card.kind === 'kanban') { row.append(iconButton('folder-opened', t('Open project'), () => this.options.resource(card, 'project'))); }
    if (item) {
      const details = document.createElement('div'); details.className = 'resource-call-details'; details.hidden = true;
      const data = document.createElement('pre'); data.textContent = JSON.stringify(item.content, null, 2); details.append(data);
      const inspect = iconButton('info', t('Tool call details'), () => { details.hidden = !details.hidden; inspect.setAttribute('aria-expanded', String(!details.hidden)); });
      inspect.setAttribute('aria-expanded', 'false'); row.append(inspect); root.append(details);
    }
    if (card.preview && ['project', 'kanban', 'browser'].includes(card.kind)) { queueMicrotask(() => { if (root.isConnected) { toggle.click(); } }); }
    return root;
  }
}
