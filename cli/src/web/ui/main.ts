import { mountProjectConfigurations, projectConfigurationsButton } from './project-configurations';
import { t, locale } from '../localization';
import type { AccountState } from '../workflow-auth-client';
import { ParameterActions } from './parameter-actions';
import { ConversationComposer } from './conversation-composer';
import { ConversationSubmissions, type ConversationSubmission } from './conversation-submissions';
import { ConversationQueue } from './conversation-queue';
import { ConversationMessageIndex, type IndexedUserMessage } from './conversation-message-index';
import { InputPrompt } from './input-prompt';
import { ConversationTools } from './conversation-tools';
import { requestAction } from './action-dialog';
import { ContentSearch } from './content-search';
import { ConversationOutput } from './conversation-output';
import { attachmentSignature } from './attachment-state';
import { activeAgentActivity } from './agent-activity';
import { ComposerOutput, composerOutputItems } from './output-display';
import type { ConnectionState } from './connection';
import { StateRevisions } from './state-revisions';
import { iconHtml as icon, escapeHtml as escape, iconButton, updateIcon } from './ui';
import { conversationHistoryStatus, updateHistoryStatus, updateConversationRunningCount } from './history-status';
import { aiUsageButton, narrowMenuDismiss, projectInfoButton, toolPermissionsButton } from './toolbar';
import { updateProjectAvatar, updateUserAvatar } from './avatar';
import './style.css';
import {
  projectParameters,
  projectParamValue,
  mergeProjectParamStates,
  messageSettled,
  sessionRunning,
  conversationModelName,
  type ConversationMessage, type ConversationSession, type ConversationDraftUpdate, type Project, type Field,
  type ParamValues, type ParamValue, type ParamState, type ParamRequest,
  type Attachment,
} from '../workflow-types';

import { acquireProjectHost } from './host';

function initialize(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  if (app.dataset.initialized === 'true') { return; }
  const vscode = acquireProjectHost({ connectionBanner: false });
  const viewQuery = new URLSearchParams(location.search);
  const conversationView = viewQuery.has('projectView');
  let initialConversation = conversationView ? viewQuery.get('conversationId') : undefined;
  const createInitialConversation = viewQuery.get('createConversation') === '1';
  app.dataset.initialized = 'true';
  app.innerHTML = `
    <header class="toolbar">
      <div class="project-title"><button id="menu-toggle" class="icon-button" title="${t("Show conversations")}" aria-label="${t("Show conversations")}" aria-controls="project-menu">${icon('layout-sidebar-left')}</button><div class="project-heading"><h1 id="conversation-title">Workflow</h1><span id="assistant-folder" hidden></span></div><span id="project-name" class="project-name"></span></div>
      <div class="toolbar-actions"><span id="running-count" class="running-count" hidden></span><button id="new" class="icon-button" title="${t("New conversation")}" aria-label="${t("New conversation")}">${icon('comment-add')}</button>${projectConfigurationsButton()}${aiUsageButton()}${toolPermissionsButton()}${projectInfoButton()}</div>
    </header>
    <aside id="project-menu" class="project-menu" aria-label="${t("Conversations")}">
      <div class="menu-heading"><span id="menu-label">${t("Conversations")}</span><div class="menu-actions"><button id="history-toggle" class="icon-button" title="${t("Search conversations")}" aria-label="${t("Search conversations")}" aria-haspopup="dialog" aria-controls="history-popover" aria-expanded="false" popovertarget="history-popover">${icon('search')}</button><button id="hide-menu" class="icon-button" title="${t("Hide conversations")}" aria-label="${t("Hide conversations")}">${icon('chevron-left')}</button></div></div>
      <section id="chats"><nav id="session-list" aria-label="${t("Conversation history")}"></nav><button id="load-more-history" class="all-history" hidden>${icon('chevron-down')}<span>${t("Load more")}</span></button><button id="all-history" class="all-history" aria-haspopup="dialog" aria-controls="history-popover" aria-expanded="false" popovertarget="history-popover" hidden></button><div id="no-history" class="no-history" hidden>${t("No conversations")}</div></section>
    </aside>
    <main><div class="transcript-area"><div id="transcript" class="transcript" role="log" aria-label="${t("Conversation messages")}" aria-live="polite" aria-relevant="additions"><div id="transcript-content" class="transcript-content"></div></div><button id="latest" class="icon-button latest-button" title="${t("Go to latest message")}" aria-label="${t("Go to latest message")}" hidden>${icon('arrow-down')}</button></div>
      <footer class="composer-area"><div id="error" class="error" role="alert" hidden></div><div id="input-queue" class="input-queue" hidden></div><div id="editing-queue" class="editing-queue" hidden><span>${t("Edit queued message")}</span><button id="cancel-queue-edit" class="icon-button" title="${t("Cancel editing")}" aria-label="${t("Cancel editing")}">${icon('close')}</button></div><section id="parameters" aria-label="${t("Run parameters")}"><div class="parameter-feedback"><div id="parameter-status" class="parameter-status" role="status" hidden>${icon('loading')}<span>${t("Loading parameters...")}</span></div><div id="parameter-error" class="parameter-error" role="alert" hidden></div><button id="parameter-login" class="parameter-login" hidden>${icon('sign-in')}<span>${t("Sign in to SteamHarness")}</span></button></div><div id="slash-menu" class="slash-menu" hidden></div><div class="composer"><div class="composer-body"><div id="main-fields" class="composer-main-fields" hidden></div><div id="draft-attachments" class="attachments" hidden></div><textarea id="message" rows="2" placeholder="${t("Send a message...")}" aria-label="${t("Message")}"></textarea></div><div class="composer-toolbar"><div class="run-options"><button id="attach" class="icon-button" title="${t("Add attachment")}" aria-label="${t("Add attachment")}" hidden>${icon('attach')}</button><select id="entrypoint" aria-label="${t("Entrypoints")}" hidden></select><div id="parameter-actions" class="parameter-actions" role="group" aria-label="${t("Run parameters")}"></div><button id="refresh-params" class="icon-button" title="${t("Refresh parameters")}" aria-label="${t("Refresh parameters")}" hidden>${icon('refresh')}</button></div><div class="composer-actions"><button id="send" class="send-button" title="${t("Send")}" aria-label="${t("Send")}">${icon('arrow-up')}</button></div></div></div><div id="composer-footer" class="composer-footer" role="status" hidden></div></section></footer>
    </main>
    <div id="history-popover" class="history-popover" popover="auto" role="dialog" aria-label="${t("All conversations")}"><div class="history-popover-toolbar"><label class="history-search">${icon('search')}<input id="search-all-history" type="search" placeholder="${t("Search conversations")}" aria-label="${t("Search all conversations")}"></label><button id="close-history" class="icon-button" title="${t("Close conversation history")}" aria-label="${t("Close conversation history")}">${icon('close')}</button></div><nav id="all-session-list" aria-label="${t("All chats")}"></nav><div id="history-empty" class="no-history" hidden>${t("No matching conversations")}</div></div>
    <div id="session-menu" class="session-menu" popover="manual" role="menu" aria-label="${t("Conversation actions")}">
      <button class="session-action" data-action="rename" role="menuitem" tabindex="-1">${icon('edit')}<span>${t("Rename")}</span></button>
      <button class="session-action" data-action="lock" role="menuitem" tabindex="-1">${icon('lock')}<span>${t("Lock title")}</span></button>
      <button class="session-action" data-action="export" role="menuitem" tabindex="-1">${icon('export')}<span>${t("Export conversation")}</span></button>
      <div class="session-menu-separator" role="separator"></div>
      <button class="session-action" data-action="delete" role="menuitem" tabindex="-1">${icon('trash')}<span>${t("Delete conversation")}</span></button>
    </div>`;

  const configurationPanel = mountProjectConfigurations(vscode);

  interface State { project: Project; sessions: ConversationSession[]; activeId: string; running: boolean; conversationAccess?: { readOnly: boolean }; parameterValues?: Record<string, ParamValues>; account?: AccountState; authenticationRevision?: number; parameterRevision?: number; serverInstanceId?: string }
  interface FieldView {
    field: Field; root: HTMLDivElement;
    controls: (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    description: HTMLDivElement; optionsSignature?: string;
  }
  interface MessageView {
    root: HTMLElement; content: HTMLDivElement; metadata: HTMLSpanElement; error: HTMLParagraphElement;
    avatar: HTMLButtonElement;
    message: ConversationMessage; output?: ConversationOutput;
    attachments: HTMLDivElement; promptRoot: HTMLDivElement; prompt?: InputPrompt;
    extrasSignature?: string;
    connection?: HTMLDivElement;
    configureModel?: HTMLButtonElement;
  }
  interface SavedNavigation { projectUri: string; activeId: string; updates: ConversationDraftUpdate[] }
  interface NavigationRequest { requestId: number; activeId: string; updates: ConversationDraftUpdate[]; refreshParameters: boolean }

  let state: State | undefined;
  let renderedProject = '';
  let renderedSession = '';
  let renderedParameterDefinition = '';
  let formKey = '';
  let paramStates: Record<string, ParamState> = {};
  let resolving = false;
  let parametersReady = false;
  let parameterOptionsStale = false;
  let parameterRequest: { id: number; signature: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const parameterCache = new Map<string, { signature: string; states: Record<string, ParamState> }>();
  let connectionAvailable = true;
  let connectionStatus: ConnectionState = 'connected';
  let manualReconnect = false;
  let reconnectFailed = false;
  interface StopRequest { projectUri: string; sessionId: string; requestId: string; runId?: string; agentOwner?: string; taskIds?: number[]; phase: 'pending' | 'accepted' | 'failed'; error?: string; timer?: ReturnType<typeof setTimeout> }
  const stopRequests = new Map<string, StopRequest>();
  window.addEventListener('pagehide', () => { for (const request of stopRequests.values()) { clearTimeout(request.timer); } stopRequests.clear(); });
  let preferredSessionId: string | undefined;
  let serverSessionId: string | undefined;
  let navigationNeeded = false;
  let navigationSequence = 0;
  let navigationRequest: NavigationRequest | undefined;
  const localSessions = new Map<string, ConversationSession>();
  const draftUpdates = new Map<string, ConversationDraftUpdate>();
  let submitting = false;
  let retryingMessage: string | undefined;
  let requestId = 0;
  let paramsNeedInit = false;
  let pendingParameterTrigger: ParamRequest['trigger'] | undefined;
  let authenticationRequired = false;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;
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
  const composerArea = document.querySelector<HTMLElement>('.composer-area')!;
  const transcript = document.querySelector<HTMLDivElement>('#transcript')!;
  const transcriptContent = document.querySelector<HTMLDivElement>('#transcript-content')!;
  const sendButton = document.querySelector<HTMLButtonElement>('#send')!;
  const composerOutput = new ComposerOutput();
  sendButton.before(composerOutput.root);
  const entrypoint = document.querySelector<HTMLSelectElement>('#entrypoint')!;
  const latest = document.querySelector<HTMLButtonElement>('#latest')!;
  let followingLatest = true;
  let transcriptScrollTop = transcript.scrollTop;
  let transcriptScrollHeight = transcript.scrollHeight;
  let transcriptViewportHeight = transcript.clientHeight;
  let transcriptScrollbarActive = false;
  let transcriptTouchY: number | undefined;
  let transcriptLayoutFrame: number | undefined;
  const messageIndex = new ConversationMessageIndex(transcript, target => {
    followingLatest = false;
    transcript.scrollTop += target.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 18;
    transcriptScrollTop = transcript.scrollTop;
    syncTranscriptLayout();
  });
  const transcriptResize = new ResizeObserver(syncTranscriptLayout);
  transcriptResize.observe(transcript);
  transcriptResize.observe(transcriptContent);
  const paramError = document.querySelector<HTMLDivElement>('#parameter-error')!;
  const chats = document.querySelector<HTMLElement>('#chats')!;
  const moreHistory = document.querySelector<HTMLButtonElement>('#load-more-history')!;
  const allHistorySearch = document.querySelector<HTMLInputElement>('#search-all-history')!;
  const historyPopover = document.querySelector<HTMLDivElement>('#history-popover')!;
  const sessionMenu = document.querySelector<HTMLDivElement>('#session-menu')!;
  const sessionActions = Array.from(sessionMenu.querySelectorAll<HTMLButtonElement>('.session-action'));
  const fields = new Map<string, FieldView>();
  const messages = new Map<string, MessageView>();
  const saved = (vscode.getState() ?? {}) as { drafts?: Record<string, string>; params?: Record<string, ParamValues>; parameterEdits?: Record<string, Record<string, string | null>>; panelOpen?: boolean; projectUri?: string; navigation?: SavedNavigation; submissions?: ConversationSubmission[] };
  const drafts = saved.drafts ?? {};
  const paramValues = saved.params ?? {};
  const submissions = new ConversationSubmissions(saved.submissions, t('Message delivery was not confirmed. Retry to check or send it again.'));
  const parameterEdits = saved.parameterEdits ?? {};
  const editedParams = (): Record<string, string | null> => parameterEdits[formKey] ??= {};
  const markParameterEdited = (name: string): void => { editedParams()[name] = currentSession()?.parameterRevisions?.[entrypoint.value]?.[name] ?? null; };
  const narrow = window.matchMedia('(max-width: 680px)');
  let panelOpen = saved.panelOpen ?? document.body.dataset.surface !== 'assistant';
  const persist = (): void => { vscode.setState({ drafts, params: paramValues, parameterEdits, panelOpen, submissions: submissions.list(), projectUri: state?.project.uri ?? saved.projectUri,
    navigation: state ? (conversationView || navigationNeeded || draftUpdates.size) ? { projectUri: state.project.uri, activeId: preferredSessionId ?? state.activeId, updates: [...draftUpdates.values()] } : undefined : saved.navigation }); };
  const post = (message: Record<string, unknown>): void => { if (state) { vscode.postMessage({ projectUri: state.project.uri, sessionId: state.activeId, ...message }); } };
  const currentSession = () => state?.sessions.find((session) => session.id === state?.activeId);
  const readOnly = () => state?.conversationAccess?.readOnly === true;
  const accessNotice = document.createElement('div');
  accessNotice.className = 'conversation-access'; accessNotice.setAttribute('role', 'status'); accessNotice.hidden = true;
  accessNotice.textContent = t('This conversation is open or running in another window. You can read it here or start a new conversation.');
  document.querySelector('main')!.prepend(accessNotice);
  const queueView = new ConversationQueue(document.querySelector<HTMLElement>('#input-queue')!, {
    action: action => { void vscode.postMessage(action); },
    edit: id => { saveDraft(); post({ type: 'queue-edit', id }); },
    reorder: ids => post({ type: 'queue-reorder', ids }),
    resume: () => post({ type: 'queue-run' }),
  });
  const dialogs = new ConversationTools();
  const contentSearch = new ContentSearch(transcript);
  const currentParameters = () => projectParameters(state!.project, entrypoint.value || undefined);
  const values = (): ParamValues => paramValues[formKey] ??= {};
  const parametersLoading = (): boolean => resolving && !parametersReady;
  const canQueue = (): boolean => state?.project.conversation?.inputQueue?.enabled === true && (!state.project.conversation.durable?.enabled || values().plan !== 'true');
  const hideComposer = (): boolean => state?.project.projectType === 'conversation' && state.project.conversation?.userInput?.hideComposer !== false
    && !!currentSession()?.messages.some(message => message.pendingInput);
  const pendingSend = (): boolean => !!state && submissions.busy(state.project.uri, state.activeId);
  const busy = (): boolean => readOnly() || submitting || pendingSend() || hideComposer() || (!!state?.running || !!currentSession()?.messages.some((message) => message.pendingInput)) && !canQueue();
  const navigationReady = (): boolean => !!state && !navigationNeeded && !navigationRequest && !localSessions.has(state.activeId) && state.activeId === serverSessionId;
  const emptyConnection = connectionFeedback();
  transcript.append(emptyConnection);
  const stopFeedback = document.createElement('div'); stopFeedback.id = 'stop-feedback'; stopFeedback.hidden = true;
  document.querySelector('.composer-area')!.prepend(stopFeedback);
  const parameterActions = new ParameterActions(document.querySelector('#parameter-actions')!, {
    current: () => ({ values: values(), states: paramStates, disabled: busy(), loading: parametersLoading(), modelConfigurationRequired: configurationPanel.needsAgentModels() }),
    fieldRoot: (name) => fields.get(name)!.root,
    onChange: (name, value) => setFieldValue(name, value),
    onConfigureModel: () => configurationPanel.openAgentModels(),
    onReset: (names) => {
      for (const name of names) {
        const field = fields.get(name)!.field;
        markParameterEdited(name);
        values()[name] = projectParamValue(field);
      }
      persist(); updateFields(); requestParams({ kind: 'param', paramName: names[0] });
    },
  });
  const conversationComposer = new ConversationComposer(textarea, document.querySelector('#slash-menu')!, document.querySelector('#composer-footer')!, {
    current: () => state ? { scope: formKey, enabled: state.project.projectType === 'conversation', parameters: currentParameters(),
      values: values(), states: paramStates, footer: state.project.conversation?.footer, commands: state.project.conversation?.commands,
      commandDisabled: !connectionAvailable || !navigationReady() || submitting || pendingSend() || uploading > 0 || !!editingQueueId || state.running || !!currentSession()?.messages.some(message => message.pendingInput),
      disabled: busy(), loading: parametersLoading() } : undefined,
    onChange: (name, value) => setFieldValue(name, value),
    onCommand: (command) => {
      if (!state || !connectionAvailable || !navigationReady() || busy() || parametersLoading() || uploading || editingQueueId || state.running || currentSession()?.messages.some(message => message.pendingInput)) { return false; }
      clearTimeout(draftTimer); saveDraft(); submitting = true;
      post({ type: 'command', command, params: values() }); updateControls(); return true;
    },
  });

  function showMenu(open: boolean): void {
    closeSessionMenu();
    panelOpen = open;
    app.classList.toggle('menu-open', open);
    const toggle = document.querySelector<HTMLButtonElement>('#menu-toggle')!;
    toggle.hidden = open;
    toggle.setAttribute('aria-expanded', String(open));
    document.querySelector('#menu-label')!.textContent = narrow.matches ? t("Chat") : t("Conversations");
    closeHistory();
    renderHistory(true);
    persist();
  }
  const dismissNarrowMenu = narrowMenuDismiss(narrow, () => panelOpen && !dialogs.open, () => showMenu(false));
  showMenu(panelOpen);
  narrow.addEventListener('change', () => showMenu(panelOpen));

  function sizeComposer(): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(240, Math.max(72, textarea.scrollHeight))}px`;
  }

  function parameterSignature(): string {
    const parameters = currentParameters();
    return JSON.stringify([formKey, state?.serverInstanceId, state?.authenticationRevision, state?.parameterRevision,
      parameters, parameters.fields.map(field => [field.name, values()[field.name]]),
      parameters.fields.some(field => field.resolveOnInput) ? textarea.value : undefined]);
  }

  function cancelParameterRequest(): void {
    ++requestId;
    clearTimeout(inputTimer); inputTimer = undefined;
    clearTimeout(parameterRequest?.timer); parameterRequest = undefined;
    resolving = false;
  }
  window.addEventListener('pagehide', cancelParameterRequest);

  function scheduleParams(trigger: ParamRequest['trigger'], delay: number): void {
    clearTimeout(inputTimer);
    pendingParameterTrigger = trigger;
    inputTimer = setTimeout(() => { inputTimer = undefined; requestParams(trigger); }, delay);
  }

  function requestParams(trigger: ParamRequest['trigger'], force = false): void {
    clearTimeout(inputTimer); inputTimer = undefined;
    if (!state || !fields.size || !currentParameters().paramResolver?.enabled) { paramsNeedInit = false; return; }
    if (!connectionAvailable || busy() || state.running || composing || !navigationReady()) { paramsNeedInit = true; pendingParameterTrigger = trigger; return; }
    const signature = parameterSignature();
    const cached = parameterCache.get(formKey);
    if (!force && cached?.signature === signature) {
      if (parameterRequest && parameterRequest.signature !== signature) { cancelParameterRequest(); }
      paramsNeedInit = false; pendingParameterTrigger = undefined;
      paramStates = structuredClone(cached.states); parametersReady = true; parameterOptionsStale = false;
      updateFields(); return;
    }
    // A worker is expensive to start. Keep one request in flight and resolve
    // only the latest edit when it finishes; stale replies never change drafts.
    if (parameterRequest) {
      if (parameterRequest.signature !== signature) { paramsNeedInit = true; pendingParameterTrigger = trigger; }
      return;
    }
    pendingParameterTrigger = undefined;
    paramsNeedInit = false;
    resolving = true;
    paramError.hidden = true;
    const id = ++requestId;
    const fail = (error: string): void => { window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'params', projectUri: state?.project.uri, sessionId: state?.activeId, requestId: id, error,
    } })); };
    parameterRequest = { id, signature, timer: setTimeout(() => fail(t('Parameter loading timed out. Retry or send the message to validate parameters.')), 40_000) };
    updateControls();
    try {
      void Promise.resolve(vscode.postMessage({ type: 'resolve', projectUri: state.project.uri, sessionId: state.activeId,
        requestId: id, entrypointId: entrypoint.value, params: structuredClone(values()), draftText: textarea.value, trigger }))
        .then(delivered => { if (delivered === false) fail(t('Cannot load parameters. Retry or send the message to validate parameters.')); }, error => fail(String(error?.message ?? error)));
    } catch (error) { fail(String((error as Error).message)); }
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
        const choose = iconButton(field.control === 'audio' ? 'mic' : 'attach', t("Choose files"), () => post({ type: 'attach', paramName: field.name, entrypointId: entrypoint.value }));
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
      if (control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement && !['checkbox', 'hidden'].includes(control.type)) {
        control.addEventListener('input', () => {
          markParameterEdited(field.name);
          values()[field.name] = control.value;
          persist();
          scheduleParams({ kind: 'param', paramName: field.name }, 200);
        });
      }
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
    cancelParameterRequest();
    renderedParameterDefinition = JSON.stringify(parameters);
    formKey = `${project.uri}:${state!.activeId}:${entrypoint.value}`;
    const serverValues = state!.parameterValues?.[entrypoint.value] ?? {};
    const revisions = currentSession()?.parameterRevisions?.[entrypoint.value] ?? {};
    paramStates = {};
    parameterOptionsStale = false;
    parametersReady = !parameters.paramResolver?.enabled;
    authenticationRequired = false;
    paramsNeedInit = parameters.fields.length > 0;
    fields.clear();
    const container = document.querySelector<HTMLDivElement>('#main-fields')!;
    container.replaceChildren();
    for (const field of parameters.fields) {
      // Local edits belong to a conversation and entrypoint. Only a newly
      // accepted input effect can replace them, including while it was hidden.
      const edited = Object.hasOwn(editedParams(), field.name);
      const effectChanged = edited && editedParams()[field.name] !== (revisions[field.name] ?? null);
      if (effectChanged) { delete editedParams()[field.name]; }
      if ((!edited || effectChanged) && (state!.parameterValues?.[entrypoint.value] !== undefined || effectChanged || revisions[field.name] !== undefined)) {
        values()[field.name] = projectParamValue(field, serverValues[field.name]);
      }
      values()[field.name] = projectParamValue(field, values()[field.name] ?? field.defaultValue ?? (field.type === 'boolean' ? 'false' : ''));
      fields.set(field.name, createField(field));
      if (project.projectType !== 'conversation' && (field.panel === undefined || field.panel === 'main')) { container.append(fields.get(field.name)!.root); }
    }
    const cached = parameterCache.get(formKey);
    if (cached?.signature === parameterSignature()) { paramStates = structuredClone(cached.states); parametersReady = true; }
    parameterActions.render(parameters);
    paramError.hidden = true;
    updateFields();
    persist();
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
    markParameterEdited(name);
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
          if (!control.multiple) { control.append(new Option(visibleOptions.length ? t("Select...") : t("No available options"), '')); }
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
      if (!parameterOptionsStale && (patch?.resolvedOptions !== undefined || !currentParameters().paramResolver?.enabled || (view.field.options?.length ?? 0) > 0)) {
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
    const durable = state.project.conversation?.durable?.enabled === true;
    const hidden = hideComposer();
    if (composerArea.hidden !== hidden) {
      composerArea.hidden = hidden;
      if (hidden) {
        paramsNeedInit ||= resolving || inputTimer !== undefined;
        cancelParameterRequest();
      } else { sizeComposer(); }
      syncTranscriptLayout();
    }
    for (const [name, view] of fields) {
      for (const control of view.controls) {
        control.disabled = busy() || paramStates[name]?.disabled === true
          || (view.field.control === 'radio' || view.field.control === 'checkboxes') && paramStates[name]?.options?.[control.value]?.disabled === true;
      }
    }
    const dynamic = currentParameters().paramResolver?.enabled;
    const refresh = document.querySelector<HTMLButtonElement>('#refresh-params')!;
    refresh.hidden = !dynamic || !fields.size;
    refresh.disabled = busy() || state.running || resolving;
    refresh.title = refresh.ariaLabel = paramError.hidden ? t('Refresh parameters') : t('Retry loading parameters');
    refresh.classList.toggle('refreshing', parametersLoading());
    document.querySelector<HTMLElement>('#parameter-status')!.hidden = !parametersLoading() || !dynamic;
    document.querySelector('#parameters')!.setAttribute('aria-busy', String(parametersLoading()));
    document.querySelector<HTMLElement>('#parameter-login')!.hidden = !authenticationRequired || state.account?.status === 'authenticated';
    parameterActions.update();
    conversationComposer.update();
    const hasInput = !!textarea.value.trim() || draftFiles.length > 0;
    const stopping = stopRequests.get(`${state.project.uri}:${state.activeId}`);
    const pendingStop = stopping?.phase === 'pending';
    const stop = state.running && (!connectionAvailable || !canQueue() || !hasInput);
    updateIcon(sendButton, pendingStop ? 'loading' : stop ? 'debug-stop' : submitting || pendingSend() || uploading ? 'loading' : conversation ? 'arrow-up' : 'play');
    sendButton.title = sendButton.ariaLabel = pendingStop ? t("Stopping...") : stop ? t("Stop") : editingQueueId ? t("Save queued message") : conversation ? t("Send") : t("Run");
    sendButton.setAttribute('aria-busy', String(pendingStop));
    sendButton.classList.toggle('stop', stop);
    sendButton.disabled = readOnly() || pendingStop || !stop && (!connectionAvailable || !conversation && !navigationReady() || submitting || pendingSend() || !conversation && resolving || uploading > 0 || conversation && !hasInput);
    stopFeedback.hidden = !stopping;
    stopFeedback.className = stopping?.phase === 'failed' ? 'error' : 'stop-feedback';
    stopFeedback.setAttribute('role', stopping?.phase === 'failed' ? 'alert' : 'status');
    stopFeedback.textContent = pendingStop ? t("Stopping...") : stopping?.phase === 'accepted' ? t("Stop request accepted.") : stopping?.error ?? '';
    accessNotice.hidden = !readOnly();
    textarea.disabled = readOnly() || busy() && !pendingSend();
    entrypoint.disabled = busy() || parametersLoading();
    document.querySelector<HTMLButtonElement>('#new')!.disabled = false;
    const waiting = currentSession()?.messages.some((message) => message.pendingInput);
    app.dataset.runState = state.running ? 'running' : waiting ? 'waiting' : submitting || pendingSend() ? 'submitting' : 'idle';
    document.querySelector<HTMLElement>('#tools')!.hidden = !conversation && !currentParameters().tools?.length;
    document.querySelector<HTMLButtonElement>('#tools')!.disabled = readOnly();
    // AI usage is a private deployment surface: it only appears when the host
    // injected a system-AI connection (internal Studio), never in the plain
    // open-source CLI web.
    document.querySelector<HTMLElement>('#usage')!.hidden = !state.account?.aiConfigured || !state.project.requiresLogin || state.account?.status !== 'authenticated';
    const attach = document.querySelector<HTMLButtonElement>('#attach')!;
    attach.hidden = !conversation || !Object.values(state.project.conversation?.attachments ?? {}).some(Boolean);
    attach.disabled = busy() || uploading > 0 || !navigationReady();
    for (const control of Array.from(document.querySelectorAll<HTMLButtonElement>('.param-file-button'))) { control.disabled = busy() || parametersLoading(); }
    renderQueue();
  }

  function sessionTime(session: ConversationSession): number {
    return Math.max(session.updatedAt ?? 0, session.createdAt ?? 0, session.messages.at(-1)?.createdAt ?? 0);
  }

  function relativeTime(session: ConversationSession): string {
    const timestamp = sessionTime(session);
    if (!timestamp) { return ''; }
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
    return minutes < 1 ? t("Just now") : minutes < 60 ? t("{0} min", minutes) : minutes < 1440 ? t("{0} hours", Math.floor(minutes / 60)) : t("{0} days", Math.floor(minutes / 1440));
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
        button.innerHTML = '<span class="session-title"></span><span class="history-status" hidden></span><time></time>';
        button.addEventListener('click', () => { navigate(entry.id); closeHistory(); dismissNarrowMenu(); });
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
      const [label, indicator, time] = Array.from(button.children) as HTMLElement[];
      const title = `${entry.titleLocked ? icon('lock-small') : ''}${escape(entry.title)}`;
      if (label.innerHTML !== title) { label.innerHTML = title; }
      const status = conversationHistoryStatus(entry);
      updateHistoryStatus(indicator, status);
      time.hidden = !!status;
      if (!status) { time.textContent = relativeTime(entry); }
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
    updateConversationRunningCount(document.querySelector('#running-count')!, sessions);
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
    all.textContent = t("View all ({0})", state.sessions.length);
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
    sessionMenu.querySelector('[data-action=lock]')!.innerHTML = `${icon(entry.titleLocked ? 'unlock' : 'lock')}<span>${entry.titleLocked ? t("Unlock title") : t("Lock title")}</span>`;
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

  function saveDraft(sync = true): void {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    if (!state || submitting) { return; }
    drafts[`${state.project.uri}:${state.activeId}`] = textarea.value;
    const draft = { text: textarea.value, attachments: [...draftFiles], editingQueueId };
    currentSession()!.draft = draft;
    draftUpdates.set(state.activeId, { id: state.activeId, create: localSessions.has(state.activeId), draft });
    persist();
    if (sync) { syncNavigation(); }
  }

  function blankSession(id: string): ConversationSession {
    const now = Date.now();
    return { id, title: t("New conversation"), createdAt: now, updatedAt: now, messages: [], parameterValues: {}, toolPermissionPolicies: {}, queuedInputs: [], draft: { text: '', attachments: [] } };
  }

  function navigate(id?: string): void {
    if (!state) { return; }
    saveDraft(false);
    let session = id ? state.sessions.find(entry => entry.id === id) : state.sessions.find(entry => !entry.messages.length && !entry.activeRunId && !entry.queuedInputs?.length && !entry.draft?.text && !entry.draft?.attachments.length);
    if (!session && id) { return; }
    if (!session) {
      session = blankSession(crypto.randomUUID());
      localSessions.set(session.id, session);
      draftUpdates.set(session.id, { id: session.id, create: true, draft: session.draft! });
    }
    preferredSessionId = session.id;
    navigationNeeded = session.id !== serverSessionId || localSessions.has(session.id);
    render({ ...state, sessions: state.sessions.some(entry => entry.id === session.id) ? state.sessions : [...state.sessions, session],
      activeId: session.id, running: sessionRunning(session), parameterValues: session.parameterValues ?? {} }, false);
    persist(); syncNavigation();
  }

  function syncNavigation(): void {
    if (!state || navigationRequest || !navigator.onLine) { return; }
    if (!navigationNeeded && (!draftUpdates.size || draftTimer !== undefined)) { return; }
    navigationRequest = { requestId: ++navigationSequence, activeId: state.activeId, updates: [...draftUpdates.values()], refreshParameters: !navigationReady() };
    vscode.postMessage({ type: 'navigate', projectUri: state.project.uri, id: navigationRequest.activeId, requestId: navigationRequest.requestId, updates: navigationRequest.updates });
    updateControls(); updateConnectionFeedback();
  }

  function dispatchSubmissions(): void {
    if (!state || !connectionAvailable) return;
    let changed = false;
    for (const entry of submissions.list()) {
      if (entry.projectUri !== state.project.uri || entry.phase !== 'pending' || localSessions.has(entry.sessionId)
        || !state.sessions.some(session => session.id === entry.sessionId)) continue;
      entry.phase = 'sending'; changed = true;
      const { input } = entry;
      vscode.postMessage({ type: 'send', projectUri: entry.projectUri, sessionId: entry.sessionId, requestId: input.id,
        mode: 'followUp', text: input.text, params: input.params, entrypointId: input.entrypointId, attachments: input.attachments,
        preserveDraft: true, editingQueueId: entry.replacesId });
    }
    if (changed) persist();
  }

  function mergeNavigation(next: State): State {
    if (state?.project.uri !== next.project.uri) {
      preferredSessionId = undefined; navigationRequest = undefined; navigationNeeded = false;
      localSessions.clear(); draftUpdates.clear();
      if (saved.navigation?.projectUri === next.project.uri) {
        preferredSessionId = saved.navigation.activeId;
        for (const update of saved.navigation.updates ?? []) {
          if (typeof update.id !== 'string' || typeof update.draft?.text !== 'string' || !Array.isArray(update.draft.attachments)) { continue; }
          draftUpdates.set(update.id, update);
          if (update.create) { localSessions.set(update.id, { ...blankSession(update.id), draft: update.draft }); }
        }
        saved.navigation = undefined;
      } else if (initialConversation) {
        preferredSessionId = initialConversation;
        if (createInitialConversation && !next.sessions.some(session => session.id === initialConversation)) {
          const session = blankSession(initialConversation);
          localSessions.set(session.id, session);
          draftUpdates.set(session.id, { id: session.id, create: true, draft: session.draft! });
        }
      }
      initialConversation = undefined;
    }
    serverSessionId = next.activeId;
    const sessions = next.sessions.map(entry => draftUpdates.has(entry.id) ? { ...entry, draft: draftUpdates.get(entry.id)!.draft } : entry);
    for (const entry of localSessions.values()) {
      if (!sessions.some(session => session.id === entry.id)) { sessions.push({ ...entry, draft: draftUpdates.get(entry.id)?.draft ?? entry.draft }); }
    }
    for (const id of draftUpdates.keys()) { if (!sessions.some(entry => entry.id === id)) { draftUpdates.delete(id); } }
    if (preferredSessionId && !sessions.some(entry => entry.id === preferredSessionId)) { preferredSessionId = undefined; }
    const activeId = preferredSessionId ?? next.activeId;
    const current = sessions.find(entry => entry.id === activeId);
    navigationNeeded = activeId !== serverSessionId || localSessions.has(activeId);
    return { ...next, sessions, activeId, running: current ? sessionRunning(current) : false, parameterValues: current?.parameterValues ?? {},
      conversationAccess: activeId === next.activeId ? next.conversationAccess : undefined };
  }

  function connectionFeedback(): HTMLDivElement {
    const root = document.createElement('div'); root.className = 'message-connection'; root.hidden = true;
    const label = document.createElement('span'); label.className = 'message-connection-status'; label.setAttribute('role', 'status');
    const retry = iconButton('refresh', t("Retry"), async () => {
      if (manualReconnect) { return; }
      manualReconnect = true; reconnectFailed = false; updateConnectionFeedback();
      try { await vscode.postMessage({ type: 'reconnect' }); }
      catch {
        manualReconnect = false; reconnectFailed = true; updateConnectionFeedback();
      }
    });
    retry.classList.add('connection-retry');
    const title = document.createElement('span'); title.textContent = t("Retry"); retry.append(title);
    root.append(label, retry);
    return root;
  }

  function updateConnectionFeedback(): void {
    const target = [...(currentSession()?.messages ?? [])].reverse().find(message => message.role === 'assistant');
    const interrupted = connectionStatus !== 'connected';
    const label = connectionStatus === 'connecting' ? t("Connecting to project") : connectionStatus === 'expired' ? `${t("Project connection expired")}. ${t("Reopen using the project's run URL.")}`
      : connectionStatus === 'offline' ? `${t("Connection interrupted")}. ${t("Reconnection will start when the network is available.")}`
        : reconnectFailed ? t("Reconnection failed. Retrying automatically; you can retry now.") : `${t("Connection interrupted")} \u00b7 ${t("Reconnecting...")}`;
    const update = (root: HTMLDivElement, visible: boolean) => {
      root.hidden = !interrupted || !visible;
      root.querySelector('.message-connection-status')!.textContent = label;
      const retry = root.querySelector<HTMLButtonElement>('button')!;
      retry.disabled = manualReconnect || connectionStatus === 'offline' || connectionStatus === 'expired';
      retry.classList.toggle('refreshing', manualReconnect);
      retry.setAttribute('aria-busy', String(manualReconnect));
      retry.title = retry.ariaLabel = manualReconnect ? t("Reconnecting...") : t("Retry");
      retry.querySelector('span:last-child')!.textContent = retry.title;
    };
    update(emptyConnection, !target);
    for (const view of messages.values()) {
      if (view.connection) { update(view.connection, view.message.id === target?.id); }
      const retry = view.root.querySelector<HTMLButtonElement>('.retry-message');
      if (retry) {
        const submission = submissions.forMessage(view.message);
        retry.hidden = interrupted || !!submission && submission.phase !== 'failed';
        retry.disabled = readOnly() || !!state?.running || pendingSend() || !!view.message.pendingInput || !!retryingMessage || !submission && !navigationReady();
      }
    }
  }

  function attachmentList(container: HTMLElement, attachments: Attachment[], removable: boolean): void {
    container.replaceChildren(); container.hidden = !attachments.length;
    for (const file of attachments) {
      const isImage = file.kind === 'image';
      const item = document.createElement('div'); item.className = `attachment${isImage ? ' attachment-image' : ''}`;
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'attachment-preview'; preview.title = isImage ? t("Image") : file.name; preview.setAttribute('aria-label', preview.title);
      if (isImage && file.previewUrl) { const image = document.createElement('img'); image.src = file.previewUrl; image.alt = t("Image"); preview.append(image); }
      else { preview.innerHTML = icon(file.mimeType.startsWith('audio/') ? 'unmute' : file.mimeType.startsWith('video/') ? 'device-camera-video' : 'file'); }
      preview.addEventListener('click', () => {
        if (isImage && file.previewUrl) { dialogs.image(file.previewUrl, t("Image")); }
        else { post({ type: 'open-file', id: file.id }); }
      });
      item.append(preview);
      if (!isImage) { const name = document.createElement('span'); name.textContent = file.name; name.title = file.name; item.append(name); }
      if (removable) { item.append(iconButton('close', t("Remove attachment"), () => { draftFiles = draftFiles.filter((entry) => entry.id !== file.id); attachmentList(container, draftFiles, true); saveDraft(); updateControls(); })); }
      container.append(item);
    }
  }

  function renderQueue(): void {
    const session = currentSession();
    if (!state || !session) return;
    queueView.update({ projectUri: state.project.uri, session, sessions: state.sessions, durable: state.project.conversation?.durable?.enabled === true,
      ready: !readOnly() && connectionAvailable && navigationReady(),
      pendingIds: new Set(submissions.list().filter(entry => entry.projectUri === state!.project.uri).map(entry => entry.input.id)) });
  }

  async function uploadFiles(files: File[]): Promise<void> {
    if (!state || !navigationReady() || busy() || !files.length || document.querySelector<HTMLElement>('#attach')!.hidden) { return; }
    const sessionId = state.activeId; const projectUri = state.project.uri;
    const allowed = state.project.conversation?.attachments;
    const selected = files.filter((file) => file.type.startsWith('image/') ? allowed?.images : file.type.startsWith('video/') ? allowed?.videos : allowed?.files);
    if (selected.length !== files.length || draftFiles.length + selected.length > 32 || selected.some((file) => file.size > 50 * 1024 * 1024)) { showError(t("Unsupported attachment type, or the 50 MiB per file / 32 attachment limit was exceeded.")); return; }
    uploading++; updateControls();
    try {
      const encoded = await Promise.all(selected.map((file) => new Promise<{ name: string; mimeType: string; data: string }>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, mimeType: file.type, data: String(reader.result).split(',', 2)[1] }); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
      })));
      vscode.postMessage({ type: 'upload', projectUri, sessionId, files: encoded });
    } catch (error) { if (state.activeId === sessionId) { uploading = Math.max(0, uploading - 1); showError(String(error)); updateControls(); } }
  }

  function showError(message: string): void { const error = document.querySelector<HTMLElement>('#error')!; error.textContent = message; error.hidden = false; }

  async function copy(text: string, button: HTMLButtonElement): Promise<void> {
    if (await vscode.postMessage({ type: 'copy', text }) === false) { return; }
    button.innerHTML = icon('check');
    button.title = t("Copied");
    setTimeout(() => { button.innerHTML = icon('copy'); button.title = t("Copy"); }, 1600);
  }

  function createMessage(message: ConversationMessage): MessageView {
    const root = document.createElement('article');
    root.className = `message ${message.role}`;
    root.dataset.messageId = message.id;
    const timestamp = message.createdAt ? new Date(message.createdAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    root.innerHTML = `<div class="message-body"><header class="message-header"><span class="message-metadata"></span><time class="message-date"${!timestamp ? ' hidden' : ''}>${escape(timestamp)}</time></header><div class="attachments" hidden></div><div class="message-content"></div><div class="message-prompt"></div><p class="message-error" hidden></p><div class="message-actions"><button class="icon-button copy-message" title="${t("Copy message")}" aria-label="${t("Copy message")}">${icon('copy')}</button></div></div>`;
    if (timestamp) { root.querySelector<HTMLTimeElement>('.message-date')!.dateTime = new Date(message.createdAt!).toISOString(); }
    if (message.role === 'user') { root.querySelector('.message-actions')!.prepend(root.querySelector('.message-date')!); }
    const avatar = iconButton('account', message.role === 'user' ? t("SteamHarness Account") : t("Project information"), () => {
      if (message.role === 'user') { vscode.postMessage({ type: 'login' }); }
      else if (state) { parameterActions.close(); dialogs.projectInfo(state.project); }
    });
    avatar.classList.add('message-avatar', message.role === 'user' ? 'user-avatar' : 'project-avatar');
    avatar.setAttribute('aria-haspopup', 'dialog');
    if (message.role === 'user') { root.append(avatar); }
    else { root.querySelector('.message-header')!.prepend(avatar); }
    const view: MessageView = { root, content: root.querySelector('.message-content')!, metadata: root.querySelector('.message-metadata')!, error: root.querySelector('.message-error')!, message,
      avatar,
      attachments: root.querySelector('.attachments')!, promptRoot: root.querySelector('.message-prompt')!,
    };
    root.querySelector<HTMLButtonElement>('.copy-message')!.addEventListener('click', (event) => copy(view.message.content, event.currentTarget as HTMLButtonElement));
    if (message.role === 'assistant') {
      view.configureModel = iconButton('settings-gear', t('Configure model'), () => configurationPanel.openAgentModels());
      view.configureModel.append(document.createTextNode(t('Configure model')));
      view.configureModel.classList.add('configure-model-message'); view.configureModel.hidden = true;
      root.querySelector('.message-actions')!.append(view.configureModel);
      view.output = new ConversationOutput(view.content, {
        composer: true,
        copy, plan: (text) => dialogs.plan(text), file: (id) => post({ type: 'open-file', id }),
        image: (src, title) => dialogs.image(src, title), resource: (card, action, requestId) => post({ type: 'resource', messageId: view.message.id, cardId: card.id, action, requestId }),
      });
      const actions = root.querySelector('.message-actions')!;
      const fork = iconButton('git-branch', t('Fork conversation'), async () => {
        const entryId = view.message.entryId, sessionId = state?.activeId, projectUri = state?.project.uri;
        if (!entryId || !connectionAvailable || !navigationReady()) return;
        const result = await requestAction({
          title: t('Fork from this response?'),
          description: t('Create and open a new conversation with the history up to and including this response. Later messages are not included. The original conversation stays unchanged, so you can explore a different direction in the new one.'),
          confirm: t('Fork'),
        });
        if (result !== undefined && state?.activeId === sessionId && state?.project.uri === projectUri && connectionAvailable && navigationReady()) {
          post({ type: 'agent-command', command: { type: 'fork', requestId: crypto.randomUUID(), entryId } });
        }
      });
      fork.classList.add('fork-message'); actions.append(fork);
      const trace = iconButton('history', t("Trace"), () => post({ type: 'trace', messageId: view.message.id, runId: view.message.runId }));
      trace.classList.add('trace-message'); actions.prepend(trace);
      const exportButton = iconButton('export', t("Export run"), () => { exportButton.disabled = true; exportButton.innerHTML = icon('loading'); post({ type: 'export-message', messageId: view.message.id }); });
      const retry = iconButton('refresh', t("Retry"), () => {
        const submission = submissions.forMessage(view.message);
        if (submission) {
          if (!connectionAvailable || pendingSend() || state?.running) return;
          submissions.retry(submission.input.id); render(state!, false); persist(); syncNavigation(); dispatchSubmissions(); return;
        }
        if (!connectionAvailable || !navigationReady() || state?.running || retryingMessage || view.message.pendingInput) { return; }
        retryingMessage = view.message.id; updateConnectionFeedback(); post({ type: 'retry', messageId: view.message.id });
      });
      retry.classList.add('retry-message'); exportButton.classList.add('export-message'); actions.append(retry, exportButton);
      view.connection = connectionFeedback(); actions.before(view.connection);
    }
    return view;
  }

  function updateMessageMetadata(view: MessageView): void {
    const message = view.message;
    const status = message.status === 'sending' ? t('Sending') : message.pendingInput ? t("Awaiting confirmation") : message.status === 'running' ? activeAgentActivity(message)?.label ?? t("Responding") : message.status === 'aborted' ? t("Stopped") : message.status === 'failed' ? t("Failed") : '';
    const seconds = Math.round((message.status === 'running' ? Date.now() - (message.createdAt ?? Date.now()) : message.durationMs ?? 0) / 1000);
    const duration = message.durationMs !== undefined || message.status === 'running' ? t("Duration {0}{1}s", seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : '', seconds % 60) : '';
    const usage = message.tokenUsage?.display ? message.tokenUsage.run : undefined;
    const tokens = usage && (usage.totalTokens ?? (Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)));
    view.metadata.textContent = [status, duration, message.model, tokens ? t('Turn usage: {0} tokens', Number(tokens).toLocaleString(locale())) : ''].filter(Boolean).join(' \u00b7 ');
    view.metadata.title = [view.metadata.textContent, ...(usage ? [
      t('Model calls: {0}', usage.calls ?? 0),
      t('Input: {0} tokens', Number(usage.inputTokens ?? 0).toLocaleString(locale())),
      t('Output: {0} tokens', Number(usage.outputTokens ?? 0).toLocaleString(locale())),
      t('Cache read: {0} tokens', Number(usage.cachedInputTokens ?? 0).toLocaleString(locale())),
      t('Cache write: {0} tokens', Number(usage.cacheCreationTokens ?? 0).toLocaleString(locale())),
    ] : [])].join('\n');
  }

  function updateMessage(view: MessageView, message: ConversationMessage, files: Attachment[], filesSignature: string): void {
    view.message = message;
    if (message.role === 'user') { updateUserAvatar(view.avatar, state?.account); }
    else { updateProjectAvatar(view.avatar, state!.project); }
    view.root.classList.toggle('streaming', message.status === 'running' || message.status === 'sending');
    view.root.querySelector<HTMLElement>('.message-actions')!.hidden = message.role === 'assistant' && !messageSettled(message);
    for (const action of view.root.querySelectorAll<HTMLButtonElement>('.trace-message, .export-message')) action.hidden = submissions.local(message);
    updateMessageMetadata(view);
    if (message.role === 'user') { view.content.textContent = message.content; }
    else { view.output!.update(message, state!.project.id, state!.activeId, files, state!.project.projectInfo?.dataStorage?.mode === 'server' ? 'server' : 'local', filesSignature); }
    const error = message.status === 'running' || message.status === 'sending' ? undefined : message.error;
    view.error.textContent = error ?? '';
    view.error.hidden = !error;
    if (view.configureModel) view.configureModel.hidden = !error || !configurationPanel.needsAgentModels() || !currentParameters().fields.some(field => field.name === 'model');
    view.root.querySelector<HTMLButtonElement>('.copy-message')!.disabled = !message.content;
    const fork = view.root.querySelector<HTMLButtonElement>('.fork-message');
    if (fork) { fork.hidden = !state?.project.conversation?.durable?.enabled || !message.entryId; fork.disabled = !connectionAvailable; }
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
      if (readOnly() || message.status === 'running') { view.prompt.setBusy(true); }
    } else if (!message.pendingInput) { view.prompt?.root.remove(); view.prompt = undefined; }
    else { view.prompt?.setBusy(readOnly() || message.status === 'running' || !!message.submittingInput, message.error ?? ''); }
  }

  function updateLatest(): void { latest.hidden = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100; }
  function syncTranscriptLayout(): void {
    if (transcriptLayoutFrame !== undefined) { return; }
    transcriptLayoutFrame = requestAnimationFrame(() => {
      transcriptLayoutFrame = undefined;
      // Composer changes and asynchronously sized content must settle before following the end.
      if (followingLatest && !transcriptScrollbarActive) {
        transcript.scrollTop = transcript.scrollHeight;
        transcriptScrollTop = transcript.scrollTop;
      }
      transcriptScrollHeight = transcript.scrollHeight;
      transcriptViewportHeight = transcript.clientHeight;
      updateLatest();
      messageIndex.syncLayout();
    });
  }
  setInterval(() => { for (const view of messages.values()) { view.output?.tick(); if (view.message.status === 'running') { updateMessageMetadata(view); } } }, 200);

  function render(next: State, fromServer = true): void {
    const previous = state;
    if (fromServer) { next = mergeNavigation(next); }
    const submissionCount = submissions.list().length;
    if (fromServer) submissions.retain(next.project.uri, new Set(next.sessions.map(session => session.id)));
    next = { ...next, sessions: next.sessions.map(session => submissions.project(next.project.uri, session, fromServer)) };
    state = next;
    for (const [key, request] of stopRequests) {
      const target = next.sessions.find(session => session.id === request.sessionId);
      const recoveringStop = request.phase === 'pending' && request.runId === target?.activeRunId && request.taskIds?.length
        && request.taskIds.every(id => target?.agent?.tasks.some(task => task.id === id));
      const replaced = request.agentOwner ? target?.agent?.ownerId !== request.agentOwner && !recoveringStop
        : !!target?.activeRunId && target.activeRunId !== request.runId;
      if (request.projectUri !== next.project.uri || !target || replaced) {
        clearTimeout(request.timer); stopRequests.delete(key);
      }
    }
    updateProjectAvatar(document.querySelector<HTMLElement>('#project-info')!, next.project);
    if (submissionCount !== submissions.list().length) persist();
    const session = next.sessions.find((entry) => entry.id === next.activeId);
    if (!session) { return; }
    const conversation = next.project.projectType === 'conversation';
    const scope = session.agent?.contexts.find(scope => scope.conversationId === (session.agentConversationId ?? session.agent?.conversationId));
    composerOutput.update(conversation ? composerOutputItems(session.messages, scope?.outputs) : [], `${next.project.uri}:${next.activeId}`);
    const projectChanged = renderedProject !== next.project.uri;
    app.dataset.projectUri = next.project.uri;
    const folder = document.querySelector<HTMLElement>('#assistant-folder')!;
    folder.hidden = !next.project.assistant;
    folder.textContent = next.project.assistant?.roots.find((root) => root.folderPath === next.project.assistant?.workdir)?.name ?? '';
    folder.title = next.project.assistant?.workdir ?? '';
    const switching = projectChanged || renderedSession !== next.activeId;
    if (switching) { vscode.postMessage({ type: 'trace-active', sessionId: next.activeId }); }
    if (switching) { followingLatest = true; }
    const authenticationChanged = previous && previous.authenticationRevision !== next.authenticationRevision;
    const parametersChanged = previous && (authenticationChanged || previous.parameterRevision !== next.parameterRevision || previous.serverInstanceId !== next.serverInstanceId);
    if (previous && previous.authenticationRevision !== next.authenticationRevision) { dialogs.closeUsage(); }
    if (parametersChanged) {
      cancelParameterRequest();
      parameterCache.clear();
      paramsNeedInit = true;
      parameterOptionsStale = true;
      if (authenticationChanged || previous.serverInstanceId !== next.serverInstanceId) { paramStates = {}; parametersReady = false; }
    }
    if (next.running && resolving) {
      paramsNeedInit = true;
      cancelParameterRequest();
    }
    document.querySelector('#project-name')!.textContent = next.project.name;
    document.querySelector<HTMLElement>('#project-name')!.hidden = !session.messages.length;
    document.querySelector('#conversation-title')!.textContent = session.messages.length ? session.title : next.project.name;
    if (projectChanged || JSON.stringify(previous?.project.entrypoints) !== JSON.stringify(next.project.entrypoints)) {
      historyLimit = historyPageSize;
      const selected = projectChanged ? undefined : entrypoint.value;
      entrypoint.replaceChildren(...next.project.entrypoints.map((entry) => new Option(entry.title || entry.id, entry.id)));
      entrypoint.value = next.project.entrypoints.some(entry => entry.id === selected) ? selected! : next.project.defaultEntrypoint || next.project.entrypoints[0]?.id || '';
      entrypoint.hidden = conversation || next.project.entrypoints.length === 0;
      textarea.placeholder = conversation ? t("Write anything") : '["--name", "Studio"]';
      renderedProject = next.project.uri;
    }
    if (switching) {
      pendingParameterTrigger = undefined;
      closeSessionMenu();
      cancelParameterRequest();
      submitting = false;
      composing = false;
      retryingMessage = undefined;
      clearTimeout(inputTimer);
      clearTimeout(draftTimer); draftTimer = undefined; uploading = 0; dialogs.close(); contentSearch.close();
      textarea.value = session.draft?.text ?? drafts[`${next.project.uri}:${next.activeId}`] ?? '';
      draftFiles = session.draft?.attachments ?? [];
      editingQueueId = session.draft?.editingQueueId;
      renderedSession = next.activeId;
      for (const view of messages.values()) { view.output?.dispose(); } messages.clear();
      transcriptContent.replaceChildren();
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
    renderHistory(switching); updateSessionMenu();
    document.querySelector<HTMLElement>('#editing-queue')!.hidden = !editingQueueId;
    attachmentList(document.querySelector('#draft-attachments')!, draftFiles, true);
    const indexedMessages: IndexedUserMessage[] = [];
    if (!session.messages.length) {
      if (!transcriptContent.querySelector('.empty')) { transcriptContent.innerHTML = `<div class="empty">${icon(conversation ? 'comment-discussion' : 'run-all')}</div>`; }
    } else {
      transcriptContent.querySelector('.empty')?.remove();
      const active = new Set<string>();
      const files = session.messages.flatMap(entry => [...(entry.files ?? []), ...(entry.attachments ?? [])]);
      const filesSignature = attachmentSignature(files);
      let epoch = 0;
      session.messages.forEach((message, index) => {
        const id = message.id || `${index}:${message.role}`;
        active.add(id);
        let view = messages.get(id);
        if (!view) { view = createMessage(message); messages.set(id, view); transcriptContent.append(view.root); }
        const current = transcriptContent.children[index] ?? null;
        if (current !== view.root) transcriptContent.insertBefore(view.root, current);
        updateMessage(view, message, files, filesSignature);
        if (message.role === 'user') indexedMessages.push({ root: view.root, message });
        let divider = view.root.querySelector<HTMLElement>('.context-epoch');
        if ((message.contextEpoch ?? 0) > epoch) {
          if (!divider) { divider = document.createElement('div'); divider.className = 'context-epoch'; divider.setAttribute('role', 'separator'); view.root.prepend(divider); }
          divider.textContent = t('Context epoch {0}', message.contextEpoch!);
        } else divider?.remove();
        epoch = message.contextEpoch ?? epoch;
      });
      for (const [id, view] of messages) { if (!active.has(id)) { view.output?.dispose(); view.root.remove(); messages.delete(id); } }
    }
    messageIndex.update(indexedMessages);
    contentSearch.refresh();
    if (fromServer) { retryingMessage = undefined; }
    updateConnectionFeedback();
    if (switching || editingChanged || formKey !== `${next.project.uri}:${next.activeId}:${entrypoint.value}`
      || renderedParameterDefinition !== JSON.stringify(currentParameters())) { renderParameters(); }
    else if (JSON.stringify(previous?.parameterValues) !== JSON.stringify(next.parameterValues)) {
      const previousValues = previous?.parameterValues?.[entrypoint.value] ?? {};
      const nextValues = next.parameterValues?.[entrypoint.value] ?? {};
      for (const name of new Set([...Object.keys(previousValues), ...Object.keys(nextValues)])) {
        if (!fields.has(name) || Object.hasOwn(editedParams(), name)) { continue; }
        const value = projectParamValue(fields.get(name)!.field, nextValues[name]);
        if (JSON.stringify(values()[name]) === JSON.stringify(value)) { continue; }
        values()[name] = value;
        if (currentParameters().paramResolver?.enabled) { paramsNeedInit = true; parameterOptionsStale = true; parameterCache.delete(formKey); }
      }
      updateFields();
    }
    const previousRevisions = previous?.sessions.find(entry => entry.id === session.id)?.parameterRevisions?.[entrypoint.value];
    const updatedParams = switching ? [] : Object.entries(session.parameterRevisions?.[entrypoint.value] ?? {})
      .filter(([name, revision]) => revision !== previousRevisions?.[name]).map(([name]) => name);
    if (updatedParams.length) {
      cancelParameterRequest();
      parameterCache.delete(formKey);
      parameterOptionsStale = currentParameters().paramResolver?.enabled === true;
      for (const name of updatedParams) {
        if (!fields.has(name)) { continue; }
        values()[name] = projectParamValue(fields.get(name)!.field, session.parameterValues?.[entrypoint.value]?.[name]);
        delete editedParams()[name];
      }
      paramsNeedInit = fields.size > 0;
      persist(); updateFields();
    }
    if (parametersChanged) { updateFields(); }
    if (paramsNeedInit && !busy() && !inputTimer) { requestParams(pendingParameterTrigger ?? { kind: 'init' }); }
    updateControls();
    if (switching && !next.running && !composerArea.hidden && document.hasFocus()) { textarea.focus(); }
    if (switching) { transcriptScrollTop = transcript.scrollTop; }
    syncTranscriptLayout();
    if (conversationView && switching) { persist(); }
    if (fromServer) { syncNavigation(); dispatchSubmissions(); }
  }

  function focusParameter(name: string): void {
    const field = fields.get(name);
    if (conversationComposer.openForField(name)) { return; }
    if (!parameterActions.openForField(name)) {
      field?.root.scrollIntoView({ block: 'nearest' });
      field?.controls[0]?.focus();
    }
  }

  function send(): void {
    if (!state) { return; }
    if (stopRequests.get(`${state.project.uri}:${state.activeId}`)?.phase === 'pending') { return; }
    const hasInput = !!textarea.value.trim() || draftFiles.length > 0;
    if (state.running && (!connectionAvailable || !canQueue() || !hasInput)) { void stopCurrent(); return; }
    if (!connectionAvailable || state.project.projectType !== 'conversation' && !navigationReady()) { return; }
    if (conversationComposer.submitCommand()) { return; }
    if (busy() || state.project.projectType !== 'conversation' && resolving || uploading || state.project.projectType === 'conversation' && !hasInput) { return; }
    const validateOnServer = state.project.projectType === 'conversation' && currentParameters().paramResolver?.enabled
      && (!parametersReady || resolving || parameterOptionsStale || paramsNeedInit || inputTimer !== undefined || !paramError.hidden);
    for (const [name, view] of fields) {
      if (validateOnServer) { break; }
      if (view.root.hidden || paramStates[name]?.disabled) { continue; }
      const value = values()[name];
      const missing = view.field.required && (!value || Array.isArray(value) && value.length === 0);
      const invalid = view.controls.some((control) => !control.checkValidity());
      if (missing || invalid) {
        focusParameter(name);
        if (invalid) { view.controls.find((control) => !control.checkValidity())?.reportValidity(); }
        else { const error = document.querySelector<HTMLElement>('#error')!; error.textContent = t("Please enter {0}.", view.field.label || name); error.hidden = false; }
        return;
      }
    }
    document.querySelector<HTMLElement>('#error')!.hidden = true;
    stopRequests.delete(`${state.project.uri}:${state.activeId}`);
    if (state.project.projectType === 'conversation') {
      const session = currentSession()!;
      const input = { id: crypto.randomUUID(), text: textarea.value, params: structuredClone(values()), entrypointId: entrypoint.value,
        attachments: structuredClone(draftFiles), createdAt: Date.now() };
      submissions.add({ projectUri: state.project.uri, sessionId: session.id, input, phase: 'pending', replacesId: editingQueueId,
        modelName: conversationModelName({ params: input.params, states: paramStates }, currentParameters().fields),
        queued: !!editingQueueId || state.running || !!session.queuedInputs?.length });
      paramsNeedInit ||= resolving || inputTimer !== undefined || currentParameters().fields.some(field => field.resolveOnInput);
      cancelParameterRequest();
      delete parameterEdits[formKey]; textarea.value = ''; draftFiles = []; editingQueueId = undefined;
      session.draft = { text: '', attachments: [] };
      followingLatest = true; sizeComposer(); saveDraft(false); render(state, false);
      persist(); syncNavigation(); dispatchSubmissions(); textarea.focus(); return;
    }
    draftUpdates.delete(state.activeId); persist();
    submitting = true;
    updateControls();
    clearTimeout(draftTimer); post({ type: 'send', requestId: crypto.randomUUID(), mode: 'followUp', text: textarea.value, params: values(), entrypointId: entrypoint.value, attachments: draftFiles });
  }

  function finishStop(message: Record<string, any>): boolean {
    const id = message.requestId ?? message.receipt?.requestId;
    const request = [...stopRequests.values()].find(request => request.requestId === id
      && request.sessionId === message.sessionId && (!message.projectUri || request.projectUri === message.projectUri));
    if (!request) { return message.type === 'error' && message.errorScope === 'stop'; }
    if (request.phase === 'accepted' || request.phase === 'failed' && message.type === 'error') { return true; }
    clearTimeout(request.timer);
    request.phase = message.type === 'error' ? 'failed' : 'accepted';
    request.error = message.type === 'error' ? t("Stop was not confirmed: {0}. Retry or reconnect to check its result.", message.message) : undefined;
    updateControls(); return true;
  }

  async function stopCurrent(): Promise<void> {
    if (!state) { return; }
    const key = `${state.project.uri}:${state.activeId}`;
    const previous = stopRequests.get(key);
    if (previous?.phase === 'pending') { return; }
    const request: StopRequest = { projectUri: state.project.uri, sessionId: state.activeId,
      requestId: previous?.phase === 'failed' ? previous.requestId : crypto.randomUUID(),
      runId: currentSession()?.activeRunId, agentOwner: currentSession()?.agent?.ownerId,
      taskIds: currentSession()?.agent?.tasks.map(task => task.id), phase: 'pending' };
    stopRequests.set(key, request);
    // Allow the host to restore the process before waiting for its cancellation receipt.
    request.timer = setTimeout(() => finishStop({ ...request, type: 'error', message: t("The server did not confirm the stop request.") }), 90_000);
    updateControls();
    const message = state.project.conversation?.durable?.enabled
      ? { type: 'agent-command', agentOwner: request.agentOwner, runId: request.runId,
        taskIds: request.taskIds,
        command: { type: 'cancel', scope: 'foreground', requestId: request.requestId } }
      : { type: 'stop', runId: request.runId };
    try { await vscode.postMessage({ ...message, projectUri: request.projectUri, sessionId: request.sessionId, requestId: request.requestId, errorScope: 'stop' }); }
    catch (error) { finishStop({ ...request, type: 'error', message: String((error as Error)?.message ?? error) }); }
  }

  textarea.addEventListener('compositionstart', () => { composing = true; clearTimeout(inputTimer); inputTimer = undefined; });
  textarea.addEventListener('compositionend', () => {
    composing = false;
    if (state && currentParameters().fields.some(field => field.resolveOnInput)) { scheduleParams({ kind: 'input' }, 350); }
  });
  textarea.addEventListener('input', () => {
    if (!state) { return; }
    saveDraft(false);
    clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 300);
    sizeComposer();
    updateControls();
    if (!composing && currentParameters().fields.some((field) => field.resolveOnInput)) {
      scheduleParams({ kind: 'input' }, 350);
    }
  });
  textarea.addEventListener('keydown', (event) => {
    if (conversationComposer.handleKeydown(event)) { return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && state?.project.projectType === 'conversation') { event.preventDefault(); send(); }
  });
  sendButton.addEventListener('click', send);
  document.querySelector('#new')!.addEventListener('click', () => navigate());
  document.querySelector('#project-info')!.addEventListener('click', () => { if (state) { parameterActions.close(); dialogs.projectInfo(state.project); } });
  document.querySelector('#attach')!.addEventListener('click', () => post({ type: 'attach' }));
  document.querySelector('#cancel-queue-edit')!.addEventListener('click', () => post({ type: 'queue-cancel-edit' }));
  document.querySelector('#tools')!.addEventListener('click', () => dialogs.permissions(currentParameters(), currentSession()?.toolPermissionPolicies ?? {}, (policies) => post({ type: 'tool-policy', entrypointId: entrypoint.value, policies })));
  document.querySelector('#usage')!.addEventListener('click', () => dialogs.usage(requestId => post({ type: 'usage', requestId })));
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
      if (id) { post({ type: 'session-action', id, action: button.dataset.action, currentTitle: state?.sessions.find(session => session.id === id)?.title }); }
    });
  }
  document.addEventListener('pointerdown', (event) => { if (!sessionMenu.contains(event.target as Node)) { closeSessionMenu(); } });
  document.addEventListener('focusin', (event) => { if (!sessionMenu.contains(event.target as Node)) { closeSessionMenu(); } });
  window.addEventListener('blur', () => closeSessionMenu());
  window.addEventListener('scroll', (event) => {
    if (sessionMenuTrigger && event.target instanceof Node && event.target.contains(sessionMenuTrigger)) { closeSessionMenu(); }
  }, true);
  document.querySelector('#refresh-params')!.addEventListener('click', () => requestParams({ kind: 'init' }, true));
  entrypoint.addEventListener('change', () => { cancelParameterRequest(); renderParameters(); });
  transcript.addEventListener('scroll', () => {
    const resized = transcript.scrollHeight !== transcriptScrollHeight || transcript.clientHeight !== transcriptViewportHeight;
    // Regrouping cards can shrink the content and clamp scrollTop before it grows
    // again. The delayed layout scroll must not cancel following the latest output.
    if (transcript.scrollTop !== transcriptScrollTop) {
      if (!followingLatest || !resized || transcriptScrollbarActive) {
        const remaining = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
        followingLatest = remaining < 100 && (transcript.scrollTop > transcriptScrollTop || remaining <= 1);
      }
      transcriptScrollTop = transcript.scrollTop;
    }
    if (followingLatest && resized) { syncTranscriptLayout(); }
    updateLatest();
    messageIndex.syncLayout();
  }, { passive: true });
  // Reader input takes precedence even when a resize is waiting for its frame.
  transcript.addEventListener('wheel', event => { if (event.deltaY < 0) { followingLatest = false; } }, { passive: true });
  transcript.addEventListener('keydown', event => {
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) { return; }
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) { followingLatest = false; }
  });
  transcript.addEventListener('touchstart', event => { transcriptTouchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; }, { passive: true });
  transcript.addEventListener('touchmove', event => {
    const y = event.touches.length === 1 ? event.touches[0].clientY : undefined;
    if (y !== undefined && transcriptTouchY !== undefined && y > transcriptTouchY) { followingLatest = false; }
    transcriptTouchY = y;
  }, { passive: true });
  transcript.addEventListener('pointerdown', event => { if (event.target === transcript) { transcriptScrollbarActive = true; } }, { passive: true });
  const releaseTranscriptScrollbar = (): void => {
    if (!transcriptScrollbarActive) { return; }
    if (transcript.scrollTop !== transcriptScrollTop) {
      const remaining = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      followingLatest = remaining < 100 && (transcript.scrollTop > transcriptScrollTop || remaining <= 1);
      transcriptScrollTop = transcript.scrollTop;
    }
    transcriptScrollbarActive = false; syncTranscriptLayout();
  };
  window.addEventListener('pointerup', releaseTranscriptScrollbar, { passive: true });
  window.addEventListener('pointercancel', releaseTranscriptScrollbar, { passive: true });
  latest.addEventListener('click', () => { followingLatest = true; syncTranscriptLayout(); });
  window.addEventListener('resize', () => { closeSessionMenu(); sizeComposer(); syncTranscriptLayout(); positionHistory(); });
  window.addEventListener('pagehide', () => {
    transcriptScrollbarActive = false; transcriptTouchY = undefined;
    messageIndex.closePreview();
    transcriptResize.disconnect();
    if (transcriptLayoutFrame !== undefined) { cancelAnimationFrame(transcriptLayoutFrame); transcriptLayoutFrame = undefined; }
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { transcriptResize.observe(transcript); transcriptResize.observe(transcriptContent); syncTranscriptLayout(); }
  });
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
    if (event.key === 'Escape') { contentSearch.close(); dismissNarrowMenu(); }
  });
  textarea.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
      if (!event.clipboardData?.getData('text/plain')) { event.preventDefault(); }
      void uploadFiles(files);
    }
  });
  document.querySelector('main')!.addEventListener('click', dismissNarrowMenu);
  document.querySelector('main')!.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files') && !document.querySelector<HTMLElement>('#attach')!.hidden) { event.preventDefault(); } });
  document.querySelector('main')!.addEventListener('drop', (event) => { const files = Array.from(event.dataTransfer?.files ?? []); if (files.length) { event.preventDefault(); void uploadFiles(files); } });
  let pendingState: State | undefined;
  const stateRevisions = new StateRevisions();
  let renderScheduled = false;
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'error' && message.requestType === 'resolve') {
      if (state && message.requestId === parameterRequest?.id && (!message.sessionId || message.sessionId === state.activeId)) {
        window.dispatchEvent(new MessageEvent('message', { data: { ...message, type: 'params', error: message.message,
          projectUri: state.project.uri, sessionId: state.activeId } }));
      }
      return;
    }
    // ConversationOutput owns inline preview errors, including late replies from older cards.
    if (message.type === 'error' && message.requestType === 'resource' && message.requestId) { return; }
    if (['stopped', 'agent-receipt', 'error'].includes(message.type) && finishStop(message)) { return; }
    if (queueView.receive(message)) return;
    if (message.type === 'connection') {
      const restored = !connectionAvailable && message.status === 'connected';
      connectionStatus = message.status;
      manualReconnect = !!message.manual;
      reconnectFailed = !!message.retryFailed;
      connectionAvailable = message.status === 'connected';
      if (!connectionAvailable) { paramsNeedInit ||= resolving; cancelParameterRequest(); dialogs.closeUsage(); }
      updateControls();
      updateConnectionFeedback(); syncTranscriptLayout();
      if (restored && state) { parameterCache.clear(); syncNavigation(); dispatchSubmissions(); paramsNeedInit = true; requestParams({ kind: 'init' }); }
      return;
    }
    if (message.type === 'agent-opened' || message.type === 'agent-receipt' && message.forkSessionId) {
      // New-session replies can arrive before the next animation-frame render.
      if (pendingState) { const next = pendingState; pendingState = undefined; render(next); }
      navigate(message.forkSessionId ?? message.sessionId); return;
    }
    if (message.type === 'trace-navigate') { navigate(message.sessionId); return; }
    if (message.type === 'navigated' && navigationRequest && navigationRequest.requestId === message.requestId) {
      const refreshParameters = navigationRequest.refreshParameters;
      for (const update of navigationRequest.updates) {
        if (draftUpdates.get(update.id) === update) { draftUpdates.delete(update.id); }
        if (update.create) { localSessions.delete(update.id); }
      }
      navigationRequest = undefined; serverSessionId = message.activeId;
      navigationNeeded = state?.activeId !== message.activeId || !!state && localSessions.has(state.activeId);
      persist(); syncNavigation(); dispatchSubmissions(); updateControls(); updateConnectionFeedback();
      if ((refreshParameters || paramsNeedInit) && navigationReady()) { paramsNeedInit = true; requestParams(pendingParameterTrigger ?? { kind: 'init' }); }
      return;
    }
    if (message.type === 'error' && message.requestType === 'navigate') {
      if (!navigationRequest || navigationRequest.requestId !== message.requestId) { return; }
      if (!message.connectionError) {
        for (const entry of submissions.list()) {
          if (entry.projectUri === state?.project.uri && entry.phase === 'pending' && navigationRequest.updates.some(update => update.id === entry.sessionId && update.create)) submissions.fail(entry.input.id, message.message);
        }
        if (state) render(state, false);
        persist();
      }
      navigationRequest = undefined;
      updateControls(); updateConnectionFeedback();
      if (!message.connectionError) { showError(message.message); }
      else if (connectionAvailable) { syncNavigation(); }
      return;
    }
    if (message.type === 'sent' && message.requestId && state?.project.projectType === 'conversation' && message.projectUri === state.project.uri) {
      const submission = submissions.get(message.requestId);
      if (submission?.sessionId === message.sessionId) submissions.accept(message.requestId);
      persist(); updateControls(); return;
    }
    if (message.type === 'error' && message.requestType === 'send' && message.requestId && state?.project.projectType === 'conversation') {
      const submission = submissions.get(message.requestId);
      if (submission?.projectUri === state.project.uri && submission.sessionId === message.sessionId) {
        submissions.fail(message.requestId, message.message); render(state, false); persist();
      }
      return;
    }
    if (message.type === 'assistant-command') {
      document.querySelector<HTMLButtonElement>(message.command === 'new' ? '#new' : '#history-toggle')!.click();
      return;
    }
    if (message.type === 'state') {
      if (!stateRevisions.accept(message)) return;
      pendingState = message;
      if (!renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => { renderScheduled = false; if (pendingState) { render(pendingState); pendingState = undefined; } });
      }
    } else if (message.type === 'params' && state && message.projectUri === state.project.uri && message.sessionId === state.activeId && message.requestId === parameterRequest?.id) {
      const request = parameterRequest!;
      clearTimeout(request.timer); parameterRequest = undefined;
      resolving = false;
      if (message.stale) { paramsNeedInit = true; updateControls(); return; }
      if (request.signature !== parameterSignature()) {
        if (!inputTimer) { requestParams(pendingParameterTrigger ?? { kind: 'init' }); }
        updateControls(); return;
      }
      if (message.error) {
        authenticationRequired = /SteamHarness Server login is not configured|Unauthorized/.test(String(message.error));
        paramError.textContent = String(message.error).includes('SteamHarness Server login is not configured') ? t("Sign in to SteamHarness Server, then refresh parameters.")
          : String(message.error).includes('Unauthorized') ? t("Sign-in expired. Sign in to SteamHarness Server again.") : message.error;
        paramError.hidden = false;
      } else {
        authenticationRequired = false;
        parameterOptionsStale = false;
        const patches = Object.fromEntries(Object.entries(message.params ?? {}).filter(([name]) => fields.has(name))) as Record<string, ParamState>;
        paramStates = mergeProjectParamStates(paramStates, patches);
        for (const [name, patch] of Object.entries(patches)) {
          if (patch.value === null) { values()[name] = projectParamValue(fields.get(name)!.field); }
          else if (patch.value !== undefined) { values()[name] = projectParamValue(fields.get(name)!.field, patch.value); }
        }
        updateFields();
        parametersReady = true;
        // Cache lives only in this page, scoped by project, conversation,
        // entrypoint, source definition, identity and configuration revision.
        parameterCache.delete(formKey);
        parameterCache.set(formKey, { signature: parameterSignature(), states: structuredClone(paramStates) });
        if (parameterCache.size > 32) { parameterCache.delete(parameterCache.keys().next().value!); }
        persist();
      }
      if (paramsNeedInit && !inputTimer) { requestParams(pendingParameterTrigger ?? { kind: 'init' }); }
      updateControls();
    } else if (message.type === 'attachment-cancelled' && message.sessionId === state?.activeId) {
      uploading = Math.max(0, uploading - 1); updateControls();
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
        if (accepted.length !== message.files.length) { showError(t("The project does not support this attachment type.")); }
        draftFiles = [...new Map([...draftFiles, ...accepted].map((file) => [file.id, file])).values()].slice(0, 32); attachmentList(document.querySelector('#draft-attachments')!, draftFiles, true); saveDraft();
      }
      updateControls();
    } else if (message.type === 'command-executed' && message.sessionId === state?.activeId) {
      submitting = false; updateControls();
    } else if (message.type === 'sent' && state && message.sessionId === state.activeId) {
      delete parameterEdits[formKey];
      submitting = false; textarea.value = ''; draftFiles = []; editingQueueId = undefined; drafts[`${state.project.uri}:${state.activeId}`] = ''; sizeComposer(); persist();
      attachmentList(document.querySelector('#draft-attachments')!, draftFiles, true); updateControls(); textarea.focus();
    } else if (message.type === 'usage' && message.sessionId === state?.activeId) { dialogs.usageResult(message.requestId, message.usage); }
    else if (message.type === 'exported' && message.sessionId === state?.activeId) {
      const button = messages.get(message.messageId)?.root.querySelector<HTMLButtonElement>('.export-message'); if (button) { button.disabled = false; button.innerHTML = icon('export'); }
    } else if (message.type === 'error' && (!message.sessionId || message.sessionId === state?.activeId)) {
      if (message.requestType === 'usage') { dialogs.usageResult(message.requestId, undefined, message.message); return; }
      if (message.requestType === 'resume' && messages.get(message.messageId)?.prompt?.request.requestId !== message.requestId) { return; }
      submitting = false;
      if (message.requestType === 'retry') { retryingMessage = undefined; }
      uploading = Math.max(0, uploading - 1);
      if (message.requestType === 'resume') { messages.get(message.messageId)?.prompt?.setBusy(false, message.message); }
      updateControls();
      updateConnectionFeedback();
      if (!message.silent) {
        const view = message.messageId && messages.get(message.messageId);
        if (view && message.requestType === 'retry') { view.error.textContent = message.message; view.error.hidden = false; }
        else { showError(message.message); }
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
}

initialize();
