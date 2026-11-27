import { createProjectCliEnvironment, prepareProjectDistributionCli } from './workflow-cli-process';
import { t } from './localization';
import { AggregateWebHostPool } from './workflow-host-pool';
import { upgradeServerProject } from './workflow-project-update-node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspectProjectCli, resolveProjectCli, startProjectCli, requestProjectCliConfiguration, type StudioControlConfiguration } from './workflow-cli-process';
import type { Launcher, WebSession } from './workflow-cli-types';
import { startLegacyLocalFrame } from './workflow-legacy-frame';
import { readUserSettings, USER_PERMISSION_SETTING } from './user-settings';
import type { AccountController } from './workflow-auth';
import { prepareAssistantApplication, prepareAnalysisApplication, prepareBuiltinApplication, ANALYSIS_PROJECT_ID } from './assistant-application';
import { assistantWorkspaceAvailable, createAssistantProject, DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';
import type { Project } from './workflow-types';
import { createStudioControlHandler, STUDIO_CONTROL_ENTRY_ID, studioControlWorkspaceAvailable } from './studio-control';
import { startStudioControlBridge, type StudioControlBridge } from './studio-control-bridge';
import { createStudioAnalysisHandler, studioAnalysisProjects } from './studio-analysis';
import { projectTemplatesRuntime, installProjectDependencies, defaultProjectParentDirectory } from './project-create-node';
import { inspectRuntimeDependencies, replaceRuntimeDependencies } from './project-runtime-dependencies-node';
import { createRuntimeNpmLatest } from './project-runtime-npm-node';
import { configuredNodeRuntime } from './node-runtime-configuration';
import { nodeRuntimeEnvironment, type NodeRuntime } from './node-runtime';
import type { ProjectType } from './projects';
import { uploadServerProject, downloadServerProject } from './steamharness-server-projects-node';
import { ProjectServerClient } from './steamharness-server-projects';
import { readStudioKanbanDiagnostics, type StudioKanbanHost } from './studio-kanban';
import type { Connection } from './workflow-auth-client';
import { readSidebarProjectEntries } from './project-sidebar-node';
import { readRunningLibraryProjects } from './library-activity';
import { ProjectUsageService } from './project-usage-service';
import type { ManagedUsageTarget } from './project-usage-types';
import { usingStudioWeb, studioPreview } from './remote-access-node';
import { WorkflowScheduleRuntime } from './workflow-schedule-runtime';
import { openProjectSchedules } from './workflow-schedule-view';
import { createBotCredentialInteraction } from './bot-credentials';
import { canAccessBotCredentialStorage } from './bot-credential-metadata';
import { createBotCredentialTargetResolver } from './bot-credential-list';
import { registerWebBotCredentialManagement } from './bot-credential-management';
import { registerBotManagementView } from './bot-management-view';
import { localAccountDirectory, localDataHome, localProjectDirectory, prepareLocalDirectory } from '@steamharness/project-manifest/node';
import { PROJECT_UUID_PATTERN } from '@steamharness/project-manifest';
import type { AccountWorkspace } from './account-workspace-data';
import { ProjectProcessManager } from './workflow-process-client';

interface RuntimeScope {
  workspace?: AccountWorkspace;
  data: string;
  lifetime: AbortController;
  usage: ProjectUsageService;
  schedules?: WorkflowScheduleRuntime;
  processes?: ProjectProcessManager;
}

export function createProjectRuntime(context: vscode.ExtensionContext, account: AccountController): Launcher {
  const sessions = new Set<WebSession>();
  const kanbanSessions = new Map<WebSession, StudioKanbanHost>();
  const controller = new AbortController();
  const authRoot = path.join(localDataHome(), 'hosts', randomUUID(), 'isolated-auth');
  const browser = usingStudioWeb();
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
  const localDesktop = !vscode.env.remoteName && typeof vscode.env.uiKind === 'number' && vscode.env.uiKind === vscode.UIKind.Desktop;
  const desktop = !browser && localDesktop;
  const botCredentials = createBotCredentialInteraction(context, undefined, () => currentData());
  const startSchedules = (scope: RuntimeScope) => new WorkflowScheduleRuntime(path.join(scope.data, 'schedules'), scope.data,
    directory => Promise.resolve(vscode.commands.executeCommand<boolean>('studio.internalSidebarProjectTrust', vscode.Uri.file(directory).toString(), false)).catch(() => false),
    async (target, workflowScheduleKey, signal) => {
      const combined = AbortSignal.any([signal, controller.signal, scope.lifetime.signal]);
      const runtime = await selectedRuntime();
      combined.throwIfAborted();
      const startup = new AbortController();
      const abort = () => startup.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        await account.loadUserModels?.();
        combined.throwIfAborted();
        return await startProjectCli({ projectDir: target.directory, expectedProjectId: target.projectId, entryId: target.entryId,
          nodePath: runtime.nodePath, runtime, theme: 'dark', locale: vscode.env.language, surface: 'editor', userSettings: settingsSnapshot(),
          dataDir: scope.data, authRoot, workflowScheduleKey, signal: AbortSignal.any([startup.signal, controller.signal, scope.lifetime.signal]) });
      } finally { signal.removeEventListener('abort', abort); }
    }, error => console.warn('Studio Workflow scheduler:', error instanceof Error ? error.message : 'unknown error'));
  let activeScope: RuntimeScope | undefined;
  const retireScope = () => {
    const scope = activeScope;
    activeScope = undefined;
    // Abort this window's leases only. Other desktop/Web clients may still own work in the account.
    if (scope) { scope.lifetime.abort(); scope.schedules?.dispose(); scope.usage.dispose(); }
    void hosts.close();
  };
  const scopeForAccount = (): RuntimeScope => {
    controller.signal.throwIfAborted();
    const workspace = account.workspace?.();
    if (activeScope && activeScope.workspace === workspace) return activeScope;
    retireScope();
    workspace?.prepare();
    const data = workspace?.runs ?? prepareLocalDirectory(localAccountDirectory());
    const scope: RuntimeScope = { workspace, data, lifetime: new AbortController(), usage: new ProjectUsageService(data,
      path.join(context.extensionUri.fsPath, 'dist', 'project-usage-worker.cjs'), account.platform
        ? uri => vscode.commands.executeCommand<ManagedUsageTarget | undefined>('studio.internalResolveFolderBotUsage', uri) : undefined) };
    if (browser || localDesktop) scope.processes = new ProjectProcessManager(data, path.join(context.extensionUri.fsPath, 'dist', 'workflow-process-service.cjs'));
    // Schedule execution stays desktop-only, with the same runtime history as an interactive run.
    if (desktop) try { scope.schedules = startSchedules(scope); }
    catch (error) { console.warn('Studio schedule storage:', error instanceof Error ? error.message : 'unknown error'); }
    return activeScope = scope;
  };
  const workspaceReady = account.waitForWorkspaceAccount?.();
  const warmScope = () => {
    if (controller.signal.aborted) return;
    try { scopeForAccount(); }
    catch (error) { console.warn('Studio account workspace:', error instanceof Error ? error.message : 'unknown error'); }
  };
  const warmLocalScope = desktop || browser && account.sharesWorkspace;
  if (warmLocalScope) { void Promise.resolve(workspaceReady).then(warmScope); }
  const accountScopeChanged = account.sharesWorkspace ? account.onDidChange(() => {
    if (activeScope && activeScope.workspace !== account.workspace?.()) retireScope();
    if (warmLocalScope) void Promise.resolve(workspaceReady).then(warmScope);
  }) : undefined;
  const captureScope = async () => { await workspaceReady; const scope = scopeForAccount(); scope.lifetime.signal.throwIfAborted(); return scope; };
  const configurationService = {
    systemModelCatalog: async (signal: AbortSignal) => {
      await account.loadUserModels?.();
      const catalog = await account.getSystemModelCatalog(AbortSignal.any([signal, controller.signal]));
      const preferred = account.getUserAgentModels()[0];
      return { ...catalog, ...(preferred?.source === 'system' ? { defaultModel: { credentialId: preferred.credentialId, model: preferred.model } } : {}) };
    },
    kanban: (input: { projectDir: string; projectId: string; entryId: string; call?: unknown }, signal: AbortSignal) =>
      readStudioKanbanDiagnostics(kanbanSessions, input, AbortSignal.any([signal, controller.signal])),
    configuration: async (input: Record<string,unknown>, signal: AbortSignal): Promise<unknown> => {
      assertAvailable();
      if(input.storage==='local') {
        if(input.open) { await vscode.commands.executeCommand('studio.openProjectConfigurations',input.projectDir,input.entryId); return {opened:true,storage:'local',projectDir:input.projectDir}; }
        const runtime = await selectedRuntime();
        return requestProjectCliConfiguration(String(input.projectDir), runtime.nodePath, input.call as Record<string, unknown>, signal, undefined, String(input.entryId), runtime, authRoot, account.workspace?.()?.owner ?? 'local');
      }
      // Remote Studio Control is explicit and never initiates interactive login on behalf of an agent.
      const connection = account.getConnection();
      if (!account.platform || !connection) throw new Error(t('Sign in to SteamHarness Server first.'));
      if(input.open) { await vscode.env.openExternal(vscode.Uri.parse(`${connection.serverUrl}/detail/${encodeURIComponent(String(input.projectId))}/entries/${encodeURIComponent(String(input.entryId))}/configurations`)); return {opened:true,storage:'server',projectId:input.projectId}; }
      return new ProjectServerClient(connection).configurations(String(input.projectId), String(input.entryId), String(input.target ?? 'draft'), signal, input.call as Record<string, unknown>);
    },
  };
  const runtimePackageDirectory = process.env.STEAMHARNESS_PROJECT_PACKAGE_DIR;
  const runtimeNpmLatest = desktop ? createRuntimeNpmLatest(controller.signal) : undefined;
  const templates = projectTemplatesRuntime(context.extensionUri.fsPath, vscode.env.language, runtimePackageDirectory);
  const currentData = () => account.workspace?.()?.runs ?? localAccountDirectory();
  const isBuiltinProjectDirectory = (directory: string): boolean => {
    const [id, builds, stamp, subdir, ...rest] = path.relative(path.join(currentData(), 'projects'), directory).split(path.sep);
    return PROJECT_UUID_PATTERN.test(id) && builds === 'builds' && /^[a-f0-9]{24}$/.test(stamp) && (!subdir || subdir === 'project') && !rest.length;
  };
  const applications = new Map<string, Promise<string>>();
  const cached = (data: string, id: string, load: () => Promise<string>): Promise<string> => {
    const key = JSON.stringify([data, id]);
    const previous = applications.get(key);
    if (previous) return previous;
    const operation = load().catch(error => { applications.delete(key); throw error; });
    applications.set(key, operation); return operation;
  };
  const assistantDirectory = async (requestedData?: string): Promise<string> => {
    await workspaceReady;
    const data = requestedData ?? currentData();
    return cached(data, DEVELOPER_ASSISTANT_PROJECT_ID, () => realpath(context.extensionUri.fsPath).then(extensionDirectory => {
      const studioRoot = path.resolve(extensionDirectory, '..', '..');
      return prepareAssistantApplication({
        templateDir: path.join(extensionDirectory, 'dist', 'developer-assistant'),
        storageDir: data,
        dependencySources: [
          path.join(process.env.STUDIO_STEAMHARNESS_SOURCE || path.resolve(studioRoot, '..'), 'build-in', 'build-in-developer-assistant'),
          path.join(process.env.STUDIO_STEAMHARNESS_SOURCE || path.join(studioRoot, '..', 'workflow'), 'build-in', 'build-in-developer-assistant'),
          path.join(studioRoot, 'vendor', 'developer-assistant')],
      });
    }));
  };
  const analysisDirectory = (data: string): Promise<string> => cached(data, ANALYSIS_PROJECT_ID, () => realpath(context.extensionUri.fsPath)
    .then(async extensionDirectory => prepareAnalysisApplication({
      templateDir: path.join(extensionDirectory, 'dist', 'analysis'),
      storageDir: data, dependencySources: [await assistantDirectory(data)],
    })));
  const listBuiltinProjectDirectories = async () => {
    const scope = await captureScope();
    const data = scope.data;
    const additional = account.platform ? await vscode.commands.executeCommand<{ directory: string; projectId: string; pending?: boolean }[]>(
      'studio.internalListAdditionalBuiltinProjects').then(rows => rows ?? [], () => []) : [];
    const applications = additional.filter(row => path.isAbsolute(row.directory) && !row.pending).map(({ directory, projectId }) => {
      return cached(data, directory, async () => prepareBuiltinApplication({ templateDir: directory,
        storageDir: data, dependencySources: [await assistantDirectory(data)] }, projectId));
    });
    const results = await Promise.allSettled([assistantDirectory(data), analysisDirectory(data), ...applications]);
    scope.lifetime.signal.throwIfAborted();
    return { directories: results.flatMap(result => result.status === 'fulfilled' && isBuiltinProjectDirectory(result.value) ? [result.value] : []),
      pending: additional.some(row => row.pending) };
  };
  let analysisProjects: Project[] = [];
  const analysisReads = new WeakMap<RuntimeScope, Promise<unknown>>();
  const readAnalysis = (scope: RuntimeScope): Promise<unknown> => {
    scope.lifetime.signal.throwIfAborted();
    const existing = analysisReads.get(scope);
    if (existing) return existing;
    const pending = (async () => {
    const cli = await resolveProjectCli(await assistantDirectory());
    const reader = await import(pathToFileURL(path.join(path.dirname(cli.entry), 'web', 'local-analysis.mjs')).href);
    for (let attempt = 0; attempt < 3; attempt++) {
      assertAvailable();
      scope.lifetime.signal.throwIfAborted();
      const scopedProjects = () => studioAnalysisProjects(context, analysisProjects).filter(project => !isBuiltinProjectDirectory(project.folderPath));
      const projects = scopedProjects();
      const result = await reader.readLocalStudioAnalysis({ storageDir: scope.data,
        projects, locale: vscode.env.language });
      assertAvailable();
      scope.lifetime.signal.throwIfAborted();
      if (JSON.stringify(projects) === JSON.stringify(scopedProjects())) { return result; }
    }
    throw new Error('Studio project scope changed while reading analysis.');
    })().finally(() => { analysisReads.delete(scope); });
    analysisReads.set(scope, pending);
    return pending;
  };
  if (desktop) context.subscriptions.push(registerBotManagementView(context, { captureScope,
    currentOwner: () => account.workspace?.()?.owner ?? null,
    target: { assistantId: DEVELOPER_ASSISTANT_PROJECT_ID, isBuiltinProjectDirectory, localAssistantDirectory: assistantDirectory,
      resolveManaged: account.platform ? uri => vscode.commands.executeCommand<ManagedUsageTarget | undefined>('studio.internalResolveFolderBotUsage', uri) : undefined,
      trusted: directory => vscode.commands.executeCommand<boolean>('studio.internalSidebarProjectTrust', vscode.Uri.file(directory).toString(), false),
    },
  }));
  const credentialOwner = () => account.workspace?.()?.owner ?? null;
  const credentialFolderTrusted = (directory: string) => vscode.commands.executeCommand<boolean>(browser ? 'studio.internalIsWebBotFolderTrusted'
    : 'studio.internalSidebarProjectTrust', vscode.Uri.file(directory).toString(), false);
  const resolveCredentialTarget = createBotCredentialTargetResolver({ isBuiltinProjectDirectory, localAssistantDirectory: assistantDirectory,
    resolveManaged: account.platform ? uri => vscode.commands.executeCommand<ManagedUsageTarget | undefined>('studio.internalResolveFolderBotUsage', uri) : undefined,
    trusted: credentialFolderTrusted,
  });
  const showWebCredentials = browser ? registerWebBotCredentialManagement(context, credentialOwner) : undefined;
  const openCredentials = !desktop && !browser ? undefined : async (input: unknown, owner: unknown) => {
    const accountScope = await captureScope();
    const signal = AbortSignal.any([controller.signal, accountScope.lifetime.signal]);
    if (owner !== credentialOwner() || owner !== (accountScope.workspace?.owner ?? null)) return;
    const target = await resolveCredentialTarget(input);
    if (target === 'untrusted') throw new Error(t('Trust the current workspace first.'));
    if (!target || signal.aborted || owner !== credentialOwner()) return;
    if (showWebCredentials) { await showWebCredentials(target, accountScope.workspace?.owner ?? null, signal); return; }
    const { projectId, entryId, projectDirectory, instanceId, workdir } = target.scope;
    const result = await botCredentials({ id: projectId, folderPath: projectDirectory,
      folderBot: instanceId && workdir ? { id: instanceId, directory: workdir } : undefined,
      assistant: !instanceId && workdir ? { workdir } : undefined,
    }, entryId, target.name, { action: 'manage' }, signal, undefined, async () => owner === credentialOwner() && await target.recheck());
    if (result === 'busy') void vscode.window.showWarningMessage(t('A secure credential prompt is already open. Try again after closing it.'));
  };
  const assertAvailable = (requiresWorkspaceTrust = true): void => {
    if (requiresWorkspaceTrust && !vscode.workspace.isTrusted) { throw new Error(t("Trust the current workspace first.")); }
    if (controller.signal.aborted) { throw new Error('Workflow host has stopped.'); }
  };
  const assertAssistantWorkspace = (assistant: NonNullable<Project['assistant']>): void => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
    if (!assistantWorkspaceAvailable(assistant, folders)) { throw new Error(t("Assistant workspace is no longer available.")); }
  };
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
    runtimeDependencies: !desktop ? undefined : {
      bundleDirectory: runtimePackageDirectory && path.isAbsolute(runtimePackageDirectory) ? runtimePackageDirectory : undefined,
      inspect: (candidate, signal) => inspectRuntimeDependencies(candidate, runtimePackageDirectory, AbortSignal.any([signal, controller.signal]), runtimeNpmLatest),
      async replace(candidate, revision, signal, beforeReplace, log) {
        assertAvailable();
        if (!runtimePackageDirectory) throw new Error(t('This Studio build does not have a valid Core and CLI bundle.'));
        const combined = AbortSignal.any([signal, controller.signal]);
        const runtime = await selectedRuntime();
        return replaceRuntimeDependencies({ candidate, bundle: runtimePackageDirectory, revision, signal: combined,
          beforeReplace: directory => { assertAvailable(); return beforeReplace(directory); },
          install: (directory, manager) => installProjectDependencies({ directory, signal: combined, log, runtime, runtimeReplacement: manager }) });
      },
    },
    startLegacyLocalFrame,
    downloadDirectory: path.join(homedir(), 'Downloads'),
    nodeRuntime: async () => {
      const runtime = await selectedRuntime();
      const base = nodeRuntimeEnvironment(runtime);
      const env = createProjectCliEnvironment(base, undefined, runtime, authRoot);
      return { nodePath: runtime.nodePath, env: { ...Object.fromEntries(Object.keys(base).filter(key => !(key in env)).map(key => [key, null])), ...env }, electron: runtime.electron };
    },
    analyzeProjectType: async sources => {
      const directory = await assistantDirectory();
      const { resolve } = await import('import-meta-resolve');
      const rules = await import(resolve('steamharness/executor/rules', pathToFileURL(path.join(directory, 'package.json')).href));
      const types = new Set<ProjectType>();
      for (const source of sources) {
        const type = rules.analyzeProjectScriptSource(source.text, source.name).executorProjectType;
        if (type === 'workflow' || type === 'bot') { types.add(type); }
      }
      return types.size === 1 ? [...types][0] : undefined;
    },
    templates: templates.templates,
    projectCreationDirectory: defaultProjectParentDirectory(),
    validateProjectCreation: templates.validate,
    createProject: async (input, signal = controller.signal) => {
      assertAvailable(false);
      const combined = AbortSignal.any([signal, controller.signal]);
      return templates.create(input, combined, undefined, true);
    },
    createRunDraft: !desktop ? undefined : (input, signal = controller.signal) => {
      assertAvailable();
      return templates.createRunDraft(input, AbortSignal.any([signal, controller.signal]));
    },
    openProjectSchedules: !desktop ? undefined : async (project, openRun) => {
      const scope = await captureScope();
      const workflowSchedules = scope.schedules;
      if (!workflowSchedules) throw new Error(t('Could not open local schedule storage.'));
      if (project.projectType !== 'workflow' || project.assistant || project.folderBot || project.distribution === 'release' || !project.manifest?.version
        || isBuiltinProjectDirectory(project.folderPath)) throw new Error(t('Schedules are available for trusted local Workflow source projects.'));
      const target = { directory: await realpath(project.folderPath), projectId: project.id, entryId: project.entryId, version: project.manifest.version };
      await workflowSchedules.verifyTarget(target).catch(error => { throw new Error(error.message === 'authorization-changed' ? t('Trust this project folder before running it.') : t('The project entry has changed or is no longer available.')); });
      scope.lifetime.signal.throwIfAborted();
      openProjectSchedules(context, workflowSchedules, project, target, openRun, scope.lifetime.signal);
    },
    registerProject: async (directory, signal) => {
      assertAvailable();
      const combined = AbortSignal.any([signal, controller.signal]);
      return templates.register(directory, combined, async () => randomUUID());
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
    prepareDistribution: async (project, snapshot, signal, progress) => {
      assertAvailable(); const runtime = await selectedRuntime();
      return prepareProjectDistributionCli(project.folderPath, runtime.nodePath, snapshot, AbortSignal.any([signal, controller.signal]), progress, runtime, snapshot ? project.entryId : undefined, authRoot);
    },
    uploadProject: !account.platform ? undefined : (project, releaseLog, signal, progress) => {
      assertAvailable();
      return transfer(signal, options => uploadServerProject({ ...options, projectId: project.id, version: project.manifest?.version ?? '', directory: project.folderPath, releaseLog, progress }));
    },
    downloadProject: !account.platform ? undefined : (projectId, version, signal, progress) => transfer(signal, options => downloadServerProject({ ...options, projectId, version,
      parentDirectory: defaultProjectParentDirectory(), progress })),
    upgradeProject: !account.platform ? undefined : (project, version, signal, progress, beforeReplace, afterReplace) => {
      assertAvailable();
      return transfer(signal, options => upgradeServerProject({ ...options, projectId: project.id, version,
        directory: project.folderPath, expectedVersion: project.manifest?.version ?? '', parentDirectory: defaultProjectParentDirectory(), progress, beforeReplace, afterReplace }));
    },
    updateAnalysisProjects: projects => { analysisProjects = [...projects]; },
    holdProjectReplacement: async (directory, signal) => {
      const scope = await captureScope();
      return await scope.processes?.hold(directory, AbortSignal.any([signal, scope.lifetime.signal, controller.signal])) ?? { dispose() {} };
    },
    inspectAnalysis: async () => {
      assertAvailable();
      const directory = await analysisDirectory((await captureScope()).data);
      const runtime = await selectedRuntime();
      const result = await inspectProjectCli(directory, runtime.nodePath, controller.signal, undefined, undefined, vscode.env.language, false, runtime, authRoot);
      const project = result.projects.find(project => project.id === ANALYSIS_PROJECT_ID && project.projectType === 'kanban');
      if (!project) { throw new Error(result.errors.join('\n') || 'Studio Analysis project is unavailable.'); }
      return { ...project, uri: vscode.Uri.file(directory).toString(), builtin: 'analysis' };
    },
    readSidebarEntries: vscode.env.remoteName && !browser ? undefined : readSidebarProjectEntries,
    readLibraryActivity: vscode.env.remoteName && !browser ? undefined : async projects => {
      const scope = await captureScope();
      const result = await readRunningLibraryProjects(scope.data, projects);
      return scope.lifetime.signal.aborted ? [] : result;
    },
    readProjectUsage: browser || desktop ? async input => (await captureScope()).usage.request(input) : undefined,
    previewWeb: browser ? studioPreview : undefined,
    openHostedSidebar: async (...args) => {
      const preview = await (await import('./hosted-sidebar-preview')).openHostedSidebar(...args);
      if (!browser) return preview;
      try {
        const remote = await studioPreview(preview.url, 'hosted');
        if (args[2].aborted) { await remote.dispose(); args[2].throwIfAborted(); }
        return { ...preview, url: remote.url.href, close: async () => { await remote.dispose(); await preview.close(); } };
      } catch (error) { await preview.close(); throw error; }
    },
    inspect: async (paths, options) => {
      assertAvailable();
      const runtime = await selectedRuntime();
      const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      signal.throwIfAborted();
      const results = await Promise.allSettled(paths.map(folder => inspectProjectCli(folder, runtime.nodePath, signal, undefined, undefined, vscode.env.language, options?.validationDetails, runtime, authRoot)));
      const projects = [], errors: string[] = [];
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'fulfilled') { projects.push(...result.value.projects); errors.push(...result.value.errors); }
        else { errors.push(`${paths[index]}: ${String(result.reason)}`); }
      }
      return { projects, errors };
    },
    localAssistantDirectory: assistantDirectory,
    listBuiltinProjectDirectories: localDesktop ? listBuiltinProjectDirectories : undefined,
    isBuiltinProjectDirectory,
    openBotCredentials: openCredentials,
    openWebProjectCredentials: showWebCredentials ? async (project, signal) => {
      const accountScope = await captureScope();
      const lifetime = AbortSignal.any([controller.signal, accountScope.lifetime.signal, signal]);
      const owner = accountScope.workspace?.owner ?? null;
      const uri = project.folderBot ? project.uri : vscode.Uri.file(project.folderPath).toString();
      const target = await resolveCredentialTarget({ uri, projectId: project.id, entryId: project.entryId });
      if (!target || target === 'untrusted' || owner !== credentialOwner() || lifetime.aborted) return;
      const workdir = !project.folderBot && project.assistant?.workdir;
      await showWebCredentials(workdir ? { ...target, scope: { ...target.scope, workdir }, recheck: async () => {
        try { assertAssistantWorkspace(project.assistant!); }
        catch { return false; }
        return await credentialFolderTrusted(workdir) && await target.recheck();
      } } : target, owner, lifetime);
    } : undefined,
    inspectAssistant: async (target, folders) => {
      assertAvailable();
      const assistant = { standalone: true, workdir: target.folderPath, roots: [target, ...folders.filter(folder => folder.uri !== target.uri)] };
      assertAssistantWorkspace(assistant);
      const preparation = assistantDirectory();
      const directory = await preparation;
      assertAvailable(); assertAssistantWorkspace(assistant);
      try {
        const runtime = await selectedRuntime();
        const result = await inspectProjectCli(directory, runtime.nodePath, controller.signal, directory, assistant, vscode.env.language, false, runtime, authRoot);
        if (result.errors.length || !result.projects.some(project => project.id === DEVELOPER_ASSISTANT_PROJECT_ID && project.projectType === 'bot')) {
          applications.delete(JSON.stringify([currentData(), DEVELOPER_ASSISTANT_PROJECT_ID]));
        }
        return { ...result, projects: result.projects.map(project => createAssistantProject({ ...project, uri: '', assistant }, target, folders)) };
      } catch (error) {
        applications.delete(JSON.stringify([currentData(), DEVELOPER_ASSISTANT_PROJECT_ID]));
        throw error;
      }
    },
    start: async (project, surface, signal, options) => {
      const scope = await captureScope();
      const scopeSignal = AbortSignal.any([scope.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
      const runtime = await selectedRuntime();
      const embeddedAccount = account.platform && options?.embedded === true && !project.entries.some(entry => entry.webApp);
      const localArtifacts = options?.embedded === true && desktop && !project.folderBot?.background && project.entries.some(entry => entry.type === 'bot');
      const backgroundCredentials = options?.backgroundBotCredentials;
      const backgroundCredentialHost = backgroundCredentials && !backgroundCredentials.signal.aborted && desktop && !options?.embedded && surface === 'editor'
        && !project.assistant && project.folderBot?.background !== false && await canAccessBotCredentialStorage(context) ? backgroundCredentials : undefined;
      const projectDirectory = await realpath(project.folderPath);
      scopeSignal.throwIfAborted();
      // Keep desktop-only Bot capabilities and unattended callers out of the
      // ordinary interactive pool, even when their account data is shared.
      const key = JSON.stringify([scope.data, scope.workspace?.owner, projectDirectory, project.id, project.distribution, surface, project.assistant ?? null,
        runtime.identity, account.platform, options?.embedded === true, embeddedAccount, project.folderBot ?? null, localArtifacts,
        backgroundCredentialHost ? randomUUID() : null]);
      const lease = await hosts.acquire(
      key, project,
      async (port, hostSignal) => {
      assertAvailable();
      if (project.assistant) { assertAssistantWorkspace(project.assistant); }
      const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
        .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
      // A launch from the library uses the release's own folder, never an unrelated open workspace.
      const ownFolder = !project.assistant && project.id === DEVELOPER_ASSISTANT_PROJECT_ID && project.distribution === 'release'
        && isBuiltinProjectDirectory(project.folderPath) && roots.find(root => root.folderPath === project.folderPath);
      const workspaceAssistant = project.assistant ?? (ownFolder ? { standalone: true, workdir: ownFolder.folderPath, roots: [ownFolder] } : undefined);
      const managedWorkspace = workspaceAssistant?.standalone === true && !project.folderBot && project.distribution === 'release'
        && isBuiltinProjectDirectory(project.folderPath) && workspaceAssistant.workdir === project.folderPath && workspaceAssistant.roots.length === 1;
      const projectHome = managedWorkspace ? prepareLocalDirectory(localProjectDirectory(scope.data, project.id)) : undefined;
      const assistant = workspaceAssistant && (projectHome ? { ...workspaceAssistant, workdir: projectHome, storageScope: 'managed-project' as const,
        roots: [{ uri: vscode.Uri.file(projectHome).toString(), folderPath: projectHome, name: project.name }] } : workspaceAssistant);
      if (project.assistant?.standalone) {
        if (project.folderPath !== await assistantDirectory()) { throw new Error('Invalid standalone assistant scope.'); }
        assertAvailable(); assertAssistantWorkspace(project.assistant);
      }
      const theme = vscode.window.activeColorTheme.kind;
      const runSignal = AbortSignal.any([hostSignal, controller.signal, scope.lifetime.signal]);
      let bridge: StudioControlBridge | undefined;
      try {
        const workflowSchedules = scope.schedules;
        const manager = options?.embedded ? scope.processes : undefined;
        const workflowScheduleKey = (workflowSchedules || manager) && !project.assistant && !project.folderBot && project.distribution !== 'release'
          && !isBuiltinProjectDirectory(project.folderPath) && project.entries.some(entry => entry.type === 'workflow') ? WorkflowScheduleRuntime.capability() : undefined;
        let studioControl: StudioControlConfiguration | undefined;
        const assistantAggregate = project.id === DEVELOPER_ASSISTANT_PROJECT_ID
          && project.entries.some(entry => entry.entryId === STUDIO_CONTROL_ENTRY_ID && entry.type === 'workflow');
        if (!project.folderBot && (project.assistant || assistantAggregate)) {
          const directory = project.assistant ? await assistantDirectory() : project.folderPath;
          const assistantScope = (managedWorkspace ? workspaceAssistant : assistant) ?? { workdir: directory, roots };
          if (!studioControlWorkspaceAvailable(assistantScope, roots)) { throw new Error(t('Studio Control workspace is no longer available.')); }
          bridge = await startStudioControlBridge(createStudioControlHandler(assistantScope, runSignal, context, configurationService,
            projectHome && await realpath(projectHome)), runSignal);
          studioControl = { url: bridge.url, token: bridge.token, mcpServer: JSON.stringify({
            id: 'workflow-studio', command: [runtime.nodePath, (await resolveProjectCli(directory)).entry, 'mcp', directory, '--entry', STUDIO_CONTROL_ENTRY_ID],
            environment: { PATH: nodeRuntimeEnvironment(runtime).PATH!, ...createProjectCliEnvironment({}, undefined, runtime, authRoot), STEAMHARNESS_LOCAL_ACCOUNT_KEY: scope.workspace?.owner ?? 'local', ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
            inheritEnvironment: ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN'], timeout: 30_000,
          }) };
        } else if (project.id === ANALYSIS_PROJECT_ID && project.projectType === 'kanban') {
          bridge = await startStudioControlBridge(createStudioAnalysisHandler(() => readAnalysis(scope), runSignal), runSignal);
          studioControl = { url: bridge.url, token: bridge.token };
        }
        // Prewarming hosted Web apps in the launchpad does not use local model keys.
        if (project.entries.some(entry => !entry.webApp)) await account.loadUserModels?.();
        runSignal.throwIfAborted();
        const session = await startProjectCli({ projectDir: projectDirectory, nodePath: runtime.nodePath, runtime,
          assistantProjectDir: assistant ? project.folderPath : undefined,
          folderBot: project.folderBot,
          localBotArtifactLabel: localArtifacts ? project.folderBot ? project.name : project.aggregateName || project.name : undefined,
          backgroundBotCredentials: backgroundCredentialHost,
          botCredentials: localArtifacts || backgroundCredentialHost ? (entryId, label, action, signal) => {
            // Approval reuse is keyed to the lease, not to a newly constructed request signal.
            return botCredentials({ ...project, assistant }, entryId, backgroundCredentialHost ? t('Background Bot: {0}', project.folderBot ? project.name : label) : label,
              action, AbortSignal.any([runSignal, signal]), backgroundCredentialHost?.signal ?? runSignal);
          } : undefined,
          workflowScheduleKey,
          expectedProjectId: project.id,
          webAppEntries: account.platform ? project.entries.filter(entry => !!entry.webApp) : undefined,
          entryId: project.entryId,
          resourceProjects: options?.resourceProjects,
          dataDir: scope.data,
          theme: theme === vscode.ColorThemeKind.Light || theme === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark',
          surface: assistant ? 'assistant' : surface, platform: account.platform, authRoot, locale: vscode.env.language, assistant,
          studioControl, userSettings: settingsSnapshot(), signal: runSignal, port,
          managed: manager && { manager, key: JSON.stringify([key, assistant, studioControl ? desktop : null]), release: project.distribution === 'release', entries: project.entries,
            sources: [projectDirectory, ...(options?.resourceProjects ?? []), ...assistant?.roots.map(root => root.folderPath) ?? [], ...(project.folderBot ? [project.folderBot.directory] : [])] } });
        if (runSignal.aborted || !vscode.workspace.isTrusted) {
          await session.close();
          runSignal.throwIfAborted();
          assertAvailable();
        }
        const entries = session.ready.project.entries;
        if (session.workflowScheduleKey) await workflowSchedules?.register(project.folderPath, project.id, session, session.workflowScheduleKey).catch(() => undefined);
        const restrictedConfigurations = session.ready.restrictedConfigurationEntries?.some(entryId => entries.some(entry => entry.entryId === entryId));
        // Hosted Web Apps keep their provider-scoped session. An aggregate with
        // restricted configurations also needs the project account for role checks.
        const inheritEmbeddedAccount = embeddedAccount && !entries.some(entry => entry.webApp);
        const inheritProjectAccount = account.platform && (restrictedConfigurations || inheritEmbeddedAccount);
        const inheritSystemAi = inheritEmbeddedAccount && !project.folderBot?.background && session.ready.systemAiConnectionProtocolVersion === 2;
        let projectConnection: Connection | undefined, explicitAiConnection: Connection | undefined, webAppConnection: Connection | undefined;
        let hostedEntry: string | undefined, connectedWebAppEntry: string | undefined, webAppServerUrl: string | undefined;
        let checkingWebAppAccount = 0;
        let checkingWebAppConnection: Connection | undefined;
        const same = (left?: Connection, right?: Connection) => left?.serverUrl === right?.serverUrl && left?.accessToken === right?.accessToken;
        const syncAuthentication = () => {
          const currentAi = inheritSystemAi || explicitAiConnection ? account.getAiConnection() : undefined;
          if (!same(explicitAiConnection, currentAi)) explicitAiConnection = undefined;
          // Only reuse the login already given to this editor. A separate AI
          // credential still needs an explicit connection for this project.
          const sharedAi = inheritSystemAi && same(projectConnection, currentAi) ? projectConnection : undefined;
          session.updateAuth(projectConnection, explicitAiConnection ?? sharedAi);
        };
        const syncWebApp = async (connection?: Connection, interactive = false) => {
          const serverUrl = account.getState?.().serverUrl ?? connection?.serverUrl;
          if (runSignal.aborted || !hostedEntry || !interactive && connectedWebAppEntry === hostedEntry && same(webAppConnection, connection) && webAppServerUrl === serverUrl) return;
          const entryId = hostedEntry;
          connectedWebAppEntry = entryId; webAppConnection = connection; webAppServerUrl = serverUrl;
          try { await session.connectWebApp?.(entryId, connection, { interactive, serverUrl }); }
          catch (error) {
            if (connectedWebAppEntry === entryId && same(webAppConnection, connection)) {
              connectedWebAppEntry = undefined; webAppConnection = undefined;
            }
            throw error;
          }
        };
        const webAppFailed = () => {
          if (!runSignal.aborted) void vscode.window.showErrorMessage(t('Could not connect the Web application to your account. Check the Server configuration and retry.'));
        };
        const connectPlatform = async (purpose: 'project' | 'ai' | 'web-app', entryId: string, interactive = true, isCurrent = () => true) => {
          assertAvailable(); runSignal.throwIfAborted();
          if (!isCurrent()) return;
          if (purpose === 'ai') {
            if (session.ready.systemAiConnectionProtocolVersion !== 2) throw new Error(t('Update the project CLI to connect to System AI.'));
            const connection = await account.connectAi();
            runSignal.throwIfAborted();
            if (connection && same(connection, account.getAiConnection())) {
              explicitAiConnection = connection;
              syncAuthentication();
            }
          } else {
            if (purpose === 'web-app' && !project.entries.some(entry => entry.entryId === entryId && entry.webApp)) return;
            // Keep the requested entry while signed out so a later login resumes it.
            if (purpose === 'web-app') {
              hostedEntry = entryId;
              if (!interactive) { await syncWebApp(account.getConnection()); return; }
            }
            let connection: Connection | undefined;
            if (purpose === 'web-app') { checkingWebAppAccount++; checkingWebAppConnection = account.getConnection(); }
            try { connection = await account.connect(); }
            finally { if (purpose === 'web-app' && !--checkingWebAppAccount) checkingWebAppConnection = undefined; }
            runSignal.throwIfAborted();
            if (!isCurrent()) return;
            if (!connection) { await vscode.commands.executeCommand('studio.openLogin'); return; }
            if (!same(connection, account.getConnection())) return;
            if (purpose === 'project') { projectConnection = connection; syncAuthentication(); }
            else if (hostedEntry === entryId) await syncWebApp(connection, true);
          }
        };
        if (account.platform) session.connectPlatform = connectPlatform;
        const accountChanged = account.onDidChange(state => {
          if (runSignal.aborted || state.status === 'checking') return;
          const current = account.getConnection();
          projectConnection = inheritProjectAccount || same(projectConnection, current) ? current : undefined;
          syncAuthentication();
          if (!checkingWebAppAccount || !same(checkingWebAppConnection, current)) void syncWebApp(current).catch(webAppFailed);
        });
        if (inheritProjectAccount) {
          projectConnection = account.getConnection();
          if (projectConnection) syncAuthentication();
          // Restore a saved session in this window without blocking local startup or opening sign-in.
          else if (inheritEmbeddedAccount) void account.connect().catch(() => undefined);
        }
        const webAppLogin = session.onWebAppLogin?.((entryId, isCurrent) => {
          if (account.platform && !runSignal.aborted) void connectPlatform('web-app', entryId, true, isCurrent).catch(webAppFailed);
        });
        const webAppErrors = session.onWebAppError?.(reason => {
          connectedWebAppEntry = undefined; webAppConnection = undefined;
          if (reason === 'login-cancelled') return;
          const retry = t('Retry');
          const messages = {
            'server-not-configured': t('The selected Server has not configured account integration for this Web application. Configure and restart the Server, then retry.'),
            'server-unsupported': t('The selected Server does not support account integration for this Web application. Update the Server, then retry.'),
            'account-unavailable': t('Your Server session is no longer valid. Sign in again from the Studio account menu, then retry.'),
            'server-unavailable': t('The account Server could not be reached. Check its address and connection, then retry.'),
            'service-unavailable': t('The Web application service could not be reached. Start the service and check its address in the Server configuration, then retry.'),
            'invalid-response': t('Account integration returned an invalid response. Check the Server and Web application service versions and configuration.'),
            'provider-unavailable': t('This Studio installation has no account provider for the Web application. Check the Studio extension configuration.'),
            'unknown': t('Could not connect the Web application to your account. Check the Server configuration and retry.'),
          };
          void vscode.window.showErrorMessage(messages[reason], retry).then(action => {
            if (action === retry && !runSignal.aborted && hostedEntry) void session.connectPlatform?.('web-app', hostedEntry);
          });
        });
        void session.closed.then(() => { accountChanged.dispose(); webAppErrors?.dispose(); webAppLogin?.dispose(); });
        const sessionBridge = bridge;
        void session.closed.then(() => sessionBridge?.close());
        try { session.updateUserSettings(settingsSnapshot()); if (options?.resourceProjects) session.updateResourceProjects(options.resourceProjects); }
        catch (error) { await session.close(); throw error; }
        if (project.assistant || session.ready.project.entries.some(entry => entry.type === 'kanban')) {
          kanbanSessions.set(session, { directory: project.assistant?.workdir ?? project.folderPath,
            ...(project.assistant ? { resourceEntryId: project.entryId } : {}) });
          void session.closed.then(() => kanbanSessions.delete(session));
        }
        return session;
      } catch (error) { await bridge?.close(); throw error; }
    }, scopeSignal);
      // Opening or recovering a tab only checks its scope; sign-in needs a click.
      if (account.platform && project.entries.some(entry => entry.entryId === project.entryId && entry.webApp)) {
        void lease.connectPlatform?.('web-app', project.entryId, false).catch(() => {
          if (!scopeSignal.aborted) void vscode.window.showErrorMessage(t('Could not connect the Web application to your account. Check the Server configuration and retry.'));
        });
      }
      return lease;
    },
    cliEntry: async folder => { assertAvailable(); return (await resolveProjectCli(folder)).entry; },
    dispose: () => { controller.abort(); retireScope(); accountScopeChanged?.dispose(); userSettingsChanged.dispose(); userModelsChanged?.dispose(); clearTimeout(settingsTimer); },
  };
}
