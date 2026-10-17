import { t, locale } from './localization';
import { iconButton, iconHtml, escapeHtml, markdownHtml } from './ui';
import { agentSession, latestAgentPlan, orderedTasks, ownedActivity, terminalTask, type AgentPlanDocument } from './trace-agent-model';
import type { TracePanelState } from '../src/workflow-trace-types';
import type { TraceAgentAction, TraceAgentCommand, TraceAgentSnapshot, TraceTask } from '../src/workflow-agent-types';

export type AgentTab = 'tasks' | 'plan' | 'records' | 'usage';
const status = (value: string) => t(({ pending: 'Pending', running: 'Running', waiting: 'Waiting', completed: 'Completed',
  aborted: 'Stopped', failed: 'Failed', faulted: 'Failed', orphaned: 'Unavailable', blocked: 'Blocked', in_progress: 'In progress',
  idle: 'Not connected', connecting: 'Connecting', ready: 'Ready', missing_task: 'Task definition missing', task_too_old: 'Task definition incompatible', migration_failed: 'Task migration failed' } as Record<string, string>)[value] ?? value);
interface Position { scroll: number; scrolls: Map<string, number>; expanded: Set<string>; task?: number }

export class TraceAgentView {
  private state?: TracePanelState;
  private tab: AgentTab = 'tasks';
  private key = '';
  private signature = '';
  private selectedTask?: number;
  private readonly positions = new Map<string, Position>();
  private readonly menu = document.createElement('div');
  private readonly actions = new Map<string, HTMLButtonElement>();
  private readonly more: HTMLButtonElement;
  private dialog?: HTMLDialogElement;

  constructor(private readonly body: HTMLElement, toolbar: HTMLElement, private readonly send: (action: TraceAgentAction) => void,
    private readonly copy: (text: string) => void) {
    this.menu.id = 'trace-agent-menu'; this.menu.className = 'trace-agent-menu'; this.menu.setAttribute('popover', 'manual');
    this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-label', t('Task actions'));
    this.more = iconButton('ellipsis', t('Task actions'), () => this.menu.matches(':popover-open') ? this.closeMenu(true) : this.openMenu());
    this.more.id = 'trace-agent-actions'; this.more.setAttribute('aria-haspopup', 'menu'); this.more.setAttribute('aria-controls', this.menu.id);
    this.more.setAttribute('aria-expanded', 'false'); toolbar.append(this.more, this.menu);
    const action = (id: string, icon: string, label: string, run: () => void): void => {
      const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
      button.setAttribute('role', 'menuitem'); button.dataset.action = id;
      button.innerHTML = `${iconHtml(icon)}<span>${escapeHtml(t(label))}</span>`;
      button.onclick = () => { this.closeMenu(true); run(); }; this.actions.set(id, button); this.menu.append(button);
    };
    action('compact', 'fold', 'Summarize context', () => this.command({ type: 'compact' }));
    action('reset', 'clear-all', 'Reset context', () => this.reset());
    action('foreground', 'debug-stop', 'Stop current response', () => this.command({ type: 'cancel', scope: 'foreground' }));
    action('all', 'stop-circle', 'Stop all tasks', () => this.command({ type: 'cancel', scope: 'all' }));
    this.more.onkeydown = event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); this.openMenu(event.key === 'ArrowUp' ? -1 : 0); }
    };
    this.menu.onkeydown = event => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); this.closeMenu(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = this.visibleActions(), index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (!buttons.length) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; }); buttons[next].focus();
    };
    document.addEventListener('pointerdown', event => { if (!this.menu.contains(event.target as Node) && !this.more.contains(event.target as Node)) this.closeMenu(); });
    this.menu.addEventListener('focusout', event => { if (event.relatedTarget && !this.menu.contains(event.relatedTarget as Node)) this.closeMenu(); });
    window.addEventListener('resize', () => this.closeMenu());
  }

  private visibleActions(): HTMLButtonElement[] { return [...this.actions.values()].filter(button => !button.hidden && !button.disabled); }
  private openMenu(index = 0): void {
    if (this.more.disabled) return;
    this.menu.showPopover(); this.more.setAttribute('aria-expanded', 'true');
    const anchor = this.more.getBoundingClientRect();
    this.menu.style.left = `${Math.max(4, Math.min(anchor.right - this.menu.offsetWidth, innerWidth - this.menu.offsetWidth - 4))}px`;
    this.menu.style.top = `${Math.max(4, Math.min(anchor.bottom, innerHeight - this.menu.offsetHeight - 4))}px`;
    const buttons = this.visibleActions(), selected = buttons.at(index);
    buttons.forEach(button => { button.tabIndex = button === selected ? 0 : -1; }); selected?.focus({ preventScroll: true });
  }
  private closeMenu(focus = false): void {
    if (!this.menu.matches(':popover-open')) return;
    this.menu.hidePopover(); this.more.setAttribute('aria-expanded', 'false'); if (focus) this.more.focus({ preventScroll: true });
  }
  private context() {
    if (!this.state) return;
    const { session, agent, connected } = agentSession(this.state);
    if (session && agent && connected) return { sessionId: session.id, ownerId: agent.ownerId, conversationId: agent.conversationId };
  }
  private command(command: TraceAgentCommand): void { const context = this.context(); if (context) this.send({ ...context, type: 'agent', command }); }
  private openConversation(targetId: number): void { const context = this.context(); if (context) this.send({ ...context, type: 'open-conversation', targetId }); }
  private reset(): void {
    const context = this.context(); if (!context) return;
    const dialog = this.dialog = document.createElement('dialog'); dialog.className = 'trace-reset-dialog';
    const form = document.createElement('form'); form.method = 'dialog';
    const heading = document.createElement('h3'); heading.id = 'trace-reset-heading'; heading.textContent = t('Reset context'); dialog.setAttribute('aria-labelledby', heading.id);
    const label = document.createElement('label'); label.textContent = t('Handoff (optional)');
    const handoff = document.createElement('textarea'); handoff.rows = 5; label.append(handoff);
    const actions = document.createElement('div'), cancel = document.createElement('button'), confirm = document.createElement('button');
    cancel.textContent = t('Cancel'); cancel.type = 'button'; cancel.onclick = () => dialog.close();
    confirm.textContent = t('Reset context'); confirm.className = 'primary'; confirm.type = 'submit';
    form.onsubmit = event => { event.preventDefault(); this.send({ ...context, type: 'agent', command: { type: 'reset', ...(handoff.value ? { handoff: handoff.value } : {}) } }); dialog.close(); };
    actions.append(cancel, confirm); form.append(heading, label, actions); dialog.append(form); document.body.append(dialog);
    dialog.onclose = () => { dialog.remove(); if (this.dialog === dialog) this.dialog = undefined; }; dialog.showModal(); handoff.focus();
  }
  private savePosition(): void {
    if (!this.key) return;
    this.positions.delete(this.key);
    this.positions.set(this.key, { scroll: this.body.scrollTop, task: this.selectedTask,
      scrolls: new Map(Array.from(this.body.querySelectorAll<HTMLElement>('[data-scroll]')).map(element => [element.dataset.scroll!, element.scrollTop])),
      expanded: new Set(Array.from(this.body.querySelectorAll<HTMLDetailsElement>('details[open][data-record]')).map(element => element.dataset.record!)) });
    if (this.positions.size > 100) this.positions.delete(this.positions.keys().next().value!);
  }
  update(state: TracePanelState, tab: AgentTab, visible: boolean): void {
    const old = this.state && agentSession(this.state), next = agentSession(state);
    if (old?.session?.id !== next.session?.id || old?.agent?.ownerId !== next.agent?.ownerId) { this.closeMenu(); this.dialog?.close(); }
    this.state = state; this.tab = tab;
    this.more.hidden = !state.snapshot?.durable;
    this.more.disabled = !next.agent || !next.connected;
    this.actions.get('foreground')!.hidden = !next.agent?.foreground;
    this.actions.get('all')!.hidden = !next.agent || !ownedActivity(next.agent);
    for (const button of this.actions.values()) button.disabled = this.more.disabled;
    if (this.more.disabled) { this.closeMenu(); this.dialog?.close(); }
    if (!visible) { this.savePosition(); this.signature = ''; return; }
    this.render();
  }
  private render(): void {
    if (!this.state) return;
    const { session, agent, current, connected } = agentSession(this.state), plan = session && latestAgentPlan(session.messages);
    const nextKey = `${this.state.selection.projectUri}:${session?.id}:${agent?.ownerId}:${this.tab}`;
    const content = this.tab === 'tasks' ? [agent?.conversations, agent?.tasks, agent?.history, agent?.compactionFailure, current]
      : this.tab === 'plan' ? [agent?.plan, plan] : this.tab === 'usage' ? [agent?.conversations, agent?.usage] : [agent?.epoch, agent?.configuration, agent?.prompt, agent?.records, agent?.resources];
    const signature = JSON.stringify([nextKey, connected, content, this.selectedTask, session?.forkSource]);
    if (signature === this.signature) return;
    this.savePosition(); const switching = nextKey !== this.key; this.key = nextKey;
    const position = this.positions.get(this.key); if (switching) this.selectedTask = position?.task;
    this.signature = signature;
    const focus = !switching && this.body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : undefined;
    this.body.classList.toggle('trace-tasks-view', this.tab === 'tasks' && !!agent); this.body.replaceChildren();
    if (this.tab === 'tasks' && agent) this.tasks(agent, current, connected);
    else if (this.tab === 'plan') this.plan(agent?.plan, plan, connected);
    else if (!agent) this.empty(t('No task state'));
    else if (this.tab === 'records') this.records(agent);
    else this.usage(agent, connected);
    for (const details of Array.from(this.body.querySelectorAll<HTMLDetailsElement>('details[data-record]'))) details.open = position?.expanded.has(details.dataset.record!) ?? false;
    for (const region of Array.from(this.body.querySelectorAll<HTMLElement>('[data-scroll]'))) region.scrollTop = position?.scrolls.get(region.dataset.scroll!) ?? 0;
    this.body.scrollTop = position?.scroll ?? 0;
    if (focus) Array.from(this.body.querySelectorAll<HTMLElement>('[data-focus]')).find(element => element.dataset.focus === focus)?.focus({ preventScroll: true });
  }
  private empty(text: string, parent = this.body): void { const paragraph = document.createElement('p'); paragraph.className = 'trace-agent-empty'; paragraph.textContent = text; parent.append(paragraph); }
  private heading(text: string, parent = this.body): void { const heading = document.createElement('h3'); heading.textContent = text; parent.append(heading); }
  private fields(fields: [string, unknown][], parent = this.body): void {
    const list = document.createElement('dl'); list.className = 'trace-agent-fields';
    for (const [label, value] of fields) {
      if (value === undefined || value === '') continue;
      const term = document.createElement('dt'), description = document.createElement('dd'); term.textContent = label; description.textContent = String(value); list.append(term, description);
    }
    parent.append(list);
  }
  private record(key: string, title: string, value: unknown): void {
    const row = document.createElement('details'), summary = document.createElement('summary'); row.className = 'trace-agent-record'; row.dataset.record = key;
    summary.dataset.focus = `record-${key}`; summary.textContent = title;
    const content = document.createElement('pre'); content.textContent = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
    row.append(summary, content); this.body.append(row);
  }
  private tasks(agent: TraceAgentSnapshot, current: number | undefined, connected: boolean): void {
    const section = (label: string, id: string): HTMLElement => {
      const section = document.createElement('section'); section.className = 'trace-task-section';
      const heading = document.createElement('h3'); heading.id = `trace-${id}-heading`; heading.textContent = label;
      const content = document.createElement('div'); content.className = 'trace-task-scroll'; content.dataset.scroll = id; content.dataset.focus = `scroll-${id}`; content.tabIndex = 0;
      content.setAttribute('role', 'region'); content.setAttribute('aria-labelledby', heading.id); section.append(heading, content); this.body.append(section); return content;
    };
    const live = section(t('Conversations'), 'conversations');
    const source = agentSession(this.state!).session?.forkSource;
    if (source) {
      const button = iconButton('references', t('Fork source'), () => { const context = this.context(); if (context) this.send({ ...context, type: 'open-session', targetSessionId: source.sessionId }); });
      button.disabled = !connected; button.dataset.focus = 'fork-source'; live.append(button);
    }
    for (const conversation of agent.conversations) {
      const button = document.createElement('button'); button.className = 'trace-agent-conversation'; button.dataset.focus = `conversation-${conversation.id}`;
      button.innerHTML = `${iconHtml(conversation.parentId === undefined ? 'comment' : 'git-branch')}<span>${escapeHtml(conversation.title)}</span>`;
      button.title = t('Open conversation'); button.disabled = !connected; button.onclick = () => this.openConversation(conversation.id);
      if (conversation.id === current) {
        button.setAttribute('aria-current', 'true');
        const marker = document.createElement('span'); marker.innerHTML = iconHtml('eye'); marker.title = t('Current conversation'); marker.setAttribute('aria-label', marker.title); button.append(marker);
      }
      if (conversation.id === agent.conversationId) button.dataset.selected = 'true';
      live.append(button);
    }
    this.heading(t('Active tasks'), live);
    if (!agent.tasks.length) this.empty(t('No active tasks'), live);
    live.append(this.taskRows(agent.tasks, agent.tasks, connected));
    if (agent.compactionFailure) this.empty(agent.compactionFailure, live);
    const history = section(t('Completed tasks'), 'history');
    if (!agent.history.length) this.empty(t('No completed tasks'), history);
    history.append(this.taskRows([...agent.history].reverse(), [...agent.tasks, ...agent.history], connected));
  }
  private taskRows(tasks: TraceTask[], all: TraceTask[], connected: boolean): HTMLElement {
    const list = document.createElement('ul'); list.className = 'trace-task-tree';
    for (const { task, depth } of orderedTasks(tasks, all)) {
      const entry = document.createElement('li'), row = document.createElement('div'); row.className = 'trace-task-row'; row.dataset.status = task.status;
      row.style.paddingInlineStart = `${depth * 10}px`;
      const button = document.createElement('button'); button.className = 'trace-task-select'; button.dataset.focus = `task-${task.id}`;
      const expanded = task.id === this.selectedTask; button.setAttribute('aria-expanded', String(expanded));
      if (expanded) button.setAttribute('aria-controls', `trace-task-${task.id}`);
      const label = task.label === 'pi.generation' ? t('Model request') : task.label === 'pi.compaction' ? t('Context compaction') : task.label === 'pi.tools' ? t('Tool round') : task.label;
      const stopping = task.stopping && !terminalTask(task);
      button.title = label; button.innerHTML = `${iconHtml(expanded ? 'chevron-down' : 'chevron-right')}${iconHtml(stopping ? 'loading' : task.status === 'completed' ? 'check' : task.blockedOn.length ? 'debug-pause' : task.toolName ? 'tools' : 'circle-outline')}<span>${escapeHtml(label)}</span><small>${escapeHtml(stopping ? t('Stopping') : status(task.status))}</small>`;
      button.onclick = () => { this.selectedTask = expanded ? undefined : task.id; this.signature = ''; this.render(); };
      row.append(button);
      if (!terminalTask(task)) {
        const stop = iconButton('debug-stop', t('Stop task'), () => this.command({ type: 'cancel', scope: 'task', taskId: task.id, targetId: task.conversationId }));
        stop.dataset.focus = `stop-${task.id}`; stop.disabled = !connected || task.stopping; row.append(stop);
      }
      entry.append(row); if (expanded) entry.append(this.taskDetails(task, connected)); list.append(entry);
    }
    return list;
  }
  private taskDetails(task: TraceTask, connected: boolean): HTMLElement {
    const content = document.createElement('div'); content.className = 'trace-task-detail'; content.id = `trace-task-${task.id}`;
    const tools = document.createElement('div'); tools.className = 'trace-detail-tools';
    const open = iconButton('comment', t('Open conversation'), () => this.openConversation(task.conversationId));
    open.disabled = !connected; open.dataset.focus = `open-task-${task.id}`;
    const copy = iconButton('copy', t('Copy record'), () => this.copy(JSON.stringify(task, null, 2))); copy.dataset.focus = `copy-task-${task.id}`;
    tools.append(open, copy); content.append(tools);
    this.fields([[t('Task'), task.id], [t('Status'), status(task.status)], [t('Phase'), task.phase], [t('Replay policy'), task.replay],
      [t('Attempt'), task.attempt], [t('Blocked by'), task.blockedOn.join(', ')], [t('Blocked reason'), task.blockedReason && status(task.blockedReason)],
      [t('Definition version'), task.definitionVersion], [t('Wake time'), task.wakeAt === undefined ? undefined : new Date(task.wakeAt).toLocaleString(locale())]], content);
    for (const [label, value] of [[t('Tool arguments'), task.arguments], [t('Checkpoint'), task.checkpoint], [t('Script'), task.script], [t('Details'), task.details]]) {
      if (value === undefined) continue;
      this.heading(String(label), content); const pre = document.createElement('pre'); pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); content.append(pre);
    }
    return content;
  }
  private plan(plan: TraceAgentSnapshot['plan'] | undefined, documentPlan: AgentPlanDocument | undefined, connected: boolean): void {
    if (documentPlan) {
      const heading = document.createElement('div'); heading.className = 'trace-plan-heading'; this.heading(t('Latest plan'), heading);
      const state = document.createElement('span'); state.setAttribute('role', 'status'); state.textContent = t(({ awaiting_approval: 'Awaiting approval', submitting: 'Submitting...', approved: 'Approved', changes_requested: 'Changes requested', ready: 'Ready' } as const)[documentPlan.state]); heading.append(state);
      const article = document.createElement('article'); article.className = 'markdown-body trace-plan-document'; article.innerHTML = markdownHtml(documentPlan.text);
      for (const link of Array.from(article.querySelectorAll('a'))) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      this.body.append(heading, article);
    }
    if (!plan?.items.length) { if (!documentPlan) this.empty(t('No plan')); return; }
    this.heading(t('Execution steps')); const list = document.createElement('ol'); list.className = 'trace-plan-steps';
    for (const item of plan.items) {
      const row = document.createElement('li'), label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.checked = item.status === 'completed'; input.disabled = !connected; input.dataset.focus = `plan-${item.id}`;
      input.onchange = () => this.command({ type: 'plan', expectedVersion: plan.version, items: plan.items.map(entry => entry.id === item.id ? { ...entry, status: input.checked ? 'completed' : 'pending' } : entry) });
      const text = document.createElement('span'), progress = document.createElement('small'); text.textContent = item.text; progress.textContent = status(item.status);
      label.append(input, text, progress); row.append(label); list.append(row);
    }
    this.body.append(list);
  }
  private records(agent: TraceAgentSnapshot): void {
    this.fields([[t('Context epoch'), agent.epoch], [t('Configuration'), agent.configuration.version], [t('Model'), `${agent.configuration.provider}/${agent.configuration.model}`],
      [t('Effort'), agent.configuration.effort], [t('Prompt version'), agent.prompt.version], [t('Prompt digest'), agent.prompt.hash]]);
    const resources = agent.resources;
    if (resources) {
      this.heading(t('Execution resources'));
      this.fields([[t('Execution target'), `${t(resources.environment.remote ? 'Remote' : 'Local')}: ${resources.environment.label}`], [t('Environment identity'), resources.environment.id],
        [t('Environment status'), status(resources.environment.state)], [t('Storage'), resources.storage], [t('Code Mode'), t(resources.codeMode ? 'Enabled' : 'Disabled')]]);
      for (const catalog of resources.catalogs) this.record(`catalog-${catalog.id}`, `${t('Tool catalog')}: ${catalog.id} (${status(catalog.state)})`, `${t('Loaded tools')}: ${catalog.loaded.join(', ') || t('None')}\n${t('Available tools')}: ${catalog.tools.join(', ') || t('None')}`);
      for (const extension of resources.extensions) this.record(`extension-${extension.name}`, `${t('Extension')}: ${extension.name}`, [...extension.tools, ...extension.tasks.map(task => `${task.name} (v${task.version})`)].join('\n'));
    }
    for (const record of agent.records.filter(record => record.conversationId === agent.conversationId).reverse()) this.record(`command-${record.id}`, `#${record.id} ${record.label}`, record.data);
  }
  private usage(agent: TraceAgentSnapshot, connected: boolean): void {
    if (!agent.usage.length) this.empty(t('No usage recorded'));
    for (const spend of agent.usage) {
      const heading = document.createElement('div'); heading.className = 'trace-plan-heading';
      this.heading(agent.conversations.find(conversation => conversation.id === spend.conversationId)?.title ?? String(spend.conversationId), heading);
      const open = iconButton('comment', t('Open conversation'), () => this.openConversation(spend.conversationId)); open.disabled = !connected; heading.append(open); this.body.append(heading);
      const table = document.createElement('table'); table.className = 'trace-agent-usage';
      const head = table.createTHead().insertRow();
      for (const label of [t('Type'), t('Source'), t('Tokens'), t('Cost')]) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell); }
      const body = table.createTBody();
      for (const [kind, entries] of [[t('Model'), spend.models], [t('Tool'), spend.tools]] as const) {
        for (const [name, value] of Object.entries(entries)) {
          const usage = value as { totalTokens?: number; cost?: { total?: number } };
          const row = body.insertRow(); row.title = JSON.stringify(usage);
          for (const text of [kind, name, String(usage.totalTokens ?? 0), (usage.cost?.total ?? 0).toFixed(6)]) row.insertCell().textContent = text;
        }
      }
      this.body.append(table);
      this.record(`usage-${spend.conversationId}`, t('Usage details'), spend);
    }
  }
}
