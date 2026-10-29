import { readProjectDeclarationFromDirectorySync } from "@steamharness/project-manifest/node";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createProjectFailure,
  safeRunProject,
  runNode,
  runStreamNode,
  HarnessError,
  type RunResult,
} from "../workflow/index";
import type {
  NodeExecutionHooks,
  NodeDefinition,
  ProviderRegistry,
  StreamNodeDefinition,
  RunContext,
  Definition,
  NodeMetadata,
  UserInputContext,
} from "../types/index";
import { resolveProjectEntrySync, type ResolvedProjectEntry } from "@steamharness/project-manifest/node";
import { projectEntryKey } from "@steamharness/project-manifest";
import type { AccessActor } from "@steamharness/project-access";
import { createExecutorHostState, createExecutorResources, type EntryDeclaration } from "./entry-resources";
import type { DatabaseResolver } from "../databases/index";
import type { ToolPermissionContext } from "../tool-permissions/index";
type ProjectDataStorageLocation = "local" | "server";
import { createLocalProjectConfigurationStore, withProjectConfiguration, currentConfigurationValues, readProjectConfigurationDefinition, projectUsesConfiguredAgentModels, type ProjectConfigurationSnapshot } from "../configuration";
import {
  combineNodeExecutionHooks,
  createNodeExecutionReporter,
  createProjectExecutionReport,
  resolveProjectResultStatus,
  type DefinitionEvent,
  type ExecutionReport,
  type RuntimeEvent,
  type StructureReport,
} from "./report";
import {
  formatProjectExecutionJson,
} from "./format";
import {
  inspectProjectScripts,
  inspectProjectStructure,
  type DefinedNode,
} from "./rules";
import { validateProjectParamResolveResult } from "./params";
import { parseExecutorParamValues } from "../agent/project-executor";
import { readAgentProjectContract } from "../agent/project-params";
import { getAgentMemoryBinding, getAgentMemoryCapabilities, type AgentMemoryCapabilities } from "../agent/memory";
import { listAgentSkillGuides, readAgentSkillGuide, type AgentSkillGuide, type AgentSkillPreview } from "../agent/skills";
import { STEAMHARNESS_ENTRYPOINT_ID_PATTERN } from "./definition";
import { assertProjectParamDeclarations, normalizeProjectParamDeclarations } from "./param-definition";
import { assertConversationFooter } from "./conversation-footer";
import { assertConversationUserInput } from "./conversation-input";
import { assertConversationPresentation } from "./conversation-presentation";
import { assertConversationCommands } from "./conversation-commands";
import type {
  NodeRegistryEntry,
  NodeRegistryItem,
  ExecutorContext,
  ExecutorDefinition,
  ExecutorModule,
  ExecutionDefinition,
  EntrypointDefinition,
  EntrypointGroupDefinition,
  ParamResolveRequest,
  ParamResolveResult,
} from "./types";
import {
  createAbortedProjectResult,
  createExecutionLimitLayer,
  createProjectRunId,
  createProjectRuntime,
  type Runtime,
  type RuntimeLayer,
} from "./runtime";
import { isOutputItemStreamChunk } from "../node/output/index";
import { installProjectRuntimeGlobal } from "../runtime-api";
import {
  createLocalProjectFileStore,
  createServerProjectFileStore,
  createProjectFileStore,
  type FileStore,
} from "../files/index";
import { createRemoteProjectFileStoreFromEnv } from "../files/remote";
import { createProjectNodeMetadata } from "../types/index";
import {
  createDisabledProjectConversationContext,
  createProjectConversationContext,
  type ConversationContext,
} from "../conversation/index";
import {
  createLocalProjectKVStore,
  createProjectPersistentValueContext,
  createProjectKVContext,
  type KVContext,
  type KVStore,
  type PersistentValueContext,
} from "../kv/index";
import {
  createProjectTokenUsageContext,
  type TokenUsageContext,
} from "../token-usage/index";
import {
  createProjectTimerContext,
} from "../timer/index";
import {
  createProjectToolPermissionContext,
  type ToolPermissionPolicyMap,
} from "../tool-permissions/index";
import {
  STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE,
  assertNeverExecutorProjectKind,
  isExecutorProjectKind,
  type ExecutorProjectType,
  type ProjectKind,
} from "../project-types";
import {
  createKanbanArtifactEntryPath,
  createKanbanExecutionUnsupportedMessage,


} from "@steamharness/kanban-project";
import {
  parseProjectSchedulePresets,
  validateProjectScheduleParamValues,
  type SchedulePreset,
} from "@steamharness/workflow-schedules";

export interface RunWorkspaceProjectOptions {
  entryId?: string;
  actor?: AccessActor;
  databaseResolver?: DatabaseResolver;
  inheritedToolPermissions?: ToolPermissionContext;
  authorizeEntry?(entryId: string, entrypointId: string | undefined, actor: AccessActor): Promise<void> | void;
  cwd?: string;
  projectName: string;
  args?: string[];
  configuration?: ProjectConfigurationSnapshot;
  /** Persist a distinct configuration generation when a durable session retains its run ID. */
  configurationRunId?: string;
  env?: NodeJS.ProcessEnv;
  providers?: ProviderRegistry;
  nodeHooks?: NodeExecutionHooks;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  timeoutMs?: number;
  maxNodeExecutions?: number;
  runId?: string;
  entrypointId?: string;
  conversationId?: string;
  storage?: ExecutionStorageOptions;
  fileStore?: FileStore;
  fileStoreDir?: string;
  fileCreateStoreDir?: string;
  layers?: RuntimeLayer[];
  userInput?: UserInputContext;
  toolPermissionPolicies?: ToolPermissionPolicyMap;
  onRuntimeEvent?(event: RuntimeEvent): Promise<void> | void;
  onDefinedNodes?(event: DefinitionEvent): Promise<void> | void;
}

export interface RunLocalProjectOptions {
  entryId?: string;
  actor?: AccessActor;
  databaseResolver?: DatabaseResolver;
  inheritedToolPermissions?: ToolPermissionContext;
  authorizeEntry?(entryId: string, entrypointId: string | undefined, actor: AccessActor): Promise<void> | void;
  projectDir?: string;
  projectName?: string;
  args?: string[];
  configuration?: ProjectConfigurationSnapshot;
  /** Persist a distinct configuration generation when a durable session retains its run ID. */
  configurationRunId?: string;
  env?: NodeJS.ProcessEnv;
  providers?: ProviderRegistry;
  nodeHooks?: NodeExecutionHooks;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  runId?: string;
  entrypointId?: string;
  conversationId?: string;
  storage?: ExecutionStorageOptions;
  fileStore?: FileStore;
  fileStoreDir?: string;
  fileCreateStoreDir?: string;
  userInput?: UserInputContext;
  toolPermissionPolicies?: ToolPermissionPolicyMap;
  onRuntimeEvent?(event: RuntimeEvent): Promise<void> | void;
  onDefinedNodes?(event: DefinitionEvent): Promise<void> | void;
}

export interface ExecutionStorageBackendOptions {
  /** Persistent, private directory for agent Harness databases and ownership locks. */
  agentStoreDir?: string;
  kvStore?: KVStore;
  kvStoreDir?: string;
  persistentValueStore?: KVStore;
  persistentValueStoreDir?: string;
}

export interface ExecutionStorageOptions {
  host: ProjectDataStorageLocation;
  local?: ExecutionStorageBackendOptions;
  server?: ExecutionStorageBackendOptions;
}

type ProjectStorageDeclaration = EntryDeclaration;

const STEAMHARNESS_PROJECT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID = "__projectResumeRuntimeEventAfterRequestId";

type UserInputContextWithResumeBarrier = UserInputContext & {
  [RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID]?: string;
};

export async function runWorkspaceProject(
  options: RunWorkspaceProjectOptions,
): Promise<RunResult<unknown>> {
  const report = await runWorkspaceProjectWithReport(options);

  return report.result;
}

async function runWorkspaceProjectWithReportInternal(
  options: RunWorkspaceProjectOptions,
): Promise<ExecutionReport<unknown>> {
  const cwd = options.cwd ?? process.cwd();
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const onRuntimeEvent = createResumeAwareRuntimeEventHandler(
    options.onRuntimeEvent,
    readResumeRuntimeEventAfterRequestId(options.userInput),
  );
  const runtime = createProjectRuntime({
    runId: options.runId,
    projectName: options.projectName,
    onRuntimeEvent,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    nodeHooks: options.nodeHooks,
    layers: [
      createExecutionLimitLayer({ maxNodeExecutions: options.maxNodeExecutions }),
      ...(options.layers ?? []),
    ],
  });
  let definedNodes: DefinedNode[] = [];
  let registry: NodeRegistryItem[] = [];
  let projectDir = "";
  let activeEntrypointId: string | undefined;
  let activeEntrypointTitle: string | undefined;
  let activeConversationId: string | undefined;
  let tokenUsage: TokenUsageContext | undefined;
  let result: RunResult<unknown>;

  try {
    await runtime.prepare();
    runtime.throwIfAborted();
    const location = resolveProjectLocation(cwd, options.projectName);
    projectDir = location.projectDir;
    const projectStorageDeclaration = readProjectStorageDeclaration(projectDir, options.entryId, options.env);
    const modulePath = projectStorageDeclaration.modulePath;

    const scriptInspection = inspectProjectScripts({
      cwd,
      projectName: options.projectName,
      projectDir: projectStorageDeclaration.rootDir,
      entryFile: projectStorageDeclaration.modulePath,
    });
    definedNodes = scriptInspection.definedNodes;

    await options.onDefinedNodes?.({
      projectName: options.projectName,
      projectDir,
      nodes: definedNodes,
    });

    if (scriptInspection.violations.length > 0) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${options.projectName}" script validation failed.`,
        metadata: {
          project: options.projectName,
          violations: scriptInspection.violations,
        },
      });
    }

    runtime.throwIfAborted();

    installProjectRuntimeGlobal();
    const module = await import(pathToFileURL(modulePath).href);
    const definition = resolveExecutorDefinition(
      module as ExecutorModule,
      options.projectName,
    );
    if (definition.projectType !== projectStorageDeclaration.registration.type) throw new Error("The registered entry type does not match its executor.");
    const selected = resolveExecutorExecution(
      definition,
      options.entrypointId,
      options.projectName,
    );
    const execution = selected.execution;
    activeEntrypointId = selected.entrypointId;
    activeEntrypointTitle = selected.entrypointTitle;
    await runtime.start({ id: selected.entrypointId, title: selected.entrypointTitle });
    const executorContext: ExecutorContext = {
      projectName: options.projectName,
      projectDir,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      args,
      paramValues: parseExecutorParamValues(execution, args),
      config: currentConfigurationValues(),
      abortSignal: runtime.abortSignal,
      hostInput: options.hostInput,
      conversationId: options.conversationId,
      toolPermissionPolicies: options.toolPermissionPolicies,
    };
    runtime.throwIfAborted();
    const input = await execution.createInput(executorContext);
    const extraContext = execution.createContext
      ? await execution.createContext(executorContext)
      : {};
    registry = resolveProjectNodeRegistry(execution.registry, executorContext);
    const resolvedConversationId = resolveExecutorConversationId(
      definition,
      options.conversationId,
      readInputConversationId(input),
    );
    const executorStorage = createExecutorStorageContexts({
      declaration: projectStorageDeclaration,
      env,
      projectName: options.projectName,
      runId: runtime.runId,
      conversationId: resolvedConversationId,
      options: options.storage,
    });
    const kv = executorStorage.host.kv;
    const conversation = createExecutorConversationContext({
      definition,
      projectName: options.projectName,
      conversationId: resolvedConversationId,
      kv,
      onTitleChange: (event) =>
        runtime.emitConversationTitleUpdated({
          conversationId: event.conversationId,
          title: event.title,
          updatedAt: new Date(event.updatedAt),
        }),
    });
    activeConversationId = conversation.conversationId;
    tokenUsage = createProjectTokenUsageContext({
      definition: execution.tokenUsage,
      kv,
      projectId: projectStorageDeclaration.projectId,
      runId: runtime.runId,
      conversationId: conversation.conversationId,
      onUpdate: (usage) =>
        runtime.emitTokenUsageUpdated({
          conversationId: conversation.conversationId,
          usage,
          updatedAt: new Date(usage.updatedAt ?? new Date().toISOString()),
        }),
    });
    const userInput = createExecutorUserInputContext({
      projectName: options.projectName,
      runtime,
      userInput: options.userInput,
    });
    const context: RunContext = {
      ...extraContext,
      config: currentConfigurationValues(),
      providers: mergeProviderRegistries(extraContext.providers, options.providers),
      ...createExecutorResources(projectStorageDeclaration, { ...options, runId: runtime.runId, conversationId: conversation.conversationId, abortSignal: runtime.abortSignal }, () => context),
      conversation,
      tokenUsage,
      userInput,
      toolPermissions: options.inheritedToolPermissions ?? createProjectToolPermissionContext({
        definitions: execution.tools,
        policies: options.toolPermissionPolicies,
        userInput,
        projectName: options.projectName,
        runId: runtime.runId,
      }),
      timers: runtime.timers,
      files: createExecutorFileStore({
        env,
        projectName: options.projectName,
        conversationId: conversation.conversationId,
        fileStore: options.fileStore,
        fileStoreDir: options.fileStoreDir,
        fileCreateStoreDir: options.fileCreateStoreDir,
      }),
      metadata: {
        project: options.projectName,
        runId: runtime.runId,
        conversationId: conversation.conversationId,
        ...extraContext.metadata,
        projectId: projectStorageDeclaration.projectId,
        entryId: projectStorageDeclaration.entryId,
        entryRootDir: projectStorageDeclaration.rootDir,
        ...(selected.entrypointId === undefined
          ? {}
          : {
              entrypointId: selected.entrypointId,
              entrypointTitle: selected.entrypointTitle,
            }),
      },
      abortSignal: runtime.abortSignal,
      nodeHooks: combineNodeExecutionHooks(
        runtime.runtimeNodeHooks,
        extraContext.nodeHooks,
      ),
    };

    runtime.throwIfAborted();
    result = await safeRunProject(execution.workflow, input, context);
  } catch (error) {
    await runtime.start({ id: activeEntrypointId, title: activeEntrypointTitle });
    const diagnosedError = diagnoseModuleImportError(error, projectDir, options.projectName) ?? error;
    result = runtime.abortSignal.aborted
      ? createAbortedProjectResult(runtime.abortSignal, options.projectName)
      : createProjectFailure(diagnosedError);
  }

  return runtime.finish({
    definedNodes,
    registry,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    conversationId:
      activeConversationId ?? readReportConversationId(options.conversationId, result),
    tokenUsage: createReportTokenUsage(tokenUsage),
    result,
  });
}

async function debugWorkspaceProjectNodeWithReportInternal(
  options: RunWorkspaceProjectOptions & {
    nodeName: string;
  },
): Promise<ExecutionReport<unknown>> {
  const cwd = options.cwd ?? process.cwd();
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const runtime = createProjectRuntime({
    runId: options.runId,
    projectName: options.projectName,
    onRuntimeEvent: options.onRuntimeEvent,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    nodeHooks: options.nodeHooks,
    layers: [
      createExecutionLimitLayer({ maxNodeExecutions: options.maxNodeExecutions }),
      ...(options.layers ?? []),
    ],
  });
  let definedNodes: DefinedNode[] = [];
  let registry: NodeRegistryItem[] = [];
  let projectDir = "";
  let activeEntrypointId: string | undefined;
  let activeEntrypointTitle: string | undefined;
  let activeConversationId: string | undefined;
  let tokenUsage: TokenUsageContext | undefined;
  let result: RunResult<unknown>;

  try {
    await runtime.prepare();
    runtime.throwIfAborted();
    const location = resolveProjectLocation(cwd, options.projectName);
    projectDir = location.projectDir;
    const projectStorageDeclaration = readProjectStorageDeclaration(projectDir, options.entryId, options.env);
    const modulePath = projectStorageDeclaration.modulePath;

    const scriptInspection = inspectProjectScripts({
      cwd,
      projectName: options.projectName,
      projectDir: projectStorageDeclaration.rootDir,
      entryFile: projectStorageDeclaration.modulePath,
    });
    definedNodes = scriptInspection.definedNodes;

    if (scriptInspection.violations.length > 0) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${options.projectName}" script validation failed.`,
        metadata: {
          project: options.projectName,
          violations: scriptInspection.violations,
        },
      });
    }

    runtime.throwIfAborted();

    installProjectRuntimeGlobal();
    const module = await import(pathToFileURL(modulePath).href);
    const definition = resolveExecutorDefinition(
      module as ExecutorModule,
      options.projectName,
    );
    if (definition.projectType !== projectStorageDeclaration.registration.type) throw new Error("The registered entry type does not match its executor.");
    const selected = resolveExecutorExecution(
      definition,
      options.entrypointId,
      options.projectName,
    );
    const execution = selected.execution;
    activeEntrypointId = selected.entrypointId;
    activeEntrypointTitle = selected.entrypointTitle;
    await runtime.start({ id: selected.entrypointId, title: selected.entrypointTitle });
    const executorContext: ExecutorContext = {
      projectName: options.projectName,
      projectDir,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      args,
      paramValues: parseExecutorParamValues(execution, args),
      config: currentConfigurationValues(),
      abortSignal: runtime.abortSignal,
      hostInput: options.hostInput,
      conversationId: options.conversationId,
      toolPermissionPolicies: options.toolPermissionPolicies,
    };
    registry = resolveProjectNodeRegistry(execution.registry, executorContext);
    const entry = resolveDebugNodeEntry(execution.registry, options.nodeName);
    const extraContext = execution.createContext
      ? await execution.createContext(executorContext)
      : {};
    const input = entry.createInput
      ? await entry.createInput(executorContext)
      : await execution.createInput(executorContext);
    const resolvedConversationId = resolveExecutorConversationId(
      definition,
      options.conversationId,
      readInputConversationId(input),
    );
    const executorStorage = createExecutorStorageContexts({
      declaration: projectStorageDeclaration,
      env,
      projectName: options.projectName,
      runId: runtime.runId,
      conversationId: resolvedConversationId,
      options: options.storage,
    });
    const kv = executorStorage.host.kv;
    const conversation = createExecutorConversationContext({
      definition,
      projectName: options.projectName,
      conversationId: resolvedConversationId,
      kv,
      onTitleChange: (event) =>
        runtime.emitConversationTitleUpdated({
          conversationId: event.conversationId,
          title: event.title,
          updatedAt: new Date(event.updatedAt),
        }),
    });
    activeConversationId = conversation.conversationId;
    tokenUsage = createProjectTokenUsageContext({
      definition: execution.tokenUsage,
      kv,
      projectId: projectStorageDeclaration.projectId,
      runId: runtime.runId,
      conversationId: conversation.conversationId,
      onUpdate: (usage) =>
        runtime.emitTokenUsageUpdated({
          conversationId: conversation.conversationId,
          usage,
          updatedAt: new Date(usage.updatedAt ?? new Date().toISOString()),
        }),
    });
    const userInput = createExecutorUserInputContext({
      projectName: options.projectName,
      runtime,
      userInput: options.userInput,
    });
    const context: RunContext = {
      ...extraContext,
      config: currentConfigurationValues(),
      providers: mergeProviderRegistries(extraContext.providers, options.providers),
      ...createExecutorResources(projectStorageDeclaration, { ...options, runId: runtime.runId, conversationId: conversation.conversationId, abortSignal: runtime.abortSignal }, () => context),
      conversation,
      tokenUsage,
      userInput,
      toolPermissions: options.inheritedToolPermissions ?? createProjectToolPermissionContext({
        definitions: execution.tools,
        policies: options.toolPermissionPolicies,
        userInput,
        projectName: options.projectName,
        runId: runtime.runId,
      }),
      timers: runtime.timers,
      files: createExecutorFileStore({
        env,
        projectName: options.projectName,
        conversationId: conversation.conversationId,
        fileStore: options.fileStore,
        fileStoreDir: options.fileStoreDir,
        fileCreateStoreDir: options.fileCreateStoreDir,
      }),
      metadata: {
        project: options.projectName,
        runId: runtime.runId,
        debugNode: options.nodeName,
        conversationId: conversation.conversationId,
        ...extraContext.metadata,
        projectId: projectStorageDeclaration.projectId,
        entryId: projectStorageDeclaration.entryId,
        entryRootDir: projectStorageDeclaration.rootDir,
        ...(selected.entrypointId === undefined
          ? {}
          : {
              entrypointId: selected.entrypointId,
              entrypointTitle: selected.entrypointTitle,
            }),
      },
      abortSignal: runtime.abortSignal,
      nodeHooks: combineNodeExecutionHooks(
        runtime.runtimeNodeHooks,
        extraContext.nodeHooks,
      ),
    };

    runtime.throwIfAborted();
    const debugOutput = entry.stream
      ? (await runStreamNode(requireStreamDebugNode(entry), input, context)).output
      : await runNode(requireDebugNode(entry), input, context);
    result = {
      ok: true,
      data: debugOutput,
    };
  } catch (error) {
    await runtime.start({ id: activeEntrypointId, title: activeEntrypointTitle });
    const diagnosedError = diagnoseModuleImportError(error, projectDir, options.projectName) ?? error;
    result = runtime.abortSignal.aborted
      ? createAbortedProjectResult(runtime.abortSignal, options.projectName)
      : createProjectFailure(diagnosedError);
  }

  return runtime.finish({
    definedNodes,
    registry,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    conversationId:
      activeConversationId ?? readReportConversationId(options.conversationId, result),
    tokenUsage: createReportTokenUsage(tokenUsage),
    result,
  });
}

function createExecutorUserInputContext(options: {
  projectName: string;
  runtime: Runtime;
  userInput?: UserInputContext;
}): UserInputContext | undefined {
  if (options.userInput === undefined) {
    return undefined;
  }

  const nextContext: UserInputContextWithResumeBarrier = {
    [RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID]: readResumeRuntimeEventAfterRequestId(options.userInput),
    async getResolvedInput(requestId, request) {
      const resolved = await options.userInput?.getResolvedInput(requestId, request);
      if (resolved !== undefined) {
        await options.runtime.emitUserInputResolved({
          ...resolved,
          request: resolved.request ?? request,
        });
      }
      return resolved;
    },
    async requestInput(request) {
      await options.runtime.emitUserInputRequested(request);
      try {
        await options.userInput?.requestInput(request);
      } catch (error) {
        if (error instanceof HarnessError && error.type === "user_input_required") {
          throw error;
        }
      }
      throw new HarnessError({
        type: "user_input_required",
        message: `Workflow "${options.projectName}" is waiting for user input "${request.requestId}".`,
        nodeName: request.nodeName,
        metadata: { request },
      });
    },
  };

  return nextContext;
}

function createLocalUserInputContext(options: {
  projectName: string;
  runId: string;
  reporter: ReturnType<typeof createNodeExecutionReporter>;
  userInput?: UserInputContext;
}): UserInputContext | undefined {
  if (options.userInput === undefined) {
    return undefined;
  }

  const nextContext: UserInputContextWithResumeBarrier = {
    [RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID]: readResumeRuntimeEventAfterRequestId(options.userInput),
    async getResolvedInput(requestId, request) {
      const resolved = await options.userInput?.getResolvedInput(requestId, request);
      if (resolved !== undefined) {
        await options.reporter.emitUserInputResolved({
          ...resolved,
          request: resolved.request ?? request,
        });
      }
      return resolved;
    },
    async requestInput(request) {
      await options.reporter.emitUserInputRequested(request);
      try {
        await options.userInput?.requestInput(request);
      } catch (error) {
        if (error instanceof HarnessError && error.type === "user_input_required") {
          throw error;
        }
      }
      // Save the pause marker so a local report can be resumed by runId.
      throw new HarnessError({
        type: "user_input_required",
        message: `Workflow "${options.projectName}" is waiting for user input "${request.requestId}".`,
        nodeName: request.nodeName,
        metadata: {
          runId: options.runId,
          request,
        },
      });
    },
  };

  return nextContext;
}

export async function runLocalProject(
  options: RunLocalProjectOptions = {},
): Promise<RunResult<unknown>> {
  const report = await runLocalProjectWithReport(options);

  return report.result;
}

async function runLocalProjectWithReportInternal(
  options: RunLocalProjectOptions = {},
): Promise<ExecutionReport<unknown>> {
  const projectDir = resolveLocalProjectDir(options.projectDir);
  let projectName = options.projectName ?? readLocalProjectName(projectDir);
  assertLocalProjectIsExecutable(projectDir, projectName, options.entryId, options.env);
  const projectStorageDeclaration = readProjectStorageDeclaration(projectDir, options.entryId, options.env);
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const startedAt = new Date();
  const runId = options.runId ?? createProjectRunId();
  const abortController = createChainedAbortController(options.abortSignal);
  const onRuntimeEvent = createResumeAwareRuntimeEventHandler(
    options.onRuntimeEvent,
    readResumeRuntimeEventAfterRequestId(options.userInput),
  );
  const reporter = createNodeExecutionReporter({
    runId,
    projectName,
    onRuntimeEvent,
  });
  const timers = createProjectTimerContext({
    onTimerStart: (event) =>
      reporter.emitTimerStarted({
        runId,
        projectName,
        timer: event.timer,
      }),
    onTimerFinish: (event) =>
      reporter.emitTimerFinished({
        runId,
        projectName,
        timer: event.timer,
      }),
  });
  let definedNodes: DefinedNode[] = [];
  let registry: NodeRegistryItem[] = [];
  let activeEntrypointId: string | undefined;
  let activeEntrypointTitle: string | undefined;
  let activeConversationId: string | undefined;
  let startedEventEmitted = false;
  let tokenUsage: TokenUsageContext | undefined;
  let result: RunResult<unknown>;

  try {
    const modulePath = projectStorageDeclaration.modulePath;
    const scriptInspection = inspectProjectScripts({
      cwd: projectDir,
      projectName,
      projectDir: projectStorageDeclaration.rootDir,
      entryFile: projectStorageDeclaration.modulePath,
    });
    definedNodes = scriptInspection.definedNodes;

    await options.onDefinedNodes?.({
      projectName,
      projectDir,
      nodes: definedNodes,
    });

    if (scriptInspection.violations.length > 0) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${projectName}" script validation failed.`,
        metadata: {
          project: projectName,
          violations: scriptInspection.violations,
        },
      });
    }


    installProjectRuntimeGlobal();
    const module = await import(pathToFileURL(modulePath).href);
    const definition = resolveExecutorDefinition(
      module as ExecutorModule,
      projectName,
    );
    if (definition.projectType !== projectStorageDeclaration.registration.type) throw new Error("The registered entry type does not match its executor.");
    const selected = resolveExecutorExecution(
      definition,
      options.entrypointId,
      projectName,
    );
    const execution = selected.execution;
    if (definition.projectType === "conversation") {
      projectName = execution.workflow.name || projectName;
    }
    activeEntrypointId = selected.entrypointId;
    activeEntrypointTitle = selected.entrypointTitle;
    await reporter.emitProjectStarted({
      runId,
      projectName,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      startedAt,
    });
    startedEventEmitted = true;

    const executorContext: ExecutorContext = {
      projectName,
      projectDir,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      args,
      paramValues: parseExecutorParamValues(execution, args),
      config: currentConfigurationValues(),
      abortSignal: abortController.signal,
      hostInput: options.hostInput,
      conversationId: options.conversationId,
      toolPermissionPolicies: options.toolPermissionPolicies,
    };
    const input = await execution.createInput(executorContext);
    const extraContext = execution.createContext
      ? await execution.createContext(executorContext)
      : {};
    registry = resolveProjectNodeRegistry(execution.registry, executorContext);
    const resolvedConversationId = resolveExecutorConversationId(
      definition,
      options.conversationId,
      readInputConversationId(input),
    );
    const executorStorage = createExecutorStorageContexts({
      declaration: projectStorageDeclaration,
      env,
      projectName,
      runId,
      conversationId: resolvedConversationId,
      options: options.storage,
    });
    const kv = executorStorage.host.kv;
    const conversation = createExecutorConversationContext({
      definition,
      projectName,
      conversationId: resolvedConversationId,
      kv,
      onTitleChange: (event) =>
        reporter.emitConversationTitleUpdated({
          runId,
          projectName,
          conversationId: event.conversationId,
          title: event.title,
          updatedAt: new Date(event.updatedAt),
        }),
    });
    activeConversationId = conversation.conversationId;
    tokenUsage = createProjectTokenUsageContext({
      definition: execution.tokenUsage,
      kv,
      projectId: projectStorageDeclaration.projectId,
      runId,
      conversationId: conversation.conversationId,
      onUpdate: (usage) =>
        reporter.emitTokenUsageUpdated({
          runId,
          projectName,
          conversationId: conversation.conversationId,
          usage,
          updatedAt: new Date(usage.updatedAt ?? new Date().toISOString()),
        }),
    });
    const userInput = createLocalUserInputContext({
      projectName,
      runId,
      reporter,
      userInput: options.userInput,
    });
    const context: RunContext = {
      ...extraContext,
      config: currentConfigurationValues(),
      providers: mergeProviderRegistries(extraContext.providers, options.providers),
      ...createExecutorResources(projectStorageDeclaration, { ...options, runId, conversationId: conversation.conversationId, abortSignal: abortController.signal }, () => context),
      conversation,
      tokenUsage,
      userInput,
      toolPermissions: options.inheritedToolPermissions ?? createProjectToolPermissionContext({
        definitions: execution.tools,
        policies: options.toolPermissionPolicies,
        userInput,
        projectName,
        runId,
      }),
      timers,
      files: createExecutorFileStore({
        env,
        projectName,
        conversationId: conversation.conversationId,
        fileStore: options.fileStore,
        fileStoreDir: options.fileStoreDir,
        fileCreateStoreDir: options.fileCreateStoreDir,
      }),
      abortSignal: abortController.signal,
      metadata: {
        project: projectName,
        runId,
        conversationId: conversation.conversationId,
        agentStoreDir: options.storage?.[options.storage.host]?.agentStoreDir
          ?? env.STEAMHARNESS_AGENT_STORE_DIR ?? path.join(os.homedir(), ".steamharness", "runtime", projectStorageDeclaration.projectId, projectStorageDeclaration.entryId, "agents"),
        ...extraContext.metadata,
        projectId: projectStorageDeclaration.projectId,
        entryId: projectStorageDeclaration.entryId,
        entryRootDir: projectStorageDeclaration.rootDir,
        ...(selected.entrypointId === undefined
          ? {}
          : {
              entrypointId: selected.entrypointId,
              entrypointTitle: selected.entrypointTitle,
            }),
      },
      nodeHooks: combineNodeExecutionHooks(
        reporter.hooks,
        extraContext.nodeHooks,
        options.nodeHooks,
      ),
    };

    throwIfRunLocalProjectAborted(abortController.signal, projectName);
    result = await safeRunProject(execution.workflow, input, context);
    if (abortController.signal.aborted) {
      result = createAbortedProjectResult(abortController.signal, projectName);
    }
  } catch (error) {
    if (!startedEventEmitted) {
      await reporter.emitProjectStarted({
        runId,
        projectName,
        entrypointId: activeEntrypointId,
        entrypointTitle: activeEntrypointTitle,
        startedAt,
      });
      startedEventEmitted = true;
    }
    result = abortController.signal.aborted
      ? createAbortedProjectResult(abortController.signal, projectName)
      : createProjectFailure(
          diagnoseModuleImportError(error, projectDir, projectName) ?? error,
        );
  }

  const endedAt = new Date();
  const pendingUserInput = reporter.getPendingUserInput();
  // Local workflow runs share the same timer cleanup contract as the
  // workspace runtime, so App live views never keep stale running timer cards.
  await timers.clearRunningTimers();
  const outputs = reporter.getOutputs();
  const status = pendingUserInput !== undefined
    ? "waiting_for_input"
    : abortController.signal.aborted
      ? "aborted"
      : undefined;
  await reporter.emitProjectFinished({
    runId,
    projectName,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    conversationId: activeConversationId,
    status: status ?? resolveProjectResultStatus(result, outputs),
    startedAt,
    endedAt,
    result,
    outputs,
  });

  return createProjectExecutionReport({
    runId,
    projectName,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    // Local project execution must preserve cancellation as an
    // aborted report instead of inferring failed from the 499 result payload.
    status,
    startedAt,
    endedAt,
    definedNodes,
    registry,
    conversationId:
      activeConversationId ?? readReportConversationId(options.conversationId, result),
    conversationTitle: reporter.getConversationTitle(),
    pendingUserInput,
    resolvedUserInputs: reporter.getResolvedUserInputs(),
    tokenUsage: createReportTokenUsage(tokenUsage),
    result,
    nodes: reporter.getReports(),
    outputs,
    timers: timers.getTimers(),
  });
}

function readResumeRuntimeEventAfterRequestId(
  userInput: UserInputContext | undefined,
): string | undefined {
  if (userInput === undefined || typeof userInput !== "object" || userInput === null) {
    return undefined;
  }

  const value = (userInput as unknown as UserInputContextWithResumeBarrier)[RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function createResumeAwareRuntimeEventHandler(
  onRuntimeEvent: ((event: RuntimeEvent) => Promise<void> | void) | undefined,
  resumeAfterRequestId: string | undefined,
): ((event: RuntimeEvent) => Promise<void>) | undefined {
  if (onRuntimeEvent === undefined) {
    return undefined;
  }

  if (resumeAfterRequestId === undefined) {
    return async (event) => {
      await onRuntimeEvent(event);
    };
  }

  let released = false;
  return async (event) => {
    if (released) {
      await onRuntimeEvent(event);
      return;
    }

    if (event.type === "user_input_resolved" && event.requestId === resumeAfterRequestId) {
      released = true;
      await onRuntimeEvent(event);
      return;
    }

    if (
      event.type === "project_succeeded" ||
      event.type === "project_failed" ||
      event.type === "project_aborted" ||
      event.type === "project_timed_out"
    ) {
      released = true;
      await onRuntimeEvent(event);
    }
  };
}

export function inspectWorkspaceProjectStructure(options: {
  cwd?: string; projectName: string; entryId?: string;
}): StructureReport {
  return inspectLocalProjectStructure({ projectDir: resolveProjectLocation(options.cwd ?? process.cwd(), options.projectName).projectDir, projectName: options.projectName, entryId: options.entryId });
}

export function inspectLocalProjectStructure(options: {
  projectDir?: string; projectName?: string; entryId?: string;
} = {}): StructureReport {
  const declaration = readProjectStorageDeclaration(resolveLocalProjectDir(options.projectDir), options.entryId);
  const { registration, rootDir, modulePath, manifest } = declaration;
  const projectName = options.projectName ?? registration.name;
  const identity = { projectId: manifest.projectId, entryId: registration.entryId, entryName: registration.name, entries: manifest.entries, defaultEntry: manifest.defaultEntry };
  const configuration = readProjectConfigurationDefinition(declaration.projectDir, registration.entryId);
  if (registration.type === "kanban") {
    readSchedulePresetValue({schedulePresets:registration.schedulePresets},"kanban",[]);
    const entry = path.basename(registration.entry);
    const artifactDir = path.posix.dirname(registration.entry);
    return { ...identity, projectType: "kanban", workflow: { name: projectName, dir: rootDir, files: [registration.entry] }, definitions: { nodes: {}, apiCalls: [], variables: {}, registry: {} }, execution: { kind: "sequence", children: [] }, diagnostics: { warnings: [], violations: [] }, configuration, kanban: { artifactDir, entry } };
  }
  const inspection = inspectProjectStructure({ cwd: rootDir, projectName, projectDir: rootDir, entryFile: modulePath });
  if (inspection.diagnostics.violations.length) throw new HarnessError({ type: "input_validation", message: `Entry "${registration.entryId}" script validation failed.`, metadata: { projectId: manifest.projectId, entryId: registration.entryId, violations: inspection.diagnostics.violations } });
  const projectType = resolveInspectedProjectType(inspection);
  if (projectType !== registration.type) throw new HarnessError({ type: "input_validation", message: `Entry "${registration.entryId}" is registered as ${registration.type}, but its executor declares ${projectType}.` });
  const schedulePresets = readSchedulePresetValue({ schedulePresets: registration.schedulePresets }, projectType, inspection.entrypoints ?? []);
  return { ...identity, projectType, workflow: inspection.workflow, definitions: inspection.definitions, configuration, diagnostics: inspection.diagnostics,
    ...(projectType === "workflow" ? { defaultEntrypoint: inspection.defaultEntrypoint, entrypoints: inspection.entrypoints, schedulePresets } : { execution: inspection.execution, params: inspection.params, paramLayout: inspection.paramLayout, paramResolver: inspection.paramResolver, conversation: conversationPresentationDefaults(inspection.conversation, rootDir, modulePath), tokenUsage: inspection.tokenUsage, tools: inspection.tools, registry: inspection.registry }) };
}

export function inspectAggregateProjectStructure(projectDir = ".") {
  const { manifest } = resolveProjectEntrySync(projectDir);
  return { ...manifest, entries: manifest.entries.map((entry) => inspectLocalProjectStructure({ projectDir, entryId: entry.entryId })) };
}

export interface LocalProjectSkillsOptions { projectDir?: string; entryId?: string; entrypointId?: string }

/** Reports the selected entry's effective memory binding without running a task or tool factory. */
export async function getLocalProjectMemoryCapabilities(options: LocalProjectSkillsOptions = {}): Promise<AgentMemoryCapabilities> {
  const selected = await localAgentProjectContract(options);
  return getAgentMemoryCapabilities(selected ? selected.contract.memory ?? getAgentMemoryBinding() : false);
}

/** Lists the selected Core Agent's project guides and always-loaded built-in guides without running a task or tool factory. */
export async function listLocalProjectSkills(options: LocalProjectSkillsOptions = {}): Promise<AgentSkillGuide[]> {
  const directories = await localProjectSkillDirectories(options);
  return directories ? listAgentSkillGuides(directories) : [];
}

/** Reads the complete SKILL.md for a catalog ID. Does not accept file paths or execute guide instructions. */
export async function readLocalProjectSkill(options: LocalProjectSkillsOptions & { skillId: string }): Promise<AgentSkillPreview> {
  const directories = await localProjectSkillDirectories(options);
  if (!directories) throw new Error("This entry does not declare a Core Agent skill catalog.");
  return readAgentSkillGuide(directories, options.skillId);
}

async function localProjectSkillDirectories(options: LocalProjectSkillsOptions): Promise<string[] | undefined> {
  const selected = await localAgentProjectContract(options);
  return selected?.contract.skillDirectories.map(directory => path.resolve(selected.rootDir, directory));
}

async function localAgentProjectContract(options: LocalProjectSkillsOptions) {
  const projectDir = resolveLocalProjectDir(options.projectDir);
  const declaration = readProjectStorageDeclaration(projectDir, options.entryId);
  if (declaration.registration.type === "kanban") return undefined;
  assertLocalProjectIsExecutable(projectDir, declaration.registration.name, options.entryId);
  installProjectRuntimeGlobal();
  const module = await import(pathToFileURL(declaration.modulePath).href);
  const definition = resolveExecutorDefinition(module as ExecutorModule, declaration.registration.name);
  const { execution } = resolveExecutorExecution(definition, options.entrypointId, declaration.registration.name);
  const source = definition.projectType === "conversation" ? definition.coreAgent ?? execution.workflow : execution.workflow;
  const contract = readAgentProjectContract(source);
  return contract ? { contract, rootDir: declaration.rootDir } : undefined;
}

function conversationPresentationDefaults(conversation: StructureReport["conversation"], projectDir: string, entryFile: string): StructureReport["conversation"] {
  return conversation?.collapseIntermediate === undefined && projectUsesConfiguredAgentModels(projectDir, entryFile)
    ? { ...conversation, collapseIntermediate: true } : conversation;
}

function readConfigurationDeclaration(projectDir: string) {
  return readProjectConfigurationDefinition(projectDir);
}

function resolveInspectedProjectType(
  inspection: {
    projectType?: ExecutorProjectType;
    entrypoints?: unknown[];
    defaultEntrypoint?: string;
  },
): ExecutorProjectType {
  if (inspection.projectType !== undefined) return inspection.projectType;
  return inspection.entrypoints !== undefined || inspection.defaultEntrypoint !== undefined
    ? "workflow"
    : "conversation";
}

export async function resolveWorkspaceProjectParams(options: {
  cwd?: string;
  projectName: string;
  entryId?: string;
  entrypointId?: string;
  request: ParamResolveRequest;
  configuration?: ProjectConfigurationSnapshot;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  storage?: ExecutionStorageOptions;
}): Promise<ParamResolveResult> {
  const cwd = options.cwd ?? process.cwd();
  const location = resolveProjectLocation(cwd, options.projectName);
  const declaration = readProjectStorageDeclaration(location.projectDir, options.entryId, options.env);
  return resolveProjectParamsFromModule({
    projectName: options.projectName,
    projectDir: location.projectDir,
    modulePath: declaration.modulePath,
    declaration,
    storage: options.storage,
    entrypointId: options.entrypointId,
    request: options.request,
    configuration: options.configuration,
    env: options.env,
    abortSignal: options.abortSignal,
    hostInput: options.hostInput,
  });
}

export async function resolveLocalProjectParams(options: {
  projectDir?: string;
  projectName?: string;
  entryId?: string;
  entrypointId?: string;
  request: ParamResolveRequest;
  configuration?: ProjectConfigurationSnapshot;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  storage?: ExecutionStorageOptions;
}): Promise<ParamResolveResult> {
  const projectDir = resolveLocalProjectDir(options.projectDir);
  const projectName = options.projectName ?? readLocalProjectName(projectDir);
  assertLocalProjectIsExecutable(projectDir, projectName, options.entryId, options.env);
  const declaration = readProjectStorageDeclaration(projectDir, options.entryId, options.env);
  return resolveProjectParamsFromModule({
    projectName,
    projectDir,
    modulePath: declaration.modulePath,
    declaration,
    storage: options.storage,
    entrypointId: options.entrypointId,
    request: options.request,
    configuration: options.configuration,
    env: options.env,
    abortSignal: options.abortSignal,
    hostInput: options.hostInput,
  });
}

async function resolveProjectParamsFromModuleInternal(options: {
  projectName: string;
  projectDir: string;
  modulePath: string;
  declaration: ProjectStorageDeclaration;
  storage?: ExecutionStorageOptions;
  entrypointId?: string;
  request: ParamResolveRequest;
  configuration?: ProjectConfigurationSnapshot;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
}): Promise<ParamResolveResult> {
  const abortSignal = options.abortSignal ?? new AbortController().signal;
  if (abortSignal.aborted) throw abortSignal.reason;
  installProjectRuntimeGlobal();
  const module = await import(pathToFileURL(options.modulePath).href);
  const definition = resolveExecutorDefinition(module as ExecutorModule, options.projectName);
  const selected = resolveExecutorExecution(
    definition,
    options.entrypointId,
    options.projectName,
  );
  const execution = selected.execution;
  if (!execution.resolveParams) return { params: {} };
  const args = options.request.args.map(String);
  const result = await execution.resolveParams({
    projectName: options.projectName,
    projectDir: options.projectDir,
    entrypointId: selected.entrypointId,
    entrypointTitle: selected.entrypointTitle,
    args,
    paramValues: parseExecutorParamValues(execution, args),
    config: currentConfigurationValues(),
    abortSignal,
    hostInput: options.hostInput,
    draftText: options.request.draftText,
    inputMode: options.request.inputMode,
    trigger: options.request.trigger,
  });
  if (abortSignal.aborted) throw abortSignal.reason;
  const validated = validateProjectParamResolveResult(execution.params, result);
  if (definition.projectType === "conversation") {
    const params = normalizeProjectParamDeclarations(execution.params).params.map(param => {
      const options = validated.params?.[param.name]?.resolvedOptions;
      return param.panel !== "slash" || !options ? param : { ...param, options: options.map(option => ({ ...option,
        command: option.command ?? param.options?.find(original => original.value === option.value)?.command })) };
    });
    assertConversationCommands(definition.conversation?.commands, params);
  }
  return validated;
}

function createExecutorConversationContext(options: {
  definition: ExecutorDefinition<unknown, unknown>;
  projectName: string;
  conversationId?: string;
  kv: KVContext;
  onTitleChange?: (event: {
    conversationId: string;
    title?: string;
    updatedAt: string;
  }) => Promise<void> | void;
}): ConversationContext {
  if (!isConversationProjectType(options.definition.projectType)) {
    return createDisabledProjectConversationContext();
  }

  // Conversation state uses the selected local or remote KV store.
  return createProjectConversationContext({
    enabled: true,
    projectName: options.projectName,
    conversationId: options.conversationId,
    kv: options.kv,
    onTitleChange: options.onTitleChange,
  });
}

function createReportTokenUsage(tokenUsage?: TokenUsageContext) {
  return tokenUsage?.enabled === true
    ? {
        enabled: true as const,
        display: tokenUsage.display,
        run: tokenUsage.getRunUsage(),
      }
    : undefined;
}

function resolveExecutorConversationId(
  definition: ExecutorDefinition<unknown, unknown>,
  requestedConversationId: string | undefined,
  inputConversationId?: string,
): string | undefined {
  if (!isConversationProjectType(definition.projectType)) {
    return undefined;
  }

  const normalized = requestedConversationId?.trim();
  if (normalized !== undefined && normalized !== "") {
    return normalized;
  }

  // createInput may supply the stable conversation ID after parsing input.
  const inputNormalized = inputConversationId?.trim();
  return inputNormalized === undefined || inputNormalized === "" ? randomUUID() : inputNormalized;
}

function readInputConversationId(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const value = input["conversationId"] ?? input["conversation_id"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const createExecutorStorageContexts = createExecutorHostState;
function readProjectStorageDeclaration(projectDir: string, entryId?: string, env?: NodeJS.ProcessEnv): ProjectStorageDeclaration {
  const resolved = resolveProjectEntrySync(projectDir, entryId, env);
  return { ...resolved, projectId: resolved.manifest.projectId, entryId: resolved.registration.entryId };
}

function readReportConversationId(
  requestedConversationId: string | undefined,
  result: RunResult<unknown>,
): string | undefined {
  if (requestedConversationId !== undefined) {
    return requestedConversationId;
  }

  if (!result.ok || !isRecord(result.data)) {
    return undefined;
  }

  const value = result.data["conversationId"] ?? result.data["conversation_id"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function mergeProviderRegistries(
  base: ProviderRegistry | undefined,
  override: ProviderRegistry | undefined,
): ProviderRegistry {
  return {
    ...base,
    ...override,
    llmProviders: {
      ...base?.llmProviders,
      ...override?.llmProviders,
    },
    llmProviderBindings: {
      ...base?.llmProviderBindings,
      ...override?.llmProviderBindings,
    },
  };
}

function resolveProjectNodeRegistry(
  entries: NodeRegistryEntry[] | undefined,
  context: ExecutorContext,
): NodeRegistryItem[] {
  return (entries ?? []).map((entry) => {
    const standardName = readNodeStandardName(entry.node);
    const fallbackType = standardName ?? entry.name;
    const fallbackTitle = readNodeName(entry.node) ?? entry.name;

    return {
      name: entry.name,
      standardName,
      metadata: createProjectNodeMetadata(
        entry.metadata ?? readNodeMetadata(entry.node),
        {
          type: fallbackType,
          title: fallbackTitle,
        },
      ),
    };
  });
}

function resolveDebugNodeEntry(
  entries: NodeRegistryEntry[] | undefined,
  nodeName: string,
): NodeRegistryEntry {
  const normalizedName = nodeName.trim();
  const entry = (entries ?? []).find((item) => item.name === normalizedName);

  if (entry === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Debug node "${normalizedName}" is not registered. Add it to executor.registry before using single-node debug.`,
      nodeName: normalizedName,
      metadata: {
        debugNode: normalizedName,
        registeredNodes: (entries ?? []).map((item) => item.name),
      },
    });
  }

  return entry;
}

function requireDebugNode(
  entry: NodeRegistryEntry,
): NodeDefinition<unknown, unknown> {
  if ("run" in entry.node && typeof entry.node.run === "function") {
    return entry.node;
  }

  throw new HarnessError({
    type: "input_validation",
    message: `Debug node "${entry.name}" is a stream node. Mark its registry entry with stream: true.`,
    nodeName: entry.name,
  });
}

function requireStreamDebugNode(
  entry: NodeRegistryEntry,
): StreamNodeDefinition<unknown, unknown, unknown> {
  if ("stream" in entry.node && typeof entry.node.stream === "function") {
    return entry.node;
  }

  throw new HarnessError({
    type: "input_validation",
    message: `Debug node "${entry.name}" is not a stream node. Remove stream: true from its registry entry.`,
    nodeName: entry.name,
  });
}

function readNodeName(node: NodeRegistryEntry["node"]): string | undefined {
  return typeof node.name === "string" && node.name.trim() !== "" ? node.name : undefined;
}

function readNodeStandardName(node: NodeRegistryEntry["node"]): string | undefined {
  return typeof node.standardName === "string" && node.standardName.trim() !== ""
    ? node.standardName
    : undefined;
}

function readNodeMetadata(node: NodeRegistryEntry["node"]): NodeMetadata | undefined {
  return node.metadata === undefined ? undefined : { ...node.metadata };
}

export async function runWorkspaceProjectFromCli(
  argv: string[],
): Promise<RunResult<unknown>> {
  const { projectName, args, entrypointId } = parseWorkspaceProjectCliArgs(argv);

  if (projectName === undefined || projectName.trim() === "") {
    return createProjectFailure(
      new HarnessError({
        type: "input_validation",
        message: "Missing workflow name. Usage: pnpm workflow <workflow-name> [...args]",
      }),
    );
  }

  return runWorkspaceProject({
    projectName,
    args,
    entrypointId,
    storage: {
      host: "local",
      local: {
        kvStoreDir: process.env.STEAMHARNESS_KV_STORE_DIR,
        persistentValueStoreDir: process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR,
      },
    },
  });
}

export async function runWorkspaceProjectReportFromCli(
  argv: string[],
  options: Pick<RunWorkspaceProjectOptions, "nodeHooks" | "onDefinedNodes" | "entrypointId"> = {},
): Promise<ExecutionReport<unknown>> {
  const parsed = parseWorkspaceProjectCliArgs(argv);
  const { projectName, args } = parsed;

  if (projectName === undefined || projectName.trim() === "") {
    const startedAt = new Date();
    const result = createProjectFailure(
      new HarnessError({
        type: "input_validation",
        message: "Missing workflow name. Usage: pnpm workflow <workflow-name> [...args]",
      }),
    );
    const endedAt = new Date();

    return createProjectExecutionReport({
      runId: createProjectRunId(),
      projectName: "",
      startedAt,
      endedAt,
      status: "failed",
      definedNodes: [],
      result,
      nodes: [],
      outputs: [],
    });
  }

  return runWorkspaceProjectWithReport({
    projectName,
    args,
    entrypointId: options.entrypointId ?? parsed.entrypointId,
    storage: {
      host: "local",
      local: {
        kvStoreDir: process.env.STEAMHARNESS_KV_STORE_DIR,
        persistentValueStoreDir: process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR,
      },
    },
    nodeHooks: options.nodeHooks,
    onDefinedNodes: options.onDefinedNodes,
  });
}

function parseWorkspaceProjectCliArgs(argv: string[]): {
  projectName?: string;
  args: string[];
  entrypointId?: string;
} {
  const [projectName, ...rest] = argv;
  const args: string[] = [];
  let entrypointId: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      args.push(...rest.slice(index + 1));
      break;
    }
    if (arg === "--entrypoint") {
      const value = rest[++index];
      if (value === undefined || value.trim() === "") {
        throw new HarnessError({
          type: "input_validation",
          message: "Missing value for --entrypoint.",
        });
      }
      entrypointId = value;
      continue;
    }
    args.push(arg);
  }
  return { projectName, args, entrypointId };
}

export function inspectWorkspaceProjectStructureFromCli(
  argv: string[],
): StructureReport {
  const [projectName] = argv;

  if (projectName === undefined || projectName.trim() === "") {
    throw new HarnessError({
      type: "input_validation",
      message: "Missing workflow directory. Usage: steamharness structure <workflow-dir>",
    });
  }

  return inspectWorkspaceProjectStructure({
    projectName,
  });
}

function resolveExecutorDefinition(
  module: ExecutorModule,
  projectName: string,
): ExecutorDefinition<unknown, unknown> {
  if (isProjectExecutorShape(module.executor)) {
    return validateExecutorDefinition(module.executor, projectName);
  }

  if (isProjectExecutorShape(module.default)) {
    return validateExecutorDefinition(module.default, projectName);
  }

  throw new HarnessError({
    type: "input_validation",
    message: createProjectTypeValidationMessage(
      `Workflow "${projectName}" must export an executor created by workflow.defineExecutor(...).`,
    ),
    metadata: {
      project: projectName,
    },
  });
}

interface ExecutorDefinitionShape extends Record<string, unknown> {
  projectType?: unknown;
  conversation?: unknown;
  workflow?: unknown;
  createInput?: unknown;
  defaultEntrypoint?: unknown;
  entrypoints?: unknown;
}

function isProjectExecutorShape(
  value: unknown,
): value is ExecutorDefinitionShape {
  return (
    typeof value === "object" &&
    value !== null &&
    (
      Object.hasOwn(value, "projectType") ||
      Object.hasOwn(value, "workflow") ||
      Object.hasOwn(value, "entrypoints")
    )
  );
}

function validateExecutorDefinition(
  definition: ExecutorDefinitionShape,
  projectName: string,
): ExecutorDefinition<unknown, unknown> {
  const projectType = resolveRuntimeExecutorProjectType(definition);
  if (projectType === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${projectName}" executor shape is not runnable.`,
      metadata: { project: projectName },
    });
  }
  const normalizedDefinition = definition.projectType === projectType
    ? definition
    : { ...definition, projectType };

  switch (projectType) {
    case "conversation": {
      if (!isProjectDefinition(normalizedDefinition.workflow) || typeof normalizedDefinition.createInput !== "function") {
        throw new HarnessError({
          type: "input_validation",
          message: `Conversation "${projectName}" must declare workflow and createInput on its executor.`,
          metadata: { project: projectName, projectType },
        });
      }
      if (normalizedDefinition.entrypoints !== undefined || normalizedDefinition.defaultEntrypoint !== undefined) {
        throw new HarnessError({
          type: "input_validation",
          message: `Conversation "${projectName}" does not support entrypoints. Keep its executor as a single workflow.`,
          metadata: { project: projectName, projectType },
        });
      }
      validateConversationOpenAIAdapter(normalizedDefinition.conversation, projectName);
      assertConversationPresentation(isRecord(normalizedDefinition.conversation) ? normalizedDefinition.conversation.collapseIntermediate : undefined);
      assertProjectParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params, "conversation");
      assertConversationFooter(isRecord(normalizedDefinition.conversation) ? normalizedDefinition.conversation.footer : undefined,
        normalizeProjectParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params).params);
      assertConversationCommands(isRecord(normalizedDefinition.conversation) ? normalizedDefinition.conversation.commands : undefined,
        normalizeProjectParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params).params);
      assertConversationUserInput(isRecord(normalizedDefinition.conversation) ? normalizedDefinition.conversation.userInput : undefined,
        normalizeProjectParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params).params);
      break;
    }
    case "workflow": {
      assertProjectEntrypointsShape(normalizedDefinition, projectName);
      break;
    }
    default:
      assertNeverExecutorProjectKind(projectType);
  }

  return normalizedDefinition as ExecutorDefinition<unknown, unknown>;
}

function validateConversationOpenAIAdapter(value: unknown, projectName: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new HarnessError({
      type: "input_validation",
      message: `Conversation "${projectName}" settings must be an object.`,
      metadata: { project: projectName, projectType: "conversation" },
    });
  }
  if (Object.hasOwn(value, "defaultInput")) {
    throw new HarnessError({
      type: "input_validation",
      message: "conversation.defaultInput was removed. Conversation always uses the standard message input; declare attachment capabilities in conversation.attachments.",
    });
  }
  if (value.openai === undefined) return;
  if (
    !isRecord(value.openai)
    || value.openai.enabled !== true
    || typeof value.openai.outputItemId !== "string"
    || value.openai.outputItemId.trim() === ""
  ) {
    throw new HarnessError({
      type: "input_validation",
      message: `Conversation "${projectName}" openai adapter must declare enabled: true and a non-empty outputItemId.`,
      metadata: { project: projectName, projectType: "conversation" },
    });
  }
}

function resolveRuntimeExecutorProjectType(
  definition: ExecutorDefinitionShape,
): ExecutorProjectType | undefined {
  if (isExecutorProjectKind(definition.projectType)) return definition.projectType;
  return undefined;
}

function assertProjectEntrypointsShape(
  definition: ExecutorDefinitionShape,
  projectName: string,
): asserts definition is ExecutorDefinitionShape & {
  projectType: "workflow";
  defaultEntrypoint: string;
  entrypoints: EntrypointDefinition<unknown, unknown>[];
} {
  const legacyKeys = [
    "workflow",
    "params",
    "createInput",
    "resolveParams",
    "requiredProviders",
    "tools",
    "tokenUsage",
    "registry",
    "createContext",
  ].filter((key) => Object.hasOwn(definition, key));
  if (legacyKeys.length > 0) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${projectName}" uses removed top-level executor fields (${legacyKeys.join(", ")}). Move each execution configuration into workflow.defineEntrypoint(...).`,
      metadata: { project: projectName, legacyKeys },
    });
  }
  if (
    typeof definition.defaultEntrypoint !== "string" ||
    definition.defaultEntrypoint.trim() === ""
  ) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${projectName}" must declare a static defaultEntrypoint string.`,
      metadata: { project: projectName },
    });
  }
  if (!Array.isArray(definition.entrypoints) || definition.entrypoints.length === 0) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${projectName}" must declare at least one entrypoint.`,
      metadata: { project: projectName },
    });
  }

  const ids = new Set<string>();
  const groups = new Map<string, EntrypointGroupDefinition>();
  for (const value of definition.entrypoints) {
    if (!isProjectEntrypointDefinition(value)) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${projectName}" contains an invalid entrypoint definition.`,
        metadata: { project: projectName },
      });
    }
    if (ids.has(value.id)) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${projectName}" declares duplicate entrypoint id "${value.id}".`,
        metadata: { project: projectName, entrypointId: value.id },
      });
    }
    ids.add(value.id);
    if (value.group !== undefined) {
      const existing = groups.get(value.group.id);
      if (
        existing !== undefined &&
        (existing.title !== value.group.title || existing.order !== value.group.order)
      ) {
        throw new HarnessError({
          type: "input_validation",
          message: `Workflow "${projectName}" entrypoint group "${value.group.id}" must use identical title and order in every entrypoint.`,
          metadata: { project: projectName, groupId: value.group.id },
        });
      }
      groups.set(value.group.id, value.group);
    }
  }
  if (!ids.has(definition.defaultEntrypoint)) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${projectName}" defaultEntrypoint "${definition.defaultEntrypoint}" does not match a declared entrypoint.`,
      metadata: {
        project: projectName,
        defaultEntrypoint: definition.defaultEntrypoint,
        allowedEntrypoints: [...ids],
      },
    });
  }
}

function isProjectEntrypointDefinition(
  value: unknown,
): value is EntrypointDefinition<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const entrypoint = value as Record<string, unknown>;
  return (
    typeof entrypoint["id"] === "string" &&
    STEAMHARNESS_ENTRYPOINT_ID_PATTERN.test(entrypoint["id"]) &&
    typeof entrypoint["title"] === "string" &&
    entrypoint["title"].trim() !== "" &&
    isProjectEntrypointGroupDefinition(entrypoint["group"]) &&
    isProjectDefinition(entrypoint["workflow"]) &&
    typeof entrypoint["createInput"] === "function"
  );
}

function isProjectEntrypointGroupDefinition(
  value: unknown,
): value is EntrypointGroupDefinition | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    value["id"].trim() !== "" &&
    typeof value["title"] === "string" &&
    value["title"].trim() !== "" &&
    (
      !Object.hasOwn(value, "order") ||
      (
        typeof value["order"] === "number" &&
        Number.isInteger(value["order"]) &&
        value["order"] >= 0
      )
    )
  );
}

interface ResolvedExecutorExecution {
  execution: ExecutionDefinition<unknown, unknown>;
  entrypointId?: string;
  entrypointTitle?: string;
}

function resolveExecutorExecution(
  definition: ExecutorDefinition<unknown, unknown>,
  requestedEntrypointId: string | undefined,
  projectName: string,
): ResolvedExecutorExecution {
  const requested = requestedEntrypointId?.trim();
  if (definition.projectType === "conversation") {
    if (requested !== undefined && requested !== "") {
      throw new HarnessError({
        type: "input_validation",
        message: `Conversation "${projectName}" does not accept an entrypoint.`,
        metadata: { project: projectName, entrypointId: requested },
      });
    }
    return { execution: definition };
  }

  const entrypointId = requested === undefined || requested === ""
    ? definition.defaultEntrypoint
    : requested;
  const entrypoint = definition.entrypoints.find((item) => item.id === entrypointId);
  if (entrypoint === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Unknown entrypoint "${entrypointId}" for workflow "${projectName}".`,
      metadata: {
        project: projectName,
        entrypointId,
        defaultEntrypoint: definition.defaultEntrypoint,
        allowedEntrypoints: definition.entrypoints.map((item) => item.id),
      },
    });
  }
  return {
    execution: entrypoint as ExecutionDefinition<unknown, unknown>,
    entrypointId: entrypoint.id,
    entrypointTitle: entrypoint.title,
  };
}

function createProjectTypeValidationMessage(reason: string): string {
  return `${reason}\n\nMigration example:\n${STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE}`;
}

function isConversationProjectType(projectType: ExecutorProjectType): boolean {
  switch (projectType) {
    case "conversation":
      return true;
    case "workflow":
      return false;
    default:
      return assertNeverExecutorProjectKind(projectType);
  }
}

function isProjectDefinition(
  value: unknown,
): value is Definition<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Definition<unknown, unknown>).name === "string" &&
    typeof (value as Definition<unknown, unknown>).run === "function"
  );
}

interface ModuleNotFoundError extends Error {
  code: string;
}

function isModuleNotFoundError(error: unknown): error is ModuleNotFoundError {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  );
}

function diagnoseModuleImportError(
  error: unknown,
  projectDir: string,
  projectName: string,
): HarnessError | null {
  if (!isModuleNotFoundError(error)) {
    return null;
  }

  const missingModule = parseMissingModuleName(error.message);
  if (missingModule === undefined) {
    return null;
  }

  const declaredDeps = readProjectDeclaredDependencies(projectDir);

  if (declaredDeps.size > 0 && declaredDeps.has(missingModule)) {
    return new HarnessError({
      type: "execution",
      message: `Workflow "${projectName}" depends on "${missingModule}" which is not installed. Run "pnpm install" in the workflow directory to install dependencies.`,
      metadata: { project: projectName, missingModule },
    });
  }

  if (declaredDeps.size > 0) {
    return new HarnessError({
      type: "execution",
      message: `Module "${missingModule}" is required by workflow "${projectName}" but was not found. Dependencies may not be installed. Run "pnpm install" in the workflow directory to install dependencies.`,
      metadata: { project: projectName, missingModule },
    });
  }

  return null;
}

const MISSING_MODULE_PATTERN = /Cannot find (?:package|module) '([^']+)'/;

function parseMissingModuleName(message: string): string | undefined {
  const match = message.match(MISSING_MODULE_PATTERN);
  if (match === null) {
    return undefined;
  }

  const raw = match[1];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  return raw;
}

function readProjectDeclaredDependencies(projectDir: string): Set<string> {
  const result = new Set<string>();
  let packageJson: unknown;

  try {
    packageJson = JSON.parse(
      readFileSync(path.join(projectDir, "package.json"), "utf8"),
    );
  } catch {
    return result;
  }

  if (typeof packageJson !== "object" || packageJson === null) {
    return result;
  }

  const deps = packageJson as Record<string, unknown>;

  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const value = deps[key];
    if (typeof value !== "object" || value === null) {
      continue;
    }

    for (const packageName of Object.keys(value as Record<string, unknown>)) {
      result.add(packageName);
    }
  }

  return result;
}

function resolveProjectLocation(
  cwd: string,
  projectName: string,
): { projectDir: string } {
  const projectDir = path.resolve(cwd, "workspace", "workflow", projectName);
  return { projectDir };
}

function resolveLocalProjectDir(projectDir = "."): string {
  return path.resolve(process.cwd(), projectDir);
}

function resolveLocalProjectModulePath(projectDir: string, _projectName: string, entryId?: string): string {
  return resolveProjectEntrySync(projectDir, entryId).modulePath;
}

function readLocalProjectName(projectDir: string): string {
  return readProjectDeclarationFromDirectorySync(projectDir).name;
}

function readSchedulePresetValue(
  packageJson: unknown,
  projectType: ProjectKind,
  entrypoints: NonNullable<StructureReport["entrypoints"]>,
): SchedulePreset[] {
  const value = (packageJson as {schedulePresets?:unknown})?.schedulePresets;
  if (value === undefined) return [];
  try {
    const presets = parseProjectSchedulePresets(value, projectType);
    const entrypointsById = new Map(entrypoints.map((entrypoint) => [entrypoint.id, entrypoint]));
    for (const preset of presets) {
      const entrypoint = entrypointsById.get(preset.entrypointId);
      if (entrypoint === undefined) {
        throw new Error(
          `steamharness.json.schedulePresets entry "${preset.id}" references unknown entrypoint "${preset.entrypointId}".`,
        );
      }
      validateProjectScheduleParamValues(
        preset.paramValues,
        entrypoint.params ?? [],
        `steamharness.json.schedulePresets entry "${preset.id}".paramValues`,
      );
    }
    return presets;
  } catch (error) {
    throw new HarnessError({
      type: "input_validation",
      message: `Project schedule preset validation failed: ${readErrorMessage(error)}`,
      metadata: { projectType },
    });
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readKanbanStructureFiles(projectDir: string, currentDir = projectDir): string[] {
  return readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      return readKanbanStructureFiles(projectDir, absolutePath);
    }
    if (!entry.isFile()) return [];
    return [path.relative(projectDir, absolutePath).split(path.sep).join("/")];
  }).sort((left, right) => left.localeCompare(right));
}

function assertLocalProjectIsExecutable(projectDir: string, projectName: string, entryId?: string, env?: NodeJS.ProcessEnv): void {
  if (resolveProjectEntrySync(projectDir, entryId, env).registration.type !== "kanban") return;
  throw new HarnessError({
    type: "input_validation",
    message: createKanbanExecutionUnsupportedMessage(projectName),
    metadata: { project: projectName, projectType: "kanban" },
  });
}

function isRunningCompiledExecutor(): boolean {
  return fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`);
}

function isExecutorCliEntrypoint(): boolean {
  const entryPath = process.argv[1];

  if (entryPath === undefined) {
    return false;
  }

  const resolvedEntryPath = path.resolve(entryPath);

  return resolvedEntryPath === fileURLToPath(import.meta.url);
}

if (isExecutorCliEntrypoint()) {
  disableAiSdkWarningLogs();
  void runExecutorCli();
}

function disableAiSdkWarningLogs(): void {
  (globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: false;
  }).AI_SDK_LOG_WARNINGS = false;
}

async function runExecutorCli(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "--structure") {
    runStructureCli(removeCliFlags(argv.slice(1), ["--json"]));
    return;
  }

  const parsed = parseExecutorCliArgs(argv);
  const report = await runWorkspaceProjectReportFromCli(parsed.argv, {
    nodeHooks: parsed.json ? undefined : createCliOutputStreamHooks(),
  });

  if (parsed.json) {
    console.log(formatProjectExecutionJson(report));
  } else if (report.status === "failed") {
    console.error(formatProjectExecutionJson(report));
  }

  process.exitCode = report.status === "success" ? 0 : 1;
}

function parseExecutorCliArgs(argv: string[]): {
  argv: string[];
  json: boolean;
} {
  let json = false;
  const filteredArgv: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      filteredArgv.push(...argv.slice(index));
      break;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    filteredArgv.push(arg);
  }

  return {
    argv: removePnpmRunSeparator(filteredArgv),
    json,
  };
}

function removePnpmRunSeparator(argv: string[]): string[] {
  const separatorIndex = argv.indexOf("--");

  if (separatorIndex <= 0) {
    return argv;
  }

  return [
    ...argv.slice(0, separatorIndex),
    ...argv.slice(separatorIndex + 1),
  ];
}

function removeCliFlags(argv: string[], flags: string[]): string[] {
  return argv.filter((arg) => !flags.includes(arg));
}

export function createCliOutputStreamHooks(): NodeExecutionHooks {
  const streamedOutputExecutionIds = new Set<string>();

  return {
    onNodeChunk(event) {
      if (event.nodeName !== "output") {
        return;
      }

      streamedOutputExecutionIds.add(event.executionId);
      const content = formatCliOutputChunk(event.chunk);
      if (content !== "") {
        process.stdout.write(content);
      }
    },
    onNodeFinish(event) {
      if (event.nodeName !== "output") {
        return;
      }

      if (!streamedOutputExecutionIds.has(event.executionId)) {
        const content = formatCliOutputContent(event.output);

        if (content !== "") {
          process.stdout.write(content);
        }
      }

      process.stdout.write("\n");
    },
  };
}

export function formatCliOutputContent(output: unknown): string {
  if (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    Array.isArray((output as { items?: unknown }).items)
  ) {
    return (output as { items: unknown[] }).items
      .map(formatCliOutputItem)
      .filter((item) => item !== "")
      .join("\n");
  }

  if (output === undefined || output === null) {
    return "";
  }

  if (typeof output === "string") {
    return output;
  }

  if (
    typeof output === "number" ||
    typeof output === "boolean" ||
    typeof output === "bigint"
  ) {
    return String(output);
  }

  return JSON.stringify(output, null, 2);
}

function formatCliOutputChunk(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (!isOutputItemStreamChunk(chunk)) {
    return "";
  }

  if (chunk.type === "output_item_start") {
    const title = chunk.item.title.trim() || "Output";
    return `\n${title}\n`;
  }

  if (chunk.type === "output_item_delta") {
    return formatCliOutputContent(chunk.delta);
  }

  return "\n";
}

function formatCliOutputItem(item: unknown): string {
  if (
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    typeof (item as { title?: unknown }).title === "string"
  ) {
    const title = (item as { title: string }).title.trim();
    const content = formatCliOutputContent((item as { content?: unknown }).content);
    return title === "" ? content : `${title}\n${content}`;
  }

  return formatCliOutputContent(item);
}

function runStructureCli(argv: string[]): void {
  try {
    const report = inspectWorkspaceProjectStructureFromCli(argv);

    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.log(formatProjectStructureError(error, argv[0]));
    process.exitCode = 1;
  }
}

function formatProjectStructureError(
  error: unknown,
  projectName: string | undefined,
): string {
  return JSON.stringify(
    {
      workflow: {
        name: projectName ?? "",
      },
      definitions: {
        nodes: {},
        apiCalls: [],
        variables: {},
      },
      execution: {
        kind: "sequence",
        children: [],
      },
      diagnostics: {
        warnings: [],
        violations: [],
        error: createProjectFailure(error).error,
      },
    },
    null,
    2,
  );
}

function createExecutorFileStore(options: {
  configuration?: ProjectConfigurationSnapshot;
  env?: NodeJS.ProcessEnv;
  projectName: string;
  conversationId?: string;
  fileStore?: FileStore;
  fileStoreDir?: string;
  fileCreateStoreDir?: string;
}): FileStore {
  const resolveStore = options.fileStore ?? createLocalResolveFileStore(options.fileStoreDir);

  if (options.fileStore?.createFile !== undefined) {
    return options.fileStore;
  }

  const createRoot = options.fileCreateStoreDir?.trim();
  if (createRoot !== undefined && createRoot !== "") {
    const createStore = createServerProjectFileStore({
      rootDir: createRoot,
      projectName: options.projectName,
      conversationId: options.conversationId,
    });
    return createProjectFileStore({
      resolveStore,
      createFile: (input) => createStore.createFile!(input),
    });
  }

  const remoteStore = createRemoteProjectFileStoreFromEnv({
    env: options.env,
    projectName: options.projectName,
    conversationId: options.conversationId,
  });
  if (remoteStore !== undefined) {
    return createProjectFileStore({
      resolveStore,
      createFile: (input) => remoteStore.createFile!(input),
    });
  }

  return createProjectFileStore({ resolveStore });
}

function createLocalResolveFileStore(
  rootDir: string | undefined,
): FileStore {
  if (rootDir === undefined || rootDir.trim() === "") {
    return createLocalProjectFileStore({ allowAbsolutePaths: true });
  }

  return createLocalProjectFileStore({
    rootDir,
    allowAbsolutePaths: true,
  });
}

function createChainedAbortController(abortSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();

  if (abortSignal === undefined) {
    return controller;
  }

  if (abortSignal.aborted) {
    controller.abort(abortSignal.reason);
    return controller;
  }

  // Local workflow runs now accept a parent abort signal so app
  // conversation cancel can propagate into workflow context and SDK calls.
  abortSignal.addEventListener(
    "abort",
    () => controller.abort(abortSignal.reason),
    { once: true },
  );
  return controller;
}

function throwIfRunLocalProjectAborted(signal: AbortSignal, projectName: string): void {
  if (!signal.aborted) {
    return;
  }

  throw new HarnessError({
    type: "execution_aborted",
    message: signal.reason instanceof Error
      ? signal.reason.message
      : `Workflow "${projectName}" execution was aborted.`,
    metadata: {
      project: projectName,
      reason: "abort",
    },
    cause: signal.reason,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runWorkspaceProjectWithReport(options: Parameters<typeof runWorkspaceProjectWithReportInternal>[0]): ReturnType<typeof runWorkspaceProjectWithReportInternal> {
  const projectDir=resolveProjectLocation(options.cwd??process.cwd(),options.projectName).projectDir;
  const declaration=readProjectStorageDeclaration(projectDir,options.entryId,options.env);
  const identity={projectId:declaration.projectId,entryId:declaration.entryId};
  const runId=options.runId??createProjectRunId();
  const snapshot=await (await createLocalProjectConfigurationStore(projectDir,{entryId:declaration.entryId})).snapshot({runId:options.configurationRunId??runId,configuration:options.configuration});
  const report=await withProjectConfiguration(snapshot,()=>runWorkspaceProjectWithReportInternal({...options,runId,entryId:declaration.entryId,configuration:snapshot,onRuntimeEvent:event=>options.onRuntimeEvent?.({...event,...identity})}),projectDir,declaration.entryId);
  return {...report,...identity};
}

export async function debugWorkspaceProjectNodeWithReport(options: Parameters<typeof debugWorkspaceProjectNodeWithReportInternal>[0]): ReturnType<typeof debugWorkspaceProjectNodeWithReportInternal> {
  const projectDir = resolveProjectLocation(options.cwd ?? process.cwd(), options.projectName).projectDir;
  const declaration = readProjectStorageDeclaration(projectDir, options.entryId, options.env);
  const identity = { projectId: declaration.projectId, entryId: declaration.entryId };
  const runId = options.runId ?? createProjectRunId();
  const snapshot = await (await createLocalProjectConfigurationStore(projectDir, { entryId: declaration.entryId })).snapshot({ runId: options.configurationRunId ?? runId, configuration: options.configuration });
  const report = await withProjectConfiguration(snapshot, () => debugWorkspaceProjectNodeWithReportInternal({ ...options, runId, entryId: declaration.entryId, configuration: snapshot, onRuntimeEvent: event => options.onRuntimeEvent?.({ ...event, ...identity }) }), projectDir, declaration.entryId);
  return { ...report, ...identity };
}

export async function runLocalProjectWithReport(options: RunLocalProjectOptions = {}): ReturnType<typeof runLocalProjectWithReportInternal> {
  const declaration = readProjectStorageDeclaration(resolveLocalProjectDir(options.projectDir), options.entryId, options.env);
  const identity = { projectId: declaration.projectId, entryId: declaration.entryId };
  const runId = options.runId ?? createProjectRunId();
  const snapshot = await (await createLocalProjectConfigurationStore(declaration.projectDir, { entryId: declaration.entryId })).snapshot({ runId: options.configurationRunId ?? runId, configuration: options.configuration });
  const report = await withProjectConfiguration(snapshot, () => runLocalProjectWithReportInternal({ ...options, runId, entryId: declaration.entryId, configuration: snapshot, onRuntimeEvent: event => options.onRuntimeEvent?.({ ...event, ...identity }) }), declaration.projectDir, declaration.entryId);
  return { ...report, ...identity };
}

async function resolveProjectParamsFromModule(options: Parameters<typeof resolveProjectParamsFromModuleInternal>[0]): Promise<ParamResolveResult> {
  const snapshot = await (await createLocalProjectConfigurationStore(options.declaration.projectDir, { entryId: options.declaration.entryId })).snapshot({ required: false,configuration:options.configuration,refreshAccess:false });
  return withProjectConfiguration(snapshot, () => resolveProjectParamsFromModuleInternal(options),options.declaration.projectDir, options.declaration.entryId);
}
