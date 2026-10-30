import { t } from './localization';
import { AggregateWebHostPool } from './workflow-host-pool';
import { upgradeServerProject } from './workflow-project-update-node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inspectProjectCli, resolveProjectCli, startProjectCli, requestProjectCliConfiguration, type StudioControlConfiguration } from './workflow-cli-process';
import type { Launcher, WebSession } from './workflow-cli-types';
import { readUserSettings, USER_PERMISSION_SETTING } from './user-settings';
import type { AccountController } from './workflow-auth';
import { prepareAssistantApplication, prepareAnalysisApplication, ANALYSIS_PROJECT_ID } from './assistant-application';
import { assistantWorkspaceAvailable, createAssistantProject, DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';
import type { Project } from './workflow-types';
import { requestProjectResource } from './workflow-resources-node';
import { createStudioControlHandler, STUDIO_CONTROL_ENTRY_ID, studioControlWorkspaceAvailable } from './studio-control';
import { startStudioControlBridge, type StudioControlBridge } from './studio-control-bridge';
import { createStudioAnalysisHandler, studioAnalysisProjects } from './studio-analysis';
import { projectTemplatesRuntime, installProjectDependencies, defaultProjectParentDirectory } from './project-create-node';
import { configuredNodeRuntime } from './node-runtime-configuration';
import { nodeRuntimeEnvironment, type NodeRuntime } from './node-runtime';
import { readFile } from 'node:fs/promises';
import type { ProjectType } from './projects';
import { uploadServerProject, downloadServerProject, allocateServerProjectId } from './steamharness-server-projects-node';
import { ProjectServerClient } from './steamharness-server-projects';
import { readStudioKanbanDiagnostics } from './studio-kanban';

export function createProjectRuntime(context: vscode.ExtensionContext, account: AccountController): Launcher {
  const sessions = new Set<WebSession>();
  const kanbanSessions = new Map<WebSession, string>();
  const controller = new AbortController();
  const hosts = new AggregateWebHostPool(session => { sessions.add(session); void session.closed.then(() => sessions.delete(session)); });
  let settingsTimer: ReturnType<typeof setTimeout> | undefined;
  const settingsSnapshot = () => readUserSettings(account.getUserAgentModels?.());
  const syncUserSettings = () => {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      try { const settings = settingsSnapshot(); for (const session of sessions) { session.updateUserSettings(settings); } }
      catch (error) { void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error)); }
    }, 50);
  };
  const userSettingsChanged = vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration(USER_PERMISSION_SETTING)) { return; }
    syncUserSettings();
  });
  const userModelsChanged = account.onDidChangeUserModels?.(syncUserSettings);
  const selectedRuntime = () => configuredNodeRuntime(context.globalStorageUri.fsPath);
  const configurationService = {
    kanban: (input: { projectDir: string; projectId: string; entryId: string; call?: unknown }, signal: AbortSignal) =>
      readStudioKanbanDiagnostics(kanbanSessions, input, AbortSignal.any([signal, controller.signal])),
    configuration: async (input: Record<string,unknown>, signal: AbortSignal): Promise<unknown> => {
      assertAvailable();
      if(input.storage==='local') {
        if(input.open) { await vscode.commands.executeCommand('studio.openProjectConfigurations',input.projectDir,input.entryId); return {opened:true,storage:'local',projectDir:input.projectDir}; }
        const runtime = await selectedRuntime();
        return requestProjectCliConfiguration(String(input.projectDir),runtime.nodePath,input.call as Record<string,unknown>,signal,account.getConnection(),String(input.entryId),runtime);
      }
      const connection=account.getConnection();if(!connection)throw new Error(t('Sign in to SteamHarness Server first.'));
      if(input.open) { await vscode.env.openExternal(vscode.Uri.parse(`${connection.serverUrl}/detail/${encodeURIComponent(String(input.projectId))}/entries/${encodeURIComponent(String(input.entryId))}/configurations`)); return {opened:true,storage:'server',projectId:input.projectId}; }
      return new ProjectServerClient(connection).configurations(String(input.projectId), String(input.entryId), String(input.target ?? 'draft'), signal, input.call as Record<string, unknown>);
    },
  };
  const templates = projectTemplatesRuntime(context.extensionUri.fsPath, vscode.env.language);
  let assistantApplication: Promise<string> | undefined;
  const assistantDirectory = (): Promise<string> => {
    return assistantApplication ??= realpath(context.extensionUri.fsPath).then(extensionDirectory => {
      const studioRoot = path.resolve(extensionDirectory, '..', '..');
      return prepareAssistantApplication({
        templateDir: path.join(extensionDirectory, 'dist', 'developer-assistant'),
        storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'assistant'),
        dependencySources: [path.join(context.globalStorageUri.fsPath, 'workflow', 'assistant', 'runtime'),
          path.join(process.env.STUDIO_STEAMHARNESS_SOURCE || path.resolve(studioRoot, '..'), 'build-in', 'build-in-developer-assistant'),
          path.join(process.env.STUDIO_STEAMHARNESS_SOURCE || path.join(studioRoot, '..', 'workflow'), 'build-in', 'build-in-developer-assistant'),
          path.join(studioRoot, 'vendor', 'developer-assistant')],
      });
    }).catch(error => { assistantApplication = undefined; throw error; });
  };
  let analysisApplication: Promise<string> | undefined;
  const analysisDirectory = (): Promise<string> => analysisApplication ??= realpath(context.extensionUri.fsPath)
    .then(async extensionDirectory => prepareAnalysisApplication({
      templateDir: path.join(extensionDirectory, 'dist', 'analysis'),
      storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'analysis'), dependencySources: [await assistantDirectory()],
    })).catch(error => { analysisApplication = undefined; throw error; });
  let analysisProjects: Project[] = [];
  let readingAnalysis: Promise<unknown> | undefined;
  const readAnalysis = (): Promise<unknown> => readingAnalysis ??= (async () => {
    const cli = await resolveProjectCli(await assistantDirectory());
    const reader = await import(pathToFileURL(path.join(path.dirname(cli.entry), 'web', 'local-analysis.mjs')).href);
    for (let attempt = 0; attempt < 3; attempt++) {
      assertAvailable();
      const projects = studioAnalysisProjects(context, analysisProjects);
      const result = await reader.readLocalStudioAnalysis({ storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'web'),
        projects, locale: vscode.env.language });
      assertAvailable();
      if (JSON.stringify(projects) === JSON.stringify(studioAnalysisProjects(context, analysisProjects))) { return result; }
    }
    throw new Error('Studio project scope changed while reading analysis.');
  })().finally(() => { readingAnalysis = undefined; });
  const assertAvailable = (requiresWorkspaceTrust = true): void => {
    if (requiresWorkspaceTrust && !vscode.workspace.isTrusted) { throw new Error(t("Trust the current workspace first.")); }
    if (controller.signal.aborted) { throw new Error('Workflow host has stopped.'); }
  };
  const assertAssistantWorkspace = (assistant: NonNullable<Project['assistant']>): void => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
    if (!assistantWorkspaceAvailable(assistant, folders)) { throw new Error(t("Assistant workspace is no longer available.")); }
  };
  let connectionKey = JSON.stringify(account.getConnection());
  const authentication = account.onDidChange(state => {
    if (state.status === 'checking') { return; }
    const connection = account.getConnection();
    const next = JSON.stringify(connection);
    if (next === connectionKey) { return; }
    connectionKey = next;
    for (const session of sessions) { session.updateAuth(connection); }
  });
  const transfer = async <T>(signal: AbortSignal, action: (options: {
    cliEntry: string; runtimeDirectory: string; nodePath: string; runtime: NodeRuntime; connection: NonNullable<ReturnType<AccountController['getConnection']>>; signal: AbortSignal;
  }) => Promise<T>): Promise<T> => {
    assertAvailable(false);
    const connection = account.getConnection();
    if (!connection) { throw new Error(t('Sign in to SteamHarness Server first.')); }
    const changed = new AbortController();
    const subscription = account.onDidChange(state => {
      if (state.status !== 'checking' && JSON.stringify(account.getConnection()) !== JSON.stringify(connection)) { changed.abort(); }
    });
    try {
      const runtimeDirectory = await assistantDirectory();
      const combined = AbortSignal.any([signal, controller.signal, changed.signal]);
      combined.throwIfAborted();
      const runtime = await selectedRuntime();
      return await action({ cliEntry: (await resolveProjectCli(runtimeDirectory)).entry, runtimeDirectory, nodePath: runtime.nodePath, runtime, connection, signal: combined });
    } finally { subscription.dispose(); }
  };
  return {
    available: true,
    downloadDirectory: path.join(homedir(), 'Downloads'),
    nodeRuntime: async () => { const runtime = await selectedRuntime(); return { nodePath: runtime.nodePath, env: nodeRuntimeEnvironment(runtime), electron: runtime.electron }; },
    analyzeProjectType: async sources => {
      const directory = await assistantDirectory();
      const { resolve } = await import('import-meta-resolve');
      const rules = await import(resolve('steamharness/executor/rules', pathToFileURL(path.join(directory, 'package.json')).href));
      const types = new Set<ProjectType>();
      for (const source of sources) {
        const type = rules.analyzeProjectScriptSource(source.text, source.name).executorProjectType;
        if (type === 'workflow' || type === 'conversation') { types.add(type); }
      }
      return types.size === 1 ? [...types][0] : undefined;
    },
    templates: templates.templates,
    projectCreationDirectory: defaultProjectParentDirectory(),
    validateProjectCreation: templates.validate,
    createProject: async (input, signal = controller.signal) => {
      assertAvailable(false);
      const connection = account.getConnection(), state = account.getState();
      if (!connection || !state.user) { throw new Error(t('Sign in before creating a project so the Server can assign its ID.')); }
      const registration = new AbortController();
      const current = (): boolean => account.getConnection()?.serverUrl === connection.serverUrl
        && account.getConnection()?.accessToken === connection.accessToken && account.getState().user?.userId === state.user!.userId;
      const assertCurrent = (): void => {
        if (!current()) { throw new Error(t('The account used to create this project changed. Sign in with that account before retrying registration.')); }
      };
      const changed = account.onDidChange(() => { if (!current()) { registration.abort(); } });
      const combined = AbortSignal.any([signal, controller.signal, registration.signal]);
      try {
        return await templates.create(input, combined, project => allocateServerProjectId({ project, connection, assertCurrent, signal: combined }));
      } finally { changed.dispose(); }
    },
    installDependencies: async (directory, signal, log) => installProjectDependencies({ directory, signal: AbortSignal.any([signal, controller.signal]), log, runtime: await selectedRuntime() }),
    hasProjectDependencies: async directory => {
      try {
        await resolveProjectCli(directory);
        await stat(path.join(directory, 'node_modules/steamharness/package.json'));
        return true;
      } catch { return false; }
    },
    prepareProjectTemplate: async (directory, signal) => { const runtime = await selectedRuntime(); return templates.prepare(directory, runtime.nodePath, AbortSignal.any([signal, controller.signal]), runtime); },
    uploadProject: (project, releaseLog, signal, progress) => {
      assertAvailable();
      return transfer(signal, options => uploadServerProject({ ...options, projectId: project.id, version: project.manifest?.version ?? '', directory: project.folderPath, releaseLog, progress }));
    },
    downloadProject: (projectId, version, signal, progress) => transfer(signal, options => downloadServerProject({ ...options, projectId, version,
      parentDirectory: defaultProjectParentDirectory(), progress })),
    upgradeProject: (project, version, signal, progress, beforeReplace, afterReplace) => {
      assertAvailable();
      return transfer(signal, options => upgradeServerProject({ ...options, projectId: project.id, version,
        directory: project.folderPath, expectedVersion: project.manifest?.version ?? '', parentDirectory: defaultProjectParentDirectory(), progress, beforeReplace, afterReplace }));
    },
    environmentStatus: async () => {
      const result: { node?: string; harness?: string; cli?: string; error?: string } = {};
      try { result.node = (await selectedRuntime()).version; }
      catch (error) { result.error = String(error); }
      try {
        const directory = await assistantDirectory();
        result.cli = (await resolveProjectCli(directory)).version;
        result.harness = JSON.parse(await readFile(path.join(directory, 'node_modules/steamharness/package.json'), 'utf8')).version;
      } catch (error) { result.error = [result.error, String(error)].filter(Boolean).join('\n'); }
      return result;
    },
    analysisSummary: async () => {
      const result = await readAnalysis() as { generatedAt: number; projects: Array<{ availability: string; runs: Array<{ status: string }> }> };
      const unavailable = result.projects.filter(project => project.availability !== 'available').length;
      return { projects: result.projects.length, running: result.projects.flatMap(project => project.runs).filter(run => run.status === 'running').length,
        waiting: result.projects.flatMap(project => project.runs).filter(run => run.status === 'waiting_for_input').length, unavailable, generatedAt: result.generatedAt };
    },
    updateAnalysisProjects: projects => { analysisProjects = [...projects]; },
    inspectAnalysis: async () => {
      assertAvailable();
      const directory = await analysisDirectory();
      const runtime = await selectedRuntime();
      const result = await inspectProjectCli(directory, runtime.nodePath, controller.signal, undefined, undefined, vscode.env.language, false, runtime);
      const project = result.projects.find(project => project.id === ANALYSIS_PROJECT_ID && project.projectType === 'kanban');
      if (!project) { throw new Error(result.errors.join('\n') || 'Studio Analysis project is unavailable.'); }
      return { ...project, uri: vscode.Uri.file(directory).toString(), builtin: 'analysis' };
    },
    inspect: async (paths, options) => {
      assertAvailable();
      const runtime = await selectedRuntime();
      const results = await Promise.allSettled(paths.map(folder => inspectProjectCli(folder, runtime.nodePath, controller.signal, undefined, undefined, vscode.env.language, options?.validationDetails, runtime)));
      const projects = [], errors: string[] = [];
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'fulfilled') { projects.push(...result.value.projects); errors.push(...result.value.errors); }
        else { errors.push(`${paths[index]}: ${String(result.reason)}`); }
      }
      return { projects, errors };
    },
    inspectAssistant: async (target, folders) => {
      assertAvailable();
      const assistant = { standalone: true, workdir: target.folderPath, roots: [target, ...folders.filter(folder => folder.uri !== target.uri)] };
      assertAssistantWorkspace(assistant);
      const preparation = assistantDirectory();
      const directory = await preparation;
      assertAvailable(); assertAssistantWorkspace(assistant);
      try {
        const runtime = await selectedRuntime();
        const result = await inspectProjectCli(directory, runtime.nodePath, controller.signal, directory, assistant, vscode.env.language, false, runtime);
        if (result.errors.length || !result.projects.some(project => project.id === DEVELOPER_ASSISTANT_PROJECT_ID && project.projectType === 'conversation')) {
          if (assistantApplication === preparation) { assistantApplication = undefined; }
        }
        return { ...result, projects: result.projects.map(project => createAssistantProject({ ...project, uri: '', assistant }, target, folders)) };
      } catch (error) {
        if (assistantApplication === preparation) { assistantApplication = undefined; }
        throw error;
      }
    },
    start: async (project, surface, signal, resourceProjects) => {
      const runtime = await selectedRuntime();
      return hosts.acquire(
      JSON.stringify([project.folderPath, project.id, surface, project.assistant ?? null, runtime.identity]), project,
      async (port, hostSignal) => {
      assertAvailable();
      if (project.assistant) { assertAssistantWorkspace(project.assistant); }
      if (project.assistant?.standalone) {
        if (project.folderPath !== await assistantDirectory()) { throw new Error('Invalid standalone assistant scope.'); }
        assertAvailable(); assertAssistantWorkspace(project.assistant);
      }
      const theme = vscode.window.activeColorTheme.kind;
      const connection = account.getConnection();
      const runSignal = AbortSignal.any([hostSignal, controller.signal]);
      let bridge: StudioControlBridge | undefined;
      try {
        let studioControl: StudioControlConfiguration | undefined;
        const assistantAggregate = project.id === DEVELOPER_ASSISTANT_PROJECT_ID
          && project.entries.some(entry => entry.entryId === STUDIO_CONTROL_ENTRY_ID && entry.type === 'workflow');
        if (project.assistant || assistantAggregate) {
          const directory = project.assistant ? await assistantDirectory() : project.folderPath;
          const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
            .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
          const scope = project.assistant ?? { workdir: directory, roots };
          if (!studioControlWorkspaceAvailable(scope, roots)) { throw new Error(t('Studio Control workspace is no longer available.')); }
          bridge = await startStudioControlBridge(createStudioControlHandler(scope, runSignal, context, configurationService), runSignal);
          studioControl = { url: bridge.url, token: bridge.token, mcpServer: JSON.stringify({
            id: 'workflow-studio', command: [runtime.nodePath, (await resolveProjectCli(directory)).entry, 'mcp', directory, '--entry', STUDIO_CONTROL_ENTRY_ID,
              '--data-dir', path.join(context.globalStorageUri.fsPath, 'workflow', 'assistant', 'control-data')],
            environment: { PATH: nodeRuntimeEnvironment(runtime).PATH!, ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
            inheritEnvironment: ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN'], timeout: 30_000,
          }) };
        } else if (project.id === ANALYSIS_PROJECT_ID && project.projectType === 'kanban') {
          bridge = await startStudioControlBridge(createStudioAnalysisHandler(readAnalysis, runSignal), runSignal);
          studioControl = { url: bridge.url, token: bridge.token };
        }
        const session = await startProjectCli({ projectDir: project.folderPath, nodePath: runtime.nodePath, runtime,
          assistantProjectDir: project.assistant ? project.folderPath : undefined,
          expectedProjectId: project.id,
          entryId: project.entryId,
          resourceProjects,
          dataDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'web'),
          theme: theme === vscode.ColorThemeKind.Light || theme === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark',
          surface, connection, locale: vscode.env.language, assistant: project.assistant, studioControl, userSettings: settingsSnapshot(), signal: runSignal, port });
        const sessionBridge = bridge;
        void session.closed.then(() => sessionBridge?.close());
        if (controller.signal.aborted) { await session.close(); throw new Error('Workflow host has stopped.'); }
        if (JSON.stringify(account.getConnection()) !== JSON.stringify(connection)) { session.updateAuth(account.getConnection()); }
        try { session.updateUserSettings(settingsSnapshot()); }
        catch (error) { await session.close(); throw error; }
        if (!project.assistant && session.ready.project.entries.some(entry => entry.type === 'kanban')) {
          kanbanSessions.set(session, project.folderPath);
          void session.closed.then(() => kanbanSessions.delete(session));
        }
        return session;
      } catch (error) { await bridge?.close(); throw error; }
    }, signal); },
    cliEntry: async folder => { assertAvailable(); return (await resolveProjectCli(folder)).entry; },
    database: async (input, signal) => {
      assertAvailable();
      const folderPath = await assistantDirectory();
      const runtime = await selectedRuntime();
      signal.throwIfAborted();
      return requestProjectResource({ project: { id: DEVELOPER_ASSISTANT_PROJECT_ID, entryId: 'main', folderPath } as Project, input,
        worker: vscode.Uri.joinPath(context.extensionUri, 'dist', 'resources-worker.mjs').fsPath,
        storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'web'), nodePath: runtime.nodePath, runtime, connection: account.getConnection(),
        signal: AbortSignal.any([signal, controller.signal]) });
    },
    resource: async (project, input, signal) => {
      assertAvailable();
      const runtime = await selectedRuntime();
      return requestProjectResource({ project, input, worker: vscode.Uri.joinPath(context.extensionUri, 'dist', 'resources-worker.mjs').fsPath,
        storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'web'), nodePath: runtime.nodePath, runtime, connection: account.getConnection(),
        signal: AbortSignal.any([signal, controller.signal]) });
    },
    dispose: () => { controller.abort(); authentication.dispose(); userSettingsChanged.dispose(); userModelsChanged?.dispose(); clearTimeout(settingsTimer); void hosts.close(); },
  };
}
