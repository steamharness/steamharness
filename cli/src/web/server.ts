import type { WebAppBinding } from "./web-app-preview";
import { assertProjectDataDirectory } from "@steamharness/project-manifest/node";
import { assertConversationUi } from '@steamharness/kanban-project';
import { createLocalRuntimePersistence, type RuntimePersistence } from "steamharness/runtime-storage";
import { WorkflowHistory } from "./workflow-history";
import { studioPreviewMount } from './studio-preview-mount';
import { EntryWorkflows } from './entry-workflows';
import { hydrateUserSettings, userSettingsJsonReplacer } from './user-settings';
import {configurationCapability} from '@steamharness/project-configuration';
import { getUserSettings, parseUserSettings, type UserSettings } from 'steamharness';
import { ProjectConfigurations } from './project-configurations';
import { uploadConfigurationFile } from './configuration-files';
import { loadAgentModelCatalog } from './agent-model-catalog';
import { t } from './localization';
import { locale } from './localization';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { assertLocalCliCoreCompatible } from '../local';
import { readOnlineConnection } from '../online';
import type { PlatformConnections } from 'steamharness';
import { ConversationController, sessionRunning } from './conversation-controller';
import { Controller } from './workflow-controller';
import { KanbanController } from './kanban-controller';
import { createProjectActions } from './workflow-actions';
import { migrateProjectHistory, type WorkspaceContract } from './workflow-workspace';
import { createWebRuntime, cliRoot, WEB_HOST_ENV, type WebConnection } from './runtime';
import { redactProjectData, projectWithUserSettings, validateProjectValues, validateConversationCommandStates, mergeProjectParamStates, projectParameters, projectParamArgs, messageSettled, type Runtime, type Project, type ConversationSession, type ConversationDraftUpdate, type Attachment, type ParamValues, type ParamState } from './workflow-types';
import { conversationResourceCards, type ResourceCardReference } from './resource-cards';
import type { AccountState } from './workflow-auth-client';
import { sharedWebLogin, signOutCliAccount } from './account-auth';
import type { WebHostConfiguration } from './host-config';
import { inspectWebProject, isLocalBuiltinAssistant } from './assistant-project';
import { ResourcePreviews } from './resource-preview';
import { createLocalActivityWriter, summarizeLocalRuns } from './local-analysis';
import { ConversationOwnership } from './conversation-ownership';
import { ConversationHistory } from './conversation-history';
import { ConversationState, withoutModelRequest } from './conversation-state';
import { pathReferences } from './conversation-paths';
import { projectMentionFiles } from './mention-files';
import { importDroppedEntries, resolveDroppedPaths } from './dropped-paths';
import { defaultServerUrl } from '../service-url';
import { ProjectServerCreation } from './project-server-create';
import { projectServerBrowserLink } from './project-server-link';
import { folderBotDataRoot, projectDataDirectory } from './project-data-directory';
import { EntryConversations, conversationProjection, type AggregateEntryCall } from './entry-conversations';
import { hostConversation } from './host-conversation';
import type { EntryConversationSnapshot } from 'steamharness';

import { conversationViewHtml, conversationViewClientId, scopeConversationViewMessage, passiveConversationViewMessage, type OpenConversationView } from './conversation-view';

type Message = Record<string, any>;
export interface WebOptions { entryId?: string; mount?: { origin: string; basePath: string; catalog(): unknown; identityChanged?(): void;
  reloadProject?(): Promise<string | undefined>;
  openConversationView?: OpenConversationView;
  invokeEntry?(call: AggregateEntryCall): Promise<unknown>;
  subscribeConversation?(sourceEntryId: string, entryId: string, conversationId: string, listener: (snapshot: EntryConversationSnapshot) => void): () => void;
}; projectDir: string; port?: number; dataDir?: string; theme?: 'auto' | 'light' | 'dark'; runtime?: Runtime; runtimePersistence?: RuntimePersistence; runtimePersistenceForEntry?(entryId: string): RuntimePersistence; host?: WebHostConfiguration; initialPlatform?: PlatformConnections;
  onWebAppConfigurationChanged?(entryId: string, configuration: { id: string; name: string; params: Record<string, unknown> }): void;
  onWebAppLogin?(entryId: string, configuration: { id: string; name: string; params: Record<string, unknown> }): void;
}

export { startAggregateWebServer as startWebServer } from "./aggregate-server";

export async function startEntryWebServer(options: WebOptions, sharedCredentials?: { capability: string; cookie: string }) {
  const credentials = sharedCredentials ?? { capability: randomBytes(32).toString('hex'), cookie: `project_web_${randomBytes(8).toString('hex')}` };
  let host = options.host, port = options.port, closing = false;
  let restarting: Promise<void> | undefined;
  const open = () => startProjectWebServer({ ...options, host, port }, credentials, () => {
    if (options.mount?.identityChanged) { options.mount.identityChanged(); return; }
    if (closing || restarting) { return; }
    restarting = (async () => {
      await current.close();
      if (!closing) {
        current = await open();
        if (host?.resourceProjects) current.setHostResourceProjects(host.resourceProjects);
        if (host?.userSettings) await current.setHostUserSettings(host.userSettings);
      }
    })().finally(() => { restarting = undefined; });
    void restarting.catch(error => process.stderr.write(`Application identity restart: ${String(error)}\n`));
  });
  let current = await open();
  port = Number(new URL(current.origin).port);
  return {
    handle: (request: IncomingMessage, response: ServerResponse) => current.handle(request, response),
    get running() { return current.running; },
    get reloadBusy() { return current.reloadBusy; },
    get pendingMessages() { return current.pendingMessages; },
    get origin() { return current.origin; }, get url() { return current.url; }, get project() { return current.project; },
    get configurations() { return current.configurations; }, get controller() { return current.controller; },
    readModelRequest: (sessionId: string, messageId: string, executionId: string) => restarting ? undefined : current.readModelRequest(sessionId, messageId, executionId),
    get projectController() { return current.projectController; }, get kanbanController() { return current.kanbanController; },
    openConversationView: (...args: Parameters<OpenConversationView>) => current.openConversationView(...args),
    invokeEntry: (call: AggregateEntryCall) => current.invokeEntry(call),
    hostTurn: async (input: Record<string, unknown>) => { await restarting; return current.hostTurn(input); },
    subscribeConversation: (id: string, listener: (snapshot: EntryConversationSnapshot) => void) => current.subscribeConversation(id, listener),
    setHostUserSettings: async (value: UserSettings) => {
      const settings = parseUserSettings(value);
      host = { ...host, surface: host?.surface ?? 'editor', userSettings: settings };
      await restarting; await current.setHostUserSettings(settings);
    },
    setHostResourceProjects: (value: string[]) => {
      host = { ...host, surface: host?.surface ?? 'editor', resourceProjects: value };
      current.setHostResourceProjects(value);
    },
    setHostWebApps: async (value: Record<string, WebAppBinding>) => {
      host = { ...host, surface: host?.surface ?? 'editor', webApps: value };
      await restarting; await current.setHostWebApps(value);
    },
    setHostConnection: async (value: WebConnection | undefined, ai?: PlatformConnections['ai']) => {
      host = { ...host, surface: host?.surface ?? 'editor', connection: value, systemAiConnection: ai };
      await restarting; await current.setHostConnection(value, ai);
    },
    close: async () => { closing = true; try { await restarting; } finally { await current.close(); } },
  };
}

async function startProjectWebServer(options: WebOptions, credentials: { capability: string; cookie: string }, identityChanged: () => void) {
  const projectDir = await realpath(path.resolve(options.projectDir));
  const folderBot = options.host?.folderBot;
  const baseStorageDir = path.resolve(options.dataDir ?? path.join(os.homedir(), '.steamharness', 'web'));
  const storageDir = folderBot ? folderBotDataRoot(baseStorageDir, folderBot.id) : baseStorageDir;
  assertProjectDataDirectory(projectDir, storageDir);
  const clients = new Set<ServerResponse>();
  const entryObservers = new Set<() => void>();
  let conversationRevision = 0;
  let connection: WebConnection | undefined;
  let aiConnection: PlatformConnections['ai'];
  const runtimeConnection = () => ({ ...connection, aiServerUrl: aiConnection?.serverUrl, aiAccessToken: aiConnection?.accessToken });
  let account: AccountState = { status: 'signed-out', serverUrl: defaultServerUrl(), revision: 0 };
  let signedOut = false;
  let authIdentity: string | undefined = '';
  const browserLogin = sharedWebLogin(credentials ?? options);
  const unsubscribeLogin = browserLogin.subscribe(error => {
    if (hostManaged || !projectOnline) return;
    if (browserLogin.busy) { account = { ...account, status: 'checking', error: undefined }; broadcast(); }
    else { void refreshAuth(true).then(() => { if (error && !hostManaged && !signedOut) { account = { ...account, status: 'error', error }; broadcast(); } }); }
  });
  let hostConnection = options.host?.connection;
  let hostAiConnection = options.host?.systemAiConnection ?? (hostConnection?.aiServerUrl && hostConnection.aiAccessToken ? { serverUrl: hostConnection.aiServerUrl, accessToken: hostConnection.aiAccessToken } : undefined);
  let webApps = options.host?.webApps ?? {};
  let userSettings = options.host?.userSettings ? parseUserSettings(options.host.userSettings) : getUserSettings();
  let hostManaged = options.host !== undefined;
  const projectOnline = Boolean(options.initialPlatform?.project);
  const platformUi = options.host?.platform === true || projectOnline;
  let authEpoch = 0;
  let authenticationInitialized = false;
  let authCheck: AbortController | undefined;
  const sensitiveTokens = new Set<string>();
  const rememberModelKeys = (settings: UserSettings) => { for (const model of settings.agent.models ?? []) if (model.source === "third-party") sensitiveTokens.add(model.apiKey); };
  rememberModelKeys(userSettings);
  let resourceProjects = options.host?.resourceProjects ?? [];
  const hostKind = options.host && process.env[WEB_HOST_ENV] === 'studio' ? 'studio' : 'cli-web';
  const executor = options.runtime ?? createWebRuntime(projectDir, storageDir, runtimeConnection, { entryId: options.entryId, hostKind, folderBot, actor: () => ({ userId: account.user?.userId, isSystemAdmin: false }), userSettings: () => userSettings, entryRuntime: call => {
    if (!options.mount?.invokeEntry) throw new Error('Conversation entry control requires an aggregate host.');
    return options.mount.invokeEntry(call);
  } });
  const runtimeOverrides: Pick<Runtime, 'run' | 'resolveParams' | 'cancel' | 'dispose' | 'kanbanBridge' | 'subscribeConversation' | 'openConversationView'> = {
    openConversationView: (source, target, emit) => {
      if (!options.mount?.openConversationView || source.projectId !== project.id || source.entryId !== project.entryId) throw Object.assign(new Error('A local aggregate host is required.'), { code: 'ENTRY_RUNTIME_UNAVAILABLE' });
      return options.mount.openConversationView({ ...source, userId: account.user?.userId }, target, emit);
    },
    subscribeConversation: (entryId, id, listener) => {
      if (!options.mount?.subscribeConversation) throw new Error('Conversation entry control requires an aggregate host.');
      return options.mount.subscribeConversation(options.entryId!, entryId, id, listener);
    },
    kanbanBridge: async (source, call, abortSignal) => {
      if (call.operation === 'entries.list') return (options.mount?.catalog() as { entries?: unknown[] } | undefined)?.entries ?? [];
      if (call.operation === 'entries.runEntrypoint' || call.operation === 'entries.workflow' || call.operation === 'conversations.snapshot') {
        if (!options.mount?.invokeEntry || source.id !== project.id || source.folderPath !== project.folderPath) throw Object.assign(new Error('A local aggregate execution host is required.'), { code: 'ENTRY_RUNTIME_UNAVAILABLE' });
        return options.mount.invokeEntry({ entryId: String(call.input.entryId),
          projectId: source.id, actor: { userId: account.user?.userId, isSystemAdmin: false }, abortSignal,
          action: call.operation === 'entries.workflow' ? 'workflow-control' : call.operation === 'entries.runEntrypoint' ? 'workflow' : 'snapshot', input: call.input, sourceEntryId: source.entryId });
      }
      throw Object.assign(new Error('The requested Kanban file is unavailable.'), { code: 'KANBAN_FILE_UNAVAILABLE' });
    },
    run: (request, emit, onModelRequest) => {
      const settings = hydrateUserSettings(request.userSettings, userSettings);
      const input = { ...request, userSettings: folderBot?.background ? { agent: { ...settings.agent, permissionPolicy: userSettings.agent.permissionPolicy } } : settings };
      return options.host?.surface === 'editor' && onModelRequest ? executor.run(input, emit, onModelRequest) : executor.run(input, emit);
    },
    resolveParams: (...args) => executor.resolveParams(...args),
    cancel: runId => executor.cancel(runId),
    dispose: () => executor.dispose(),
  };
  const runtime: Runtime = Object.assign(Object.create(executor), runtimeOverrides);
  let inspected;
  try { inspected = await inspectWebProject(runtime, projectDir, options.host); } catch (error) { unsubscribeLogin(); runtime.dispose(); throw error; }
  const descriptor = (inspected.projects.find(entry => entry.entryId === options.entryId) ?? inspected.projects[0]) as Project & { runtime?: { harnessVersion: string; harnessPath: string } };
  try {
    if (!descriptor) throw new Error(inspected.errors.join('\n') || 'No Workflow project found.');
    if (!options.runtime) assertLocalCliCoreCompatible(projectDir, descriptor.runtime!.harnessVersion);
    if (!['bot', 'workflow', 'kanban'].includes(descriptor.projectType)) throw new Error('Unsupported Workflow project type.');
  } catch (error) { unsubscribeLogin(); runtime.dispose(); throw error; }
  const project: Project = projectWithUserSettings(descriptor, userSettings);
  const applyUserSettings = () => {
    const view = projectWithUserSettings({ ...descriptor, agentModelPolicy: project.agentModelPolicy }, userSettings);
    project.fields = view.fields; project.entrypoints = view.entrypoints;
  };
  const resources = new ResourcePreviews(project, runtime, storageDir, () => connection, () => resourceProjects, () => broadcast(), options.mount?.basePath);
  const key = project.assistant ? createHash('sha256').update(`assistant:${project.id}:${project.assistant.workdir}`).digest('hex').slice(0, 24)
    : path.relative(storageDir, await projectDataDirectory(storageDir, projectDir, project.id, project.entryId));
  const activityDirectory = path.join(storageDir, key);
  let saved: { sessions?: ConversationSession[]; activeId?: string; selectionVersion?: number } = {};
  let pendingSave = Promise.resolve();
  const runtimePersistence = options.runtimePersistence ?? createLocalRuntimePersistence({ directory: path.join(activityDirectory, 'runtime') });
  let storageIdentity = '';
  let storageEpoch = 0;
  let storageReset = Promise.resolve();
  let storageInitialization: { epoch: number; promise: Promise<void> } | undefined;
  let storageReady = Boolean(options.runtimePersistence);
  let storageError: string | undefined;
  const ownership = project.projectType === 'bot' ? new ConversationOwnership(() => runtimePersistence,
    id => conversationController?.sessions.find(session => session.id === id)?.agentOwnerId ?? id,
    () => { broadcast(); conversationController?.recover(); },
    (scope, error) => {
      for (const session of conversationController?.sessions ?? []) if ((session.agentOwnerId ?? session.id) === scope && session.activeRunId) runtime.cancel(session.activeRunId);
      storageReady = false; storageError = String((error as Error).message); broadcast();
    }) : undefined;
  const conversationHistory = ownership ? new ConversationHistory(() => runtimePersistence, ownership) : undefined;
  const isHostConversation = (id: string) => controller?.sessions.some(session => session.id === id && session.origin === 'host') === true;
  const selectAccess = (clientId: string, id: string) => isHostConversation(id) ? ownership!.selectHostHistory(clientId) : ownership!.select(clientId, id);
  const assertLocalConversation = (id: string) => {
    if (isHostConversation(id)) throw new Error(t('Read-only IM history. Continue this conversation in IM.'));
  };
  const backgroundAdmissions = new Set<string>();
  const workflowHistory = project.projectType === 'workflow' ? new WorkflowHistory(() => runtimePersistence, error => {
    storageReady = false; storageError = error.message;
    for (const run of projectController?.runs ?? []) if (run.status === 'running') runtime.cancel(run.id);
    broadcast();
  }) : undefined;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  let stateRevision = 0;
  const serverInstanceId = randomBytes(16).toString('hex');
  let authRevision = 0;
  let parameterRevision = 0;
  let activity: ReturnType<typeof createLocalActivityWriter> | undefined;
  const isProject = project.projectType === 'workflow';
  const isKanban = project.projectType === 'kanban';
  const parameterStates = new Map<string, Record<string, ParamState>>();
  const parameterEpochs = new Map<string, number>();
  const navigationSequences = new Map<string, number>();
  const selections = new Map<string, string>();
  const clientIds = new WeakMap<ServerResponse, string>();
  const blockedClients = new Set<ServerResponse>();
  const pendingStates = new Set<ServerResponse>();
  const conversationState = new ConversationState();
  const sessionIdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
  const rememberSelection = (clientId: string, id: string) => {
    selections.set(clientId, id);
    if (selections.size > 256) selections.delete(selections.keys().next().value!);
  };
  const publicFile = (file: Attachment) => ({ ...file, previewUrl: `${options.mount?.basePath ?? ""}/api/file/${encodeURIComponent(file.id)}` });
  const publicValue = (value: unknown): any => {
    if (Array.isArray(value)) { return value.map(publicValue); }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.url === 'string' && /^\/(?:kanban|resource)(?:s|[-/])/.test(record.url) && options.mount) record.url = options.mount.basePath + record.url;
      if (typeof record.id === 'string' && /^wf_[a-f0-9]{32}$/.test(record.id) && typeof record.mimeType === 'string') { return publicFile(record as unknown as Attachment); }
      return Object.fromEntries(Object.entries(record).map(([name, entry]) => [name, publicValue(entry)]));
    }
    return value;
  };
  // Preserve project-owned data keys; remove host credentials by their actual values.
  const publicState = (value: unknown) => publicValue(redactProjectData(JSON.parse(JSON.stringify(value, userSettingsJsonReplacer)), [...sensitiveTokens], false));
  const exportData = (value: unknown) => JSON.stringify(redactProjectData(value, [...sensitiveTokens], false), userSettingsJsonReplacer, 2);
  const exportSession = (session: ConversationSession) => exportData({ ...session, messages: session.messages.map(withoutModelRequest) });
  const sharedState = () => {
    // LLM Bots have no Workflow diagram. Static call definitions can contain the authored system prompt.
    const publicProject = project.conversation?.engine === 'llm' ? { ...project, definitions: undefined } : project;
    const result = publicState({ type: 'state', serverInstanceId, runtimeStorage: { ready: storageReady, error: storageError }, aggregate: options.mount?.catalog(), project: publicProject, configurationError: configurations.error,
    ...(isKanban ? { kanban: kanbanController!.state() } : isProject ? projectActions!.state() : { sessions: conversationState.sessions(controller.sessions) }),
    account: platformUi || aiConnection ? { ...account, signInPending: browserLogin.busy || undefined, user: account.user && { userId: account.user.userId, email: account.user.email, displayName: account.user.displayName, avatarUrl: account.user.avatarUrl } } : undefined,
    authenticationRevision: authRevision, parameterRevision, resourceRevision: resources.revision });
    // Configuration values are user-owned JSON, including explicitly entered credentials.
    return { ...result, configurations: configurations.state };
  };
  const clientState = (clientId?: string) => {
    const selected = controller?.sessions.find(entry => entry.id === selections.get(clientId ?? '')) ?? controller?.current;
    // Pin open pages before navigation changes the persisted default for new pages.
    if (clientId && selected) rememberSelection(clientId, selected.id);
    return publicState({ stateRevision: ++stateRevision,
      ...(selected ? { activeId: selected.id, running: sessionRunning(selected), parameterValues: selected.parameterValues ?? {} } : {}),
      ...(ownership && selected && clientId ? { conversationAccess: selectAccess(clientId, selected.id) } : {}) });
  };
  const state = (clientId?: string) => ({ ...sharedState(), ...clientState(clientId) });
  const writeFrame = (client: ServerResponse, data: string) => {
    if (!client.write(data)) {
      blockedClients.add(client);
      client.once('drain', () => {
        blockedClients.delete(client);
        if (pendingStates.delete(client) && !client.destroyed) writeState(client);
      });
    }
  };
  const writeState = (client: ServerResponse, shared?: string) => {
    // Apply backpressure before constructing, redacting or serializing history.
    if (blockedClients.has(client)) { pendingStates.add(client); return; }
    const base = shared ?? JSON.stringify(sharedState()).slice(0, -1);
    writeFrame(client, `data: ${base},${JSON.stringify(clientState(clientIds.get(client))).slice(1)}\n\n`);
  };
  const broadcast = () => {
    if (broadcastTimer) { return; }
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      conversationRevision++;
      for (const listener of entryObservers) listener();
      if (ownership && conversationController) ownership.update(conversationController.executingIds, new Set(conversationController.sessions.filter(sessionRunning).map(session => session.id)));
      activity?.changed();
      const writable = [...clients].filter(client => {
        if (blockedClients.has(client)) { pendingStates.add(client); return false; }
        return !client.destroyed;
      });
      if (writable.length) {
        const shared = JSON.stringify(sharedState()).slice(0, -1);
        for (const client of writable) writeState(client, shared);
      }
    }, 30);
  };
  let conversationController: ConversationController | undefined;
  let kanbanController: KanbanController | undefined;
  const projectCreation = new ProjectServerCreation(project, () => connection,
    () => account.status === 'authenticated' && account.user ? `${authIdentity}\n${account.user.userId}` : '',
    () => ({ kind: 'project-unavailable', projectId: project.id }), async () => {
      await stopForAuthentication();
    });
  let configurationSignature = '';
  // The built-in assistant has local profiles, not a Server project publication.
  // Its AI connection continues to use the authenticated runtime account.
  const configurations = new ProjectConfigurations(project.assistant ? project.folderPath : projectDir, () => {
    const signature=configurations.signature;
    if(signature!==configurationSignature) {
      configurationSignature=signature;
      project.agentModelPolicy = configurations.state.agentModelPolicy;
      applyUserSettings();
      parameterRevision++;
      parameterStates.clear();
      const previousWebAppConfiguration = project.kanban?.webApp && kanbanController ? JSON.stringify(kanbanController.configuration()) : undefined;
      kanbanController?.configurationChanged(configurations.state);
      if (project.kanban?.webApp && kanbanController && previousWebAppConfiguration !== JSON.stringify(kanbanController.configuration())) {
        webApps = { ...webApps }; delete webApps[project.entryId];
        void kanbanController.setWebAppBinding(undefined);
        options.onWebAppConfigurationChanged?.(project.entryId, kanbanController.configuration());
      }
      conversationController?.configurationChanged();
      resources.clear();
    }
    broadcast();
  }, () => isLocalBuiltinAssistant(project) ? undefined : connection, project.entryId, () => userSettings);
  await configurations.initialize();
  configurationSignature=configurations.signature;
  project.agentModelPolicy = configurations.state.agentModelPolicy;
  applyUserSettings();
  conversationController = isProject || isKanban ? undefined : new ConversationController(project, runtime, saved, {
    canRun: session => (!folderBot || (folderBot.background ? session.origin === 'host' && backgroundAdmissions.has(session.id) : !session.origin)) && (ownership?.execute(session.id) ?? true),
    canStart: () => storageReady,
    canDrain: session => storageReady && !session.origin,
    configurationRevision: () => configurations.state.revision,
    userSettings: () => userSettings,
    independent: session => ownership?.independent(session.id) ?? (() => undefined),
    changed: broadcast,
    log: message => process.stderr.write(`${message}\n`),
    save: (sessions, activeId) => {
      if (!storageReady || !conversationHistory) return Promise.reject(new Error(storageError ?? 'Conversation history is not ready.'));
      pendingSave = conversationHistory.save(sessions, activeId); return pendingSave;
    },
  });
  const controller = conversationController!;
  const projectConversation = (session: ConversationSession) => redactProjectData(conversationProjection(project.entryId, session, serverInstanceId, conversationRevision), [...sensitiveTokens]) as EntryConversationSnapshot;
  const entryConversations = controller ? new EntryConversations(controller, projectConversation, async (session, text, submitted) => {
    const auth = authRevision, configuration = parameterRevision;
    const params = { ...session.parameterValues?.[''], ...submitted };
    const parameters = projectParameters(project);
    const resolved = parameters.paramResolver?.enabled ? await runtime.resolveParams(project, { draftText: text, args: projectParamArgs(parameters.fields, params), inputMode: 'form', trigger: { kind: 'init' } }) : { params: {} };
    for (const [name, patch] of Object.entries(resolved.params ?? {})) {
      if (patch.value === null) delete params[name]; else if (patch.value !== undefined) params[name] = patch.value;
    }
    const configurationSelection = await configurations.selection();
    if (auth !== authRevision || configuration !== parameterRevision) throw new Error('The entry configuration or identity changed.');
    return { params, states: resolved.params, configurationSelection };
  }) : undefined;
  const refreshHistory = async (restoreHostId?: string) => {
    const epoch = storageEpoch;
    const acquired = ownership?.takeAcquired() ?? new Set<string>();
    for (const id of controller?.executingIds ?? []) acquired.delete(id);
    if (!storageReady) return;
    const history = await conversationHistory?.refresh(acquired);
    if (epoch !== storageEpoch || !history?.sessions) return;
    const local = new Map(controller.sessions.map(session => [session.id, session]));
    const merged = history.sessions.map(session => {
      if (ownership!.owns(session.id) && !acquired.has(ownership!.scope(session.id)) && local.has(session.id)) return local.get(session.id)!;
      delete session.activeRunId;
      if (!folderBot?.background) for (const message of session.messages) if (message.status === 'running' && message.runId && message.args && project.conversation?.recovery?.enabled) message.recovering = true;
      return session;
    });
    for (const session of controller.sessions) if (!merged.some(item => item.id === session.id) && ownership!.owns(session.id)) merged.push(session);
    if (!merged.length) return;
    controller.sessions.splice(0, controller.sessions.length, ...merged);
    const reloaded = merged.filter(session => session !== local.get(session.id));
    controller.restoreAgentState(reloaded);
    if (!merged.some(session => session.id === controller.activeId)) controller.activeId = merged[0].id;
    const restored = reloaded.find(session => session.id === restoreHostId && session.origin === 'host');
    if (restored) {
      // Only the background host holding this conversation's lock can settle
      // an interrupted run; a read-only window may be observing a live run.
      controller.restoreInterruptedSessions([restored]);
      await controller.persist();
    }
    broadcast();
  };
  const workspace: WorkspaceContract = { version: 1, runs: [], drafts: {} };
  const projectController = isProject ? new Controller(project, runtime, workspace!, {
    changed: broadcast, legacy: saved.sessions, journal: workflowHistory?.journal,
    log: message => process.stderr.write(`${message}\n`),
    save: workspace => {
      if (!storageReady || !workflowHistory) return Promise.reject(new Error(storageError ?? 'Workflow history is not ready.'));
      pendingSave = workflowHistory.save(workspace); return pendingSave;
    },
  }) : undefined;
  const projectActions = projectController ? createProjectActions(projectController, runtime, project, () => authRevision, broadcast) : undefined;
  const entryWorkflows = projectController ? new EntryWorkflows(projectController, project, runtime) : undefined;
  kanbanController = isKanban ? new KanbanController(project, runtime, storageDir, {
    webAppBinding: () => webApps[project.entryId],
    webAppLogin: options.onWebAppLogin ? configuration => options.onWebAppLogin!(project.entryId, configuration) : undefined,
    changed: broadcast, emit: message => { for (const client of clients) { client.write(`data: ${JSON.stringify(message)}\n\n`); } },
    connection: () => connection, log: message => process.stderr.write(`${redactProjectData(message, [...sensitiveTokens], false)}\n`),
  }) : undefined;
  if (kanbanController) kanbanController.configurationChanged(configurations.state);
  if (kanbanController) { try { await kanbanController.initialize(); } catch (error) { configurations.close(); resources.close(); await kanbanController.close(); runtime.dispose(); throw error; } }
  const stopForAuthentication = async () => {
    if (conversationController) {
      const executing = conversationController.executingIds;
      for (const session of conversationController.sessions) {
        // Stop only local work. Stopping idle or read-only history can reopen
        // saved Agent state or isolate a fork owned by another window.
        const pending = ownership?.owns(session.id) && (sessionRunning(session) || session.agentCommands?.length
          || session.messages.some(message => !messageSettled(message) || message.recovering));
        if (executing.has(session.id) || pending) await conversationController.stop(session);
      }
    }
    if (projectController) { await projectController.stop('Workflow login changed.'); }
  };
  const resetRuntimeStorage = () => {
    storageEpoch++;
    storageReady = Boolean(options.runtimePersistence); storageIdentity = ''; storageError = undefined;
    const resetting = storageReset.then(async () => {
      await conversationHistory?.reset(); await workflowHistory?.reset(); await ownership?.reset();
      conversationController?.replace(await conversationHistory?.read() ?? {});
      projectController?.replace(await workflowHistory?.read() ?? {});
      // CLI Web sign-in reloads the same local history; keep its per-page selection.
      if (hostManaged || signedOut) selections.clear();
    });
    storageReset = resetting.catch(() => undefined); return resetting;
  };
  const initializeRuntimeStorage = (): Promise<void> => {
    if (isKanban) return Promise.resolve();
    const identity = `local:${activityDirectory}`;
    if (storageIdentity === identity && storageReady) return Promise.resolve();
    const epoch = storageEpoch;
    if (storageInitialization?.epoch === epoch) return storageInitialization.promise;
    if (conversationController?.hasRuns || projectController?.runs.some(run => run.status === 'running')) return Promise.resolve();
    const initializing = (async () => {
    await storageReset;
    if (epoch !== storageEpoch) return;
    try {
      const history = await conversationHistory?.read();
      const runs = await workflowHistory?.read();
      if (epoch !== storageEpoch) return;
      if (history) { saved = history; conversationController?.replace(history); }
      if (runs) projectController?.replace(runs);
      storageIdentity = identity; storageReady = true; storageError = undefined;
    } catch (error) {
      if (epoch !== storageEpoch) return;
      storageReady = false; storageError = String((error as Error).message);
      process.stderr.write(`Runtime history: ${storageError}\n`);
    }
    })().finally(() => { if (storageInitialization?.promise === initializing) storageInitialization = undefined; });
    storageInitialization = { epoch, promise: initializing }; return initializing;
  };
  const prepareRuntimeForAuthentication = async (epoch: number, resetStorage: boolean): Promise<boolean> => {
    try {
      await stopForAuthentication();
      if (epoch !== authEpoch) return false;
      if (resetStorage) await resetRuntimeStorage();
      return epoch === authEpoch;
    } catch {
      if (epoch === authEpoch) {
        // Even the same credentials must retry the unfinished runtime transition.
        authIdentity = undefined;
        account = { ...account, status: 'error', user: undefined, expiresAt: undefined, error: t('Sign-in failed.'), revision: account.revision + 1 };
        process.stderr.write('Workflow web authentication failed while updating local runtime state.\n');
        broadcast();
      }
      return false;
    }
  };
  const refreshAuth = async (force = false) => {
    if ((browserLogin.busy) && !force) { return; }
    const readingEpoch = authEpoch;
    const projectAuth = hostManaged ? hostConnection : projectOnline && !signedOut ? (force ? await readOnlineConnection('project') : options.initialPlatform?.project) : undefined;
    if (readingEpoch !== authEpoch) { return; }
    const serverUrl = projectAuth?.serverUrl, token = projectAuth?.accessToken;
    const aiAuth = hostManaged ? hostAiConnection : options.initialPlatform?.ai;
    const aiServerUrl = aiAuth?.serverUrl, aiToken = aiAuth?.accessToken;
    if (token) { sensitiveTokens.add(token); }
    if (aiToken) { sensitiveTokens.add(aiToken); }
    const identity = serverUrl && token && !signedOut ? JSON.stringify([serverUrl, token]) : '';
    const aiChanged = aiConnection?.serverUrl !== aiServerUrl || aiConnection?.accessToken !== aiToken;
    if (aiChanged) {
      aiConnection = aiAuth;
      authRevision++;
      parameterStates.clear();
      account = { ...account, aiConfigured: !!aiAuth, aiServerUrl, revision: account.revision + 1 };
      broadcast();
    }
    if (!force && identity === authIdentity) {
      await initializeRuntimeStorage();
      return;
    }
    const epoch = ++authEpoch;
    authCheck?.abort();
    const check = authCheck = new AbortController();
    const changed = identity !== authIdentity;
    if (changed) projectCreation.close();
    authIdentity = identity;
    const candidate = identity && serverUrl && token ? { serverUrl: serverUrl.replace(/\/+$/, ''), accessToken: token } : undefined;
    if (changed || !connection) {
      account = { status: candidate ? 'checking' : 'signed-out', serverUrl: serverUrl || defaultServerUrl(),
        aiServerUrl, aiConfigured: !!aiAuth, revision: account.revision + 1 };
      broadcast();
    }
    if (changed) {
      resources.clear();
      connection = undefined;
      authRevision++;
      parameterStates.clear();
      projectActions?.invalidate();
      if (authenticationInitialized) {
        kanbanController?.authenticationChanged();
        if (!await prepareRuntimeForAuthentication(epoch, true)) return;
      }
      if (epoch !== authEpoch) { return; }
    }
    if (candidate) {
      let unauthorized = false;
      try {
        const response = await fetch(`${candidate.serverUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${candidate.accessToken}` }, signal: AbortSignal.any([check.signal, AbortSignal.timeout(10_000)]), redirect: 'error' });
        unauthorized = response.status === 401;
        const result = await response.json();
        if (epoch !== authEpoch) { return; }
        const profile = result.data?.profile;
        if (!response.ok || result.errCode !== 0 || typeof profile?.userId !== 'string' || !profile.userId || (profile.email !== null && typeof profile.email !== 'string') || typeof profile.displayName !== 'string') { throw new Error('Workflow login is invalid or expired.'); }
        if (!connection) {
          authRevision++;
          parameterStates.clear();
          projectActions?.invalidate();
        }
        connection = candidate;
        kanbanController?.authenticationChanged(false);
        const next: AccountState = { ...account, status: 'authenticated', user: profile, expiresAt: result.data.principal?.expiresAt, error: undefined };
        if (JSON.stringify(next) !== JSON.stringify(account)) account = { ...next, revision: account.revision + 1 };
      } catch (error) {
        if (epoch !== authEpoch) { return; }
        const wasAuthenticated = !!connection;
        connection = undefined;
        resources.clear();
        if (wasAuthenticated) kanbanController?.authenticationChanged();
        if (!changed && wasAuthenticated) {
          authRevision++; parameterStates.clear(); projectActions?.invalidate();
          if (!await prepareRuntimeForAuthentication(epoch, false)) return;
        }
        if (epoch !== authEpoch) { return; }
        account = { ...account, status: unauthorized ? 'expired' : 'error', user: undefined, expiresAt: undefined, error: String((error as Error).message), revision: account.revision + 1 };
      }
    } else { connection = undefined; }
    await initializeRuntimeStorage();
    broadcast();
  };
  await initializeRuntimeStorage();
  if (options.initialPlatform?.project || options.initialPlatform?.ai || hostConnection || hostAiConnection) await refreshAuth();
  authenticationInitialized = true;
  const { capability, cookie } = credentials;
  let replacementId: string | undefined;
  let origin = '';
  const signInReturnUrl = () => new URL(`${options.mount?.basePath ?? ''}/`, origin).href;
  let signInHandoff: { state: string; previousClientId: string; ticket: string; selectedId?: string } | undefined;
  const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const authMatches = (value: string) => { const a = Buffer.from(value), b = Buffer.from(capability); return a.length === b.length && timingSafeEqual(a, b); };
  const readBody = async (request: IncomingMessage): Promise<Message> => {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 72 * 1024 * 1024) { throw new Error('Request exceeds 72 MiB.'); } chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid request.'); }
    return value;
  };
  const readAttachments = async (files: unknown, sessionId = controller.activeId): Promise<Attachment[]> => {
    if (!Array.isArray(files) || files.length > 32) { throw new Error('Invalid attachments.'); }
    return Promise.all(files.map(async file => { if (typeof file?.id !== 'string') { throw new Error('Invalid attachment.'); } const { reference } = await runtime.readFile(project, file.id); if (reference.conversationId !== sessionId) { throw new Error('Attachment belongs to another conversation.'); } return reference; }));
  };
  const findResourceCard = (reference: ResourceCardReference) => {
    let items, scopeId, source: ResourceCardReference;
    if (projectController) {
      const run = projectController.runs.find(run => run.id === reference.runId);
      if (!run) { throw new Error(t('Run no longer exists.')); }
      items = run.items; scopeId = run.scopeId;
      source = { runId: run.id, cardId: reference.cardId };
    } else {
      const current = reference.sessionId ? conversationController?.sessions.find(entry => entry.id === reference.sessionId) : conversationController?.current;
      if (!current) { throw new Error(t('Conversation no longer exists.')); }
      items = current.messages.find(answer => answer.id === reference.messageId)?.items ?? []; scopeId = current.id;
      source = { sessionId: current.id, messageId: reference.messageId, cardId: reference.cardId };
    }
    const card = conversationResourceCards(items, project.id, project.entryId, scopeId, 'local').find(card => card.id === reference.cardId);
    if (!card) { throw new Error(t('This resource no longer exists.')); }
    return { card, reference: source };
  };
  const handleMessage = async (message: Message): Promise<Message[]> => {
    const held: Array<() => void> = [];
    try {
    if (replacementId || message.applicationId && message.applicationId !== `${project.id}:${project.entryId}`) { throw new Error(t('The application ID changed. The new application is opening.')); }
    if (typeof message.type !== 'string') { throw new Error('Invalid message.'); }
    if (message.projectUri && message.projectUri !== project.uri) { throw new Error('Project changed.'); }
    if (message.type === 'project-reload') {
      if (!options.mount?.reloadProject) throw new Error(t('Project reload is unavailable.'));
      return [{ type: 'project-reloaded', entryId: await options.mount.reloadProject() }];
    }
    if (message.type === 'login' || message.type === 'cancel-login') {
      if (!projectOnline) throw new Error('Run workspace login, then start web with --online project.');
      if (hostManaged) { throw new Error(t('Manage this account through Studio.')); }
      if (message.type === 'cancel-login') { browserLogin.cancel(); return []; }
      if (process.env.STEAMHARNESS_SERVER_ADMIN_KEY !== undefined) { throw new Error('This session is supplied by the host. Sign in through the host.'); }
      if (message.email !== undefined || message.password !== undefined) throw new Error(t('Use browser sign-in.'));
      signedOut = false;
      const signIn = await browserLogin.start(String(message.serverUrl), signInReturnUrl());
      if (!signIn) return [];
      const { clientId, returnTicket } = message;
      if (typeof clientId === 'string' && typeof returnTicket === 'string' && sessionIdPattern.test(clientId) && sessionIdPattern.test(returnTicket)) {
        // The return ticket is local to the initiating tab and separate from its new connection ID.
        signInHandoff = { state: signIn.state, previousClientId: clientId, ticket: returnTicket, selectedId: selections.get(clientId) };
      }
      return [{ type: 'login-started', signIn }];
    }
    if (message.type === 'project-server-check') return [state(message.clientId), { type: 'project-server-checked', requestId: message.requestId }];
    if (message.type === 'project-server-open') {
      if (!connection) throw new Error(t('Please sign in to the project Server.'));
      const selected = connection;
      const url = await projectServerBrowserLink(selected, project.id);
      if (connection?.serverUrl !== selected.serverUrl || connection.accessToken !== selected.accessToken) throw new Error(t('The project or account changed. Check the connection again.'));
      return [{ type: 'project-server-open-url', url }];
    }
    if (message.type === 'project-server-create-prepare') return [{ type: 'project-server-create-context', context: await projectCreation.prepare(message.personal === true) }];
    if (message.type === 'project-server-create-cancel') { projectCreation.cancel(message.token); return []; }
    if (message.type === 'project-server-create-confirm') {
      replacementId = await projectCreation.confirm(message);
      return [{ type: 'project-server-created', projectId: replacementId }];
    }
    if (message.type === 'ready') await configurations.refresh().catch(() => undefined);
    if (message.type === 'kanban-refresh') {
      await configurations.refresh();
      if (kanbanController) { const replies = await kanbanController.handle(message); return [state(message.clientId), ...replies]; }
    }
    if (message.type === 'project-configuration') {
      return [{ type: 'project-configuration-result', requestId: message.requestId, value: await configurations.dispatch(message.call) }];
    }
    if (message.type === 'project-ai-catalog') {
      const epoch = authEpoch, revision = authRevision;
      const value = await loadAgentModelCatalog(runtimeConnection());
      if (epoch !== authEpoch || revision !== authRevision) throw new Error('Account changed. Refresh AI models.');
      return [{ type: 'project-ai-catalog-result', requestId: message.requestId, value }];
    }
    if (message.type === 'project-mention-files') {
      if (project.projectType !== 'bot' || typeof message.requestId !== 'string' || message.requestId.length > 256
        || typeof message.query !== 'string' || message.query.length > 256 || /[\0\r\n]/.test(message.query)) throw new Error('Invalid file reference search.');
      return [{ type: 'project-mention-files-result', requestId: message.requestId, value: await projectMentionFiles(project, message.query) }];
    }
    if (message.type === 'project-skills') {
      if (typeof message.requestId !== 'string' || message.requestId.length > 256
        || message.skillId !== undefined && (typeof message.skillId !== 'string' || message.skillId.length > 8192)) throw new Error('Invalid skill request.');
      const entrypointId = message.entrypointId || project.defaultEntrypoint;
      if (entrypointId !== undefined && (typeof entrypointId !== 'string' || !project.entrypoints.some(entry => entry.id === entrypointId))) throw new Error('Unknown entrypoint.');
      if (!runtime.listSkills || !runtime.readSkill) throw new Error(t('Skill preview is unavailable. Update the project runtime.'));
      const value = message.skillId === undefined ? await runtime.listSkills(project, entrypointId) : await runtime.readSkill(project, message.skillId, entrypointId);
      return [{ type: 'project-skills-result', requestId: message.requestId, value }];
    }
    if (message.type === 'project-configuration-upload') {
      const current = await configurations.refresh(), revision = authRevision;
      if (message.revision !== current.revision) throw new Error('Configuration changed. Refresh before saving your draft.');
      if (!current.configurations.some(item => item.id === message.id)) throw new Error('Configuration no longer exists.');
      const field = current.fields.find(item => item.name === message.key);
      if (field?.type !== 'file') throw new Error('Invalid configuration file field.');
      if(!configurationCapability(current,field).editable)throw new Error('Configuration is locked by the author.');
      const reference = await uploadConfigurationFile(project.id, field, message.file, connection, { entryId: project.entryId, target: current.template?.projectVersion });
      if (revision !== authRevision) throw new Error('Account changed. Select the file again.');
      return [{type:'project-configuration-upload-result',requestId:message.requestId,value:reference}];
    }
    if (message.type === 'resource-data') {
      try { return [{ type: 'resource-data', requestId: message.requestId, data: resources.get(String(message.id)) }]; }
      catch (error) { if (!message.reference) { throw error; } }
    }
    if (['resource-data', 'resource-refresh'].includes(message.type)) {
      // Only a saved card may restore an expired preview; never accept a client-supplied resource target.
      const card = message.reference ? findResourceCard(message.reference).card : resources.get(String(message.id)).card;
      const preview = await resources.open(card);
      return [{ type: 'resource-data', requestId: message.requestId, id: preview.id, data: preview.data }];
    }
    if (message.type === 'resource-bridge') { return [{ type: 'resource-bridge', requestId: message.requestId, value: await resources.bridge(String(message.id), message.call) }]; }
    if (message.type === 'resource-method-state') { return [{ type: 'resource-method-state', requestId: message.requestId, messages: resources.methodState(String(message.id), message) }]; }
    if (message.type === 'resource-method-reply') { resources.methodReply(String(message.id), message); return []; }
    if (message.type === 'resource-method-close') { resources.methodClose(String(message.id), message); return []; }
    if (message.type === 'resource-kanban-diagnostics') { return [{ type: 'kanban-diagnostics-result', requestId: message.requestId, value: await resources.diagnostics(message.target) }]; }
    if (message.type === 'resource') {
      if (!['open', 'inline', 'window', 'project', undefined].includes(message.action)) { throw new Error(t('Invalid resource action.')); }
      const { card, reference } = findResourceCard(message as ResourceCardReference);
      const preview = await resources.open(card);
      return [{ type: 'resource-preview', requestId: message.requestId, cardId: card.id, action: message.action ?? 'open',
        id: preview.id, url: `${preview.url}&resourceRef=${encodeURIComponent(JSON.stringify(reference))}`, card, project: preview.data.project }];
    }
    if (kanbanController && !['ready', 'verify', 'logout', 'usage'].includes(message.type)) { return kanbanController.handle(message); }
    if (projectActions && !['ready', 'verify', 'logout', 'usage'].includes(message.type)) { return publicValue(await projectActions.handle(message)); }
    if (message.type === 'navigate') {
      await refreshHistory();
      if (!conversationController || typeof message.id !== 'string' || !Array.isArray(message.updates) || message.updates.length > 1000
        || typeof message.clientId !== 'string' || !sessionIdPattern.test(message.clientId) || !Number.isSafeInteger(message.requestId) || message.requestId < 1) { throw new Error('Invalid conversation navigation.'); }
      const reply = () => [state(message.clientId), { type: 'navigated', requestId: message.requestId, activeId: selections.get(message.clientId) ?? conversationController.activeId }];
      if (message.requestId < (navigationSequences.get(message.clientId) ?? 0)) { return reply(); }
      navigationSequences.delete(message.clientId); navigationSequences.set(message.clientId, message.requestId);
      if (navigationSequences.size > 256) { navigationSequences.delete(navigationSequences.keys().next().value!); }
      const updates: ConversationDraftUpdate[] = [];
      const ids = new Set<string>();
      for (const update of message.updates) {
        if (typeof update?.id !== 'string' || ids.has(update.id) || update.create && !sessionIdPattern.test(update.id)
          || typeof update.draft?.text !== 'string' || update.draft.text.length > 100_000 || update.draft.editingQueueId !== undefined && typeof update.draft.editingQueueId !== 'string') { throw new Error('Invalid conversation draft.'); }
        ids.add(update.id);
        const references = pathReferences(update.draft.references);
        updates.push({ id: update.id, create: update.create === true, draft: { text: update.draft.text, editingQueueId: update.draft.editingQueueId, attachments: await readAttachments(update.draft.attachments, update.id), ...(references.length ? { references } : {}) } });
      }
      if (navigationSequences.get(message.clientId) === message.requestId) {
        const writable: ConversationDraftUpdate[] = [];
        for (const update of updates) {
          const session = controller.sessions.find(session => session.id === update.id);
          if (isHostConversation(update.id)) continue;
          try {
            await ownership?.assertWritable(update.id, message.clientId);
            if (ownership) held.push(await ownership.hold(update.id));
            writable.push(update);
          }
          catch (error) { if (!session || JSON.stringify(update.draft) !== JSON.stringify(session.draft)) throw error; }
        }
        await refreshHistory();
        await conversationController.navigate(message.id, writable.filter(update => !isHostConversation(update.id)));
        rememberSelection(message.clientId, message.id);
      }
      return reply();
    }
    if (ownership && (message.type === 'ready' || message.type === 'select')) {
      // IM history can arrive from another process and must never take a page writer.
      await refreshHistory();
      const selectedId = message.type === 'select' ? String(message.id) : selections.get(message.clientId ?? '') ?? controller.activeId;
      if (!isHostConversation(selectedId) && controller.sessions.some(session => session.id === selectedId)) await ownership.acquire(selectedId);
    }
    await refreshHistory();
    const replies: Message[] = [];
    let current = (message.sessionId ? conversationController?.sessions.find(entry => entry.id === message.sessionId) : conversationController?.current) as ConversationSession;
    if (!isKanban && !isProject && !current) { throw new Error(t("Conversation no longer exists.")); }
    const readOnly = ['ready', 'select', 'new', 'agent-open', 'trace', 'logs', 'export-message', 'usage', 'verify', 'logout'];
    if (ownership && !readOnly.includes(message.type) && !(message.type === 'session-action' && message.action === 'export')) {
      const target = message.type === 'session-action' ? controller.sessions.find(session => session.id === message.id) : current;
      if (target) {
        assertLocalConversation(target.id);
        await ownership.assertWritable(target.id, message.clientId);
        held.push(await ownership.hold(target.id));
        await refreshHistory();
        assertLocalConversation(target.id);
        current = controller.sessions.find(session => session.id === current.id)!;
      }
    }
    const entrypointId = typeof message.entrypointId === 'string' && message.entrypointId ? message.entrypointId : project.defaultEntrypoint;
    if (entrypointId && !project.entrypoints.some(entry => entry.id === entrypointId)) { throw new Error('Unknown entrypoint.'); }
    switch (message.type) {
      case 'ready': replies.push(state(message.clientId)); break;
      case 'agent-command': {
        if (!message.command || typeof message.command.requestId !== 'string' || message.command.requestId.length > 256) throw new Error('Invalid agent command.');
        if (message.agentOwner !== undefined && current.agent?.ownerId !== message.agentOwner) {
          // A stopped process can be replaced while the user's explicit Stop
          // is in flight. Permit it only for the very same run and task set.
          const sameTasks = Array.isArray(message.taskIds) && message.taskIds.length > 0
            && message.taskIds.every((id: unknown) => Number.isSafeInteger(id))
            && JSON.stringify([...message.taskIds].sort((a, b) => a - b)) === JSON.stringify(current.agent?.tasks.map(task => task.id).sort((a, b) => a - b));
          if (message.errorScope !== 'stop' || message.command.type !== 'cancel' || !['foreground', 'all'].includes(message.command.scope)
            || !message.runId || message.runId !== current.activeRunId || !sameTasks) throw new Error(t('Task state changed. Refresh the trace and try again.'));
        }
        if (message.errorScope === 'stop' && message.command.type === 'cancel' && message.command.scope === 'all' && message.command.targetId === undefined) {
          if (message.runId !== undefined && current.activeRunId && message.runId !== current.activeRunId) throw new Error(t('Task state changed. Refresh the trace and try again.'));
          await controller.stop(current, message.command.requestId);
          replies.push(state(message.clientId), { type: 'stopped', projectUri: project.uri, sessionId: current.id, requestId: message.command.requestId });
          break;
        }
        const receipt = await controller.agentCommand(current.id, message.command);
        const fork = receipt.forkId === undefined ? undefined : controller.sessions.find(entry => entry.agentOwnerId === (current.agentOwnerId ?? current.id) && entry.agentConversationId === receipt.forkId
          || entry.forkSource?.agentOwnerId === (current.agentOwnerId ?? current.id) && entry.forkSource.agentConversationId === receipt.forkId);
        replies.push(state(message.clientId), { type: 'agent-receipt', receipt, projectUri: project.uri, sessionId: current.id, requestId: message.command.requestId, forkSessionId: fork?.id });
        break;
      }
      case 'agent-open': {
        assertLocalConversation(current.id);
        if (!Number.isSafeInteger(message.conversationId)) throw new Error('Invalid agent conversation.');
        if (message.agentOwner !== undefined && current.agent?.ownerId !== message.agentOwner) throw new Error(t('Task state changed. Refresh the trace and try again.'));
        const sessionId = await controller.openAgentConversation(current.id, message.conversationId);
        replies.push(state(message.clientId), { type: 'agent-opened', sessionId, sourceSessionId: current.id, projectUri: project.uri, requestId: message.requestId }); break;
      }
      case 'resolve': {
        try {
          const parameters = projectParameters(project, entrypointId);
          const supplied = message.params ?? {};
          if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.values(supplied).some(value => typeof value !== 'string' && !(Array.isArray(value) && value.every(entry => typeof entry === 'string')))) { throw new Error('Invalid parameters.'); }
          const values: ParamValues = Object.fromEntries(parameters.fields.filter(field => supplied[field.name] !== undefined).map(field => [field.name, supplied[field.name]]));
          const stateKey = `${current.id}:${entrypointId ?? ''}`;
          const epoch = (parameterEpochs.get(stateKey) ?? 0) + 1;
          parameterEpochs.set(stateKey, epoch);
          const revision = authRevision;
          const configurationRevision = parameterRevision;
          const parameterRevisions = JSON.stringify(current.parameterRevisions?.[entrypointId ?? ''] ?? {});
          const states = parameterStates.get(stateKey) ?? {};
          const trigger = message.trigger?.kind === 'param' && parameters.fields.some(field => field.name === message.trigger.paramName)
            ? { kind: 'param' as const, paramName: message.trigger.paramName as string } : { kind: message.trigger?.kind === 'input' ? 'input' as const : 'init' as const };
          const result = parameters.paramResolver?.enabled ? await runtime.resolveParams(project, { draftText: String(message.draftText ?? '').slice(0, 20_000), args: projectParamArgs(parameters.fields, values, states), inputMode: 'form', trigger }, entrypointId) : { params: {} };
          const latest = controller.sessions.find(session => session.id === current.id);
          if (revision !== authRevision || configurationRevision !== parameterRevision || !latest || parameterRevisions !== JSON.stringify(latest.parameterRevisions?.[entrypointId ?? ''] ?? {})) {
            replies.push(state(message.clientId), { type: 'params', projectUri: project.uri, sessionId: current.id, requestId: message.requestId, stale: true });
            break;
          }
          // Reply to every page; only the newest request may persist shared parameters.
          if (parameterEpochs.get(stateKey) === epoch) {
            const nextStates = mergeProjectParamStates(states, result.params);
            if (project.projectType === 'bot') { validateConversationCommandStates(parameters.fields, nextStates, project.conversation?.commands); }
            for (const [name, patch] of Object.entries(result.params ?? {})) {
              if (patch.value === null) { delete values[name]; } else if (patch.value !== undefined) { values[name] = patch.value; }
            }
            parameterStates.set(stateKey, nextStates);
            (latest.parameterValues ??= {})[entrypointId ?? ''] = values;
            await controller.persist();
          }
          replies.push({ type: 'params', projectUri: project.uri, sessionId: current.id, requestId: message.requestId, params: result.params });
        } catch (error) { replies.push({ type: 'params', projectUri: project.uri, sessionId: current.id, requestId: message.requestId, error: String((error as Error).message) }); }
        break;
      }
      case 'command': case 'send': {
        const command = message.type === 'command' ? project.conversation?.commands?.find(entry => entry.command === message.command) : undefined;
        if (message.type === 'command') {
          if (project.projectType !== 'bot' || !command) { throw new Error(t("Unknown conversation command.")); }
          if (sessionRunning(current) || current.messages.some(answer => answer.pendingInput) || current.queuedInputs?.length || current.draft?.editingQueueId) { throw new Error(t("The current session is running.")); }
          if (command.action.kind === 'export') {
            const name = `conversation-${current.id}.json`;
            const count = current.messages.length + 2;
            await controller.recordCommand(command.command, t("Conversation export ready: {0} ({1} messages).", name, count), current);
            replies.push({ type: 'download', name, content: exportSession(current) },
              { type: 'command-executed', command: command.command, sessionId: current.id });
            break;
          }
        }
        const text = command?.action.kind === 'prompt' ? command.action.text : message.text;
        if (typeof text !== 'string' || text.length > 100_000) { throw new Error('Invalid message text.'); }
        const params = message.params as ParamValues;
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.values(params).some(value => typeof value !== 'string' && !(Array.isArray(value) && value.every(entry => typeof entry === 'string')))) { throw new Error('Invalid parameters.'); }
        const parameters = projectParameters(project, entrypointId);
        const stateKey = `${current.id}:${entrypointId ?? ''}`;
        parameterEpochs.set(stateKey, (parameterEpochs.get(stateKey) ?? 0) + 1);
        const revision = authRevision;
        const configurationRevision = parameterRevision;
        const resolved = parameters.paramResolver?.enabled ? await runtime.resolveParams(project, { draftText: text, args: projectParamArgs(parameters.fields, params), inputMode: 'form', trigger: { kind: 'init' } }, entrypointId) : { params: {} };
        if (revision !== authRevision) { throw new Error('Workflow login changed. Send the message again.'); }
        if (configurationRevision !== parameterRevision) { throw new Error(t('Project configuration changed. Send the message again.')); }
        const states = mergeProjectParamStates(parameterStates.get(stateKey) ?? {}, resolved.params);
        if (project.projectType === 'bot') { validateConversationCommandStates(parameters.fields, states, project.conversation?.commands); }
        for (const [name, patch] of Object.entries(resolved.params ?? {})) {
          if (patch.value === null) { delete params[name]; } else if (patch.value !== undefined) { params[name] = patch.value; }
        }
        validateProjectValues(parameters.fields, params, states);
        const attachments = command ? [] : await readAttachments(message.attachments ?? [], current.id);
        if (revision !== authRevision) { throw new Error('Workflow login changed. Send the message again.'); }
        if (configurationRevision !== parameterRevision) { throw new Error(t('Project configuration changed. Send the message again.')); }
        parameterStates.set(stateKey, states);
        (current.parameterValues ??= {})[entrypointId ?? ''] = { ...params };
        if (message.mode !== undefined && !['steer', 'followUp', 'reject'].includes(message.mode)) throw new Error('Invalid input mode.');
        if (message.requestId !== undefined && (typeof message.requestId !== 'string' || !sessionIdPattern.test(message.requestId))) throw new Error('Invalid input identity.');
        if (message.editingQueueId !== undefined && typeof message.editingQueueId !== 'string') throw new Error('Invalid queued input identity.');
        const references = command ? [] : pathReferences(message.references);
        const configurationSelection=await configurations.selection();
        if(revision!==authRevision)throw new Error('Workflow login changed. Send the message again.');
        await controller.send({ text, params, states, entrypointId, attachments, configurationSelection, ...(references.length ? { references } : {}) }, current, !!command || message.preserveDraft === true, message.requestId, message.mode, message.editingQueueId);
        replies.push(state(message.clientId), { type: command ? 'command-executed' : 'sent', ...(command ? { command: command.command } : {}), projectUri: project.uri, sessionId: current.id, requestId: message.requestId }); break;
      }
      case 'stop': {
        if (message.runId !== undefined && current.activeRunId !== message.runId) throw new Error(t('Task state changed. Refresh the trace and try again.'));
        await controller.stop(current);
        replies.push(state(message.clientId), { type: 'stopped', projectUri: project.uri, sessionId: current.id, requestId: message.requestId });
        break;
      }
      case 'new':
        if (!isHostConversation(current.id) && (!ownership || !message.clientId || !selectAccess(message.clientId, current.id).readOnly)) await controller.updateDraft(current.id, String(message.text ?? ''), await readAttachments(message.attachments ?? [], current.id), undefined, pathReferences(message.references));
        await controller.create(true);
        if (message.clientId) rememberSelection(message.clientId, controller.activeId);
        break;
      case 'select':
        await controller.select(String(message.id));
        if (message.clientId) rememberSelection(message.clientId, controller.activeId);
        break;
      case 'draft': await controller.updateDraft(current.id, String(message.text ?? ''), await readAttachments(message.attachments ?? [], current.id), undefined, pathReferences(message.references)); break;
      case 'retry': await controller.retry(String(message.messageId), current); break;
      case 'resume': await controller.resume(String(message.messageId), String(message.requestId), message.values ?? {}, current); break;
      case 'tool-policy': {
        const tools = projectParameters(project, entrypointId).tools ?? [];
        current.toolPermissionPolicies = Object.fromEntries(tools.map(tool => [tool.name, { enabled: typeof message.policies?.[tool.name]?.enabled === 'boolean' ? message.policies[tool.name].enabled : tool.enabled, autoApprove: typeof message.policies?.[tool.name]?.autoApprove === 'boolean' ? message.policies[tool.name].autoApprove : tool.autoApprove }]));
        await controller.persist(); broadcast(); break;
      }
      case 'queue-edit': await controller.editQueued(String(message.id), current); break;
      case 'queue-remove':
      case 'queue-promote': {
        if (message.requestId !== undefined && (typeof message.requestId !== 'string' || !sessionIdPattern.test(message.requestId))) throw new Error('Invalid queue action identity.');
        if (message.type === 'queue-remove') await controller.removeQueued(String(message.id), current, message.requestId);
        else await controller.promoteQueued(String(message.id), current, message.requestId);
        replies.push(state(message.clientId), { type: 'queue-updated', projectUri: project.uri, sessionId: current.id, requestId: message.requestId, id: message.id });
        break;
      }
      case 'queue-cancel-edit': await controller.cancelQueueEdit(current); break;
      case 'queue-run': await controller.runQueued(current); break;
      case 'queue-reorder': if (Array.isArray(message.ids) && message.ids.every((id: unknown) => typeof id === 'string')) { await controller.reorderQueued(message.ids, current); } break;
      case 'session-action': {
        const session = controller.sessions.find(entry => entry.id === message.id);
        if (!session) { throw new Error('Conversation no longer exists.'); }
        if (message.action === 'rename') { await controller.rename(session.id, String(message.title ?? '')); }
        else if (message.action === 'lock') { await controller.lockTitle(session.id, !session.titleLocked); }
        else if (message.action === 'delete') {
          const previous = controller.sessions.map(session => session.id);
          await controller.remove(session.id);
          await Promise.all(previous.filter(id => !controller.sessions.some(session => session.id === id)).map(id => rm(path.join(storageDir, key, 'conversation-imports', path.basename(id)), { recursive: true, force: true })));
        }
        else if (message.action === 'export') { replies.push({ type: 'download', name: `conversation-${session.id}.json`, content: exportSession(session) }); }
        break;
      }
      case 'resolve-paths':
      case 'import-drop': {
        const references = message.type === 'resolve-paths' ? await resolveDroppedPaths(message.paths)
          : await importDroppedEntries(path.join(storageDir, key, 'conversation-imports', current.id), message.entries);
        replies.push({ type: 'path-references', projectUri: project.uri, sessionId: current.id, requestId: message.requestId, references });
        break;
      }
      case 'upload': {
        if (!Array.isArray(message.files) || message.files.length > 32 || message.files.some((file: Message) => typeof file?.name !== 'string' || typeof file.data !== 'string' || file.path !== undefined)) { throw new Error('Invalid upload.'); }
        const files = await runtime.uploadFiles(project, current.id, message.files);
        replies.push({ type: 'attachments', projectUri: project.uri, sessionId: current.id, paramName: message.paramName, messageId: message.messageId, requestId: message.requestId, files: files.map(publicFile) }); break;
      }
      case 'trace': case 'logs': case 'export-message': {
        const answer = current.messages.find(entry => entry.id === message.messageId);
        if (!answer) { throw new Error('Message no longer exists.'); }
        if (message.type === 'export-message') { replies.push({ type: 'download', name: `run-${answer.id}.json`, content: exportData(withoutModelRequest(answer)) }, { type: 'exported', sessionId: current.id, messageId: answer.id }); }
        else { replies.push({ type: 'preview', title: message.type === 'logs' ? t("Run logs") : t("Trace"), content: message.type === 'logs' ? answer.report?.logs ?? '' : { report: answer.report, events: answer.events, items: answer.items } }); }
        break;
      }
      case 'usage': {
        const revision = authRevision;
        if (!aiConnection) { throw new Error(t('System AI is unavailable.')); }
        const response = await fetch(`${aiConnection.serverUrl}/api/ai/usage`, { headers: { Authorization: `Bearer ${aiConnection.accessToken}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); const result = await response.json();
        if (revision !== authRevision) { throw new Error(t("Account changed. Refresh usage.")); }
        if (!response.ok || result.errCode !== 0) { throw new Error(result.errMessage || 'Cannot load usage.'); }
        replies.push({ type: 'usage', requestId: message.requestId, sessionId: current?.id, usage: result.data }); break;
      }
      case 'verify': await refreshAuth(true); break;
      case 'logout': {
        if (hostManaged || !projectOnline) { throw new Error(t("Manage this account through Studio.")); }
        signedOut = true; browserLogin.cancel(); if (process.env.STEAMHARNESS_SERVER_ADMIN_KEY === undefined) { await signOutCliAccount(); } await refreshAuth(true); break;
      }
      default: throw new Error(`Unsupported action: ${message.type}`);
    }
    return replies;
    } finally { for (const release of held) release(); }
  };
  let mutations = Promise.resolve();
  let closing: Promise<void> | undefined;
  const pendingMessages = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
      const host = new URL(`http://${request.headers.host ?? ''}`);
      // SSH forwards TCP without rewriting the browser's loopback Host header.
      const forwarded = !!options.host && ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && !host.username && !host.password && host.pathname === '/' && !host.search && !host.hash;
      const url = new URL(request.url ?? '/', origin);
      if (options.host && options.mount && studioPreviewMount(request) && url.pathname.startsWith('/studio-app/')) {
        const hosted = kanbanController?.hostedPreview;
        const pathname = url.pathname.slice('/studio-app'.length);
        if (!hosted || !pathname.startsWith(`/${kanbanController!.preview.nonce}/`)) { response.writeHead(404).end(); return; }
        request.url = pathname + url.search;
        return hosted.handle(request, response, origin, `${options.mount.basePath}/studio-app`);
      }
      const resourceAsset = url.pathname.startsWith('/kanban/') || url.pathname.startsWith('/resource-assets/');
      const sandboxAsset = resourceAsset && ['GET', 'HEAD'].includes(request.method ?? '') && request.headers.origin === 'null';
      if (request.headers.host !== new URL(origin).host && !forwarded || request.headers.origin && request.headers.origin !== (forwarded ? host.origin : origin) && !sandboxAsset) { json(response, 403, { message: 'Invalid request origin.' }); return; }
      if (request.method === 'GET' && url.searchParams.has('auth_state')
        && (url.pathname !== '/' || !browserLogin.matchesReturn(url.searchParams.get('auth_state')!, signInReturnUrl()))) {
        json(response, 400, { message: 'Invalid sign-in return.' }); return;
      }
      if (resourceAsset && ['GET', 'HEAD'].includes(request.method ?? '')) {
        const asset = await kanbanController?.preview.asset(url) ?? await resources.asset(url);
        if (!asset) { json(response, 404, { message: 'Kanban asset not found.' }); return; }
        response.writeHead(200, asset.headers); response.end(request.method === 'HEAD' ? undefined : asset.content); return;
      }
      if (url.pathname === '/api/session' && request.method === 'POST') {
        if (!authMatches(String(request.headers.authorization ?? '').replace(/^Bearer /, ''))) { json(response, 401, { message: 'Invalid session.' }); return; }
        response.setHeader('Set-Cookie', `${cookie}=${capability}; HttpOnly; SameSite=Strict; Path=/`); json(response, 200, { ok: true }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (request.headers['sec-fetch-site'] === 'cross-site') { json(response, 403, { message: 'Invalid request origin.' }); return; }
        const value = String(request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookie}=`))?.slice(cookie.length + 1) ?? '';
        const bearer = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
        const readSession = request.method === 'GET' && (url.pathname === '/api/events' || url.pathname.startsWith('/api/file/')) ? url.searchParams.get('session') ?? '' : '';
        if (!authMatches(value) && !authMatches(bearer) && !authMatches(readSession)) { json(response, 401, { message: 'Open the URL printed by steamharness web.' }); return; }
        if (url.pathname === '/api/session' && request.method === 'GET') { json(response, 200, { connected: true }); return; }
        if (url.pathname === '/api/resource-state' && request.method === 'GET') { json(response, 200, { type: 'state', project: { id: project.id, entryId: project.entryId }, authenticationRevision: authRevision, resourceRevision: resources.revision }); return; }
        if (url.pathname === '/api/events' && request.method === 'GET') {
          const clientId = url.searchParams.get('clientId') ?? '';
          if (signInHandoff && signInHandoff.ticket === url.searchParams.get('returnTicket')
            && clientId !== signInHandoff.previousClientId && sessionIdPattern.test(clientId)) {
            const { state, previousClientId, selectedId } = signInHandoff;
            signInHandoff = undefined;
            if (browserLogin.matchesReturn(state, signInReturnUrl())) {
              for (const client of clients) {
                if (clientIds.get(client) === previousClientId) { clients.delete(client); client.end(); }
              }
              ownership?.handoff(previousClientId, clientId);
              if (selectedId) rememberSelection(clientId, selectedId);
            }
          }
          await refreshHistory();
          if (closing) { json(response, 503, { message: t('The project is already reloading. Try again shortly.') }); return; }
          const disconnectKanban = kanbanController?.methods.connect(clientId);
          clientIds.set(response, clientId);
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); writeState(response); clients.add(response);
          const heartbeat = setInterval(() => { if (!blockedClients.has(response)) writeFrame(response, 'event: heartbeat\ndata: {}\n\n'); }, 20_000);
          response.once('close', () => {
            clearInterval(heartbeat); clients.delete(response); blockedClients.delete(response); pendingStates.delete(response); disconnectKanban?.();
            if (clientId && ![...clients].some(client => clientIds.get(client) === clientId)) { ownership?.disconnect(clientId, broadcast); kanbanController?.disconnectClient(clientId); }
          }); return;
        }
        if (url.pathname === '/api/message' && request.method === 'POST') {
          const message = await readBody(request);
          if (closing) { json(response, 503, { message: t('The project is already reloading. Try again shortly.') }); return; }
          if (message.type === 'project-reload') {
            json(response, 200, { messages: await handleMessage(message) }); return;
          }
          let messages: Message[] = [];
          const operation = () => handleMessage(message).then(value => { messages = value; });
          const concurrent = ['stop', 'workflow-stop', 'navigate', 'resolve', 'ready', 'project-server-check', 'verify', 'logout', 'usage', 'resource', 'resource-data', 'resource-refresh', 'resource-select', 'resource-bridge', 'resource-method-state', 'resource-method-reply', 'resource-method-close', 'resource-kanban-diagnostics', 'kanban-bridge', 'kanban-method-state', 'kanban-method-reply', 'kanban-methods', 'kanban-diagnostics'].includes(message.type)
            || message.type === 'agent-command' && message.command?.type === 'cancel';
          const task = concurrent ? operation() : mutations.catch(() => undefined).then(operation);
          if (!concurrent) { mutations = task; }
          pendingMessages.add(task);
          try { await task; } finally { pendingMessages.delete(task); }
          if (replacementId) { response.once('finish', identityChanged); }
          json(response, 200, { messages: messages.map(message => message.type === 'state' || message.type === 'project-configuration-result' || message.type === 'project-configuration-upload-result' ? message : redactProjectData(message, [...sensitiveTokens], false)) }); return;
        }
        if (url.pathname.startsWith('/api/file/') && request.method === 'GET') {
          const file = await runtime.readFile(project, decodeURIComponent(url.pathname.slice('/api/file/'.length)));
          const bytes = await readFile(file.path); const safeType = /^(?:image\/(?:png|jpeg|gif|webp|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/.test(file.reference.mimeType);
          response.writeHead(200, { 'Content-Type': safeType ? file.reference.mimeType : 'application/octet-stream', 'Content-Disposition': `${safeType ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.reference.name)}`, 'Cache-Control': 'no-store' }); response.end(bytes); return;
        }
        json(response, 404, { message: 'Unknown API endpoint.' }); return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { message: 'Method not allowed.' }); return; }
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (url.pathname === '/' || /^\/resource\/[a-f\d-]{36}$/.test(url.pathname)) {
        const base = (options.host ? studioPreviewMount(request) : '') + (options.mount?.basePath ?? '');
        const ancestors = options.host ? "'self' vscode-webview: vscode-file: https://*.vscode-cdn.net https://*.vscode-webview.net http://127.0.0.1:* http://localhost:*" : "'self' vscode-webview:";
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-src 'self' https: http:; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors}; form-action 'self'` });
        const ui = url.pathname !== '/' ? 'resource-preview' : isKanban ? 'kanban-workspace' : isProject ? 'workflow-workspace' : 'workflow-ui';
        response.end(`<!doctype html><html lang="${locale()}" data-theme="${options.theme ?? 'auto'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="steamharness-project" content="${key}"><meta name="steamharness-base" content="${base}"><title>Workflow</title><link rel="stylesheet" href="${base}/assets/codicons/codicon.css"><link rel="stylesheet" href="${base}/assets/${ui}.css"><link rel="stylesheet" href="${base}/assets/theme.css"></head><body data-surface="${options.host?.surface ?? 'editor'}" data-account-host="${hostManaged}" data-platform="${platformUi}"><div id="app"></div><script src="${base}/assets/${ui}.js" defer></script></body></html>`); return;
      }
      const assets: Record<string, string> = { '/assets/workflow-ui.js': 'application/javascript', '/assets/workflow-ui.css': 'text/css', '/assets/theme.css': 'text/css', '/assets/codicons/codicon.css': 'text/css', '/assets/codicons/codicon.ttf': 'font/ttf' };
      assets['/assets/workflow-workspace.js'] = 'application/javascript'; assets['/assets/workflow-workspace.css'] = 'text/css';
      assets['/assets/kanban-workspace.js'] = 'application/javascript'; assets['/assets/kanban-workspace.css'] = 'text/css';
      assets['/assets/resource-preview.js'] = 'application/javascript'; assets['/assets/resource-preview.css'] = 'text/css';
      if (!assets[url.pathname]) { json(response, 404, { message: 'Not found.' }); return; }
      const content = await readFile(path.join(cliRoot(), 'dist/web', url.pathname.slice('/assets/'.length))); response.writeHead(200, { 'Content-Type': assets[url.pathname], 'Cache-Control': 'no-cache' }); response.end(content);
    })().catch(error => { if (!response.headersSent) { json(response, 400, { message: String(redactProjectData((error as Error).message, [...sensitiveTokens])) }); } else { response.end(); } });
  });
  try { if (!options.mount) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { projectCreation.close(); ownership?.close(); configurations.close(); resources.close(); conversationController?.dispose(); projectController?.dispose(); await kanbanController?.close(); runtime.dispose(); throw error; }
  origin = options.mount?.origin ?? `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  activity = createLocalActivityWriter(activityDirectory, project, () => ({
    identity: connection && account.user ? `${connection.serverUrl}\n${account.user.userId}` : '', runs: summarizeLocalRuns(projectController?.runs, conversationController?.sessions),
    queued: (conversationController?.sessions ?? []).reduce((total, session) => total + (session.queuedInputs?.length ?? 0), 0),
    queuedInputIds: (conversationController?.sessions ?? []).flatMap(session => (session.queuedInputs ?? []).map(input => input.id)),
  }), message => process.stderr.write(`${message}\n`));
  await activity.publish().catch(error => process.stderr.write(`Local activity: ${String(error)}\n`));
  conversationController?.recover();
  let refreshingHistory = false;
  let accessSignature = '';
  const historyPoll = conversationHistory && !folderBot?.background ? setInterval(() => {
    if (refreshingHistory || !clients.size && !project.conversation?.recovery?.enabled) return;
    refreshingHistory = true;
    void refreshHistory().then(() => {
      if (storageReady) conversationController?.recover();
      const signature = JSON.stringify([...clients].map(client => {
        const id = clientIds.get(client) ?? '', selected = selections.get(id) ?? controller.activeId;
        return [id, selected, selectAccess(id, selected)];
      }));
      if (signature !== accessSignature) { accessSignature = signature; broadcast(); }
    }).catch(error => process.stderr.write(`Conversation history: ${String(error)}\n`)).finally(() => { refreshingHistory = false; });
  }, 1_000) : undefined;
  historyPoll?.unref();
  return {
    handle: (request: IncomingMessage, response: ServerResponse) => { server.emit("request", request, response); },
    hostTurn: async (input: Record<string, unknown>) => {
      const id = input.conversationId;
      if (options.host?.surface !== 'editor' || folderBot?.background === false || !entryConversations || !storageReady || typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('Background conversation unavailable.');
      const restore = folderBot?.background === true || input.action === 'recover';
      const admit = !!folderBot && ['submit', 'resolve', 'recover'].includes(String(input.action));
      if (restore || input.action !== 'turn') await ownership?.assertWritable(id);
      const release = restore || input.action !== 'turn' ? await ownership?.hold(id) : undefined;
      try {
        await refreshHistory(restore ? id : undefined);
        if (admit) {
          if (!isHostConversation(id) && (input.action !== 'submit' || controller.sessions.some(session => session.id === id))) throw new Error('Background conversation unavailable.');
          backgroundAdmissions.add(id);
        }
        return redactProjectData(await hostConversation(controller, entryConversations, runtime, project, input, !!folderBot), [...sensitiveTokens]);
      } finally {
        if (admit) backgroundAdmissions.delete(id);
        release?.();
        if (restore || input.action !== 'turn') broadcast();
      }
    },
    // Only the Studio stdio control channel can call this, never a Web client.
    readModelRequest: (sessionId: string, messageId: string, executionId: string) => {
      if (options.host?.surface !== 'editor' || !storageReady) return;
      const request = conversationController?.sessions.find(session => session.id === sessionId)?.messages
        .find(message => message.role === 'assistant' && message.id === messageId)?.modelRequest;
      if (request?.executionId === executionId) return redactProjectData(request.previous?.length
        ? { requests: [...request.previous, request.snapshot] } : request.snapshot, [...sensitiveTokens], false);
    },
    invokeEntry: async (call: AggregateEntryCall): Promise<unknown> => {
      call.abortSignal?.throwIfAborted();
      if (call.projectId !== project.id || call.actor.userId !== account.user?.userId) throw new Error('The entry caller identity changed.');
      if (!storageReady) throw new Error(storageError ?? 'Runtime storage is unavailable.');
      call.abortSignal?.throwIfAborted();
      if (call.action === 'workflow-control') {
        if (!entryWorkflows) throw new Error('The target is not a Workflow.');
        return publicValue(await entryWorkflows.invoke(call.input, call.sourceEntryId, call.readOnly));
      }
      if (call.action === 'workflow') {
        if (project.projectType !== 'workflow') throw new Error('The target is not a Workflow.');
        const operation = String(call.input.entrypointId);
        if (!project.entrypoints.some(entry => entry.id === operation && (!call.readOnly || entry.readOnly === true))) throw new Error('A declared read-only Workflow operation is required.');
        const args = call.input.args;
        if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Invalid Workflow arguments.');
        const runId = globalThis.crypto.randomUUID();
        const report = await runtime.run({ project, readOnly: call.readOnly, abortSignal: call.abortSignal, runId, conversationId: runId, args, entrypointId: operation,
          entryCall: { entryId: call.sourceEntryId, conversationId: call.sourceConversationId, runId: call.sourceRunId } }, () => {});
        if (report.status !== 'success') throw new Error(report.error?.message ?? report.result?.error?.message ?? 'Workflow operation failed.',
          { cause: report.error ?? report.result?.error });
        const data = report.result?.data as { output?: unknown } | undefined;
        return data?.output ?? data ?? report.output;
      }
      if (!entryConversations) throw new Error('The target is not a Conversation.');
      if (call.action === 'list' || call.action === 'snapshot') return entryConversations.invoke(call.action, call.input, call.abortSignal);
      const id = call.input.conversationId;
      if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('Invalid conversation id.');
      await refreshHistory();
      assertLocalConversation(id);
      await ownership?.assertWritable(id);
      const release = await ownership?.hold(id);
      try {
        // Refresh an acquired owner before creating or preparing a session, as
        // native controls do. Later polling must preserve this in-flight object.
        await refreshHistory();
        assertLocalConversation(id);
        if (folderBot?.background) throw new Error('Conversation is not editable by this entry.');
        return await entryConversations.invoke(call.action, call.input, call.abortSignal);
      }
      finally { release?.(); }
    },
    openConversationView: (async (source, target, emit) => {
      if (!controller || !entryConversations || source.projectId !== project.id || source.userId !== account.user?.userId) throw new Error('Conversation runtime is unavailable.');
      const epoch = authRevision, configuration = parameterRevision, id = target.conversationId;
      // A group's composer and its focused Bot view belong to one page. They
      // may share a session writer; another page still gets a different identity.
      const clientId = conversationViewClientId(source.entryId, source.clientId, target.viewId);
      const writerId = conversationViewClientId(source.entryId, source.clientId, `conversation:${id}`);
      const lifetime = new AbortController();
      let closed = false;
      // Background profile checks advance authEpoch even when identity is unchanged.
      const check = () => { if (closed || epoch !== authRevision || configuration !== parameterRevision) throw Object.assign(new Error('The conversation view expired. Reopen it.'), { code: 'KANBAN_BRIDGE_SESSION_INVALID' }); };
      await refreshHistory();
      check();
      assertLocalConversation(id);
      if (!controller.sessions.some(session => session.id === id)) {
        await ownership?.assertWritable(id);
        const release = await ownership?.hold(id);
        try { check(); await controller.navigate(id, [{ id, create: true, draft: { text: '', attachments: [] } }], false); }
        finally { release?.(); }
      }
      check();
      const session = controller.sessions.find(session => session.id === id);
      await ownership?.acquire(id);
      check(); rememberSelection(clientId, id);
      ownership?.shareWriter(clientId, writerId);
      ownership?.select(clientId, id);
      const releaseWriter = () => {
        selections.delete(clientId); ownership?.detach(clientId);
        broadcast();
      };
      const snapshot = () => {
        const current = state(clientId);
        // Project/account configuration is managed by the enclosing host.
        return { ...current, aggregate: undefined, configurations: undefined,
          sessions: current.sessions.filter((session: ConversationSession) => session.id === id), activeId: id };
      };
      const notify = () => { if (!closed && epoch === authRevision && configuration === parameterRevision) emit([snapshot()]); };
      entryObservers.add(notify);
      try {
        if (target.draft && session && !session.draft?.text && !ownership?.select(clientId, id).readOnly)
          await controller.updateDraft(id, target.draft, session.draft?.attachments ?? []);
        const html = await conversationViewHtml(path.join(cliRoot(), 'dist/web'), target.viewId, id, target.locale ?? locale(), !!target.submit);
        check();
        return { html, close: () => { if (closed) return; closed = true; lifetime.abort(); entryObservers.delete(notify); releaseWriter(); },
          request: async (input: Message): Promise<Message[]> => {
            check();
            const message = scopeConversationViewMessage(input, id, project.uri, clientId);
            if (passiveConversationViewMessage(message.type)) return [];
            if (message.type === 'ready') return [{ type: 'connection', status: 'connected' }, { type: 'conversation-ui', ui: target.ui }, snapshot()];
            if (message.type === 'view-ui') { assertConversationUi(message.ui); target.ui = structuredClone(message.ui); return [{ type: 'conversation-ui', ui: target.ui }]; }
            if (message.type === 'send' && target.submit && !message.editingQueueId) {
              const adapter = target.submit;
              if (message.attachments?.length || message.references?.length) throw new Error('This Workflow submission adapter accepts text and parameters.');
              const result = await options.mount!.invokeEntry!({ projectId: project.id, actor: { userId: source.userId, isSystemAdmin: false }, abortSignal: lifetime.signal,
                entryId: adapter.entryId, sourceEntryId: source.entryId, action: 'workflow',
                input: { entrypointId: adapter.entrypointId, args: ['--payload', JSON.stringify({ ...adapter.payload,
                  conversationId: id, text: message.text, params: message.params, requestId: message.requestId })] } }) as { data?: { errCode?: number; errMessage?: string; data?: { id: string; conversationId: string }[] } };
              check();
              if (!result?.data || !Number.isSafeInteger(result.data.errCode)) throw Object.assign(new Error('The Workflow did not acknowledge the submission.'), { code: 'KANBAN_SUBMISSION_INVALID_RECEIPT' });
              if (result.data.errCode !== 0) throw Object.assign(new Error('The Workflow rejected the message.'), {
                code: 'KANBAN_SUBMISSION_REJECTED', publicMessage: result.data.errMessage,
              });
              const receipts = Array.isArray(result.data.data) ? result.data.data : [];
              if (receipts.some(receipt => typeof receipt?.id !== 'string' || !receipt.id || typeof receipt.conversationId !== 'string' || !receipt.conversationId)) throw Object.assign(new Error('The Workflow returned an invalid durable receipt.'), { code: 'KANBAN_SUBMISSION_INVALID_RECEIPT' });
              const own = receipts?.find(receipt => receipt.conversationId === id);
              const receiptId = own?.id ?? receipts?.[0]?.id;
              if (typeof receiptId !== 'string' || !receiptId) throw Object.assign(new Error('The Workflow did not return a durable receipt.'), { code: 'KANBAN_SUBMISSION_INVALID_RECEIPT' });
              return [snapshot(), { type: 'sent', projectUri: project.uri, sessionId: id, requestId: message.requestId, receiptId,
                external: !own || target.ui?.presentation === 'composer', submissionResult: receipts }];
            }
            // Editing a persisted queued input retains its Core identity; Bot context
            // freezes the edited text when that queued turn actually starts.
            const replies = await handleMessage(message);
            check();
            return replies.map(reply => reply.type === 'state' ? snapshot() : reply);
          },
        };
      } catch (error) { closed = true; lifetime.abort(); entryObservers.delete(notify); releaseWriter(); throw error; }
    }) satisfies OpenConversationView,
    subscribeConversation: (id: string, listener: (snapshot: EntryConversationSnapshot) => void) => {
      if (!controller || !storageReady) throw new Error('Conversation runtime is unavailable.');
      const notify = () => { const session = controller.sessions.find(session => session.id === id); if (session) listener(projectConversation(session)); };
      entryObservers.add(notify); notify();
      return () => { entryObservers.delete(notify); };
    },
    get running() { return projectController?.runs.some(run => run.status === "running") || conversationController?.sessions.some(sessionRunning) || false; },
    get reloadBusy() {
      return browserLogin.busy || !!projectController?.running || !!conversationController?.hasRuns
        || !!conversationController?.sessions.some(session => sessionRunning(session) || session.messages.some(message => !!message.pendingInput));
    },
    get pendingMessages() { return [...pendingMessages]; },
    origin, url: `${origin}${options.mount?.basePath ?? ""}/#session=${capability}`, project, configurations, controller, projectController, kanbanController,
    setHostUserSettings: async (value: UserSettings) => {
      const settings = parseUserSettings(value);
      if (JSON.stringify(settings) === JSON.stringify(userSettings)) return;
      userSettings = settings;
      rememberModelKeys(settings);
      applyUserSettings();
      ++parameterRevision;
      conversationController?.configurationChanged();
      await configurations.refresh().catch(() => undefined);
      broadcast();
    },
    setHostResourceProjects: (value: string[]) => { resourceProjects = value; resources.clear(); },
    setHostWebApps: async (value: Record<string, WebAppBinding>) => {
      webApps = value;
      await kanbanController?.setWebAppBinding(value[project.entryId]);
    },
    setHostConnection: async (value: WebConnection | undefined, ai?: PlatformConnections['ai']) => {
      if (hostManaged && authIdentity !== undefined && JSON.stringify([value, ai]) === JSON.stringify([hostConnection, hostAiConnection])) { return; }
      const projectChanged = !hostManaged || value?.serverUrl !== hostConnection?.serverUrl || value?.accessToken !== hostConnection?.accessToken;
      if (projectChanged) { authEpoch++; authCheck?.abort(); resources.clear(); }
      hostConnection = value;
      hostAiConnection = ai;
      hostManaged = true; signedOut = !value;
      await refreshAuth(projectChanged);
    },
    close: () => closing ??= (async () => {
      entryObservers.clear();
      projectCreation.close();
      authEpoch++; authCheck?.abort();
      clearInterval(historyPoll);
      configurations.close(); resources.close(); if (broadcastTimer) { clearTimeout(broadcastTimer); } unsubscribeLogin(); if (!options.mount) browserLogin.cancel(); conversationController?.dispose(); projectController?.dispose(); runtime.dispose();
      await kanbanController?.close();
      for (const client of clients) { client.end(); }
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        await conversationController?.idle(); if (storageReady) await conversationController?.persist();
        await projectController?.idle(); if (storageReady) await projectController?.persist(); await pendingSave.catch(() => undefined);
      } finally { await ownership?.close(); await workflowHistory?.reset(); if (!options.runtimePersistence) await runtimePersistence?.close(); await activity?.close(); }
    })(),
  };
}
