import type { AccountState } from '../src/workflow-auth-client';
import { ParameterActions } from './parameter-actions';
import { InputPrompt } from './input-prompt';
import { ConversationTools } from './conversation-tools';
import { ContentSearch } from './content-search';
import { ConversationOutput } from './conversation-output';
import { activeAgentActivity } from './agent-activity';
import { iconHtml as icon, escapeHtml as escape, iconButton } from './ui';
import './style.css';
import {
  workflowParameters,
  workflowParamValue,
  type ConversationMessage, type ConversationSession, type Project, type Field,
  type ParamValues, type ParamValue, type ParamState, type ParamRequest,
  type Attachment,
} from '../src/workflow-types';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

function initialize(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  if (app.dataset.initialized === 'true') { return; }
  const vscode = acquireVsCodeApi();
  app.dataset.initialized = 'true';
  app.innerHTML = `
    <header class="toolbar">
      <div class="project-title"><button id="menu-toggle" class="icon-button" title="\u663e\u793a\u5bf9\u8bdd\u5217\u8868" aria-label="\u663e\u793a\u5bf9\u8bdd\u5217\u8868" aria-controls="project-menu">${icon('layout-sidebar-left')}</button><span id="project-icon" class="project-icon">${icon('comment-discussion')}</span><div class="project-heading"><h1 id="conversation-title">Workflow</h1><span id="assistant-folder" hidden></span></div><span id="project-name" class="project-name"></span></div>
      <div class="toolbar-actions"><button id="usage" class="icon-button" title="\u7cfb\u7edf AI \u7528\u91cf" aria-label="\u7cfb\u7edf AI \u7528\u91cf" hidden>${icon('dashboard')}</button><button id="tools" class="icon-button" title="\u5de5\u5177\u6743\u9650" aria-label="\u5de5\u5177\u6743\u9650" hidden>${icon('tools')}</button></div>
    </header>
    <aside id="project-menu" class="project-menu" aria-label="\u5bf9\u8bdd\u5217\u8868">
      <div class="menu-heading"><span id="menu-label">\u5bf9\u8bdd\u5217\u8868</span><div class="menu-actions"><button id="history-toggle" class="icon-button" title="\u641c\u7d22\u5bf9\u8bdd" aria-label="\u641c\u7d22\u5bf9\u8bdd" aria-haspopup="dialog" aria-controls="history-popover" aria-expanded="false" popovertarget="history-popover">${icon('search')}</button><button id="new" class="icon-button" title="\u65b0\u5bf9\u8bdd" aria-label="\u65b0\u5bf9\u8bdd">${icon('edit')}</button><button id="hide-menu" class="icon-button" title="\u9690\u85cf\u5bf9\u8bdd\u5217\u8868" aria-label="\u9690\u85cf\u5bf9\u8bdd\u5217\u8868">${icon('chevron-left')}</button></div></div>
      <section id="chats"><nav id="session-list" aria-label="\u5bf9\u8bdd\u5386\u53f2"></nav><button id="load-more-history" class="all-history" hidden>${icon('chevron-down')}<span>\u52a0\u8f7d\u66f4\u591a</span></button><button id="all-history" class="all-history" aria-haspopup="dialog" aria-controls="history-popover" aria-expanded="false" popovertarget="history-popover" hidden></button><div id="no-history" class="no-history" hidden>\u6682\u65e0\u5bf9\u8bdd</div></section>
    </aside>
    <main><div class="transcript-area"><div id="transcript" class="transcript" role="log" aria-label="\u5bf9\u8bdd\u6d88\u606f" aria-live="polite" aria-relevant="additions"></div><button id="latest" class="icon-button latest-button" title="\u56de\u5230\u6700\u65b0\u6d88\u606f" aria-label="\u56de\u5230\u6700\u65b0\u6d88\u606f" hidden>${icon('arrow-down')}</button></div>
      <footer class="composer-area"><div id="error" class="error" role="alert" hidden></div><div id="input-queue" class="input-queue" hidden></div><div id="editing-queue" class="editing-queue" hidden><span>\u7f16\u8f91\u5f85\u53d1\u6d88\u606f</span><button id="cancel-queue-edit" class="icon-button" title="\u53d6\u6d88\u7f16\u8f91" aria-label="\u53d6\u6d88\u7f16\u8f91">${icon('close')}</button></div><section id="parameters" aria-label="\u8fd0\u884c\u53c2\u6570"><div class="parameter-feedback"><div id="parameter-status" class="parameter-status" role="status" hidden>${icon('loading')}<span>\u52a0\u8f7d\u53c2\u6570...</span></div><div id="parameter-error" class="parameter-error" role="alert" hidden></div><button id="refresh-params" class="icon-button" title="\u91cd\u8bd5\u52a0\u8f7d\u53c2\u6570" aria-label="\u91cd\u8bd5\u52a0\u8f7d\u53c2\u6570" hidden>${icon('refresh')}</button><button id="parameter-login" class="parameter-login" hidden>${icon('sign-in')}<span>\u767b\u5f55 Workflow</span></button></div><div class="composer"><div id="main-fields" class="composer-main-fields" hidden></div><div id="draft-attachments" class="attachments" hidden></div><textarea id="message" rows="2" placeholder="\u53d1\u9001\u6d88\u606f..." aria-label="\u6d88\u606f"></textarea><div class="composer-toolbar"><div class="run-options"><button id="attach" class="icon-button" title="\u6dfb\u52a0\u9644\u4ef6" aria-label="\u6dfb\u52a0\u9644\u4ef6" hidden>${icon('attach')}</button><select id="entrypoint" aria-label="\u8fd0\u884c\u5165\u53e3" hidden></select><div id="parameter-actions" class="parameter-actions" role="group" aria-label="\u8fd0\u884c\u53c2\u6570"></div></div><div class="composer-actions"><button id="send" class="send-button" title="\u53d1\u9001" aria-label="\u53d1\u9001">${icon('arrow-up')}</button></div></div></div></section></footer>
    </main>
    <div id="history-popover" class="history-popover" popover="auto" role="dialog" aria-label="\u5168\u90e8\u5bf9\u8bdd"><div class="history-popover-toolbar"><label class="history-search">${icon('search')}<input id="search-all-history" type="search" placeholder="\u641c\u7d22\u5bf9\u8bdd" aria-label="\u641c\u7d22\u5168\u90e8\u5bf9\u8bdd"></label><button id="close-history" class="icon-button" title="\u5173\u95ed\u5bf9\u8bdd\u5386\u53f2" aria-label="\u5173\u95ed\u5bf9\u8bdd\u5386\u53f2">${icon('close')}</button></div><nav id="all-session-list" aria-label="\u5168\u90e8\u804a\u5929"></nav><div id="history-empty" class="no-history" hidden>\u6ca1\u6709\u5339\u914d\u7684\u5bf9\u8bdd</div></div>
    <div id="session-menu" class="session-menu" popover="manual" role="menu" aria-label="\u5bf9\u8bdd\u64cd\u4f5c">
      <button class="session-action" data-action="rename" role="menuitem" tabindex="-1">${icon('edit')}<span>\u91cd\u547d\u540d</span></button>
      <button class="session-action" data-action="lock" role="menuitem" tabindex="-1">${icon('lock')}<span>\u9501\u5b9a\u6807\u9898</span></button>
      <button class="session-action" data-action="export" role="menuitem" tabindex="-1">${icon('export')}<span>\u5bfc\u51fa\u5bf9\u8bdd</span></button>
      <div class="session-menu-separator" role="separator"></div>
      <button class="session-action" data-action="delete" role="menuitem" tabindex="-1">${icon('trash')}<span>\u5220\u9664\u5bf9\u8bdd</span></button>
    </div>`;

  interface State { project: Project; sessions: ConversationSession[]; activeId: string; running: boolean; parameterValues?: Record<string, ParamValues>; account?: AccountState; authenticationRevision?: number; parameterRevision?: number }
  interface FieldView {
    field: Field; root: HTMLDivElement;
    controls: (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    description: HTMLDivElement; optionsSignature?: string;
  }
  interface MessageView {
    root: HTMLElement; content: HTMLDivElement; metadata: HTMLSpanElement; error: HTMLParagraphElement;
    message: ConversationMessage; output?: ConversationOutput;
    attachments: HTMLDivElement; promptRoot: HTMLDivElement; prompt?: InputPrompt;
    extrasSignature?: string;
  }

  let state: State | undefined;
  let renderedProject = '';
  let renderedSession = '';
  let formKey = '';
  let paramStates: Record<string, ParamState> = {};
  let resolving = false;
  let submitting = false;
  let requestId = 0;
  let paramsNeedInit = false;
  let authenticationRequired = false;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let draftFiles: Attachment[] = [];
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let uploading = 0;
  let editingQueueId: string | undefined;
  const historyPageSize = 30;
  let historyLimit = historyPageSize;
  let allHistoryQuery = '';
  let historyTrigger: HTMLButtonElement | undefined;
  let sessionMenuId: string | undefined;
  let sessionMenuTrigger: HTMLButtonElement | undefined;
  const textarea = document.querySelector<HTMLTextAreaElement>('#message')!;
  const transcript = document.querySelector<HTMLDivElement>('#transcript')!;
  const sendButton = document.querySelector<HTMLButtonElement>('#send')!;
  const entrypoint = document.querySelector<HTMLSelectElement>('#entrypoint')!;
  const latest = document.querySelector<HTMLButtonElement>('#latest')!;
  const paramError = document.querySelector<HTMLDivElement>('#parameter-error')!;
  const chats = document.querySelector<HTMLElement>('#chats')!;
  const moreHistory = document.querySelector<HTMLButtonElement>('#load-more-history')!;
  const allHistorySearch = document.querySelector<HTMLInputElement>('#search-all-history')!;
  const historyPopover = document.querySelector<HTMLDivElement>('#history-popover')!;
  const sessionMenu = document.querySelector<HTMLDivElement>('#session-menu')!;
  const sessionActions = Array.from(sessionMenu.querySelectorAll<HTMLButtonElement>('.session-action'));
  const fields = new Map<string, FieldView>();
  const messages = new Map<string, MessageView>();
  const saved = (vscode.getState() ?? {}) as { drafts?: Record<string, string>; params?: Record<string, ParamValues>; panelOpen?: boolean; projectUri?: string };
  const drafts = saved.drafts ?? {};
  const paramValues = saved.params ?? {};
  const narrow = window.matchMedia('(max-width: 680px)');
  let panelOpen = saved.panelOpen ?? document.body.dataset.surface !== 'assistant';
  const persist = (): void => { vscode.setState({ drafts, params: paramValues, panelOpen, projectUri: state?.project.uri ?? saved.projectUri }); };
  const post = (message: Record<string, unknown>): void => { if (state) { vscode.postMessage({ projectUri: state.project.uri, sessionId: state.activeId, ...message }); } };
  const currentSession = () => state?.sessions.find((session) => session.id === state?.activeId);
  const dialogs = new ConversationTools();
  const contentSearch = new ContentSearch(transcript);
  const currentParameters = () => workflowParameters(state!.project, entrypoint.value || undefined);
  const values = (): ParamValues => paramValues[formKey] ??= {};
  const canQueue = (): boolean => state?.project.conversation?.inputQueue?.enabled === true;
  const busy = (): boolean => submitting || (!!state?.running || !!currentSession()?.messages.some((message) => message.pendingInput)) && !canQueue();
  const parameterActions = new ParameterActions(document.querySelector('#parameter-actions')!, {
    current: () => ({ values: values(), states: paramStates, disabled: busy(), loading: resolving }),
    fieldRoot: (name) => fields.get(name)!.root,
    onChange: (name, value) => setFieldValue(name, value),
    onReset: (names) => {
      for (const name of names) {
        const field = fields.get(name)!.field;
        values()[name] = workflowParamValue(field);
      }
      persist(); updateFields(); requestParams({ kind: 'param', paramName: names[0] });
    },
  });

  function showMenu(open: boolean): void {
    closeSessionMenu();
    panelOpen = open;
    app.classList.toggle('menu-open', open);
    const toggle = document.querySelector<HTMLButtonElement>('#menu-toggle')!;
    toggle.hidden = open;
    toggle.setAttribute('aria-expanded', String(open));
    const actions = document.querySelector(narrow.matches && open ? '.menu-actions' : '.toolbar-actions')!;
    actions.prepend(document.querySelector('#usage')!, document.querySelector('#tools')!);
    document.querySelector('#menu-label')!.textContent = narrow.matches ? '\u804a\u5929' : '\u5bf9\u8bdd\u5217\u8868';
    closeHistory();
    renderHistory(true);
    persist();
  }
  showMenu(panelOpen);
  narrow.addEventListener('change', () => showMenu(panelOpen));

  function sizeComposer(): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(240, Math.max(72, textarea.scrollHeight))}px`;
  }

  function requestParams(trigger: ParamRequest['trigger']): void {
    clearTimeout(inputTimer);
    if (!state || busy() || !fields.size) { return; }
    paramsNeedInit = false;
    resolving = true;
    paramError.hidden = true;
    updateControls();
    vscode.postMessage({ type: 'resolve', projectUri: state.project.uri, sessionId: state.activeId,
      requestId: ++requestId, entrypointId: entrypoint.value, params: values(), draftText: textarea.value, trigger });
  }

  function createField(field: Field): FieldView {
    const root = document.createElement('div');
    root.className = `param-field${field.type === 'boolean' ? ' boolean-field' : ''}`;
    root.dataset.param = field.name;
    const label = document.createElement('label');
    label.htmlFor = `param-${field.name}`;
    label.className = 'field-label';
    label.innerHTML = `<span>${escape(field.label || field.name)}</span>${field.required ? '<span class="required" aria-hidden="true">*</span>' : ''}${field.description ? icon('info') : ''}`;
    if (field.description) { label.title = field.description; }
    root.append(label);
    const controls: FieldView['controls'] = [];
    if (field.control === 'radio' || field.control === 'checkboxes') {
      const choices = document.createElement('div');
      choices.className = 'field-choices';
      root.append(choices);
    } else {
      let control: FieldView['controls'][number];
      if (field.type === 'file' || field.control === 'audio') {
        control = document.createElement('input'); control.type = 'hidden';
        const summary = document.createElement('span'); summary.className = 'param-file-summary'; root.append(summary);
        const choose = iconButton(field.control === 'audio' ? 'mic' : 'attach', '\u9009\u62e9\u6587\u4ef6', () => post({ type: 'attach', paramName: field.name, entrypointId: entrypoint.value }));
        choose.classList.add('param-file-button'); root.append(choose);
      } else if (field.control === 'select' || field.options !== undefined) {
        control = document.createElement('select');
        control.multiple = !!field.multiple;
      } else if (field.control === 'textarea') {
        control = document.createElement('textarea');
        control.rows = 3;
      } else {
        control = document.createElement('input');
        control.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number'
          : field.control === 'datetime' ? 'datetime-local' : ['date', 'time'].includes(field.control ?? '') ? field.control!
          : /key|token|secret/i.test(field.name) ? 'password' : 'text';
        if (control.type === 'number') { control.step = 'any'; }
        if (control.type === 'checkbox') { control.setAttribute('role', 'switch'); }
      }
      control.id = `param-${field.name}`;
      control.name = field.name;
      control.classList.add('field-control');
      // Required booleans describe a supplied true/false value, not a checked box.
      control.required = !!field.required && field.type !== 'boolean';
      control.addEventListener('change', () => changeField(field.name));
      root.append(control);
      controls.push(control);
    }
    const description = document.createElement('div');
    description.className = 'option-description';
    description.hidden = true;
    root.append(description);
    return { field, root, controls, description };
  }

  function renderParameters(): void {
    const project = state!.project;
    const parameters = currentParameters();
    formKey = `${project.uri}:${state!.activeId}:${entrypoint.value}`;
    paramValues[formKey] = { ...paramValues[formKey], ...state!.parameterValues?.[entrypoint.value] };
    paramStates = {};
    authenticationRequired = false;
    paramsNeedInit = parameters.fields.length > 0;
    fields.clear();
    const container = document.querySelector<HTMLDivElement>('#main-fields')!;
    container.replaceChildren();
    for (const field of parameters.fields) {
      values()[field.name] = workflowParamValue(field, values()[field.name] ?? field.defaultValue ?? (field.type === 'boolean' ? 'false' : ''));
      fields.set(field.name, createField(field));
      if (project.projectType !== 'conversation' && (field.panel === undefined || field.panel === 'main')) { container.append(fields.get(field.name)!.root); }
    }
    parameterActions.render(parameters);
    paramError.hidden = true;
    updateFields();
    requestParams({ kind: 'init' });
  }

  function changeField(name: string): void {
    const view = fields.get(name)!;
    const control = view.controls[0];
    if (view.field.control === 'checkboxes') { values()[name] = view.controls.filter((entry) => entry instanceof HTMLInputElement && entry.checked).map((entry) => entry.value); }
    else if (view.field.control === 'radio') { values()[name] = view.controls.find((entry) => entry instanceof HTMLInputElement && entry.checked)?.value ?? ''; }
    else if (control instanceof HTMLInputElement && control.type === 'checkbox') { values()[name] = String(control.checked); }
    else if (control instanceof HTMLSelectElement && control.multiple) { values()[name] = Array.from(control.selectedOptions, (option) => option.value); }
    else { values()[name] = control.value; }
    setFieldValue(name, values()[name]);
  }

  function setFieldValue(name: string, value: ParamValue): void {
    values()[name] = value;
    persist(); updateFields(); requestParams({ kind: 'param', paramName: name });
  }

  function updateFields(): void {
    for (const [name, view] of fields) {
      const patch = paramStates[name];
      const options = patch?.resolvedOptions ?? view.field.options ?? [];
      const visibleOptions = options.filter((option) => patch?.options?.[option.value]?.visible !== false);
      view.root.hidden = patch?.visible === false;
      const signature = JSON.stringify([visibleOptions, patch?.options]);
      const control = view.controls[0];
      if (signature !== view.optionsSignature) {
        view.optionsSignature = signature;
        if (control instanceof HTMLSelectElement) {
          control.replaceChildren();
          if (!control.multiple) { control.append(new Option(visibleOptions.length ? '\u9009\u62e9...' : '\u6682\u65e0\u53ef\u7528\u9009\u9879', '')); }
          for (const option of visibleOptions) {
            const entry = new Option(option.label || option.value, option.value);
            entry.disabled = patch?.options?.[option.value]?.disabled === true;
            entry.title = option.description || '';
            control.append(entry);
          }
        } else if (view.field.control === 'radio' || view.field.control === 'checkboxes') {
          const choices = view.root.querySelector<HTMLDivElement>('.field-choices')!;
          choices.replaceChildren();
          view.controls = visibleOptions.map((option, index) => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.id = index === 0 ? `param-${name}` : `param-${name}-${index}`;
            input.name = name;
            input.type = view.field.control === 'radio' ? 'radio' : 'checkbox';
            input.value = option.value;
            input.className = 'field-control';
            input.addEventListener('change', () => changeField(name));
            label.append(input, document.createTextNode(option.label || option.value));
            label.title = option.description || '';
            choices.append(label);
            return input;
          });
        }
      }
      let value = values()[name];
      if (view.field.type === 'file' || view.field.control === 'audio') {
        try { view.root.querySelector('.param-file-summary')!.textContent = (JSON.parse(String(value || '[]')) as { name: string }[]).map((file) => file.name).join(', '); }
        catch { view.root.querySelector('.param-file-summary')!.textContent = ''; }
      }
      // Dynamic selects start with an empty catalog; keep restored values for the initial resolver.
      if (patch?.resolvedOptions !== undefined || !currentParameters().paramResolver?.enabled || (view.field.options?.length ?? 0) > 0) {
        if (view.field.options !== undefined || ['select', 'radio', 'checkboxes'].includes(view.field.control ?? '')) {
          const allowed = new Set(visibleOptions.filter((option) => !patch?.options?.[option.value]?.disabled).map((option) => option.value));
          value = values()[name] = Array.isArray(value) ? value.filter((entry) => allowed.has(entry)) : value && !allowed.has(value) ? '' : value;
        }
      }
      for (const entry of view.controls) {
        if (entry instanceof HTMLInputElement && entry.type === 'checkbox') { entry.checked = view.field.control === 'checkboxes' ? Array.isArray(value) && value.includes(entry.value) : value === 'true'; }
        else if (entry instanceof HTMLInputElement && entry.type === 'radio') { entry.checked = entry.value === value; }
        else if (entry instanceof HTMLSelectElement && entry.multiple) { for (const option of Array.from(entry.options)) { option.selected = Array.isArray(value) && value.includes(option.value); } }
        else { entry.value = typeof value === 'string' ? value : ''; }
      }
      const selected = visibleOptions.find((option) => option.value === value);
      view.description.textContent = selected?.description ?? '';
      view.description.hidden = !selected?.description;
    }
    const mainFields = document.querySelector<HTMLElement>('#main-fields')!;
    mainFields.hidden = !Array.from(mainFields.children).some((field) => !(field as HTMLElement).hidden);
    updateControls();
  }

  function updateControls(): void {
    if (!state) { return; }
    const conversation = state.project.projectType === 'conversation';
    for (const [name, view] of fields) {
      for (const control of view.controls) {
        control.disabled = busy() || resolving || paramStates[name]?.disabled === true
          || (view.field.control === 'radio' || view.field.control === 'checkboxes') && paramStates[name]?.options?.[control.value]?.disabled === true;
      }
    }
    const dynamic = currentParameters().paramResolver?.enabled;
    const refresh = document.querySelector<HTMLButtonElement>('#refresh-params')!;
    refresh.hidden = !dynamic || paramError.hidden;
    refresh.disabled = busy() || resolving;
    refresh.classList.toggle('refreshing', resolving);
    document.querySelector<HTMLElement>('#parameter-status')!.hidden = !resolving || !dynamic;
    document.querySelector('#parameters')!.setAttribute('aria-busy', String(resolving));
    document.querySelector<HTMLElement>('#parameter-login')!.hidden = !authenticationRequired || state.account?.status === 'authenticated';
    parameterActions.update();
    const hasInput = !!textarea.value.trim() || draftFiles.length > 0;
    const stop = state.running && (!canQueue() || !hasInput);
    sendButton.innerHTML = icon(stop ? 'debug-stop' : submitting || uploading ? 'loading' : conversation ? 'arrow-up' : 'play');
    sendButton.title = sendButton.ariaLabel = stop ? '\u505c\u6b62' : editingQueueId ? '\u4fdd\u5b58\u5f85\u53d1\u6d88\u606f' : conversation ? '\u53d1\u9001' : '\u8fd0\u884c';
    sendButton.classList.toggle('stop', stop);
    sendButton.disabled = !stop && (submitting || resolving || uploading > 0 || conversation && !hasInput);
    textarea.disabled = busy();
    entrypoint.disabled = busy() || resolving;
    document.querySelector<HTMLButtonElement>('#new')!.disabled = false;
    const waiting = currentSession()?.messages.some((message) => message.pendingInput);
    app.dataset.runState = state.running ? 'running' : waiting ? 'waiting' : submitting ? 'submitting' : 'idle';
    document.querySelector<HTMLElement>('#tools')!.hidden = !conversation && !currentParameters().tools?.length;
    document.querySelector<HTMLElement>('#usage')!.hidden = !state.project.requiresLogin || state.account?.status !== 'authenticated';
    const attach = document.querySelector<HTMLButtonElement>('#attach')!;
    attach.hidden = !conversation || !Object.values(state.project.conversation?.attachments ?? {}).some(Boolean);
    attach.disabled = busy() || uploading > 0;
    for (const control of Array.from(document.querySelectorAll<HTMLButtonElement>('.param-file-button'))) { control.disabled = busy() || resolving; }
  }

  function sessionTime(session: ConversationSession): number {
    return Math.max(session.updatedAt ?? 0, session.createdAt ?? 0, session.messages.at(-1)?.createdAt ?? 0);
  }

  function relativeTime(session: ConversationSession): string {
    const timestamp = sessionTime(session);
    if (!timestamp) { return ''; }
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
    return minutes < 1 ? '\u521a\u521a' : minutes < 60 ? `${minutes} \u5206` : minutes < 1440 ? `${Math.floor(minutes / 60)} \u5c0f\u65f6` : `${Math.floor(minutes / 1440)} \u5929`;
  }

  function matchingSessions(query: string): ConversationSession[] {
    return [...(state?.sessions ?? [])].reverse().sort((a, b) => sessionTime(b) - sessionTime(a))
      .filter((entry) => !query || entry.title.toLocaleLowerCase().includes(query) || entry.messages.some((message) => message.content.toLocaleLowerCase().includes(query)));
  }

  function renderSessionList(list: HTMLElement, sessions: ConversationSession[]): void {
    if (!state) { return; }
    const existing = new Map(Array.from(list.querySelectorAll<HTMLButtonElement>('.session')).map((button) => [button.dataset.sessionId!, button]));
    for (const [index, entry] of sessions.entries()) {
      let button = existing.get(entry.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.dataset.sessionId = entry.id;
        button.addEventListener('click', () => { saveDraft(); vscode.postMessage({ type: 'select', id: entry.id }); closeHistory(); });
        button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-controls', sessionMenu.id); button.setAttribute('aria-expanded', 'false');
        button.addEventListener('contextmenu', (event) => { event.preventDefault(); openSessionMenu(entry.id, event.currentTarget as HTMLButtonElement, event); });
        button.addEventListener('keydown', (event) => {
          if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
            event.preventDefault(); openSessionMenu(entry.id, event.currentTarget as HTMLButtonElement);
          }
        });
      }
      existing.delete(entry.id);
      button.className = `session${entry.id === state.activeId ? ' active' : ''}${button === sessionMenuTrigger ? ' context-active' : ''}`;
      const status = entry.activeRunId ? '\u8fd0\u884c\u4e2d' : entry.messages.some((message) => message.pendingInput) ? '\u5f85\u786e\u8ba4' : entry.messages.at(-1)?.status === 'failed' ? '\u5931\u8d25' : relativeTime(entry);
      const content = `<span>${entry.titleLocked ? icon('lock-small') : ''}${escape(entry.title)}</span><time>${status}</time>`;
      if (button.innerHTML !== content) { button.innerHTML = content; }
      button.title = entry.title;
      button.setAttribute('aria-current', String(entry.id === state.activeId));
      const current = list.children[index] ?? null;
      if (current !== button) { list.insertBefore(button, current); }
    }
    for (const button of existing.values()) { button.remove(); }
  }

  function renderAllHistory(): void {
    const sessions = matchingSessions(allHistoryQuery);
    renderSessionList(document.querySelector('#all-session-list')!, sessions);
    document.querySelector<HTMLElement>('#history-empty')!.hidden = sessions.length !== 0;
  }

  function renderHistory(revealActive = false): void {
    if (!state) { return; }
    const sessions = matchingSessions('');
    const activeIndex = sessions.findIndex((entry) => entry.id === state!.activeId);
    let visible: ConversationSession[];
    if (narrow.matches) {
      visible = sessions.slice(0, 3);
      if (activeIndex >= 3) { visible.splice(2, 1, sessions[activeIndex]); }
    } else {
      if (revealActive && activeIndex >= historyLimit) { historyLimit = Math.ceil((activeIndex + 1) / historyPageSize) * historyPageSize; }
      visible = sessions.slice(0, historyLimit);
    }
    renderSessionList(document.querySelector('#session-list')!, visible);
    moreHistory.hidden = narrow.matches || visible.length >= sessions.length;
    const all = document.querySelector<HTMLButtonElement>('#all-history')!;
    all.hidden = !narrow.matches || !sessions.length;
    all.textContent = `\u67e5\u770b\u5168\u90e8\uff08${state.sessions.length}\uff09`;
    document.querySelector<HTMLElement>('#no-history')!.hidden = sessions.length !== 0;
    if (historyPopover.matches(':popover-open')) { renderAllHistory(); }
    requestAnimationFrame(() => {
      if (revealActive && panelOpen) { document.querySelector('#session-list .session.active')?.scrollIntoView({ block: 'nearest' }); }
      loadMoreIfNeeded();
    });
  }

  function loadMoreHistory(): void {
    if (!state || narrow.matches || historyLimit >= state.sessions.length) { return; }
    historyLimit += historyPageSize;
    renderHistory();
  }

  function loadMoreIfNeeded(): void {
    if (panelOpen && !narrow.matches && !moreHistory.hidden && chats.clientHeight > 0 && chats.scrollHeight - chats.scrollTop - chats.clientHeight <= 80) { loadMoreHistory(); }
  }

  function positionHistory(): void {
    if (!historyPopover.matches(':popover-open')) { return; }
    const anchor = document.querySelector('.menu-heading')!.getBoundingClientRect();
    const top = anchor.bottom + 6;
    historyPopover.style.maxHeight = `${Math.max(100, Math.min(520, window.innerHeight - top - 12))}px`;
    historyPopover.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - historyPopover.offsetWidth - 12))}px`;
    historyPopover.style.top = `${Math.max(12, Math.min(top, window.innerHeight - historyPopover.offsetHeight - 12))}px`;
  }

  function closeHistory(restoreFocus = false): void {
    if (historyPopover.contains(sessionMenu)) { closeSessionMenu(); }
    if (historyPopover.matches(':popover-open')) { historyPopover.hidePopover(); }
    if (restoreFocus) { historyTrigger?.focus(); }
  }

  function updateSessionMenu(): void {
    if (!sessionMenuId) { return; }
    const entry = state?.sessions.find((entry) => entry.id === sessionMenuId);
    if (!entry || !sessionMenuTrigger?.isConnected || !sessionMenuTrigger.getClientRects().length) { closeSessionMenu(); return; }
    sessionMenu.querySelector('[data-action=lock]')!.innerHTML = `${icon(entry.titleLocked ? 'unlock' : 'lock')}<span>${entry.titleLocked ? '\u89e3\u9664\u6807\u9898\u9501\u5b9a' : '\u9501\u5b9a\u6807\u9898'}</span>`;
  }

  function openSessionMenu(id: string, trigger: HTMLButtonElement, pointer?: MouseEvent): void {
    closeSessionMenu();
    if (!state?.sessions.some((entry) => entry.id === id)) { return; }
    sessionMenuId = id; sessionMenuTrigger = trigger;
    // Keep the submenu inside the history popover so clicking it preserves the search results.
    (historyPopover.contains(trigger) ? historyPopover : app).append(sessionMenu);
    updateSessionMenu();
    trigger.setAttribute('aria-expanded', 'true'); trigger.classList.add('context-active');
    sessionMenu.showPopover();
    const anchor = trigger.getBoundingClientRect();
    const x = pointer && (pointer.clientX || pointer.clientY) ? pointer.clientX : anchor.left;
    const y = pointer && (pointer.clientX || pointer.clientY) ? pointer.clientY : anchor.bottom;
    const margin = 8;
    sessionMenu.style.left = `${Math.max(margin, Math.min(x + sessionMenu.offsetWidth + margin <= window.innerWidth ? x : x - sessionMenu.offsetWidth, window.innerWidth - sessionMenu.offsetWidth - margin))}px`;
    sessionMenu.style.top = `${Math.max(margin, Math.min(y + sessionMenu.offsetHeight + margin <= window.innerHeight ? y : y - sessionMenu.offsetHeight, window.innerHeight - sessionMenu.offsetHeight - margin))}px`;
    sessionMenu.scrollTop = 0;
    focusSessionAction(0);
  }

  function closeSessionMenu(restoreFocus = false): void {
    sessionMenuId = undefined;
    const trigger = sessionMenuTrigger; sessionMenuTrigger = undefined;
    trigger?.setAttribute('aria-expanded', 'false'); trigger?.classList.remove('context-active');
    if (sessionMenu.matches(':popover-open')) { sessionMenu.hidePopover(); }
    if (restoreFocus && trigger?.isConnected) { trigger.focus({ preventScroll: true }); }
  }

  function focusSessionAction(index: number): void {
    sessionActions.forEach((button, i) => { button.tabIndex = i === index ? 0 : -1; });
    sessionActions[index].focus({ preventScroll: true });
  }

  function saveDraft(): void {
    clearTimeout(draftTimer);
    if (!state || submitting) { return; }
    drafts[`${state.project.uri}:${state.activeId}`] = textarea.value;
    persist(); post({ type: 'draft', text: textarea.value, attachments: draftFiles });
  }

  function attachmentList(container: HTMLElement, attachments: Attachment[], removable: boolean): void {
    container.replaceChildren(); container.hidden = !attachments.length;
    for (const file of attachments) {
      const item = document.createElement('div'); item.className = 'attachment';
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'attachment-preview'; preview.title = file.name;
      if (file.kind === 'image' && file.previewUrl) { const image = document.createElement('img'); image.src = file.previewUrl; image.alt = file.name; preview.append(image); }
      else { preview.innerHTML = icon(file.mimeType.startsWith('audio/') ? 'unmute' : file.mimeType.startsWith('video/') ? 'device-camera-video' : 'file'); }
      preview.addEventListener('click', () => post({ type: 'open-file', id: file.id }));
      const name = document.createElement('span'); name.textContent = file.name; name.title = file.name;
      item.append(preview, name);
      if (removable) { item.append(iconButton('close', '\u79fb\u9664\u9644\u4ef6', () => { draftFiles = draftFiles.filter((entry) => entry.id !== file.id); attachmentList(container, draftFiles, true); saveDraft(); updateControls(); })); }
      container.append(item);
    }
  }

  function renderQueue(): void {
    const queue = currentSession()?.queuedInputs ?? [];
    const container = document.querySelector<HTMLElement>('#input-queue')!; container.replaceChildren(); container.hidden = !queue.length;
    if (!queue.length) { return; }
    const heading = document.createElement('div'); heading.className = 'queue-heading'; heading.textContent = `\u5f85\u53d1\u6d88\u606f (${queue.length})`;
    if (!state!.running && !currentSession()?.messages.some((message) => message.pendingInput)) { heading.append(iconButton('play', '\u7ee7\u7eed\u53d1\u9001\u961f\u5217', () => post({ type: 'queue-run' }))); }
    container.append(heading);
    for (const [index, input] of queue.entries()) {
      const row = document.createElement('div'); row.className = 'queued-input'; row.dataset.id = input.id; row.draggable = true;
      const label = document.createElement('span'); label.textContent = input.text || input.attachments.map((file) => file.name).join(', '); label.title = label.textContent;
      row.append(label, iconButton('edit', '\u7f16\u8f91', () => { saveDraft(); post({ type: 'queue-edit', id: input.id }); }), iconButton('arrow-up', '\u4e0a\u79fb', () => {
        const ids = queue.map((entry) => entry.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; post({ type: 'queue-reorder', ids });
      }), iconButton('send', '\u7acb\u5373\u53d1\u9001', () => post({ type: 'queue-promote', id: input.id })), iconButton('close', '\u5220\u9664', () => post({ type: 'queue-remove', id: input.id })));
      row.querySelectorAll<HTMLButtonElement>('button')[1].disabled = index === 0;
      row.addEventListener('dragstart', (event) => { event.dataTransfer?.setData('application/x-studio-queue', input.id); });
      row.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('application/x-studio-queue')) { event.preventDefault(); } });
      row.addEventListener('drop', (event) => {
        const id = event.dataTransfer?.getData('application/x-studio-queue'); if (!id || !queue.some((entry) => entry.id === id)) { return; }
        event.preventDefault(); const ids = queue.filter((entry) => entry.id !== id).map((entry) => entry.id); ids.splice(index, 0, id); post({ type: 'queue-reorder', ids });
      });
      container.append(row);
    }
  }

  async function uploadFiles(files: File[]): Promise<void> {
    if (!state || busy() || !files.length || document.querySelector<HTMLElement>('#attach')!.hidden) { return; }
    const sessionId = state.activeId; const projectUri = state.project.uri;
    const allowed = state.project.conversation?.attachments;
    const selected = files.filter((file) => file.type.startsWith('image/') ? allowed?.images : file.type.startsWith('video/') ? allowed?.videos : allowed?.files);
    if (selected.length !== files.length || draftFiles.length + selected.length > 32 || selected.some((file) => file.size > 50 * 1024 * 1024)) { showError('\u9644\u4ef6\u7c7b\u578b\u4e0d\u53d7\u652f\u6301\uff0c\u6216\u8d85\u8fc7\u5355\u6587\u4ef6 50 MiB / 32 \u4e2a\u9644\u4ef6\u9650\u5236\u3002'); return; }
    uploading++; updateControls();
    try {
      const encoded = await Promise.all(selected.map((file) => new Promise<{ name: string; mimeType: string; data: string }>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, mimeType: file.type, data: String(reader.result).split(',', 2)[1] }); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
      })));
      vscode.postMessage({ type: 'upload', projectUri, sessionId, files: encoded });
    } catch (error) { if (state.activeId === sessionId) { uploading = Math.max(0, uploading - 1); showError(String(error)); updateControls(); } }
  }

  function showError(message: string): void { const error = document.querySelector<HTMLElement>('#error')!; error.textContent = message; error.hidden = false; }

  function copy(text: string, button: HTMLButtonElement): void {
    vscode.postMessage({ type: 'copy', text });
    button.innerHTML = icon('check');
    button.title = '\u5df2\u590d\u5236';
    setTimeout(() => { button.innerHTML = icon('copy'); button.title = '\u590d\u5236'; }, 1600);
  }

  function createMessage(message: ConversationMessage): MessageView {
    const root = document.createElement('article');
    root.className = `message ${message.role}`;
    const timestamp = message.createdAt ? new Date(message.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    root.innerHTML = `<div class="message-body"><header class="message-header"><span class="message-metadata"></span><time class="message-date"${!timestamp ? ' hidden' : ''}>${escape(timestamp)}</time></header><div class="attachments" hidden></div><div class="message-content"></div><div class="message-prompt"></div><p class="message-error" hidden></p><div class="message-actions"><button class="icon-button copy-message" title="\u590d\u5236\u6d88\u606f" aria-label="\u590d\u5236\u6d88\u606f">${icon('copy')}</button></div></div>`;
    if (timestamp) { root.querySelector<HTMLTimeElement>('.message-date')!.dateTime = new Date(message.createdAt!).toISOString(); }
    if (message.role === 'user') { root.querySelector('.message-actions')!.prepend(root.querySelector('.message-date')!); }
    const view: MessageView = { root, content: root.querySelector('.message-content')!, metadata: root.querySelector('.message-metadata')!, error: root.querySelector('.message-error')!, message,
      attachments: root.querySelector('.attachments')!, promptRoot: root.querySelector('.message-prompt')!,
    };
    root.querySelector<HTMLButtonElement>('.copy-message')!.addEventListener('click', (event) => copy(view.message.content, event.currentTarget as HTMLButtonElement));
    if (message.role === 'assistant') {
      view.output = new ConversationOutput(view.content, {
        copy, plan: (text) => dialogs.plan(text), file: (id) => post({ type: 'open-file', id }),
        image: (src, title) => dialogs.image(src, title), resource: (card) => post({ type: 'resource', messageId: view.message.id, cardId: card.id }),
      });
      const actions = root.querySelector('.message-actions')!;
      actions.prepend(iconButton('type-hierarchy', '\u8fd0\u884c\u8ddf\u8e2a', () => post({ type: 'trace', messageId: view.message.id })), iconButton('output', '\u8fd0\u884c\u65e5\u5fd7', () => post({ type: 'logs', messageId: view.message.id })));
      const exportButton = iconButton('export', '\u5bfc\u51fa\u8fd0\u884c\u8bb0\u5f55', () => { exportButton.disabled = true; exportButton.innerHTML = icon('loading'); post({ type: 'export-message', messageId: view.message.id }); });
      exportButton.classList.add('export-message'); actions.append(iconButton('refresh', '\u91cd\u8bd5', () => post({ type: 'retry', messageId: view.message.id })), exportButton);
    }
    return view;
  }

  function updateMessageMetadata(view: MessageView): void {
    const message = view.message;
    const status = message.pendingInput ? '\u7b49\u5f85\u786e\u8ba4' : message.status === 'running' ? activeAgentActivity(message)?.label ?? '\u56de\u590d\u4e2d' : message.status === 'aborted' ? '\u5df2\u505c\u6b62' : message.status === 'failed' ? '\u5931\u8d25' : '';
    const seconds = Math.round((message.status === 'running' ? Date.now() - (message.createdAt ?? Date.now()) : message.durationMs ?? 0) / 1000);
    const duration = message.durationMs !== undefined || message.status === 'running' ? `\u7528\u65f6 ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ''}${seconds % 60}s` : '';
    const usage = message.tokenUsage?.display ? message.tokenUsage.run : undefined;
    const tokens = usage && (usage.totalTokens ?? (Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)));
    view.metadata.textContent = [status, duration, message.model, tokens ? `${tokens} tokens` : ''].filter(Boolean).join(' \u00b7 ');
    view.metadata.title = view.metadata.textContent;
  }

  function updateMessage(view: MessageView, message: ConversationMessage): void {
    view.message = message;
    view.root.classList.toggle('streaming', message.status === 'running');
    updateMessageMetadata(view);
    if (message.role === 'user') { view.content.textContent = message.content; }
    else { view.output!.update(message, state!.project.id, state!.activeId, (currentSession()?.messages ?? []).flatMap((entry) => [...(entry.files ?? []), ...(entry.attachments ?? [])])); }
    view.error.textContent = message.error ?? '';
    view.error.hidden = !message.error;
    view.root.querySelector<HTMLButtonElement>('.copy-message')!.disabled = !message.content;
    if (message.role === 'assistant') { const retry = view.root.querySelectorAll<HTMLButtonElement>('.message-actions button')[3]; retry.disabled = !!state?.running || !!message.pendingInput; }
    const signature = JSON.stringify(message.attachments);
    if (signature !== view.extrasSignature) {
      view.extrasSignature = signature; attachmentList(view.attachments, message.attachments ?? [], false);
    }
    if (message.pendingInput && view.prompt?.request.requestId !== message.pendingInput.requestId) {
      view.prompt?.root.remove(); view.prompt = new InputPrompt(message.pendingInput, {
        submit: (values) => post({ type: 'resume', messageId: message.id, requestId: message.pendingInput!.requestId, values }),
        stop: () => post({ type: 'stop' }),
        files: (name) => post({ type: 'attach', messageId: message.id, requestId: message.pendingInput!.requestId, paramName: name }),
      }); view.promptRoot.append(view.prompt.root);
      if (message.status === 'running') { view.prompt.setBusy(true); }
    } else if (!message.pendingInput) { view.prompt?.root.remove(); view.prompt = undefined; }
    else { view.prompt?.setBusy(message.status === 'running' || !!message.submittingInput, message.error ?? ''); }
  }

  function updateLatest(): void { latest.hidden = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100; }
  setInterval(() => { for (const view of messages.values()) { view.output?.tick(); if (view.message.status === 'running') { updateMessageMetadata(view); } } }, 200);

  function render(next: State): void {
    const previous = state;
    state = next;
    const session = next.sessions.find((entry) => entry.id === next.activeId);
    if (!session) { return; }
    const conversation = next.project.projectType === 'conversation';
    const projectChanged = renderedProject !== next.project.uri;
    app.dataset.projectUri = next.project.uri;
    const folder = document.querySelector<HTMLElement>('#assistant-folder')!;
    folder.hidden = !next.project.assistant;
    folder.textContent = next.project.assistant?.roots.find((root) => root.folderPath === next.project.assistant?.workdir)?.name ?? '';
    folder.title = next.project.assistant?.workdir ?? '';
    const switching = projectChanged || renderedSession !== next.activeId;
    const authenticationChanged = previous && (previous.authenticationRevision !== next.authenticationRevision || previous.parameterRevision !== next.parameterRevision);
    if (authenticationChanged) {
      ++requestId;
      resolving = false;
      paramStates = {};
      formKey = '';
    }
    document.querySelector('#project-name')!.textContent = next.project.name;
    document.querySelector<HTMLElement>('#project-name')!.hidden = !session.messages.length;
    document.querySelector('#conversation-title')!.textContent = session.messages.length ? session.title : next.project.name;
    document.querySelector<HTMLElement>('#project-icon')!.hidden = !!session.messages.length;
    if (projectChanged) {
      historyLimit = historyPageSize;
      entrypoint.replaceChildren(...next.project.entrypoints.map((entry) => new Option(entry.title || entry.id, entry.id)));
      entrypoint.value = next.project.defaultEntrypoint || next.project.entrypoints[0]?.id || '';
      entrypoint.hidden = conversation || next.project.entrypoints.length === 0;
      textarea.placeholder = conversation ? '\u968f\u5fc3\u8f93\u5165' : '["--name", "Studio"]';
      renderedProject = next.project.uri;
    }
    if (switching) {
      closeSessionMenu();
      ++requestId;
      resolving = submitting = false;
      clearTimeout(inputTimer);
      clearTimeout(draftTimer); uploading = 0; dialogs.close(); contentSearch.close();
      textarea.value = session.draft?.text ?? drafts[`${next.project.uri}:${next.activeId}`] ?? '';
      draftFiles = session.draft?.attachments ?? [];
      editingQueueId = session.draft?.editingQueueId;
      renderedSession = next.activeId;
      messages.clear();
      transcript.replaceChildren();
      document.querySelector<HTMLElement>('#error')!.hidden = true;
      sizeComposer();
    }
    const editingChanged = editingQueueId !== session.draft?.editingQueueId;
    if (editingChanged) {
      editingQueueId = session.draft?.editingQueueId;
      textarea.value = session.draft?.text ?? ''; draftFiles = session.draft?.attachments ?? [];
      const queued = session.queuedInputs?.find((input) => input.id === editingQueueId);
      if (queued?.entrypointId) { entrypoint.value = queued.entrypointId; }
      sizeComposer();
    }
    renderHistory(switching); updateSessionMenu(); renderQueue();
    document.querySelector<HTMLElement>('#editing-queue')!.hidden = !editingQueueId;
    attachmentList(document.querySelector('#draft-attachments')!, draftFiles, true);
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
    if (!session.messages.length) {
      if (!transcript.querySelector('.empty')) { transcript.innerHTML = `<div class="empty">${icon(conversation ? 'comment-discussion' : 'run-all')}</div>`; }
    } else {
      transcript.querySelector('.empty')?.remove();
      const active = new Set<string>();
      session.messages.forEach((message, index) => {
        const id = message.id || `${index}:${message.role}`;
        active.add(id);
        let view = messages.get(id);
        if (!view) { view = createMessage(message); messages.set(id, view); transcript.append(view.root); }
        updateMessage(view, message);
      });
      for (const [id, view] of messages) { if (!active.has(id)) { view.root.remove(); messages.delete(id); } }
    }
    if (atBottom || switching) { transcript.scrollTop = transcript.scrollHeight; }
    updateLatest();
    contentSearch.refresh();
    if (switching || authenticationChanged || editingChanged) { renderParameters(); }
    else if (JSON.stringify(previous?.parameterValues) !== JSON.stringify(next.parameterValues)) { Object.assign(values(), next.parameterValues?.[entrypoint.value]); updateFields(); }
    else if (paramsNeedInit && !busy()) { requestParams({ kind: 'init' }); }
    updateControls();
    if (switching && !next.running) { textarea.focus(); }
  }

  function focusParameter(name: string): void {
    const field = fields.get(name);
    if (!parameterActions.openForField(name)) {
      field?.root.scrollIntoView({ block: 'nearest' });
      field?.controls[0]?.focus();
    }
  }

  function send(): void {
    if (!state) { return; }
    const hasInput = !!textarea.value.trim() || draftFiles.length > 0;
    if (state.running && (!canQueue() || !hasInput)) { post({ type: 'stop' }); return; }
    if (busy() || resolving || uploading || state.project.projectType === 'conversation' && !hasInput) { return; }
    for (const [name, view] of fields) {
      if (view.root.hidden || paramStates[name]?.disabled) { continue; }
      const value = values()[name];
      const missing = view.field.required && (!value || Array.isArray(value) && value.length === 0);
      const invalid = view.controls.some((control) => !control.checkValidity());
      if (missing || invalid) {
        focusParameter(name);
        if (invalid) { view.controls.find((control) => !control.checkValidity())?.reportValidity(); }
        else { const error = document.querySelector<HTMLElement>('#error')!; error.textContent = `\u8bf7\u586b\u5199 ${view.field.label || name}\u3002`; error.hidden = false; }
        return;
      }
    }
    document.querySelector<HTMLElement>('#error')!.hidden = true;
    submitting = true;
    updateControls();
    clearTimeout(draftTimer); post({ type: 'send', text: textarea.value, params: values(), entrypointId: entrypoint.value, attachments: draftFiles });
  }

  textarea.addEventListener('input', () => {
    if (!state) { return; }
    drafts[`${state.project.uri}:${state.activeId}`] = textarea.value;
    persist();
    clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 300);
    sizeComposer();
    updateControls();
    if (currentParameters().fields.some((field) => field.resolveOnInput)) {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => requestParams({ kind: 'input' }), 350);
    }
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && state?.project.projectType === 'conversation') { event.preventDefault(); send(); }
  });
  sendButton.addEventListener('click', send);
  document.querySelector('#new')!.addEventListener('click', () => { saveDraft(); post({ type: 'new', text: textarea.value, attachments: draftFiles }); });
  document.querySelector('#attach')!.addEventListener('click', () => post({ type: 'attach' }));
  document.querySelector('#cancel-queue-edit')!.addEventListener('click', () => post({ type: 'queue-cancel-edit' }));
  document.querySelector('#tools')!.addEventListener('click', () => dialogs.permissions(currentParameters(), currentSession()?.toolPermissionPolicies ?? {}, (policies) => post({ type: 'tool-policy', entrypointId: entrypoint.value, policies })));
  document.querySelector('#usage')!.addEventListener('click', () => dialogs.usage(() => post({ type: 'usage' })));
  document.querySelector('#parameter-login')!.addEventListener('click', () => vscode.postMessage({ type: 'login' }));
  document.querySelector('#menu-toggle')!.addEventListener('click', () => showMenu(true));
  document.querySelector('#hide-menu')!.addEventListener('click', () => showMenu(false));
  for (const selector of ['#history-toggle', '#all-history']) {
    document.querySelector<HTMLButtonElement>(selector)!.addEventListener('click', (event) => { historyTrigger = event.currentTarget as HTMLButtonElement; });
  }
  historyPopover.addEventListener('beforetoggle', (event) => {
    closeSessionMenu();
    if ((event as ToggleEvent).newState === 'open') { allHistoryQuery = allHistorySearch.value = ''; renderAllHistory(); }
  });
  historyPopover.addEventListener('toggle', () => {
    const open = historyPopover.matches(':popover-open');
    for (const selector of ['#history-toggle', '#all-history']) { document.querySelector(selector)!.setAttribute('aria-expanded', String(open)); }
    if (open) { positionHistory(); allHistorySearch.focus(); }
  });
  document.querySelector('#close-history')!.addEventListener('click', () => closeHistory(true));
  allHistorySearch.addEventListener('input', () => { allHistoryQuery = allHistorySearch.value.trim().toLocaleLowerCase(); renderAllHistory(); });
  moreHistory.addEventListener('click', loadMoreHistory);
  chats.addEventListener('scroll', loadMoreIfNeeded, { passive: true });
  for (const button of sessionActions) {
    button.addEventListener('click', () => {
      const id = sessionMenuId;
      closeSessionMenu(true);
      if (id) { post({ type: 'session-action', id, action: button.dataset.action }); }
    });
  }
  document.addEventListener('pointerdown', (event) => { if (!sessionMenu.contains(event.target as Node)) { closeSessionMenu(); } });
  document.addEventListener('focusin', (event) => { if (!sessionMenu.contains(event.target as Node)) { closeSessionMenu(); } });
  window.addEventListener('blur', () => closeSessionMenu());
  window.addEventListener('scroll', (event) => {
    if (sessionMenuTrigger && event.target instanceof Node && event.target.contains(sessionMenuTrigger)) { closeSessionMenu(); }
  }, true);
  document.querySelector('#refresh-params')!.addEventListener('click', () => requestParams({ kind: 'init' }));
  entrypoint.addEventListener('change', () => { ++requestId; resolving = false; renderParameters(); });
  transcript.addEventListener('scroll', updateLatest, { passive: true });
  latest.addEventListener('click', () => { transcript.scrollTop = transcript.scrollHeight; updateLatest(); });
  window.addEventListener('resize', () => { closeSessionMenu(); sizeComposer(); updateLatest(); positionHistory(); });
  document.addEventListener('keydown', (event) => {
    if (sessionMenu.matches(':popover-open')) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSessionMenu(true); }
      else if (event.key === 'Tab') { closeSessionMenu(true); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = sessionActions.indexOf(document.activeElement as HTMLButtonElement);
        focusSessionAction(event.key === 'Home' ? 0 : event.key === 'End' ? sessionActions.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + sessionActions.length) % sessionActions.length);
      }
      return;
    }
    if (historyPopover.matches(':popover-open')) {
      if (event.key === 'Escape') { event.preventDefault(); closeHistory(true); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); allHistorySearch.focus(); }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !dialogs.open) { event.preventDefault(); contentSearch.open(); }
    if (event.key === 'Escape') { contentSearch.close(); if (panelOpen && narrow.matches && !dialogs.open) { showMenu(false); } }
  });
  textarea.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? []); if (files.length) { event.preventDefault(); void uploadFiles(files); }
  });
  document.querySelector('main')!.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files') && !document.querySelector<HTMLElement>('#attach')!.hidden) { event.preventDefault(); } });
  document.querySelector('main')!.addEventListener('drop', (event) => { const files = Array.from(event.dataTransfer?.files ?? []); if (files.length) { event.preventDefault(); void uploadFiles(files); } });
  let pendingState: State | undefined;
  let renderScheduled = false;
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'assistant-command') {
      document.querySelector<HTMLButtonElement>(message.command === 'new' ? '#new' : '#history-toggle')!.click();
      return;
    }
    if (message.type === 'state') {
      pendingState = message;
      if (!renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => { renderScheduled = false; if (pendingState) { render(pendingState); pendingState = undefined; } });
      }
    } else if (message.type === 'params' && state && message.projectUri === state.project.uri && message.sessionId === state.activeId && message.requestId === requestId) {
      resolving = false;
      if (message.error) {
        authenticationRequired = /SteamHarness Server login is not configured|Unauthorized/.test(String(message.error));
        paramError.textContent = String(message.error).includes('SteamHarness Server login is not configured') ? '\u8bf7\u5148\u767b\u5f55 SteamHarness Server\uff0c\u7136\u540e\u5237\u65b0\u53c2\u6570\u3002'
          : String(message.error).includes('Unauthorized') ? '\u767b\u5f55\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55 SteamHarness Server\u3002' : message.error;
        paramError.hidden = false;
      } else {
        authenticationRequired = false;
        for (const [name, patch] of Object.entries(message.params ?? {}) as [string, ParamState][]) {
          if (!fields.has(name)) { continue; }
          paramStates[name] = { ...paramStates[name], ...patch, options: { ...paramStates[name]?.options, ...patch.options } };
          if (patch.value === null) { values()[name] = workflowParamValue(fields.get(name)!.field); }
          else if (patch.value !== undefined) { values()[name] = workflowParamValue(fields.get(name)!.field, patch.value); }
        }
        updateFields();
        persist();
      }
      updateControls();
    } else if (message.type === 'attachments' && state && message.projectUri === state.project.uri && message.sessionId === state.activeId) {
      uploading = Math.max(0, uploading - 1);
      if (message.messageId) {
        const prompt = messages.get(message.messageId)?.prompt;
        if (prompt && prompt.request.requestId === message.requestId) {
          const field = prompt.request.params.find((field) => field.name === message.paramName);
          if (field) { prompt.fileValue(field.name, JSON.stringify((field.multiple ? message.files : message.files.slice(0, 1)).map(({ previewUrl: _, ...file }: Attachment) => file))); }
        }
      } else if (message.paramName && fields.has(message.paramName)) {
        const field = fields.get(message.paramName)!.field;
        const files = field.multiple ? message.files : message.files.slice(0, 1);
        setFieldValue(message.paramName, JSON.stringify(files.map(({ previewUrl: _, ...file }: Attachment) => file)));
      } else {
        const allowed = state.project.conversation?.attachments;
        const accepted = (message.files as Attachment[]).filter((file) => file.kind === 'image' ? allowed?.images : file.mimeType.startsWith('video/') ? allowed?.videos : allowed?.files);
        if (accepted.length !== message.files.length) { showError('\u9879\u76ee\u4e0d\u652f\u6301\u6b64\u7c7b\u9644\u4ef6\u3002'); }
        draftFiles = [...new Map([...draftFiles, ...accepted].map((file) => [file.id, file])).values()].slice(0, 32); attachmentList(document.querySelector('#draft-attachments')!, draftFiles, true); saveDraft();
      }
      updateControls();
    } else if (message.type === 'sent' && state && message.sessionId === state.activeId) {
      submitting = false; textarea.value = ''; draftFiles = []; editingQueueId = undefined; drafts[`${state.project.uri}:${state.activeId}`] = ''; sizeComposer(); persist();
      attachmentList(document.querySelector('#draft-attachments')!, draftFiles, true); updateControls(); textarea.focus();
    } else if (message.type === 'usage' && message.sessionId === state?.activeId) { dialogs.usageResult(message.usage); }
    else if (message.type === 'exported' && message.sessionId === state?.activeId) {
      const button = messages.get(message.messageId)?.root.querySelector<HTMLButtonElement>('.export-message'); if (button) { button.disabled = false; button.innerHTML = icon('export'); }
    } else if (message.type === 'error' && (!message.sessionId || message.sessionId === state?.activeId)) {
      if (message.requestType === 'resume' && messages.get(message.messageId)?.prompt?.request.requestId !== message.requestId) { return; }
      submitting = false;
      uploading = Math.max(0, uploading - 1);
      if (message.requestType === 'usage') { dialogs.usageResult(undefined, message.message); }
      if (message.requestType === 'resume') { messages.get(message.messageId)?.prompt?.setBusy(false, message.message); }
      updateControls();
      showError(message.message);
    }
  });
  vscode.postMessage({ type: 'ready' });
}

initialize();
