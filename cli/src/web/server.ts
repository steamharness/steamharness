import {configurationCapability} from '@steamharness/project-configuration';
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
import { readCliAuthConfig, clearCliAuthConfig } from '../auth-config';
import { createEmptyProjectAuthConfig } from '@steamharness/auth-config';
import { ConversationController, sessionRunning } from './conversation-controller';
import { Controller } from './workflow-controller';
import { KanbanController } from './kanban-controller';
import { createProjectActions } from './workflow-actions';
import { migrateProjectHistory, type WorkspaceContract } from './workflow-workspace';
import { createWebRuntime, cliRoot, type WebConnection } from './runtime';
import { redactProjectData, validateProjectValues, validateConversationCommandStates, mergeProjectParamStates, projectParameters, projectParamArgs, type Runtime, type Project, type ConversationSession, type ConversationDraftUpdate, type Attachment, type ParamValues, type ParamState } from './workflow-types';
import { conversationResourceCards, type ResourceCardReference } from './resource-cards';
import type { AccountState } from './workflow-auth-client';
import { loginWebAccount } from './account-auth';
import type { WebHostConfiguration } from './host-config';
import { inspectWebProject } from './assistant-project';
import { ResourcePreviews } from './resource-preview';
import { createLocalActivityWriter, summarizeLocalRuns } from './local-analysis';
import { ConversationOwnership } from './conversation-ownership';
import { ConversationHistory } from './conversation-history';
import { ConversationState } from './conversation-state';
import { pathReferences } from './conversation-paths';
import { importDroppedEntries, resolveDroppedPaths } from './dropped-paths';
import { defaultServerUrl } from '../service-url';
import { ProjectServerConnection, projectServerAccessFailure, projectServerStateWithIssue, type ProjectServerIssue } from './project-server-state';
import { projectStartupInspector } from './project-startup-checks';
import { ProjectServerCreation } from './project-server-create';
import { RelatedProjectImports } from './related-projects';
import { projectDataDirectory, retainProjectDataIdentity } from './project-data-directory';

type Message = Record<string, any>;
export interface WebOptions { projectDir: string; port?: number; dataDir?: string; theme?: 'auto' | 'light' | 'dark'; runtime?: Runtime; host?: WebHostConfiguration }

export async function startWebServer(options: WebOptions) {
  const credentials = { capability: randomBytes(32).toString('hex'), cookie: `project_web_${randomBytes(8).toString('hex')}` };
  let host = options.host, port = options.port, closing = false;
  let restarting: Promise<void> | undefined;
  const open = () => startProjectWebServer({ ...options, host, port }, credentials, () => {
    if (closing || restarting) { return; }
    restarting = (async () => {
      await current.close();
      if (!closing) {
        current = await open();
        if (host && Object.hasOwn(host, 'connection')) await current.setHostConnection(host.connection);
        if (host?.relatedProjects) await current.setHostRelatedProjects(host.relatedProjects);
        if (host?.resourceProjects) current.setHostResourceProjects(host.resourceProjects);
      }
    })().finally(() => { restarting = undefined; });
    void restarting.catch(error => process.stderr.write(`Application identity restart: ${String(error)}\n`));
  });
  let current = await open();
  port = Number(new URL(current.origin).port);
  return {
    get origin() { return current.origin; }, get url() { return current.url; }, get project() { return current.project; },
    get configurations() { return current.configurations; }, get controller() { return current.controller; },
    get projectController() { return current.projectController; }, get kanbanController() { return current.kanbanController; },
    setHostRelatedProjects: async (value: NonNullable<WebHostConfiguration['relatedProjects']>) => {
      host = { ...host, surface: host?.surface ?? 'editor', relatedProjects: value };
      await restarting; await current.setHostRelatedProjects(value);
    },
    setHostResourceProjects: (value: string[]) => {
      host = { ...host, surface: host?.surface ?? 'editor', resourceProjects: value };
      current.setHostResourceProjects(value);
    },
    setHostConnection: async (value: WebConnection | undefined) => {
      host = { ...host, surface: host?.surface ?? 'editor', connection: value };
      await restarting; await current.setHostConnection(value);
    },
    close: async () => { closing = true; try { await restarting; } finally { await current.close(); } },
  };
}

async function startProjectWebServer(options: WebOptions, credentials: { capability: string; cookie: string }, identityChanged: () => void) {
  const projectDir = await realpath(path.resolve(options.projectDir));
  const storageDir = path.resolve(options.dataDir ?? path.join(os.homedir(), '.steamharness', 'web'));
  const clients = new Set<ServerResponse>();
  let connection: WebConnection | undefined;
  let account: AccountState = { status: 'signed-out', serverUrl: defaultServerUrl(), revision: 0 };
  let signedOut = false;
  let authIdentity = '';
  let login: ChildProcess | undefined;
  let passwordLogin = false;
  let hostConnection = options.host?.connection;
  let hostManaged = options.host !== undefined;
  // A normal editor host may authenticate its project Server, but it must not
  // hand the private system-AI credentials to arbitrary project workflows.
  // Standalone CLI sessions keep their explicit local AI configuration.
  // Host-managed surfaces (editor and assistant) may carry the private system-AI
  // connection; the open-source host simply never provides those fields.
  const allowAiConnection = true;
  let authEpoch = 0;
  let authenticationInitialized = false;
  let authCheck: AbortController | undefined;
  let authCheckPending = false;
  let nextProfileCheck = 0;
  const sensitiveTokens = new Set<string>();
  let relatedProjects = options.host?.relatedProjects ?? [];
  let relatedProjectsManaged = options.host !== undefined;
  const relatedImports = new RelatedProjectImports();
  await relatedImports.update(relatedProjectsManaged ? relatedProjects : undefined);
  let resourceProjects = options.host?.resourceProjects ?? [];
  let projectServer: ProjectServerConnection | undefined;
  let relatedImportIssue: ProjectServerIssue | undefined;
  const waitingRuns = new Map<AbortController, string | undefined>();
  const cancelWaitingRuns = (runId?: string) => { for (const [abort, id] of waitingRuns) if (!runId || id === runId) abort.abort(); };
  const executor = options.runtime ?? createWebRuntime(projectDir, storageDir, () => connection, () => relatedProjects, { allowSystemAi: allowAiConnection });
  const runtimeOverrides: Pick<Runtime, 'run' | 'resolveParams' | 'cancel' | 'dispose'> = {
    run: async (request, emit) => {
      const runConnection = connection;
      const abort = new AbortController(); waitingRuns.set(abort, request.runId);
      try {
        if (projectServer?.blocking) await Promise.race([projectServer.assertReady(), new Promise<never>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error(t('Stopped'))), { once: true });
        })]);
        if (abort.signal.aborted) throw new Error(t('Stopped'));
        const report = await executor.run(request, emit);
        if (!abort.signal.aborted && report.status === 'failed') observeStorageFailure((report.error ?? report.result?.error)?.metadata, runConnection);
        return report;
      } catch (error) {
        if (!abort.signal.aborted) observeStorageFailure((error as { metadata?: Record<string, unknown> }).metadata, runConnection);
        throw error;
      } finally { waitingRuns.delete(abort); }
    },
    resolveParams: async (...args) => {
      if (projectServer?.blocking) projectServer.assertAvailable();
      const resolvingConnection = connection;
      try { return await executor.resolveParams(...args); }
      catch (error) { observeStorageFailure((error as { metadata?: Record<string, unknown> }).metadata, resolvingConnection); throw error; }
    },
    cancel: runId => { cancelWaitingRuns(runId); executor.cancel(runId); },
    dispose: () => { cancelWaitingRuns(); executor.dispose(); },
  };
  const runtime: Runtime = Object.assign(Object.create(executor), runtimeOverrides);
  let inspected;
  try { inspected = await inspectWebProject(runtime, projectDir, options.host); } catch (error) { runtime.dispose(); throw error; }
  const descriptor = inspected.projects[0] as Project & { runtime?: { harnessVersion: string; harnessPath: string } };
  if (!descriptor) { runtime.dispose(); throw new Error(inspected.errors.join('\n') || 'No Workflow project found.'); }
  if (!options.runtime) { assertLocalCliCoreCompatible(projectDir, descriptor.runtime!.harnessVersion); }
  if (!['conversation', 'workflow', 'kanban'].includes(descriptor.projectType)) { runtime.dispose(); throw new Error('Unsupported Workflow project type.'); }
  const project: Project = descriptor;
  const resources = new ResourcePreviews(project, runtime, storageDir, () => connection, () => relatedProjects, () => resourceProjects, () => broadcast());
  const key = project.assistant ? createHash('sha256').update(`assistant:${project.id}:${project.assistant.workdir}`).digest('hex').slice(0, 24)
    : path.relative(storageDir, await projectDataDirectory(storageDir, projectDir, project.id));
  const historyPath = path.join(storageDir, key, 'conversations.json');
  let saved: { sessions?: ConversationSession[]; activeId?: string; selectionVersion?: number } = {};
  if (project.projectType !== 'kanban') { try { saved = JSON.parse(await readFile(historyPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { runtime.dispose(); throw new Error(`Cannot read conversation history: ${String(error)}`); } } }
  let pendingSave = Promise.resolve();
  const ownership = project.projectType === 'conversation' ? new ConversationOwnership(path.join(storageDir, key, 'conversation-owners'), id => conversationController?.sessions.find(session => session.id === id)?.agentOwnerId ?? id) : undefined;
  const conversationHistory = ownership ? new ConversationHistory(historyPath, saved, ownership) : undefined;
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
  const publicFile = (file: Attachment) => ({ ...file, previewUrl: `/api/file/${encodeURIComponent(file.id)}` });
  const publicValue = (value: unknown): any => {
    if (Array.isArray(value)) { return value.map(publicValue); }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.id === 'string' && /^wf_[a-f0-9]{32}$/.test(record.id) && typeof record.mimeType === 'string') { return publicFile(record as unknown as Attachment); }
      return Object.fromEntries(Object.entries(record).map(([name, entry]) => [name, publicValue(entry)]));
    }
    return value;
  };
  // Preserve project-owned data keys; remove host credentials by their actual values.
  const publicState = (value: unknown) => publicValue(redactProjectData(value, [...sensitiveTokens], false));
  const sharedState = () => {
    const serverData = projectServer?.state ?? (relatedImportIssue ? { checking: false, blocking: false } : undefined);
    const issue = relatedImports.issue(projectServer?.state.issue ?? relatedImportIssue ?? kanbanController?.serverDataIssue);
    const result = publicState({ type: 'state', serverInstanceId, project, configurationError: configurations.error,
    serverData: serverData && projectServerStateWithIssue(serverData, issue, project.id),
    ...(isKanban ? { kanban: kanbanController!.state() } : isProject ? projectActions!.state() : { sessions: conversationState.sessions(controller.sessions) }),
    account: { ...account, user: account.user && { userId: account.user.userId, email: account.user.email, displayName: account.user.displayName, avatarUrl: account.user.avatarUrl } },
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
      ...(ownership && selected && clientId ? { conversationAccess: ownership.select(clientId, selected.id) } : {}) });
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
  projectServer = new ProjectServerConnection(project.id, () => connection, () => {
    kanbanController?.projectChecksChanged(); broadcast();
  }, { blocking: project.projectInfo?.dataStorage?.mode === 'server', inspect: projectStartupInspector(project, relatedImports) });
  const observeStorageFailure = (metadata: Record<string, unknown> | undefined, previous: WebConnection | undefined) => {
    if (isKanban) return;
    if (metadata?.code === 'RELATED_PROJECT_UNAVAILABLE') {
      const issue = relatedImports.missingIssue(metadata.alias, project);
      if (issue) { relatedImportIssue = issue; broadcast(); }
      return;
    }
    if (!previous || previous.serverUrl !== connection?.serverUrl || previous.accessToken !== connection.accessToken) return;
    const failure = projectServerAccessFailure(metadata, project, connection);
    if (!failure) return;
    void projectServer!.reportFailure(failure);
  };
  const projectCreation = new ProjectServerCreation(project, () => connection,
    () => account.status === 'authenticated' && account.user ? `${authIdentity}\n${account.user.userId}` : '',
    () => projectServer?.state.issue ?? kanbanController?.serverDataIssue, async () => {
      await stopForAuthentication();
      await retainProjectDataIdentity(storageDir, projectDir, project.id);
    });
  let configurationSignature = '';
  const configurations = new ProjectConfigurations(project.assistant ? project.folderPath : projectDir, () => {
    const signature=JSON.stringify(configurations.state);
    if(signature!==configurationSignature) {
      configurationSignature=signature;
      parameterRevision++;
      parameterStates.clear();
      kanbanController?.configurationChanged(configurations.state);
      conversationController?.configurationChanged();
      resources.clear();
    }
    broadcast();
  }, () => connection);
  await configurations.initialize();
  configurationSignature=JSON.stringify(configurations.state);
  conversationController = isProject || isKanban ? undefined : new ConversationController(project, runtime, saved, {
    canRun: session => ownership?.execute(session.id) ?? true,
    canStart: () => !projectServer?.blocking || projectServer.ready,
    canDrain: () => (!projectServer?.blocking || projectServer.ready) && !relatedImportIssue,
    configurationRevision: () => configurations.state.revision,
    changed: broadcast,
    log: message => process.stderr.write(`${message}\n`),
    save: (sessions, activeId) => {
      if (conversationHistory) {
        pendingSave = conversationHistory.save(sessions, activeId);
        return pendingSave;
      }
      const content = JSON.stringify({ sessions, activeId, selectionVersion: 1 });
      pendingSave = pendingSave.catch(() => undefined).then(async () => {
        await mkdir(path.dirname(historyPath), { recursive: true });
        const temp = `${historyPath}.${process.pid}.tmp`;
        await writeFile(temp, content, { mode: 0o600 }); await rename(temp, historyPath);
      });
      return pendingSave;
    },
  });
  const controller = conversationController!;
  const refreshHistory = async () => {
    const acquired = ownership?.takeAcquired() ?? new Set<string>();
    for (const id of controller?.executingIds ?? []) acquired.delete(id);
    const history = await conversationHistory?.refresh(acquired);
    if (!history?.sessions) return;
    const local = new Map(controller.sessions.map(session => [session.id, session]));
    const merged = history.sessions.map(session => {
      if (ownership!.owns(session.id) && !acquired.has(ownership!.scope(session.id)) && local.has(session.id)) return local.get(session.id)!;
      delete session.activeRunId;
      for (const message of session.messages) if (message.status === 'running' && message.runId && message.args && project.conversation?.recovery?.enabled) message.recovering = true;
      return session;
    });
    for (const session of controller.sessions) if (!merged.some(item => item.id === session.id) && ownership!.owns(session.id)) merged.push(session);
    if (!merged.length) return;
    controller.sessions.splice(0, controller.sessions.length, ...merged);
    if (!merged.some(session => session.id === controller.activeId)) controller.activeId = merged[0].id;
    broadcast();
  };
  const runsPath = path.join(storageDir, key, 'runs.json');
  let workspace: WorkspaceContract | undefined;
  if (isProject) {
    try {
      workspace = JSON.parse(await readFile(runsPath, 'utf8'));
      if (workspace?.version !== 1 || !Array.isArray(workspace.runs) || !workspace.drafts || typeof workspace.drafts !== 'object') { throw new Error('Invalid Workflow history.'); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { runtime.dispose(); throw error; }
      workspace = migrateProjectHistory(saved.sessions ?? [], saved.activeId);
    }
  }
  const projectController = isProject ? new Controller(project, runtime, workspace!, {
    changed: broadcast, legacy: saved.sessions,
    log: message => process.stderr.write(`${message}\n`),
    save: workspace => {
      const content = JSON.stringify(workspace);
      pendingSave = pendingSave.catch(() => undefined).then(async () => {
        await mkdir(path.dirname(runsPath), { recursive: true });
        const temp = `${runsPath}.${process.pid}.tmp`;
        await writeFile(temp, content, { mode: 0o600 }); await rename(temp, runsPath);
      });
      return pendingSave;
    },
  }) : undefined;
  const projectActions = projectController ? createProjectActions(projectController, runtime, project, () => authRevision, broadcast) : undefined;
  kanbanController = isKanban ? new KanbanController(project, runtime, storageDir, {
    changed: broadcast, emit: message => { for (const client of clients) { client.write(`data: ${JSON.stringify(message)}\n\n`); } },
    connection: () => connection, log: message => process.stderr.write(`${message}\n`),
    serverIssue: issue => relatedImports.issue(issue), relatedImport: alias => relatedImports.missingIssue(alias, project), relatedProjects: () => relatedProjects,
    serverState: () => projectServer!.state, projectChanged: () => {
      projectServer!.state.blocking = project.projectInfo?.dataStorage?.mode === 'server';
      return projectServer!.restart();
    },
  }) : undefined;
  if (kanbanController) kanbanController.configurationChanged(configurations.state);
  if (kanbanController) { try { await kanbanController.initialize(); } catch (error) { configurations.close(); resources.close(); await kanbanController.close(); runtime.dispose(); throw error; } }
  if (projectController) { await projectController.persist(); }
  const stopForAuthentication = async () => {
    for (const session of conversationController?.sessions ?? []) { await conversationController!.stop(session); }
    if (projectController) { await projectController.stop('Workflow login changed.'); }
  };
  const refreshAuth = async (force = false) => {
    if ((passwordLogin || login) && !force) { return; }
    const readingEpoch = authEpoch;
    const config = hostManaged ? createEmptyProjectAuthConfig() : await readCliAuthConfig();
    if (readingEpoch !== authEpoch) { return; }
    const serverUrl = hostManaged ? hostConnection?.serverUrl : process.env.STEAMHARNESS_SERVER_URL ?? config.serverUrl;
    const token = hostManaged ? hostConnection?.accessToken : process.env.STEAMHARNESS_SERVER_ADMIN_KEY ?? config.apiKey;
    const aiServerUrl = allowAiConnection
      ? hostManaged ? hostConnection?.aiServerUrl : process.env.STEAMHARNESS_AI_SERVER_URL ?? config.aiServerUrl
      : undefined;
    const aiToken = allowAiConnection
      ? hostManaged ? hostConnection?.aiAccessToken : process.env.STEAMHARNESS_AI_API_KEY ?? config.aiApiKey
      : undefined;
    if (token) { sensitiveTokens.add(token); }
    if (aiToken) { sensitiveTokens.add(aiToken); }
    const identity = signedOut ? '' : `${serverUrl}\n${token}\n${aiServerUrl}\n${aiToken}`;
    const expired = account.expiresAt && Date.parse(account.expiresAt) <= Date.now();
    const background = !force && identity === authIdentity && account.status === 'authenticated' && !expired;
    if (!force && identity === authIdentity) {
      if (authCheckPending) { return; }
      if (account.status !== 'error' && !expired && (!background || Date.now() < nextProfileCheck)) { return; }
    }
    const epoch = ++authEpoch;
    authCheck?.abort();
    const check = authCheck = new AbortController();
    const changed = identity !== authIdentity;
    if (changed) projectCreation.close();
    authIdentity = identity;
    const candidate = !signedOut && serverUrl && token ? {
      serverUrl: serverUrl.replace(/\/+$/, ''), accessToken: token,
      ...(aiServerUrl && aiToken ? { aiServerUrl: aiServerUrl.replace(/\/+$/, ''), aiAccessToken: aiToken } : {}),
    } : undefined;
    if (changed) {
      resources.clear();
      connection = undefined;
      projectServer?.authenticationChanged({ ...account, status: 'checking', serverUrl: serverUrl || defaultServerUrl() });
      authRevision++;
      parameterStates.clear();
      projectActions?.invalidate();
      kanbanController?.authenticationChanged();
      if (authenticationInitialized) { await stopForAuthentication(); }
      if (epoch !== authEpoch) { return; }
    }
    authenticationInitialized = true;
    if (!background) {
      account = { status: candidate ? 'checking' : 'signed-out', serverUrl: serverUrl || defaultServerUrl(),
        aiServerUrl: aiServerUrl || undefined, aiConfigured: Boolean(aiServerUrl && aiToken),
        user: candidate ? changed ? hostManaged ? undefined : config.user : account.user : undefined, revision: account.revision + 1 };
      projectServer?.authenticationChanged(account);
    }
    if (candidate) {
      authCheckPending = true;
      nextProfileCheck = Date.now() + 30_000;
      let unauthorized = false;
      try {
        const response = await fetch(`${candidate.serverUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${candidate.accessToken}` }, signal: AbortSignal.any([check.signal, AbortSignal.timeout(10_000)]), redirect: 'error' });
        unauthorized = response.status === 401;
        const result = await response.json();
        if (epoch !== authEpoch) { return; }
        const profile = result.data?.profile;
        if (!response.ok || result.errCode !== 0 || typeof profile?.userId !== 'string' || !profile.userId || typeof profile.email !== 'string' || typeof profile.displayName !== 'string') { throw new Error('Workflow login is invalid or expired.'); }
        if (!connection) { authRevision++; parameterStates.clear(); projectActions?.invalidate(); }
        connection = candidate;
        if (!background) { kanbanController?.authenticationChanged(); }
        const savedConnection = !hostManaged && candidate.serverUrl === config.serverUrl.replace(/\/+$/, '') && candidate.accessToken === config.apiKey;
        const expiresAt = result.data.principal?.expiresAt ?? (savedConnection ? config.expiresAt : undefined);
        if (background && (['userId', 'email', 'displayName', 'avatarUrl'] as const).every(key => profile[key] === account.user?.[key]) && expiresAt === account.expiresAt) { return; }
        account = { ...account, status: 'authenticated', user: profile, expiresAt, revision: account.revision + (background ? 1 : 0) };
      } catch (error) {
        if (epoch !== authEpoch) { return; }
        if (background && !unauthorized) { return; }
        connection = undefined;
        projectServer?.authenticationChanged({ ...account, status: unauthorized ? 'expired' : 'error' });
        resources.clear();
        kanbanController?.authenticationChanged();
        if (!changed) { authRevision++; parameterStates.clear(); projectActions?.invalidate(); await stopForAuthentication(); }
        if (epoch !== authEpoch) { return; }
        account = { ...account, status: unauthorized ? 'expired' : 'error', error: String((error as Error).message) };
      } finally {
        if (epoch === authEpoch) { authCheckPending = false; }
      }
    } else { connection = undefined; }
    if (!background || !connection) projectServer?.authenticationChanged(account);
    broadcast();
  };
  await refreshAuth();
  const selectedSession = controller?.sessions.find(session => session.id === saved.activeId) ?? controller?.current;
  const previousReport = isProject ? projectController?.runs[0]?.report : selectedSession?.messages.at(-1)?.report;
  if (previousReport?.status === 'failed') observeStorageFailure((previousReport.error ?? previousReport.result?.error)?.metadata, connection);
  const authPoll = setInterval(() => void refreshAuth().catch(error => process.stderr.write(`${String(error)}\n`)), 5_000); authPoll.unref();
  const { capability, cookie } = credentials;
  let replacementId: string | undefined;
  let origin = '';
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
    const card = conversationResourceCards(items, project.id, scopeId, project.projectInfo?.dataStorage?.mode === 'server' ? 'server' : 'local').find(card => card.id === reference.cardId);
    if (!card) { throw new Error(t('This resource no longer exists.')); }
    return { card, reference: source };
  };
  const handleMessage = async (message: Message): Promise<Message[]> => {
    if (replacementId || message.applicationId && message.applicationId !== project.id) { throw new Error(t('The application ID changed. The new application is opening.')); }
    if (typeof message.type !== 'string') { throw new Error('Invalid message.'); }
    if (message.projectUri && message.projectUri !== project.uri) { throw new Error('Project changed.'); }
    if (message.type === 'project-server-check') {
      await relatedImports.update(relatedProjectsManaged ? relatedProjects : undefined);
      if (relatedImports.issue(relatedImportIssue)?.relatedProjectImported) relatedImportIssue = undefined;
      await refreshAuth(true);
      await projectServer?.settled();
      return [state(message.clientId), { type: 'project-server-checked', requestId: message.requestId }];
    }
    if (message.type === 'project-server-create-prepare') return [{ type: 'project-server-create-context', context: await projectCreation.prepare() }];
    if (message.type === 'project-server-create-cancel') { projectCreation.cancel(message.token); return []; }
    if (message.type === 'project-server-create-confirm') {
      replacementId = await projectCreation.confirm(message);
      return [{ type: 'project-server-created', projectId: replacementId }];
    }
    // Check before controllers mutate drafts, histories, or queue state. Stop,
    // navigation, export and local draft edits remain available during setup.
    const needsServer = ['workflow-run', 'workflow-rerun', 'workflow-resume', 'send', 'retry', 'resume', 'queue-run', 'queue-promote'].includes(message.type)
      || message.type === 'command' && project.conversation?.commands?.find(entry => entry.command === message.command)?.action.kind !== 'export'
      || message.type === 'agent-command' && !['cancel', 'withdraw'].includes(message.command?.type);
    if (needsServer && projectServer?.blocking) projectServer.assertAvailable();
    if (message.type === 'ready') await configurations.refresh().catch(() => undefined);
    if (message.type === 'kanban-refresh') {
      await relatedImports.update(relatedProjectsManaged ? relatedProjects : undefined);
      await configurations.refresh();
      if (kanbanController) { const replies = await kanbanController.handle(message); return [state(message.clientId), ...replies]; }
    }
    if (message.type === 'project-configuration') {
      return [{ type: 'project-configuration-result', requestId: message.requestId, value: await configurations.dispatch(message.call) }];
    }
    if (message.type === 'project-ai-catalog') {
      const epoch = authEpoch;
      const value = await loadAgentModelCatalog(connection);
      if (epoch !== authEpoch) throw new Error('Account changed. Refresh AI models.');
      return [{ type: 'project-ai-catalog-result', requestId: message.requestId, value }];
    }
    if (message.type === 'project-configuration-upload') {
      const current = await configurations.refresh(), epoch = authEpoch;
      if (message.revision !== current.revision) throw new Error('Configuration changed. Refresh before saving your draft.');
      if (!current.configurations.some(item => item.id === message.id)) throw new Error('Configuration no longer exists.');
      const field = current.fields.find(item => item.name === message.key);
      if (field?.type !== 'file') throw new Error('Invalid configuration file field.');
      if(!configurationCapability(current,field).editable)throw new Error('Configuration is locked by the author.');
      const reference = await uploadConfigurationFile(project.id, field, message.file, connection, { target: current.template?.projectVersion });
      if (epoch !== authEpoch) throw new Error('Account changed. Select the file again.');
      return [{type:'project-configuration-upload-result',requestId:message.requestId,value:reference}];
    }
    if (message.type === 'resource-data') {
      try { return [{ type: 'resource-data', requestId: message.requestId, data: resources.get(String(message.id)) }]; }
      catch (error) { if (!message.reference) { throw error; } }
    }
    if (['resource-data', 'resource-refresh', 'resource-select'].includes(message.type)) {
      // Only a saved card may restore an expired preview; never accept a client-supplied resource target.
      const card = message.reference ? findResourceCard(message.reference).card : resources.get(String(message.id)).card;
      const selection = message.selection;
      const target = { ...card.target };
      if (selection && ['kv', 'knowledge'].includes(card.kind)) {
        for (const key of card.kind === 'knowledge' ? ['documentId'] : ['key', 'scope', 'conversationId']) {
          if (typeof selection[key] === 'string' && selection[key].length <= 8192) { target[key] = selection[key]; }
        }
      }
      const preview = await resources.open({ ...card, target });
      return [{ type: 'resource-data', requestId: message.requestId, id: preview.id, data: preview.data }];
    }
    if (message.type === 'resource-bridge') { return [{ type: 'resource-bridge', requestId: message.requestId, value: await resources.bridge(String(message.id), message.call) }]; }
    if (message.type === 'resource') {
      if (!['open', 'inline', 'window', 'project', undefined].includes(message.action)) { throw new Error(t('Invalid resource action.')); }
      const { card, reference } = findResourceCard(message as ResourceCardReference);
      const preview = await resources.open(card);
      return [{ type: 'resource-preview', requestId: message.requestId, cardId: card.id, action: message.action ?? 'open',
        id: preview.id, url: `${preview.url}&resourceRef=${encodeURIComponent(JSON.stringify(reference))}`, card, project: preview.data.project }];
    }
    if (kanbanController && !['ready', 'login', 'verify', 'logout', 'usage'].includes(message.type)) { return kanbanController.handle(message); }
    if (projectActions && !['ready', 'login', 'verify', 'logout', 'usage'].includes(message.type)) { return publicValue(await projectActions.handle(message)); }
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
        const writable = updates.filter(update => {
          const session = controller.sessions.find(session => session.id === update.id);
          try { ownership?.assertWritable(update.id, message.clientId); return true; }
          catch (error) { if (session && JSON.stringify(update.draft) === JSON.stringify(session.draft)) return false; throw error; }
        });
        await refreshHistory();
        await conversationController.navigate(message.id, writable);
        rememberSelection(message.clientId, message.id);
      }
      return reply();
    }
    await refreshHistory();
    const replies: Message[] = [];
    let current = (message.sessionId ? conversationController?.sessions.find(entry => entry.id === message.sessionId) : conversationController?.current) as ConversationSession;
    if (!isKanban && !isProject && !current) { throw new Error(t("Conversation no longer exists.")); }
    const readOnly = ['ready', 'select', 'new', 'agent-open', 'trace', 'logs', 'export-message', 'usage', 'login', 'verify', 'logout'];
    if (ownership && !readOnly.includes(message.type) && !(message.type === 'session-action' && message.action === 'export')) {
      const target = message.type === 'session-action' ? controller.sessions.find(session => session.id === message.id) : current;
      if (target) {
        ownership.assertWritable(target.id, message.clientId);
        await refreshHistory();
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
          if (message.errorScope !== 'stop' || message.command.type !== 'cancel' || message.command.scope !== 'foreground'
            || !message.runId || message.runId !== current.activeRunId || !sameTasks) throw new Error(t('Task state changed. Refresh the trace and try again.'));
        }
        const receipt = await controller.agentCommand(current.id, message.command);
        const fork = receipt.forkId === undefined ? undefined : controller.sessions.find(entry => entry.agentOwnerId === (current.agentOwnerId ?? current.id) && entry.agentConversationId === receipt.forkId);
        replies.push(state(message.clientId), { type: 'agent-receipt', receipt, projectUri: project.uri, sessionId: current.id, requestId: message.command.requestId, forkSessionId: fork?.id });
        break;
      }
      case 'agent-open': {
        if (!Number.isSafeInteger(message.conversationId)) throw new Error('Invalid agent conversation.');
        if (message.agentOwner !== undefined && current.agent?.ownerId !== message.agentOwner) throw new Error(t('Task state changed. Refresh the trace and try again.'));
        const sessionId = await controller.openAgentConversation(current.id, message.conversationId);
        replies.push(state(message.clientId), { type: 'agent-opened', sessionId }); break;
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
            if (project.projectType === 'conversation') { validateConversationCommandStates(parameters.fields, nextStates, project.conversation?.commands); }
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
          if (project.projectType !== 'conversation' || !command) { throw new Error(t("Unknown conversation command.")); }
          if (sessionRunning(current) || current.messages.some(answer => answer.pendingInput) || current.queuedInputs?.length || current.draft?.editingQueueId) { throw new Error(t("The current session is running.")); }
          if (command.action.kind === 'export') {
            const name = `conversation-${current.id}.json`;
            const count = current.messages.length + 2;
            await controller.recordCommand(command.command, t("Conversation export ready: {0} ({1} messages).", name, count), current);
            replies.push({ type: 'download', name, content: JSON.stringify(redactProjectData(current, [...sensitiveTokens], false), null, 2) },
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
        if (project.projectType === 'conversation') { validateConversationCommandStates(parameters.fields, states, project.conversation?.commands); }
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
        if (!ownership || !message.clientId || !ownership.select(message.clientId, current.id).readOnly) await controller.updateDraft(current.id, String(message.text ?? ''), await readAttachments(message.attachments ?? [], current.id), undefined, pathReferences(message.references));
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
        else if (message.action === 'export') { replies.push({ type: 'download', name: `conversation-${session.id}.json`, content: JSON.stringify(redactProjectData(session, [...sensitiveTokens], false), null, 2) }); }
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
        if (message.type === 'export-message') { replies.push({ type: 'download', name: `run-${answer.id}.json`, content: JSON.stringify(redactProjectData(answer, [...sensitiveTokens], false), null, 2) }, { type: 'exported', sessionId: current.id, messageId: answer.id }); }
        else { replies.push({ type: 'preview', title: message.type === 'logs' ? t("Run logs") : t("Trace"), content: message.type === 'logs' ? answer.report?.logs ?? '' : { report: answer.report, events: answer.events, items: answer.items } }); }
        break;
      }
      case 'usage': {
        if (!connection) { throw new Error('SteamHarness Server login is not configured.'); }
        const revision = authRevision;
        if (!connection.aiServerUrl || !connection.aiAccessToken) { throw new Error(t('System AI is unavailable.')); }
        const response = await fetch(`${connection.aiServerUrl}/api/ai/usage`, { headers: { Authorization: `Bearer ${connection.aiAccessToken}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); const result = await response.json();
        if (revision !== authRevision) { throw new Error(t("Account changed. Refresh usage.")); }
        if (!response.ok || result.errCode !== 0) { throw new Error(result.errMessage || 'Cannot load usage.'); }
        replies.push({ type: 'usage', requestId: message.requestId, sessionId: current?.id, usage: result.data }); break;
      }
      case 'login': {
        if (hostManaged) { throw new Error(t("Manage this account through Studio.")); }
        if (!options.host && process.env.STEAMHARNESS_SERVER_ADMIN_KEY !== undefined) { throw new Error('This session is supplied by the host. Sign in through the host.'); }
        if (login || passwordLogin) { break; }
        const url = new URL(String(message.serverUrl)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { throw new Error('Invalid SteamHarness Server URL.'); }
        signedOut = false; account = { ...account, status: 'checking' }; broadcast();
        if (message.email !== undefined || message.password !== undefined) {
          const epoch = ++authEpoch;
          passwordLogin = true;
          try {
            if (typeof message.email !== 'string' || typeof message.password !== 'string') { throw new Error('Invalid login credentials.'); }
            await loginWebAccount(url.toString().replace(/\/+$/, ''), message.email, message.password);
            if (epoch !== authEpoch) { break; }
            hostManaged = false; hostConnection = undefined;
          } catch (error) { if (epoch === authEpoch) { account = { ...account, status: 'error', error: String((error as Error).message) }; broadcast(); } throw error; }
          finally { passwordLogin = false; }
          await refreshAuth(true);
          break;
        }
        login = spawn(process.execPath, [path.join(cliRoot(), 'dist/index.js'), 'workspace', 'login', '--server', url.toString().replace(/\/$/, '')], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
        login.stderr?.on('data', chunk => process.stderr.write(chunk));
        login.once('error', error => { login = undefined; account = { ...account, status: 'error', error: error.message }; broadcast(); });
        login.once('close', () => { login = undefined; authIdentity = ''; void refreshAuth(); }); break;
      }
      case 'verify': await refreshAuth(true); break;
      case 'logout': {
        if (hostManaged) { throw new Error(t("Manage this account through Studio.")); }
        signedOut = true; login?.kill(); if (process.env.STEAMHARNESS_SERVER_ADMIN_KEY === undefined) { await clearCliAuthConfig(); } authIdentity = 'signed-out'; await refreshAuth(); break;
      }
      default: throw new Error(`Unsupported action: ${message.type}`);
    }
    return replies;
  };
  let mutations = Promise.resolve();
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
      const host = new URL(`http://${request.headers.host ?? ''}`);
      // SSH forwards TCP without rewriting the browser's loopback Host header.
      const forwarded = !!options.host && ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && !host.username && !host.password && host.pathname === '/' && !host.search && !host.hash;
      const url = new URL(request.url ?? '/', origin);
      const resourceAsset = url.pathname.startsWith('/kanban/') || url.pathname.startsWith('/resource-assets/');
      const sandboxAsset = resourceAsset && ['GET', 'HEAD'].includes(request.method ?? '') && request.headers.origin === 'null';
      if (request.headers.host !== new URL(origin).host && !forwarded || request.headers.origin && request.headers.origin !== (forwarded ? host.origin : origin) && !sandboxAsset) { json(response, 403, { message: 'Invalid request origin.' }); return; }
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
        if (url.pathname === '/api/resource-state' && request.method === 'GET') { json(response, 200, { type: 'state', project: { id: project.id }, authenticationRevision: authRevision, resourceRevision: resources.revision }); return; }
        if (url.pathname === '/api/events' && request.method === 'GET') {
          await refreshHistory();
          const disconnectKanban = kanbanController?.methods.connect(url.searchParams.get('clientId') ?? '');
          const clientId = url.searchParams.get('clientId') ?? '';
          clientIds.set(response, clientId);
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); writeState(response); clients.add(response);
          const heartbeat = setInterval(() => { if (!blockedClients.has(response)) writeFrame(response, 'event: heartbeat\ndata: {}\n\n'); }, 20_000);
          response.once('close', () => {
            clearInterval(heartbeat); clients.delete(response); blockedClients.delete(response); pendingStates.delete(response); disconnectKanban?.();
            if (clientId && ![...clients].some(client => clientIds.get(client) === clientId)) ownership?.disconnect(clientId, broadcast);
          }); return;
        }
        if (url.pathname === '/api/message' && request.method === 'POST') {
          const message = await readBody(request);
          let messages: Message[] = [];
          const operation = () => handleMessage(message).then(value => { messages = value; });
          const concurrent = ['stop', 'workflow-stop', 'navigate', 'resolve', 'ready', 'project-server-check', 'usage', 'resource', 'resource-data', 'resource-refresh', 'resource-select', 'resource-bridge', 'kanban-bridge', 'kanban-method-state', 'kanban-method-reply', 'kanban-methods'].includes(message.type)
            || message.type === 'agent-command' && message.command?.type === 'cancel';
          const task = concurrent ? operation() : mutations.catch(() => undefined).then(operation);
          if (!concurrent) { mutations = task; }
          await task;
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
        const ancestors = options.host ? "'self' vscode-webview: vscode-file: https://*.vscode-cdn.net https://*.vscode-webview.net http://127.0.0.1:* http://localhost:*" : "'self' vscode-webview:";
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-src 'self' https: http:; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors}; form-action 'self'` });
        const ui = url.pathname !== '/' ? 'resource-preview' : isKanban ? 'kanban-workspace' : isProject ? 'workflow-workspace' : 'workflow-ui';
        response.end(`<!doctype html><html lang="${locale()}" data-theme="${options.theme ?? 'auto'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="steamharness-project" content="${key}"><title>Workflow</title><link rel="stylesheet" href="/assets/codicons/codicon.css"><link rel="stylesheet" href="/assets/${ui}.css"><link rel="stylesheet" href="/assets/theme.css"></head><body data-surface="${options.host?.surface ?? 'editor'}" data-account-host="${hostManaged}"><div id="app"></div><script src="/assets/${ui}.js" defer></script></body></html>`); return;
      }
      const assets: Record<string, string> = { '/assets/workflow-ui.js': 'application/javascript', '/assets/workflow-ui.css': 'text/css', '/assets/theme.css': 'text/css', '/assets/codicons/codicon.css': 'text/css', '/assets/codicons/codicon.ttf': 'font/ttf' };
      assets['/assets/workflow-workspace.js'] = 'application/javascript'; assets['/assets/workflow-workspace.css'] = 'text/css';
      assets['/assets/kanban-workspace.js'] = 'application/javascript'; assets['/assets/kanban-workspace.css'] = 'text/css';
      assets['/assets/resource-preview.js'] = 'application/javascript'; assets['/assets/resource-preview.css'] = 'text/css';
      if (!assets[url.pathname]) { json(response, 404, { message: 'Not found.' }); return; }
      const content = await readFile(path.join(cliRoot(), 'dist/web', url.pathname.slice('/assets/'.length))); response.writeHead(200, { 'Content-Type': assets[url.pathname], 'Cache-Control': 'no-cache' }); response.end(content);
    })().catch(error => { if (!response.headersSent) { json(response, 400, { message: String(redactProjectData((error as Error).message, [...sensitiveTokens])) }); } else { response.end(); } });
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { projectCreation.close(); projectServer?.close(); ownership?.close(); configurations.close(); resources.close(); clearInterval(authPoll); conversationController?.dispose(); projectController?.dispose(); await kanbanController?.close(); runtime.dispose(); throw error; }
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  activity = createLocalActivityWriter(path.dirname(historyPath), project, () => ({
    runs: summarizeLocalRuns(projectController?.runs, conversationController?.sessions),
    queued: (conversationController?.sessions ?? []).reduce((total, session) => total + (session.queuedInputs?.length ?? 0), 0),
    queuedInputIds: (conversationController?.sessions ?? []).flatMap(session => (session.queuedInputs ?? []).map(input => input.id)),
  }), message => process.stderr.write(`${message}\n`));
  await activity.publish().catch(error => process.stderr.write(`Local activity: ${String(error)}\n`));
  conversationController?.recover();
  let refreshingHistory = false;
  let accessSignature = '';
  const historyPoll = conversationHistory ? setInterval(() => {
    if (refreshingHistory || !clients.size) return;
    refreshingHistory = true;
    void refreshHistory().then(() => {
      const signature = JSON.stringify([...clients].map(client => {
        const id = clientIds.get(client) ?? '', selected = selections.get(id) ?? controller.activeId;
        return [id, selected, ownership!.select(id, selected)];
      }));
      if (signature !== accessSignature) { accessSignature = signature; broadcast(); }
    }).catch(error => process.stderr.write(`Conversation history: ${String(error)}\n`)).finally(() => { refreshingHistory = false; });
  }, 1_000) : undefined;
  historyPoll?.unref();
  let closing: Promise<void> | undefined;
  return {
    origin, url: `${origin}/#session=${capability}`, project, configurations, controller, projectController, kanbanController,
    setHostRelatedProjects: async (value: NonNullable<WebHostConfiguration['relatedProjects']>) => {
      relatedProjects = value; relatedProjectsManaged = true; resources.clear();
      if (await relatedImports.update(value)) {
        relatedImportIssue = undefined;
        await projectServer?.restart(); broadcast();
      }
    },
    setHostResourceProjects: (value: string[]) => { resourceProjects = value; resources.clear(); },
    setHostConnection: async (value: WebConnection | undefined) => {
      if (hostManaged && JSON.stringify(value) === JSON.stringify(hostConnection)) { return; }
      authEpoch++; authCheck?.abort();
      resources.clear();
      hostConnection = value && !allowAiConnection ? { serverUrl: value.serverUrl, accessToken: value.accessToken } : value;
      hostManaged = true; signedOut = !value;
      await refreshAuth(true);
    },
    close: () => closing ??= (async () => {
      relatedImports.close(); projectCreation.close(); projectServer?.close();
      authEpoch++; authCheck?.abort();
      clearInterval(historyPoll);
      configurations.close(); resources.close(); clearInterval(authPoll); if (broadcastTimer) { clearTimeout(broadcastTimer); } login?.kill(); conversationController?.dispose(); projectController?.dispose(); runtime.dispose();
      await kanbanController?.close();
      for (const client of clients) { client.end(); }
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        await conversationController?.idle(); await conversationController?.persist();
        await projectController?.idle(); await projectController?.persist(); await pendingSave;
      } finally { ownership?.close(); await activity?.close(); }
    })(),
  };
}
