import { t } from './localization';
import { upgradeServerProject } from './steamharness-project-update-node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inspectProjectCli, resolveProjectCli, startProjectCli, type StudioControlConfiguration } from './workflow-cli-process';
import type { WorkflowLauncher, WorkflowWebSession } from './workflow-cli-types';
import type { WorkflowAccountController } from './workflow-auth';
import { prepareAssistantApplication, prepareStudioControlApplication, prepareAnalysisApplication, ANALYSIS_PROJECT_ID } from './assistant-application';
import { assistantWorkspaceAvailable, createAssistantProject, DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';
import type { WorkflowProject } from './workflow-types';
import { requestProjectResource } from './workflow-resources-node';
import { createStudioControlHandler, STUDIO_CONTROL_PROJECT_ID, studioControlWorkspaceAvailable } from './studio-control';
import { startStudioControlBridge, type StudioControlBridge } from './studio-control-bridge';
import { createStudioAnalysisHandler, studioAnalysisProjects } from './studio-analysis';
import { projectTemplatesRuntime, installProjectDependencies, defaultProjectParentDirectory } from './project-create-node';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { ProjectType } from './projects';
import { uploadServerProject, downloadServerProject } from './workflow-server-projects-node';

export function createWorkflowRuntime(context: vscode.ExtensionContext, account: WorkflowAccountController): WorkflowLauncher {
  const sessions = new Set<WorkflowWebSession>();
  const controller = new AbortController();
  const executable = (): string => vscode.workspace.getConfiguration('studio').get<string>('workflow.nodePath') || process.execPath;
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
  let studioControlApplication: Promise<string> | undefined;
  const studioControlDirectory = (): Promise<string> => studioControlApplication ??= realpath(context.extensionUri.fsPath)
    .then(async extensionDirectory => prepareStudioControlApplication({
      templateDir: path.join(extensionDirectory, 'dist', 'studio-control'),
      storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'studio-control'),
      dependencySources: [await assistantDirectory()],
    })).catch(error => { studioControlApplication = undefined; throw error; });
  let analysisApplication: Promise<string> | undefined;
  const analysisDirectory = (): Promise<string> => analysisApplication ??= realpath(context.extensionUri.fsPath)
    .then(async extensionDirectory => prepareAnalysisApplication({
      templateDir: path.join(extensionDirectory, 'dist', 'analysis'),
      storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'analysis'), dependencySources: [await assistantDirectory()],
    })).catch(error => { analysisApplication = undefined; throw error; });
  let analysisProjects: WorkflowProject[] = [];
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
  const assertAssistantWorkspace = (assistant: NonNullable<WorkflowProject['assistant']>): void => {
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
    cliEntry: string; runtimeDirectory: string; nodePath: string; connection: NonNullable<ReturnType<WorkflowAccountController['getConnection']>>; signal: AbortSignal;
  }) => Promise<T>): Promise<T> => {
    assertAvailable(false);
    const connection = account.getConnection();
    if (!connection) { throw new Error(t('Sign in to Workflow Server first.')); }
    const changed = new AbortController();
    const subscription = account.onDidChange(state => {
      if (state.status !== 'checking' && JSON.stringify(account.getConnection()) !== JSON.stringify(connection)) { changed.abort(); }
    });
    try {
      const runtimeDirectory = await assistantDirectory();
      const combined = AbortSignal.any([signal, controller.signal, changed.signal]);
      combined.throwIfAborted();
      return await action({ cliEntry: (await resolveProjectCli(runtimeDirectory)).entry, runtimeDirectory, nodePath: executable(), connection, signal: combined });
    } finally { subscription.dispose(); }
  };
  return {
    available: true,
    analyzeProjectType: async sources => {
      const directory = await assistantDirectory();
      const { resolve } = await import('import-meta-resolve');
      const rules = await import(resolve('steamharness/executor/rules', pathToFileURL(path.join(directory, 'package.json')).href));
      const types = new Set<ProjectType>();
      for (const source of sources) {
        const type = rules.analyzeWorkflowScriptSource(source.text, source.name).executorProjectType;
        if (type === 'workflow' || type === 'conversation') { types.add(type); }
      }
      return types.size === 1 ? [...types][0] : undefined;
    },
    templates: templates.templates,
    projectCreationDirectory: defaultProjectParentDirectory(),
    validateProjectCreation: templates.validate,
    createProject: templates.create,
    installDependencies: (directory, signal, log) => installProjectDependencies({ directory, signal: AbortSignal.any([signal, controller.signal]), log }),
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
      try { result.node = (await promisify(execFile)(executable(), ['--version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000, windowsHide: true })).stdout.trim(); }
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
      const result = await inspectProjectCli(directory, executable(), controller.signal, undefined, undefined, vscode.env.language);
      const project = result.projects.find(project => project.id === ANALYSIS_PROJECT_ID && project.projectType === 'kanban');
      if (!project) { throw new Error(result.errors.join('\n') || 'Studio Analysis project is unavailable.'); }
      return { ...project, uri: vscode.Uri.file(directory).toString(), builtin: 'analysis' };
    },
    inspect: async paths => {
      assertAvailable();
      const results = await Promise.allSettled(paths.map(folder => inspectProjectCli(folder, executable(), controller.signal, undefined, undefined, vscode.env.language)));
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
        const result = await inspectProjectCli(directory, executable(), controller.signal, directory, assistant, vscode.env.language);
        if (result.errors.length || !result.projects.some(project => project.id === DEVELOPER_ASSISTANT_PROJECT_ID && project.projectType === 'conversation')) {
          if (assistantApplication === preparation) { assistantApplication = undefined; }
        }
        return { ...result, projects: result.projects.map(project => createAssistantProject({ ...project, uri: '', assistant }, target, folders)) };
      } catch (error) {
        if (assistantApplication === preparation) { assistantApplication = undefined; }
        throw error;
      }
    },
    start: async (project, surface, signal, relatedProjects, resourceProjects) => {
      assertAvailable();
      if (project.assistant) { assertAssistantWorkspace(project.assistant); }
      if (project.assistant?.standalone) {
        if (project.folderPath !== await assistantDirectory()) { throw new Error('Invalid standalone assistant scope.'); }
        assertAvailable(); assertAssistantWorkspace(project.assistant);
      }
      const theme = vscode.window.activeColorTheme.kind;
      const connection = account.getConnection();
      const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let bridge: StudioControlBridge | undefined;
      try {
        let studioControl: StudioControlConfiguration | undefined;
        if (project.assistant) {
          const directory = await studioControlDirectory();
          bridge = await startStudioControlBridge(createStudioControlHandler(project.assistant, runSignal, context), runSignal);
          studioControl = { url: bridge.url, token: bridge.token, mcpServer: JSON.stringify({
            id: 'workflow-studio', command: [executable(), (await resolveProjectCli(directory)).entry, 'mcp', directory,
              '--data-dir', path.join(context.globalStorageUri.fsPath, 'workflow', 'studio-control', 'data')],
            environment: { ELECTRON_RUN_AS_NODE: '1' },
            inheritEnvironment: ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN'], timeout: 30_000,
          }) };
        } else if (project.id === ANALYSIS_PROJECT_ID && project.projectType === 'kanban') {
          bridge = await startStudioControlBridge(createStudioAnalysisHandler(readAnalysis, runSignal), runSignal);
          studioControl = { url: bridge.url, token: bridge.token };
        } else if (project.id === STUDIO_CONTROL_PROJECT_ID && project.projectType === 'workflow') {
          const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
            .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
          const scope = { workdir: project.folderPath, roots };
          if (!studioControlWorkspaceAvailable(scope, roots)) { throw new Error(t('Studio Control workspace is no longer available.')); }
          bridge = await startStudioControlBridge(createStudioControlHandler(scope, runSignal, context), runSignal);
          studioControl = { url: bridge.url, token: bridge.token };
        }
        const session = await startProjectCli({ projectDir: project.folderPath, nodePath: executable(),
          assistantProjectDir: project.assistant ? project.folderPath : undefined,
          expectedProjectId: project.id,
          relatedProjects,
          resourceProjects,
          dataDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'web'),
          theme: theme === vscode.ColorThemeKind.Light || theme === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark',
          surface, connection, locale: vscode.env.language, assistant: project.assistant, studioControl, signal: runSignal });
        const sessionBridge = bridge;
        void session.closed.then(() => sessionBridge?.close());
        if (controller.signal.aborted) { await session.close(); throw new Error('Workflow host has stopped.'); }
        sessions.add(session);
        void session.closed.then(() => sessions.delete(session));
        if (JSON.stringify(account.getConnection()) !== JSON.stringify(connection)) { session.updateAuth(account.getConnection()); }
        return session;
      } catch (error) { await bridge?.close(); throw error; }
    },
    cliEntry: async folder => { assertAvailable(); return (await resolveProjectCli(folder)).entry; },
    resource: (project, input, signal) => {
      assertAvailable();
      return requestProjectResource({ project, input, worker: vscode.Uri.joinPath(context.extensionUri, 'dist', 'resources-worker.mjs').fsPath,
        storageDir: path.join(context.globalStorageUri.fsPath, 'workflow', 'web'), nodePath: executable(), connection: account.getConnection(),
        signal: AbortSignal.any([signal, controller.signal]) });
    },
    dispose: () => { controller.abort(); authentication.dispose(); for (const session of sessions) { void session.close(); } },
  };
}
