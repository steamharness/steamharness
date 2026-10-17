import type { ConversationMessage, WorkflowAttachment, WorkflowOutputItem, WorkflowResolvedInput, WorkflowTimerRecord } from '../src/workflow-types';
import { conversationResourceCards, type ResourceCard } from '../src/resource-cards';
import { escapeHtml, iconHtml, iconButton, managedFileForUrl, markdownHtml } from './ui';
import { agentActivity, activeAgentActivity, activityGroupSummary, activityValueText, type AgentActivity } from './agent-activity';

interface OutputOptions {
  copy(text: string, button: HTMLButtonElement): void;
  plan(text: string): void;
  file(id: string): void;
  image(src: string, title: string): void;
  resource(card: ResourceCard): void;
}
interface OutputView { root: HTMLElement; signature: string }
interface OutputEntry { key: string; item?: WorkflowOutputItem; answer?: WorkflowResolvedInput; card?: ResourceCard; text?: string; timer?: WorkflowTimerRecord; activity?: AgentActivity }
interface ActivityGroup { root: HTMLDetailsElement; list: HTMLDivElement }

export class ConversationOutput {
  private readonly views = new Map<string, OutputView>();
  private readonly groups = new Map<string, ActivityGroup>();
  private readonly activities = new Map<string, AgentActivity>();
  constructor(private readonly root: HTMLElement, private readonly options: OutputOptions) { root.className = 'message-output'; }

  update(message: ConversationMessage, projectId: string, conversationId: string, files: WorkflowAttachment[]): void {
    const items = message.items ?? [];
    const cards = conversationResourceCards(items, projectId, conversationId);
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
    this.root.querySelector(':scope > .pending')?.remove();
    const active = new Set<string>();
    const blocks: (OutputEntry | { key: string; entries: OutputEntry[] })[] = [];
    for (const entry of ordered) {
      const content = entry.item?.content as { tool?: string } | undefined;
      if (content?.tool === 'workflow-ui_present_card' && !entry.card) { continue; }
      if (entry.item && content?.tool !== 'workflow-ui_present_card') { entry.activity = agentActivity(entry.item, message); }
      if (entry.activity?.kind === 'read' && !entry.card) { entry.card = conversationResourceCards([entry.item!], projectId, conversationId)[0]; }
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
      const signature = JSON.stringify([content, activity?.status, files.map((file) => [file.id, file.previewUrl]), message.submittingInput?.requestId === entry.answer?.requestId]);
      let view = this.views.get(entry.key);
      if (view?.root instanceof HTMLDetailsElement && view.root.classList.contains('agent-activity-item') && activity) {
        if (view.signature !== signature) { this.updateActivity(view.root, activity, entry.card); view.signature = signature; }
      } else if (!view || view.signature !== signature) {
        const root = entry.answer ? this.answer(entry.answer, message.submittingInput?.requestId === entry.answer.requestId)
          : entry.timer ? this.timer(entry.timer) : activity ? this.activity(activity, entry.key, entry.card) : entry.card ? this.card(entry.card) : entry.item ? this.item(entry.item, files) : this.markdown(entry.text ?? '', files);
        if (view?.root instanceof HTMLDetailsElement && root instanceof HTMLDetailsElement) { root.open = view.root.open; }
        view?.root.replaceWith(root);
        view = { root, signature }; this.views.set(entry.key, view);
      }
      return view.root;
    };
    const activeGroups = new Set<string>();
    for (const [position, block] of blocks.entries()) {
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
      const current = this.root.children[position] ?? null;
      if (current !== root) { this.root.insertBefore(root, current); }
      if (followList) { followList.scrollTop = followList.scrollHeight; }
    }
    for (const [key, view] of this.views) { if (!active.has(key)) { view.root.remove(); this.views.delete(key); this.activities.delete(key); } }
    for (const [key, group] of this.groups) { if (!activeGroups.has(key)) { group.root.remove(); this.groups.delete(key); } }
    if (message.status === 'running' && !message.pendingInput) {
      const pending = document.createElement('div'); pending.className = 'pending'; pending.innerHTML = `${iconHtml('loading')}<span></span>`;
      pending.querySelector('span:last-child')!.textContent = activeAgentActivity(message)?.title ?? '\u6b63\u5728\u56de\u590d...'; this.root.append(pending);
    }
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
    root.querySelector('.activity-icon')!.innerHTML = iconHtml(activity.icon);
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
      const file = title.querySelector('button')!; file.textContent = activity.target ?? card.title; file.title = `\u6253\u5f00 ${card.title}`;
      file.onclick = (event) => { event.preventDefault(); event.stopPropagation(); this.options.resource(card); };
    } else { title.textContent = activity.title; }
    root.querySelector('.activity-state')!.innerHTML = activity.status === 'running' ? iconHtml('loading') : activity.status === 'failed' ? iconHtml('error') : activity.status === 'waiting' ? iconHtml('question') : activity.status === 'stopped' ? iconHtml('circle-slash') : '';
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
        const copy = iconButton('copy', `\u590d\u5236${section.label}`, () => this.options.copy(pre.textContent ?? '', copy));
        header.append(label, copy); replacement.append(header, pre);
        if (content) { content.replaceWith(replacement); } else { body.append(replacement); }
        content = replacement;
      }
      content.className = `activity-section${section.error ? ' activity-error' : ''}`;
      const pre = content.querySelector('pre')!; const text = activityValueText(section.value);
      if (pre.textContent !== text) { pre.textContent = text; }
    }
    while (body.children.length > activity.sections.length) { body.lastElementChild!.remove(); }
    if (!activity.sections.length) { body.textContent = activity.status === 'running' ? '\u7b49\u5f85\u5de5\u5177\u7ed3\u679c...' : '\u6682\u65e0\u989d\u5916\u8be6\u60c5'; }
    body.scrollTop = scroll;
  }

  private timer(timer: WorkflowTimerRecord): HTMLElement {
    const root = document.createElement('details'); root.className = 'output-detail timer-record';
    const summary = document.createElement('summary'); const title = document.createElement('span'); title.textContent = timer.title;
    const duration = document.createElement('span'); duration.className = 'timer-duration'; duration.textContent = `${((timer.durationMs ?? 0) / 1000).toFixed(1)}s`;
    if (timer.status === 'running') { duration.dataset.started = timer.startedAt; }
    summary.innerHTML = iconHtml(timer.status === 'running' ? 'loading' : timer.status === 'failed' ? 'error' : 'watch'); summary.append(title, duration); root.append(summary);
    const details = document.createElement('p'); details.className = 'timer-details';
    details.textContent = [`\u5f00\u59cb\uff1a${new Date(timer.startedAt).toLocaleString('zh-CN')}`, timer.endedAt ? `\u7ed3\u675f\uff1a${new Date(timer.endedAt).toLocaleString('zh-CN')}` : '', timer.message ?? ''].filter(Boolean).join('\n');
    root.append(details); return root;
  }

  private markdown(text: string, files: WorkflowAttachment[]): HTMLDivElement {
    const root = document.createElement('div'); root.className = 'message-content'; root.innerHTML = markdownHtml(text, files);
    for (const link of Array.from(root.querySelectorAll('a'))) {
      if (link.dataset.workflowFile) { link.addEventListener('click', (event) => { event.preventDefault(); this.options.file(link.dataset.workflowFile!); }); }
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
      const language = document.createElement('span'); language.textContent = pre.querySelector('code')?.className.replace('language-', '') || '\u4ee3\u7801';
      const button = iconButton('copy', '\u590d\u5236\u4ee3\u7801', () => this.options.copy(pre.textContent || '', button));
      toolbar.append(language, button); pre.replaceWith(block); block.append(toolbar, pre);
    }
    return root;
  }

  private item(item: WorkflowOutputItem, files: WorkflowAttachment[]): HTMLElement {
    const text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2) ?? '';
    if (item.metadata?.plan === true) {
      const root = document.createElement('details'); root.className = 'output-detail plan-card';
      const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml('notebook')}<span>\u8ba1\u5212</span><p class="plan-preview">${escapeHtml(text.slice(0, 180))}</p>`;
      summary.addEventListener('click', (event) => { event.preventDefault(); this.options.plan(text); }); root.append(summary); return root;
    }
    if (!item.collapsed && ['markdown', 'text', undefined].includes(item.contentType)) {
      if (item.contentType === 'text') { const root = document.createElement('div'); root.className = 'message-content plain-output'; root.textContent = text; return root; }
      return this.markdown(text, files);
    }
    const root = document.createElement('details'); root.className = 'output-detail'; root.open = !item.collapsed;
    const content = item.content && typeof item.content === 'object' ? item.content as { tool?: string; status?: string; src?: string; name?: string } : undefined;
    const status = String(content?.status ?? item.metadata?.status ?? '');
    const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml(status === 'running' ? 'loading' : status === 'failed' ? 'error' : status === 'success' ? 'check' : 'chevron-right')}<span>${escapeHtml(content?.tool ?? item.title ?? '\u8be6\u60c5')}</span>`;
    root.append(summary);
    if (['audio', 'video'].includes(item.contentType ?? '') && typeof content?.src === 'string') {
      const file = managedFileForUrl(content.src, files);
      const src = file?.previewUrl ?? content.src;
      if (/^https?:\/\//i.test(src) || new RegExp(`^data:${item.contentType}/[a-z0-9.+-]+;base64,`, 'i').test(src)) {
        const media = document.createElement(item.contentType === 'audio' ? 'audio' : 'video'); media.controls = true; media.preload = 'metadata'; media.src = src;
        const label = document.createElement('p'); label.textContent = content.name ?? item.title ?? ''; root.append(media, label); return root;
      }
    }
    if (item.contentType === 'markdown') { root.append(this.markdown(text, files)); }
    else { const pre = document.createElement('pre'); pre.textContent = text; root.append(pre); }
    return root;
  }

  private answer(answer: WorkflowResolvedInput, submitting: boolean): HTMLElement {
    const root = document.createElement('div'); root.className = 'resolved-inputs'; root.dataset.requestId = answer.requestId;
    const entry = document.createElement('div'); entry.className = 'resolved-input';
    for (const field of answer.request?.params ?? []) {
      const value = answer.values[field.name]; if (value === undefined || value === '' || value === null || Array.isArray(value) && !value.length) { continue; }
      const label = document.createElement('strong'); label.textContent = field.label || field.name;
      const text = document.createElement('p');
      text.textContent = (Array.isArray(value) ? value : [value]).map((entry) => {
        if (entry && typeof entry === 'object') { return field.type === 'file' && 'name' in entry ? String(entry.name) : JSON.stringify(entry); }
        return field.options?.find((option) => option.value === String(entry))?.label ?? (typeof entry === 'boolean' ? entry ? '\u662f' : '\u5426' : String(entry));
      }).join(', ');
      entry.append(label, text);
    }
    if (submitting) { const status = document.createElement('span'); status.className = 'pending'; status.innerHTML = `${iconHtml('loading')}<span>\u6b63\u5728\u63d0\u4ea4...</span>`; entry.append(status); }
    root.append(entry); return root;
  }

  private card(card: ResourceCard): HTMLElement {
    const button = document.createElement('button'); button.className = 'resource-card'; button.title = card.title;
    button.innerHTML = `${iconHtml(card.kind === 'browser' ? 'globe' : card.kind === 'file' ? 'file' : card.kind === 'kv' ? 'database' : card.kind === 'knowledge' ? 'book' : 'folder')}<span>${escapeHtml(card.title)}</span>${iconHtml('arrow-up-right')}`;
    button.addEventListener('click', () => this.options.resource(card)); return button;
  }
}
